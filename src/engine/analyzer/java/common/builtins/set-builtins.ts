const Collection = require('./collection-builtins')
const {
  addElementToBuffer: addElementToBufferSet,
  clearBuffer: clearBufferSet,
  removeElementFromBuffer: removeElementFromBufferSet,
} = require('./buffer')
const { shallowCopyValue } = require('../../../../../util/clone-util')
import { UndefinedValue } from '../../../common/value/undefine'

/**
 * java.util.Set
 */
class Set extends Collection {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static Set(_this: any, argvalues: any, state: any, node: any, scope: any) {
    super.Collection(_this, argvalues, state, node, scope)

    return _this
  }

  /**
   * Set.add
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static add(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    addElementToBufferSet(_this, argvalues[0])

    return new UndefinedValue()
  }

  /**
   * Set.addAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static addAll(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    addElementToBufferSet(_this, argvalues[0])

    return new UndefinedValue()
  }

  /**
   * Set.clear
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static clear(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return
    }

    clearBufferSet(_this)
  }

  /**
   * Set.contains
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static contains(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Set.containsAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static containsAll(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Set.equals
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static equals(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Set.hashCode
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static hashCode(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Set.isEmpty
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static isEmpty(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Set.iterator
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static iterator(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    const newThis = shallowCopyValue(_this)
    newThis._this = newThis

    return newThis
  }

  /**
   * Set.remove
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static remove(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    removeElementFromBufferSet(_this, argvalues[0])

    return new UndefinedValue()
  }

  /**
   * Set.removeAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static removeAll(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    removeElementFromBufferSet(_this, argvalues[0])

    return new UndefinedValue()
  }

  /**
   * Set.retainAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static retainAll(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Set.size
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static size(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Set.spliterator
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static spliterator(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Set.iterator(fclos, argvalues, state, node, scope)
  }

  /**
   * Set.toArray
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static toArray(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }
}

module.exports = Set
