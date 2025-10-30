const { addElementToBuffer: addElementToBufferStringBuilder } = require('./buffer')

/**
 * java.lang.StringBuilder
 */
class StringBuilder {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static StringBuilder(_this: any, argvalues: any[], state: any, node: any, scope: any): any {
    return _this
  }

  /**
   * StringBuilder.append
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static append(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return _this
    }
    addElementToBufferStringBuilder(_this, argvalues[0])
    return _this
  }
}

module.exports = StringBuilder
