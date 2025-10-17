const { addElementToBuffer } = require('./buffer')

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
  static StringBuilder(_this, argvalues, state, node, scope) {
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
  static append(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return _this
    }
    addElementToBuffer(_this, argvalues[0])
    return _this
  }
}

module.exports = StringBuilder
