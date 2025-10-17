const Map = require('./map-builtins')

/**
 * java.util.HashMap
 */
class HashMap extends Map {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static HashMap(_this, argvalues, state, node, scope) {
    super.Map(_this, argvalues, state, node, scope)

    if (argvalues.length === 1 && argvalues[0].vtype !== 'primitive') {
      super.putAll(_this, argvalues, state, node, scope)
    }

    return _this
  }
}

module.exports = HashMap
