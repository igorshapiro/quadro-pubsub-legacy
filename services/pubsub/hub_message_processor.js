const HubMessageContext = require('./hub_message_context')
const shortid = require('shortid')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

module.exports = class HubMessageProcessor {
  constructor(log, config, hubStats = 'pubsub:hubStats', mongoConnectionFactory, handlers = 'pubsub:handlersList') {
    this.log = log
    this.config = config
    this.hubStats = hubStats
    this.handlers = {}
    this.defaultDelaySec = 5
    this.handlers = handlers
    this.mongoConnectionFactory = mongoConnectionFactory
    this.schedule = config.get('service.retrySchedule', [
      5 * SECOND, 3 * MINUTE, 30 * MINUTE, 6 * HOUR
    ])
  }

  /**
   * Initialize the mongo connection
   */
  async initialize() {
    if (this.config.get('service.name')) {
      this.initialized = true

      const mongoConnectionString = this.config.get('service.storage.host')
      const mongoDB = await this.mongoConnectionFactory.connectToDB(mongoConnectionString)
      const serviceName = this.config.get('service.name')
      this.scheduleCollection = await mongoDB.collection(this.config.get('service.storage.schedule', `${serviceName}_schedule`))
      await this.scheduleCollection.createIndex(
        { scheduledMessageId: 1 },
        { unique: true, name: 'scheduledMessageId' }
      )
      this.deadLetterCollection = await mongoDB.collection(this.config.get('service.storage.dead', `${serviceName}_dead_v2`))
      await this.deadLetterCollection.createIndex(
        { killedAt: 1 },
        { name: 'killedAt' }
      )
      await this.deadLetterCollection.createIndex(
        { messageId: 1 },
        { name: 'messageId' }
      )
      await this.initailizeHandlers()
    }
  }

  async initailizeHandlers() {
    await Promise.map(
      this.handlers,
      ({ handler, messageType }) => this.register(messageType, handler)
    )
  }

  /**
   * This handles the processing of the message. This method does follwoing things
   * 1. Sends message to appropriat handler
   * 2. If message fails then schedule it for later time.
   * 3. If all retries are exhausted then it put the message in dead letter queue
   * @param  {Object}  message the message object
   * @return {Promise}
   */
  async handleProcessing(message) {
    // Parse the message. If it fails then log and return.
    // Else this message will keep hanging in the system
    let parsedMessage
    try {
      parsedMessage = JSON.parse(message.content.toString())
    } catch (err) {
      this.log.error({ err }, `Error while parsing message: ${parsedMessage}`)
      return
    }

    let messageContext = new HubMessageContext(parsedMessage)
    let messageType = parsedMessage.messageType
    let handler = this.handlers[messageType]
    if (!this.initialized || !handler) {
      messageContext.failure('Message handler not found.')
      return this.sendToDeadLetter(messageContext)
    }

    try {
      let timer = new Date()
      await handler.handle(messageContext)
      Q.log.debug({ messageType, parsedMessage }, 'Message received')
      this.hubStats.timing(parsedMessage.messageType, 'response_time', timer)
      // reschdule message if it failed
      if (messageContext.isFailed()) {
        let data = { messageType, statusCode: messageContext.getStatusCode() }
        Q.log.error(data, 'Message handling failed')

        return this.rescheduleMessage(messageContext)
      } else if (messageContext.shouldRedeliver()) {
        let data = { messageType, retryAfterSec: messageContext.getRetryAfterSec() }
        Q.log.debug(data, 'Handler asked for message re-delivery')

        return this.scheduleMessage(messageContext)
      }
      this.hubStats.increment(parsedMessage.messageType, 'succeeded')
    } catch (err) {
      Q.log.error({ messageType, err }, 'Unhandled exception while handling message')
      messageContext.failure(err)
      // In case of error set the retry and push it to mongo
      await this.rescheduleMessage(messageContext)
    }
  }

  /**
   * This method reschedule the message for later time
   * @param  {MessageContext}  messageContext the message context
   * @return {Promise}
   */
  async rescheduleMessage(messageContext) {
    // Get the message from context
    let message = messageContext.getRawMessage()
    this.hubStats.increment(message.messageType, 'failed', messageContext.getStatusCode())

    // Set the max attempts if not exists
    if (!message.maxAttempts) message.maxAttempts = 5
    // Set the attempt made
    message.attemptsMade = message.attemptsMade ? message.attemptsMade + 1 : 1
    // If attempt made are more than max attempts
    if (message.attemptsMade >= message.maxAttempts) await this.sendToDeadLetter(messageContext)
    // Else put in the schedule collection
    else await this.scheduleMessage(messageContext)
  }

  /**
   * This method put the message in dead letter collection
   * @param  {Object}  messageContext message context that wraps message to be
   *                                  send to dead letter
   * @return {Promise}
   */
  async sendToDeadLetter(messageContext) {
    let message = messageContext.getRawMessage()
    message.lastError = {
      statusCode: messageContext.getStatusCode(),
      body: messageContext.getError()
    }
    message.killedAt = Date.now()
    await this.deadLetterCollection.insertOne(message)
    this.hubStats.increment(message.messageType, 'killed', messageContext.getStatusCode())
  }

  /**
   * This method updates the due time of message based on number of retries and
   * put in the scheduled collection of mongo. Central hub then take care of
   * putting it back in exchange at due time
   * @param  {Object}  messageContext message context that wraps message to be
   *                                  rescheduled
   * @return {Promise}
   */
  async scheduleMessage(messageContext) {
    let message = messageContext.getRawMessage()
    messageContext.lastError = {
      statusCode: messageContext.getStatusCode(),
      body: messageContext.getError()
    }
    let dueTime
    if (messageContext.isFailed()) {
      dueTime = Date.now() + this.getDelay(message)
    } else if (messageContext.shouldRedeliver()) {
      dueTime = Date.now() + messageContext.getRetryAfterSec() * 1000
    } else {
      Q.log.error(
        { message: messageContext.getRawMessage() },
        'Do not know how to schedule the message. It is not failed, nor requested to redeliver'
      )
      return
    }
    let scheduledItem = {
      dueTime: dueTime,
      message,
      scheduledMessageId: shortid.generate()
    }
    await this.scheduleCollection.insert(scheduledItem)
    this.hubStats.increment(message.messageType, 'scheduled', messageContext.getStatusCode())
  }

  getDelay(msg) {
    return this.schedule[msg.attemptsMade - 1] ||
      this.schedule[this.schedule.length - 1] ||
      this.defaultDelaySec * 1000
  }

  /**
   * This method register a handler with a given message name
   * @param  {String}  messageName the message name
   * @param  {Object}  messageHandler the message handler
   * @return {Promise}
   */
  async register(messageName, messageHandler) {
    this.handlers[messageName] = messageHandler
  }
}
