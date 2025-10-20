const { addElementToBuffer } = require('./buffer')

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
  static StringBuffer(_this, argvalues, state, node, scope) {
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
  static append(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return
    }
    addElementToBuffer(_this, argvalues[0])
    return _this
  }
}

module.exports = StringBuffer
