const CONSTANT = require('../../../util/constant')

let currentEntryPoint = {
  filepath: CONSTANT.YASA_DEFAULT,
  functionName: CONSTANT.YASA_DEFAULT,
  attribute: CONSTANT.YASA_DEFAULT,
  funcReceiverType: CONSTANT.YASA_DEFAULT,
}

/**
 * setCurrentEntryPoint
 * entryPoint
 * @param entryPoint
 */
function setCurrentEntryPoint(entryPoint) {
  currentEntryPoint = entryPoint
}

/**
 *
 */
function getCurrentEntryPoint() {
  return currentEntryPoint
}

module.exports = {
  getCurrentEntryPoint,
  setCurrentEntryPoint,
}
