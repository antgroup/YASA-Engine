const MemSpaceAtomic = require('../../../common/memSpace')
import { UndefinedValue } from '../../../common/value/undefine'

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
  static set(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    if (_this.vtype === 'union' && Array.isArray(_this.value)) {
      for (const thisObj of _this.value) {
        thisObj.arguments = []
        memSpaceUtilAtomic.saveVarInScope(thisObj, '_value', argvalues[0], state)
      }
    } else {
      _this.arguments = []
      memSpaceUtilAtomic.saveVarInScope(_this, '_value', argvalues[0], state)
    }

    return new UndefinedValue()
  }
}

module.exports = AtomicReference
