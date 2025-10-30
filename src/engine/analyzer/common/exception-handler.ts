const logger = require('../../../util/logger')(__filename)

let totalErrors: any[]
/**
 *
 * @param {Error} error
 * @param infoMsg
 * @param errorMsg
 */
function handleException(error: any, infoMsg: any, errorMsg: any): void {
  if (infoMsg && typeof infoMsg === 'string' && infoMsg.length >= 1) {
    logger.info(infoMsg)
  }
  if (errorMsg && typeof errorMsg === 'string' && errorMsg.length >= 1) {
    logger.error(errorMsg)
  }
  if (error) {
    logger.error(error)
  }
  totalErrors = totalErrors || []
  totalErrors.push({ errorMsg, error })
}

/**
 *
 */
function clearTotalErrorsExceptionHandler(): void {
  totalErrors = []
}

/**
 *
 */
function outputTotalErrorsExceptionHandler(): void {
  if (Array.isArray(totalErrors) && totalErrors.length > 0) {
    for (const error of totalErrors) {
      logger.info(error.errorMsg)
      logger.info(error.error)
    }
  }
}

export {
  handleException,
  clearTotalErrorsExceptionHandler as clearTotalErrors,
  outputTotalErrorsExceptionHandler as outputTotalErrors,
}
