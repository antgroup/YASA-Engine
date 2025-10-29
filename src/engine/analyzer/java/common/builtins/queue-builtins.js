const { addElementToBuffer, moveExistElementsToBuffer } = require('./buffer')
const MemSpace = require('../../../common/memSpace')
const Collection = require('./collection-builtins')
const UndefinedValue = require('../../../common/value/undefine')

const memSpaceUtil = new MemSpace()

/**
 * java.util.Queue
 */
class Queue extends Collection {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @private
   */
  static Queue(_this, argvalues, state, node, scope) {
    super.Collection(_this, argvalues, state, node, scope)
    _this.setMisc('precise', true)

    return _this
  }

  /**
   * Queue.add
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
    if (!_this.getMisc('precise')) {
      addElementToBuffer(_this, argvalues[0])
    } else {
      _this.length = _this.length ?? 0
      if (argvalues.length === 1) {
        _this.value[_this.length] = argvalues[0]
        _this.length++
      } else {
        _this.setMisc('precise', false)
        moveExistElementsToBuffer(_this)
        addElementToBuffer(_this, argvalues[0])
        _this.length = 0
      }
    }

    return new UndefinedValue()
  }

  /**
   * Queue.element
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static element(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }
    return memSpaceUtil.getMemberValue(_this, '0', state)
  }

  /**
   * Queue.offer
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static offer(fclos, argvalues, state, node, scope) {
    return Queue.add(fclos, argvalues, state, node, scope)
  }

  /**
   * Queue.peek
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*|{type, object, property}}
   */
  static peek(fclos, argvalues, state, node, scope) {
    return Queue.element(fclos, argvalues, state, node, scope)
  }

  /**
   * Queue.poll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static poll(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }
    const firstElement = memSpaceUtil.getMemberValue(_this, '0', state)
    const tmpVal = {}
    for (const key in _this.value) {
      if (Number(key) >= 0) {
        tmpVal[key] = _this.value[key]
      }
    }

    delete _this.value[_this.length - 1]
    for (const key in tmpVal) {
      if (Number(key) !== 0) {
        _this.value[key - 1] = tmpVal[key]
      }
    }

    _this.length = _this.length ?? 0
    if (_this.length > 0) {
      _this.length--
    }

    return firstElement
  }

  /**
   * Queue.remove
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static remove(fclos, argvalues, state, node, scope) {
    return Queue.poll(fclos, argvalues, state, node, scope)
  }

  /**
   * callback for unknown function
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @private
   */
  static _functionNotFoundCallback_(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return
    }
    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)
  }
}

module.exports = Queue
