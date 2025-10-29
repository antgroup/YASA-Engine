const Collection = require('./collection-builtins')
const {
  addElementToBuffer: addElementToBufferSet,
  clearBuffer: clearBufferSet,
  removeElementFromBuffer: removeElementFromBufferSet,
} = require('./buffer')
const { cloneWithDepth: cloneWithDepthJava } = require('../../../../../util/clone-util')
const UndefinedValueJava = require('../../../common/value/undefine')

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
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValueJava()
    }

    addElementToBufferSet(_this, argvalues[0])

    return new UndefinedValueJava()
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
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValueJava()
    }

    addElementToBufferSet(_this, argvalues[0])

    return new UndefinedValueJava()
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
    const _this = fclos.getThis()
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
    return new UndefinedValueJava()
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
    return new UndefinedValueJava()
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
    return new UndefinedValueJava()
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
    return new UndefinedValueJava()
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
    return new UndefinedValueJava()
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
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValueJava()
    }

    const newThis = cloneWithDepthJava(_this, 3)
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
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValueJava()
    }

    removeElementFromBufferSet(_this, argvalues[0])

    return new UndefinedValueJava()
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
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValueJava()
    }

    removeElementFromBufferSet(_this, argvalues[0])

    return new UndefinedValueJava()
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
    return new UndefinedValueJava()
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
    return new UndefinedValueJava()
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
    return fclos.getThis()
  }
}

module.exports = Set
