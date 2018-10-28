require('quadro')({
  plugins: [
    '.',
    { name: 'quadro-test', condition: () => Q.app.isTestEnv }
  ]
})
