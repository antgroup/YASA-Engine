const { execute } = require('./interface/starter')
const { ErrorCode: ErrorCodeMain } = require('./util/error-code')
const { handleException: handleExceptionMain } = require('./engine/analyzer/common/exception-handler')

;(async function run() {
  try {
    const args = process.argv.slice(2)
    await execute(null, args)
  } catch (e) {
    handleExceptionMain(e, 'ERROR occurred in main.run!!', 'ERROR occurred in main.run!!')
    process.exitCode = ErrorCodeMain.unknown_error
  }
})()
