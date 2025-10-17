const MemSpace = require('../../../common/memSpace')
const UndefinedValue = require('../../../common/value/undefine')

const memSpaceUtil = new MemSpace()

/**
 * java.util.concurrent.atomic.AtomicReference
 */
class AtomicReference {
  /**
   * constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static AtomicReference(_this, argvalues, state, node, scope) {
    if (!_this) {
      return _this
    }

    if (argvalues.length > 0) {
      memSpaceUtil.saveVarInScope(_this, '_value', argvalues[0], state)
    }

    return _this
  }

  /**
   * AtomicReference.set
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static set(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    memSpaceUtil.saveVarInScope(_this, '_value', argvalues[0], state)
    _this.arguments = []
  }
}

module.exports = AtomicReference
