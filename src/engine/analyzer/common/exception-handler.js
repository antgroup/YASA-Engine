const logger = require('../../../util/logger')(__filename)

let totalErrors
/**
 *
 * @param {Error} error
 * @param infoMsg
 * @param errorMsg
 */
function handleException(error, infoMsg, errorMsg) {
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
function clearTotalErrors() {
  totalErrors = []
}

/**
 *
 */
function outputTotalErrors() {
  if (Array.isArray(totalErrors) && totalErrors.length > 0) {
    for (const error of totalErrors) {
      logger.info(error.errorMsg)
      logger.info(error.error)
    }
  }
}

module.exports = {
  handleException,
  clearTotalErrors,
  outputTotalErrors,
}
