const constValue = require('../../../util/constant')

/**
 *
 */
class EntryPoint {
  /**
   *
   * @param type
   */
  constructor(type) {
    this.type = type || constValue.ENGIN_START_FILE_BEGIN
    this.scopeVal = {}
    this.argValues = []
    this.entryPointSymVal = {}
    this.functionName = ''
    this.filePath = ''
    this.attribute = ''
    this.funcReceiverType = ''
  }
}

module.exports = EntryPoint
