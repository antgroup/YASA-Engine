const SetBuiltins = require('./set-builtins')
const { addElementToBuffer: addElementToBufferHashSet } = require('./buffer')
/**
 * java.util.HashSet
 */
class HashSet extends SetBuiltins {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static HashSet(_this: any, argvalues: any[], state: any, node: any, scope: any): any {
    super.Set(_this, argvalues, state, node, scope)

    if (argvalues.length === 1 && argvalues[0].vtype !== 'primitive') {
      addElementToBufferHashSet(_this, argvalues[0])
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
  static clone(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    return fclos.getThis()
  }
}

module.exports = HashSet
