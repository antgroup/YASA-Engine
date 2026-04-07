const _ = require('lodash')
const Collection = require('./collection-builtins')
const { getSymbolRef } = require('../../../../../util/common-util')
const { clearBuffer, addElementToBuffer, getAllElementFromBuffer } = require('./buffer')
const { buildNewValueInstance } = require('../../../../../util/clone-util')
const QidUnifyUtil = require('../../../../../util/qid-unify-util')

import { UnionValue } from '../../../common/value/union'
import { UndefinedValue } from '../../../common/value/undefine'

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
      return new UndefinedValue()
    }

    let keyRefSet = _this.getFieldValue('keyRefSet')
    if (keyRefSet === null || keyRefSet === undefined || keyRefSet.size === 0) {
      keyRefSet = new Set()
      _this.setFieldValue('keyRefSet', keyRefSet)
    }
    for (const keyRef of keyRefSet) {
      const entryValue = _this.getFieldValue(keyRef)
      if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
        _this.members.delete(keyRef)
      }
    }
    keyRefSet.clear()

    if (!_this.getMisc('precise')) {
      clearBuffer(_this)
    }

    return new UndefinedValue()
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
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    const newThis = buildNewValueInstance(
      this,
      _this,
      node,
      scope,
      () => {
        return false
      },
      (v: any) => {
        return !v
      }
    )
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
  static forEach(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    const keyRefSet = _this.getFieldValue('keyRefSet')
    if (keyRefSet instanceof Set) {
      for (const keyRef of keyRefSet) {
        const entryValue = _this.getFieldValue(keyRef)
        if (entryValue && Array.isArray(entryValue.value) && entryValue.value.length === 2) {
          ;(this as any).executeCall(node, argvalues[0], state, scope, { callArgs: (this as any).buildCallArgs(node, [entryValue.getFieldValue('0'), entryValue.getFieldValue('1')], argvalues[0]) })
        }
      }
    } else {
      ;(this as any).executeCall(node, argvalues[0], state, scope, { callArgs: (this as any).buildCallArgs(node, [_this, _this], argvalues[0]) })
    }

    return new UndefinedValue()
  }

  /**
   * Map.get
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static get(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0 || _this.vtype === 'primitive') {
      return new UndefinedValue()
    }

    const keyRef = getSymbolRef(argvalues[0])
    let keyRefSet = _this.getFieldValue('keyRefSet')
    if (keyRefSet === null || keyRefSet === undefined || keyRefSet.size === 0) {
      keyRefSet = new Set()
      _this.setFieldValue('keyRefSet', keyRefSet)
    }
    if (!keyRefSet.has(keyRef)) {
      if (!_this.getMisc('precise')) {
        return _this
      }
      return new UndefinedValue()
    }

    const entryValue = _this.getFieldValue(keyRef)
    if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
      return entryValue.getFieldValue('1')
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
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }

    const resSet = new UnionValue(undefined, `${_this.sid}-keySet`, `${_this.qid}-keySet`, node)
    resSet.parent = _this
    let keyRefSet = _this.getFieldValue('keyRefSet')
    if (keyRefSet === null || keyRefSet === undefined || keyRefSet.size === 0) {
      keyRefSet = new Set()
      _this.setFieldValue('keyRefSet', keyRefSet)
    }
    for (const keyRef of keyRefSet) {
      const entryValue = _this.getFieldValue(keyRef)
      if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
        resSet.appendValue(entryValue.getFieldValue('0'))
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
    const _this = fclos.getThisObj()
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
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length < 2) {
      return new UndefinedValue()
    }

    const keyRef = getSymbolRef(argvalues[0])
    let keyRefSet = _this.getFieldValue('keyRefSet')
    if (keyRefSet === null || keyRefSet === undefined || keyRefSet.size === 0) {
      keyRefSet = new Set()
      _this.setFieldValue('keyRefSet', keyRefSet)
    }
    if (keyRefSet.has(keyRef)) {
      const entryValue = _this.getFieldValue(keyRef)
      try {
        if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
          entryValue.setFieldValue('1', argvalues[1])
        }
      } catch (e) {
        // key覆盖失败，忽略
      }
    } else {
      // 否则新增
      const kvPair = new UnionValue(undefined, 'map-key-value-pair', `${_this.qid}.map-kvp.${keyRef}`, node)
      kvPair.parent = _this
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
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    const newMap = argvalues[0]
    if (!newMap || !_.isFunction(newMap.getFieldValue) || !_.isFunction(newMap.getMisc)) {
      _this.setMisc('precise', false)
      addElementToBuffer(_this, newMap)
      return new UndefinedValue()
    }

    const newKeyRefSet = newMap.getFieldValue('keyRefSet')
    if (newKeyRefSet) {
      for (const newKeyRef of newKeyRefSet) {
        const newEntryValue = newMap.getFieldValue(newKeyRef)
        if (Array.isArray(newEntryValue.value) && newEntryValue.value.length === 2) {
          const newArgValues = [newEntryValue.getFieldValue('0'), newEntryValue.getFieldValue('1')]
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

    return new UndefinedValue()
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
    const _this = fclos.getThisObj()
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
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length < 1) {
      return new UndefinedValue()
    }

    const keyRef = getSymbolRef(argvalues[0])
    let keyRefSet = _this.getFieldValue('keyRefSet')
    if (keyRefSet === null || keyRefSet === undefined || keyRefSet.size === 0) {
      keyRefSet = new Set()
      _this.setFieldValue('keyRefSet', keyRefSet)
    }
    if (!keyRefSet.has(keyRef)) {
      return new UndefinedValue()
    }

    const entryValue = _this.getFieldValue(keyRef)
    if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
      const value = entryValue.getFieldValue('1')
      if (argvalues.length === 1) {
        keyRefSet.delete(keyRef)
        _this.members.delete(keyRef)
        return value
      }
      if (
        argvalues.length === 2 &&
        value?.logicalQid ===
          argvalues[1].logicalQid
      ) {
        keyRefSet.delete(keyRef)
        _this.members.delete(keyRef)
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
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length < 2) {
      return new UndefinedValue()
    }

    const keyRef = getSymbolRef(argvalues[0])
    let keyRefSet = _this.getFieldValue('keyRefSet')
    if (keyRefSet === null || keyRefSet === undefined || keyRefSet.size === 0) {
      keyRefSet = new Set()
      _this.setFieldValue('keyRefSet', keyRefSet)
    }
    if (!keyRefSet.has(keyRef)) {
      return new UndefinedValue()
    }

    const entryValue = _this.getFieldValue(keyRef)
    if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
      const value = entryValue.getFieldValue('1')
      if (argvalues.length === 2) {
        entryValue.setFieldValue('1', argvalues[1])
        return value
      }
      if (argvalues.length === 3 && value?.qid === argvalues[1].qid) {
        entryValue.setFieldValue('1', argvalues[2])
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
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }

    const resSet = new UnionValue(undefined, `${_this.sid}-valueSet`, `${_this.qid}-valueSet`, node)
    resSet.parent = _this
    let keyRefSet = _this.getFieldValue('keyRefSet')
    if (keyRefSet === null || keyRefSet === undefined || keyRefSet.size === 0) {
      keyRefSet = new Set()
      _this.setFieldValue('keyRefSet', keyRefSet)
    }
    for (const keyRef of keyRefSet) {
      const entryValue = _this.getFieldValue(keyRef)
      if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
        resSet.appendValue(entryValue.getFieldValue('1'))
      }
    }

    return resSet
  }
}

export = Map
