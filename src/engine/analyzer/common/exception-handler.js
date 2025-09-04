const logger = require('../../../util/logger')(__filename)

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
}

module.exports = {
  handleException,
}
