const Collection = require('./collection-builtins')
const { addElementToBuffer, clearBuffer, removeElementFromBuffer } = require('./buffer')
const { cloneWithDepth } = require('../../../../../util/clone-util')
const UndefinedValue = require('../../../common/value/undefine')

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
  static Set(_this, argvalues, state, node, scope) {
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
  static add(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    addElementToBuffer(_this, argvalues[0])

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
  static addAll(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    addElementToBuffer(_this, argvalues[0])

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
  static clear(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return
    }

    clearBuffer(_this)
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
  static contains(fclos, argvalues, state, node, scope) {
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
  static containsAll(fclos, argvalues, state, node, scope) {
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
  static equals(fclos, argvalues, state, node, scope) {
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
  static hashCode(fclos, argvalues, state, node, scope) {
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
  static isEmpty(fclos, argvalues, state, node, scope) {
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
  static iterator(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    const newThis = cloneWithDepth(_this, 3)
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
  static remove(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    removeElementFromBuffer(_this, argvalues[0])

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
  static removeAll(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    removeElementFromBuffer(_this, argvalues[0])

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
  static retainAll(fclos, argvalues, state, node, scope) {
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
  static size(fclos, argvalues, state, node, scope) {
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
  static spliterator(fclos, argvalues, state, node, scope) {
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
  static toArray(fclos, argvalues, state, node, scope) {
    return fclos.getThis()
  }
}

module.exports = Set
