const { execute } = require('./interface/starter')
const logger = require('./util/logger')(__filename)
const { ErrorCode: ErrorCodeMain } = require('./util/error-code')

const { handleException: handleExceptionMain } = require('./engine/analyzer/common/exception-handler')

;(async function run() {
  logger.info(`main file:${require.main?.filename}`)
  try {
    const args = process.argv.slice(2)
    await execute(null, args)
  } catch (e) {
    handleExceptionMain(e, 'ERROR occurred in main.run!!', 'ERROR occurred in main.run!!')
    process.exitCode = ErrorCodeMain.unknown_error
  }
})()
