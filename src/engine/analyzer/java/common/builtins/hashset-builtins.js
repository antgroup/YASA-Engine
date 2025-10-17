const Set = require('./set-builtins')
const { addElementToBuffer } = require('./buffer')
/**
 * java.util.HashSet
 */
class HashSet extends Set {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static HashSet(_this, argvalues, state, node, scope) {
    super.Set(_this, argvalues, state, node, scope)

    if (argvalues.length === 1 && argvalues[0].vtype !== 'primitive') {
      addElementToBuffer(_this, argvalues[0])
    }

    return _this
  }

  /**
   * HashSet.clone
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static clone(fclos, argvalues, state, node, scope) {
    return fclos.getThis()
  }
}

module.exports = HashSet
