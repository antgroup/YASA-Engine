const { addElementToBuffer: addElementToBufferStringBuffer } = require('./buffer')

/**
 * java.lang.StringBuffer
 */
class StringBuffer {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static StringBuffer(_this: any, argvalues: any[], state: any, node: any, scope: any): any {
    return _this
  }

  /**
   * StringBuffer.append
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static append(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return
    }
    addElementToBufferStringBuffer(_this, argvalues[0])
    return _this
  }
}

module.exports = StringBuffer
