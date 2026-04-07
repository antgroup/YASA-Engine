import v8 from 'v8'

const { execute } = require('./interface/starter')
const logger = require('./util/logger')(__filename)
const { ErrorCode: ErrorCodeMain } = require('./util/error-code')
const { handleException: handleExceptionMain } = require('./engine/analyzer/common/exception-handler')
const { YASA_VERSION } = require('./util/constant')

;(async function run() {
  logger.info(`version: ${YASA_VERSION}`)
  logger.info(`v8 heap_size_limit: ${v8.getHeapStatistics().heap_size_limit / 1024 / 1024}`, 'MB')
  logger.info(`main file:${require.main?.filename}`)
  try {
    const args = process.argv.slice(2)
    await execute(null, args)
  } catch (e) {
    handleExceptionMain(e, 'ERROR occurred in main.run!!', 'ERROR occurred in main.run!!')
    process.exitCode = ErrorCodeMain.unknown_error
  }
})()
