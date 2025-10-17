const { cloneWithDepth } = require('../../../../../util/clone-util')
const { addElementToBuffer, moveExistElementsToBuffer, removeElementFromBuffer, clearBuffer } = require('./buffer')
const MemSpace = require('../../../common/memSpace')
const Collection = require('./collection-builtins')
const UndefinedValue = require('../../../common/value/undefine')

const memSpaceUtil = new MemSpace()

/**
 * java.util.List
 */
class List extends Collection {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @private
   */
  static List(_this, argvalues, state, node, scope) {
    super.Collection(_this, argvalues, state, node, scope)
    _this.setMisc('precise', true)

    return _this
  }

  /**
   * List.add
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
      } else if (argvalues.length === 2) {
        const indexVal = argvalues[0]
        if (indexVal?.vtype === 'primitive' && indexVal?.type === 'Literal' && indexVal?.literalType === 'number') {
          const index = parseInt(indexVal.value, 10)
          if (index >= 0 && index <= _this.length) {
            _this.value[index] = argvalues[1]
            if (index === _this.length) {
              _this.length++
            }
          }
        } else {
          _this.setMisc('precise', false)
          moveExistElementsToBuffer(_this)
          addElementToBuffer(_this, argvalues[0])
          _this.length = 0
        }
      }
    }

    if (argvalues.length === 1) {
      return new UndefinedValue()
    }
  }

  /**
   * List.addAll
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

    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)
    addElementToBuffer(_this, argvalues[0])
    _this.length = 0

    return new UndefinedValue()
  }

  /**
   * List.addFirst
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static addFirst(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return
    }

    if (!_this.getMisc('precise')) {
      addElementToBuffer(_this, argvalues[0])
    } else {
      const tmpVal = {}
      for (const key in _this.value) {
        if (Number(key) >= 0) {
          tmpVal[key] = _this.value[key]
        }
      }

      _this.value[0] = argvalues[0]
      for (const key in tmpVal) {
        _this.value[key + 1] = tmpVal[key]
      }
      _this.length = _this.length ?? 0
      _this.length++
    }
  }

  /**
   * List.addList
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static addLast(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()

    if (!_this || !argvalues || argvalues.length === 0) {
      return
    }

    if (!_this.getMisc('precise')) {
      addElementToBuffer(_this, argvalues[0])
    } else {
      _this.length = _this.length ?? 0
      _this.value[_this.length] = argvalues[0]
      _this.length++
    }
  }

  /**
   * List.clear
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

    if (!_this.getMisc('precise')) {
      clearBuffer(_this)
    } else {
      const indexKeys = []
      for (const key in _this.value) {
        if (Number(key) >= 0) {
          indexKeys.push(key)
        }
      }
      for (const indexKey of indexKeys) {
        delete _this.value[indexKey]
      }
      _this.length = 0
    }
  }

  /**
   * List.contains
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
   * List.containsAll
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
   * List.equals
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
   * List.get
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {{type, object, property}|*}
   */
  static get(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }
    return memSpaceUtil.getMemberValue(_this, argvalues[0], state)
  }

  /**
   * List.getFirst
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static getFirst(fclos, argvalues, state, node, scope) {
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
   * List.getLast
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static getLast(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }

    const length = _this.length ?? 0
    return memSpaceUtil.getMemberValue(_this, String(length - 1), state)
  }

  /**
   * List.hashCode
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
   * List.indexOf
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static indexOf(fclos, argvalues, state, node, scope) {
    return new UndefinedValue()
  }

  /**
   * List.isEmpty
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
   * List.iterator
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static iterator(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    const newThis = cloneWithDepth(_this, 3)
    newThis._this = newThis
    newThis.setMisc('precise', false)
    moveExistElementsToBuffer(newThis)
    newThis.length = 0
    for (const key in newThis.value) {
      const prop = newThis.value[key]
      if (prop.vtype === 'fclos') {
        prop._this = newThis
      }
    }

    return newThis
  }

  /**
   * List.lastIndexOf
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static lastIndexOf(fclos, argvalues, state, node, scope) {
    return new UndefinedValue()
  }

  /**
   * List.listIterator
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static listIterator(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this || !argvalues) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }

    const newThis = cloneWithDepth(_this, 3)
    newThis._this = newThis
    newThis.setMisc('precise', false)
    newThis.length = 0
    for (const key in newThis.value) {
      const prop = newThis.value[key]
      if (prop.vtype === 'fclos') {
        prop._this = newThis
      }
    }

    if (argvalues.length === 0) {
      moveExistElementsToBuffer(newThis)
    } else if (argvalues.length === 1) {
      let index
      const indexVal = argvalues[0]
      if (indexVal?.vtype === 'primitive' && indexVal?.type === 'Literal' && indexVal?.literalType === 'number') {
        index = parseInt(indexVal.value, 10)
      }
      moveExistElementsToBuffer(newThis, index)
    }

    return newThis
  }

  /**
   * List.remove
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

    if (!_this.getMisc('precise')) {
      removeElementFromBuffer(_this, argvalues[0])
      return _this
    }

    const tmpVal = {}
    const indexKeys = []
    for (const key in _this.value) {
      if (Number(key) >= 0) {
        tmpVal[key] = _this.value[key]
        indexKeys.push(key)
      }
    }

    let removeKey
    let needReturnObj = false
    let element
    if (
      argvalues[0]?.vtype === 'primitive' &&
      argvalues[0]?.type === 'Literal' &&
      argvalues[0]?.literalType === 'number'
    ) {
      removeKey = parseInt(argvalues[0].value, 10)
      needReturnObj = true
    } else {
      for (const indexKey of indexKeys) {
        if (_this.value[indexKey]._qid === argvalues[0]._qid) {
          removeKey = indexKey
          break
        }
      }
    }

    if (Number(removeKey) >= 0) {
      if (needReturnObj) {
        element = tmpVal[removeKey]
      }
      delete tmpVal[removeKey]
      _this.length = _this.length ?? 0
      if (_this.length > 0) {
        _this.length--
      }
      for (const indexKey of indexKeys) {
        delete _this.value[indexKey]
      }

      let newIndex = 0
      Object.keys(tmpVal)
        .sort()
        .map((key) => {
          _this.value[newIndex] = tmpVal[key]
          newIndex++
        })
    }

    if (!element) {
      element = new UndefinedValue()
    }
    return element
  }

  /**
   * List.removeAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static removeAll(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)
    removeElementFromBuffer(_this, argvalues[0])
    _this.length = 0

    return new UndefinedValue()
  }

  /**
   * List.removeFirst
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static removeFirst(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    if (_this.getMisc('precise')) {
      const tmpVal = {}
      for (const key in _this.value) {
        if (Number(key) >= 0) {
          tmpVal[key] = _this.value[key]
        }
      }

      _this.length = _this.length ?? 0
      let element
      if (_this.length > 0) {
        element = _this.value['0']
        delete _this.value[_this.length - 1]
        for (const key in tmpVal) {
          if (Number(key) !== 0) {
            _this.value[key - 1] = tmpVal[key]
          }
        }
        _this.length--
      }
      return element
    }

    return _this
  }

  /**
   * List.removeLast
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static removeLast(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    if (_this.getMisc('precise')) {
      _this.length = _this.length ?? 0
      let element
      if (_this.length > 0) {
        element = _this.value[_this.length - 1]
        delete _this.value[_this.length - 1]
        _this.length--
      }
      return element
    }

    return _this
  }

  /**
   * List.replaceAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static replaceAll(fclos, argvalues, state, node, scope) {}

  /**
   * List.retainAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static retainAll(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)

    return new UndefinedValue()
  }

  /**
   * List.reversed
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static reversed(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    if (_this.getMisc('precise')) {
      const tmpVal = {}
      for (const key in _this.value) {
        if (Number(key) >= 0) {
          tmpVal[key] = _this.value[key]
        }
      }

      _this.length = _this.length ?? 0
      for (let index = 0; index < _this.length; index++) {
        _this.value[index] = tmpVal[_this.length - 1 - index]
      }
    }

    return _this
  }

  /**
   * List.set
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static set(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()

    if (!_this || !argvalues || argvalues.length !== 2) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      addElementToBuffer(_this, argvalues[1])
      return _this
    }

    const indexVal = argvalues[0]
    if (
      _this.getMisc('precise') &&
      indexVal?.vtype === 'primitive' &&
      indexVal?.type === 'Literal' &&
      indexVal?.literalType === 'number'
    ) {
      const index = parseInt(indexVal.value, 10)
      const elment = _this.value[index]
      _this.value[index] = argvalues[1]
      return elment
    }

    moveExistElementsToBuffer(_this)
    addElementToBuffer(_this, argvalues[0])
    return _this
  }

  /**
   * List.size
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
   * List.sort
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static sort(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this) {
      return
    }

    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)
    _this.length = 0
  }

  /**
   * List.spliterator
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static spliterator(fclos, argvalues, state, node, scope) {
    return List.iterator(fclos, argvalues, state, node, scope)
  }

  /**
   * List.subList
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static subList(fclos, argvalues, state, node, scope) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length !== 2) {
      return new UndefinedValue()
    }

    const newThis = cloneWithDepth(_this, 3)
    newThis._this = newThis
    if (newThis.getMisc('precise')) {
      let startIndex
      let endIndex
      if (
        argvalues[0]?.vtype === 'primitive' &&
        argvalues[0]?.type === 'Literal' &&
        argvalues[0]?.literalType === 'number'
      ) {
        startIndex = parseInt(argvalues[0].value, 10)
      }
      if (
        argvalues[1]?.vtype === 'primitive' &&
        argvalues[1]?.type === 'Literal' &&
        argvalues[1]?.literalType === 'number'
      ) {
        endIndex = parseInt(argvalues[1].value, 10)
      }

      if (startIndex >= 0 && endIndex >= 0) {
        const tmpVal = {}
        const indexKeys = []
        for (const key in newThis.value) {
          if (Number(key) >= 0) {
            tmpVal[key] = newThis.value[key]
            indexKeys.push(key)
          }
        }

        const removeKeys = []
        for (const indexKey of indexKeys) {
          if (indexKey < startIndex || indexKey >= endIndex) {
            removeKeys.push(indexKey)
          }
        }

        if (removeKeys.length > 0) {
          for (const removeKey of removeKeys) {
            delete tmpVal[removeKey]
          }
          for (const indexKey of indexKeys) {
            delete newThis.value[indexKey]
          }

          let newIndex = 0
          Object.keys(tmpVal)
            .sort()
            .map((key) => {
              newThis.value[newIndex] = tmpVal[key]
              newIndex++
            })
        }
      } else {
        newThis.setMisc('precise', false)
        moveExistElementsToBuffer(newThis)
        for (const key in newThis.value) {
          const prop = newThis.value[key]
          if (prop.vtype === 'fclos') {
            prop._this = newThis
          }
        }
      }
    }

    return newThis
  }

  /**
   * List.toArray
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

module.exports = List
