const _ = require('lodash')
const Collection = require('./collection-builtins')
const { getSymbolRef } = require('../../../../../util/common-util')
const UnionValue = require('../../../common/value/union')
const { clearBuffer, addElementToBuffer, getAllElementFromBuffer } = require('./buffer')
const { cloneWithDepth } = require('../../../../../util/clone-util')
const UndefinedValue = require('../../../common/value/undefine')

/**
 * java.util.Map
 */
class Map extends (Collection as any) {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static Map(_this: any, argvalues: any[], state: any, node: any, scope: any) {
    super.Collection(_this, argvalues, state, node, scope)
    _this.setMisc('precise', true)

    const keyRefSet = new Set()
    _this.setFieldValue('keyRefSet', keyRefSet)

    return _this
  }

  /**
   * Map.clear
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static clear(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.parent
    if (!_this) {
      return
    }

    const keyRefSet = _this.getFieldValue('keyRefSet')
    for (const keyRef of keyRefSet) {
      const entryValue = _this.getFieldValue(keyRef)
      if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
        delete _this.field[keyRef]
      }
    }
    keyRefSet.clear()

    if (!_this.getMisc('precise')) {
      clearBuffer(_this)
    }
  }

  /**
   * Map.fclos
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static compute(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return Map.get(fclos, argvalues, state, node, scope)
  }

  /**
   * Map.computeIfAbsent
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static computeIfAbsent(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Map.computeIfPresent
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static computeIfPresent(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return Map.get(fclos, argvalues, state, node, scope)
  }

  /**
   * Map.containsKey
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static containsKey(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Map.containsValue
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static containsValue(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Map.entrySet
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static entrySet(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    const newThis = cloneWithDepth(_this, 3)
    newThis._this = newThis

    return newThis
  }

  /**
   * Map.equals
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static equals(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Map.forEach
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static forEach(fclos: any, argvalues: any[], state: any, node: any, scope: any) {}

  /**
   * Map.get
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static get(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    const keyRef = getSymbolRef(argvalues[0])
    const keyRefSet = _this.getFieldValue('keyRefSet')
    if (!keyRefSet.has(keyRef)) {
      if (!_this.getMisc('precise')) {
        return _this
      }
      return new UndefinedValue()
    }

    const entryValue = _this.getFieldValue(keyRef)
    if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
      return entryValue.field[1]
    }
  }

  /**
   * Map.getOrDefault
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static getOrDefault(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const element = Map.get(fclos, argvalues, state, node, scope)
    if ((!element || element.vtype === 'undefine') && argvalues.length === 2) {
      return argvalues[1]
    }
    return element
  }

  /**
   * Map.hashCode
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static hashCode(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Map.isEmpty
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static isEmpty(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Map.keySet
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static keySet(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }

    const resSet = new UnionValue({
      id: `${_this.id}-keySet`,
      sid: `${_this.sid}-keySet`,
      qid: `${_this.qid}-keySet`,
      parent: _this,
    })
    const keyRefSet = _this.getFieldValue('keyRefSet')
    for (const keyRef of keyRefSet) {
      const entryValue = _this.getFieldValue(keyRef)
      if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
        resSet.appendValue(entryValue.field[0])
      }
    }

    return resSet
  }

  /**
   * Map.merge
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static merge(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length < 3) {
      return new UndefinedValue()
    }

    Map.put(fclos, argvalues, state, node, scope)

    return argvalues[1]
  }

  /**
   * Map.put
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static put(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length < 2) {
      return new UndefinedValue()
    }

    const keyRef = getSymbolRef(argvalues[0])
    const keyRefSet = _this.getFieldValue('keyRefSet')
    if (keyRefSet.has(keyRef)) {
      const entryValue = _this.getFieldValue(keyRef)
      if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
        entryValue.field[1] = argvalues[1]
      }
    } else {
      // 否则新增
      const kvPair = new UnionValue({
        sid: 'key-value-pair',
        parent: _this,
      })
      kvPair.appendValue(argvalues[0])
      kvPair.appendValue(argvalues[1])
      _this.setFieldValue(keyRef, kvPair)
    }
    keyRefSet.add(keyRef)

    return argvalues[1]
  }

  /**
   * Map.putAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static putAll(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length === 0) {
      return
    }

    const newMap = argvalues[0]
    if (!newMap || !_.isFunction(newMap.getFieldValue) || !_.isFunction(newMap.getMisc)) {
      return
    }

    const newKeyRefSet = newMap.getFieldValue('keyRefSet')
    if (newKeyRefSet) {
      for (const newKeyRef of newKeyRefSet) {
        const newEntryValue = newMap.getFieldValue(newKeyRef)
        if (Array.isArray(newEntryValue.field) && newEntryValue.field.length === 2) {
          const newArgValues = [newEntryValue.field[0], newEntryValue.field[1]]
          Map.put(fclos, newArgValues, state, node, scope)
        }
      }
    }

    if (!newMap.getMisc('precise')) {
      _this.setMisc('precise', false)
      for (const element of getAllElementFromBuffer(newMap)) {
        addElementToBuffer(_this, element)
      }
      addElementToBuffer(_this, newMap)
    }
  }

  /**
   * Map.putIfAbsent
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static putIfAbsent(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length < 2) {
      return new UndefinedValue()
    }

    const element = Map.get(fclos, argvalues, state, node, scope)
    if (!element || element.vtype === 'undefine') {
      Map.put(fclos, argvalues, state, node, scope)
    }

    return element
  }

  /**
   * Map.remove
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static remove(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length < 1) {
      return new UndefinedValue()
    }

    const keyRef = getSymbolRef(argvalues[0])
    const keyRefSet = _this.getFieldValue('keyRefSet')
    if (!keyRefSet.has(keyRef)) {
      return
    }

    const entryValue = _this.getFieldValue(keyRef)
    if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
      const value = entryValue.field[1]
      if (argvalues.length === 1) {
        keyRefSet.delete(keyRef)
        delete _this.field[keyRef]
        return value
      }
      if (argvalues.length === 2 && value?._qid === argvalues[1]._qid) {
        keyRefSet.delete(keyRef)
        delete _this.field[keyRef]
        return new UndefinedValue()
      }
    }
  }

  /**
   * Map.replace
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static replace(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || !argvalues || argvalues.length < 2) {
      return
    }

    const keyRef = getSymbolRef(argvalues[0])
    const keyRefSet = _this.getFieldValue('keyRefSet')
    if (!keyRefSet.has(keyRef)) {
      return
    }

    const entryValue = _this.getFieldValue(keyRef)
    if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
      const value = entryValue.field[1]
      if (argvalues.length === 2) {
        entryValue.field[1] = argvalues[1]
        return value
      }
      if (argvalues.length === 3 && value?._qid === argvalues[1]._qid) {
        entryValue.field[1] = argvalues[2]
        return new UndefinedValue()
      }
    }
  }

  /**
   * Map.replaceAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static replaceAll(fclos: any, argvalues: any[], state: any, node: any, scope: any) {}

  /**
   * Map.size
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static size(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Map.values
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static values(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }

    const resSet = new UnionValue({
      id: `${_this.id}-valueSet`,
      sid: `${_this.sid}-valueSet`,
      qid: `${_this.qid}-valueSet`,
      parent: _this,
    })
    const keyRefSet = _this.getFieldValue('keyRefSet')
    for (const keyRef of keyRefSet) {
      const entryValue = _this.getFieldValue(keyRef)
      if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
        resSet.appendValue(entryValue.field[1])
      }
    }

    return resSet
  }
}

export = Map
