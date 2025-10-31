const {
  addElementToBuffer: addElementToBufferQueue,
  moveExistElementsToBuffer: moveExistElementsToBufferQueue,
} = require('./buffer')
const MemSpaceQueue = require('../../../common/memSpace')
const Collection = require('./collection-builtins')
const UndefinedValueQueue = require('../../../common/value/undefine')

const memSpaceUtil = new MemSpaceQueue()

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
  static Queue(_this: any, argvalues: any[], state: any, node: any, scope: any): any {
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
  static add(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValueQueue()
    }
    if (!_this.getMisc('precise')) {
      addElementToBufferQueue(_this, argvalues[0])
    } else {
      _this.length = _this.length ?? 0
      if (argvalues.length === 1) {
        _this.value[_this.length] = argvalues[0]
        _this.length++
      } else {
        _this.setMisc('precise', false)
        moveExistElementsToBufferQueue(_this)
        addElementToBufferQueue(_this, argvalues[0])
        _this.length = 0
      }
    }

    return new UndefinedValueQueue()
  }

  /**
   * Queue.element
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static element(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValueQueue()
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
  static offer(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
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
  static peek(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
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
  static poll(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValueQueue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }
    const firstElement = memSpaceUtil.getMemberValue(_this, '0', state)
    const tmpVal: any = {}
    for (const key in _this.value) {
      if (Number(key) >= 0) {
        tmpVal[key] = _this.value[key]
      }
    }

    delete _this.value[_this.length - 1]
    for (const key in tmpVal) {
      if (Number(key) !== 0) {
        _this.value[Number(key) - 1] = tmpVal[key]
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
  static remove(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
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
  static _functionNotFoundCallback_(fclos: any, argvalues: any[], state: any, node: any, scope: any): void {
    const _this = fclos.getThis()
    if (!_this) {
      return
    }
    _this.setMisc('precise', false)
    moveExistElementsToBufferQueue(_this)
  }
}

module.exports = Queue
