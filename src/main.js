const { execute } = require('./interface/starter')
const logger = require('./util/logger')(__filename)
const { ErrorCode } = require('./util/error-code')

const { handleException } = require('./engine/analyzer/common/exception-handler')

;(async function run() {
  logger.info(`main file:${require.main.filename}`)
  try {
    const args = process.argv.slice(2)
    const res = await execute(null, args)
  } catch (e) {
    handleException(e, 'ERROR occurred in main.run!!', 'ERROR occurred in main.run!!')
    process.exitCode = ErrorCode.unknown_error
  }
})()
