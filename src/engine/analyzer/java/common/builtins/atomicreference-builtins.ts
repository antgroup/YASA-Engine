const MemSpaceAtomic = require('../../../common/memSpace')
const UndefinedValueAtomic = require('../../../common/value/undefine')

const memSpaceUtilAtomic = new MemSpaceAtomic()

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
  static AtomicReference(_this: any, argvalues: any[], state: any, node: any, scope: any): any {
    if (!_this) {
      return _this
    }

    if (argvalues.length > 0) {
      memSpaceUtilAtomic.saveVarInScope(_this, '_value', argvalues[0], state)
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
  static set(fclos: any, argvalues: any[], state: any, node: any, scope: any): void {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValueAtomic()
    }

    memSpaceUtilAtomic.saveVarInScope(_this, '_value', argvalues[0], state)
    _this.arguments = []
  }
}

module.exports = AtomicReference
