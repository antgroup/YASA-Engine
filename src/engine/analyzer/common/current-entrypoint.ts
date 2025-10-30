import type { EntryPoint } from './entrypoint'

const constant = require('../../../util/constant')

let currentEntryPoint: EntryPoint = {
  filePath: constant.YASA_DEFAULT,
  functionName: constant.YASA_DEFAULT,
  attribute: constant.YASA_DEFAULT,
  funcReceiverType: constant.YASA_DEFAULT,
}

/**
 * setCurrentEntryPoint
 * entryPoint
 * @param entryPoint
 */
function setCurrentEntryPoint(entryPoint: EntryPoint): void {
  currentEntryPoint = entryPoint
}

/**
 *
 */
function getCurrentEntryPoint(): EntryPoint {
  return currentEntryPoint
}

module.exports = {
  getCurrentEntryPoint,
  setCurrentEntryPoint,
}
