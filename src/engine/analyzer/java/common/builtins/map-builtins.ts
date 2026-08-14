const _ = require('lodash')
const Collection = require('./collection-builtins')
const { getSymbolRef } = require('../../../../../util/common-util')
const { clearBuffer, addElementToBuffer, getAllElementFromBuffer, removeElementFromBuffer } = require('./buffer')
const { buildNewValueInstance } = require('../../../../../util/clone-util')
const QidUnifyUtil = require('../../../../../util/qid-unify-util')
const AstUtil = require('../../../../../util/ast-util')

import { UnionValue } from '../../../common/value/union'
import { UndefinedValue } from '../../../common/value/undefine'
import { ObjectValue } from '../../../common/value/object'
import type Unit from '../../../common/value/unit'
import type { BaseNode } from '../../../../../types/uast'

type MapValue = Unit & { valueType?: string }
type AnalyzerValue = Unit & {
  logicalQid?: string
  rtype?: { definiteType?: unknown }
  value?: unknown
  getThisObj?: () => AnalyzerValue | undefined
  getFieldValue: (fieldName: string) => AnalyzerValue | undefined
}

function getClassLiteralType(value: AnalyzerValue | undefined): string | undefined {
  if (!value) return undefined
  const thisObj = value.getThisObj?.() ?? value._this
  if (thisObj?.logicalQid && value.logicalQid === 'java.lang.Class') return thisObj.logicalQid
  return undefined
}

function buildValueUnion(mapValue: AnalyzerValue, values: AnalyzerValue[], node: unknown): AnalyzerValue | undefined {
  if (values.length === 0) return undefined
  if (values.length === 1) return values[0]
  const unionValue = new UnionValue(undefined, `${mapValue.sid}-classKeyValue`, `${mapValue.qid}.class-key-value`, node as object | null)
  for (const value of values) unionValue.appendValue(value)
  return unionValue as AnalyzerValue
}

function getClassKeyValue(mapValue: AnalyzerValue, keyRefSet: Set<string>, keyValue: AnalyzerValue, node: unknown): AnalyzerValue | undefined {
  const targetClassType = getClassLiteralType(keyValue)
  const classKeyValues: AnalyzerValue[] = []
  for (const storedKeyRef of keyRefSet) {
    const entryValue = mapValue.getFieldValue(storedKeyRef)
    if (!Array.isArray(entryValue?.value) || entryValue.value.length !== 2) continue
    const storedClassType = getClassLiteralType(entryValue.getFieldValue('0'))
    if (!storedClassType) continue
    const value = entryValue.getFieldValue('1')
    if (!value) continue
    if (targetClassType && storedClassType === targetClassType) return value
    classKeyValues.push(value)
  }
  const keyTypeText = AstUtil.prettyPrint(keyValue.rtype?.definiteType)
  if (!targetClassType && classKeyValues.length > 0 && /(^|\.)Class$/.test(keyTypeText)) {
    return buildValueUnion(mapValue, classKeyValues, node)
  }
  return undefined
}

function getMapValues(mapValue: AnalyzerValue, node: unknown): AnalyzerValue | undefined {
  const keyRefSet = mapValue.getFieldValue('keyRefSet')
  if (!(keyRefSet instanceof Set)) return undefined
  const values: AnalyzerValue[] = []
  for (const storedKeyRef of keyRefSet) {
    const entryValue = mapValue.getFieldValue(storedKeyRef)
    if (Array.isArray(entryValue?.value) && entryValue.value.length === 2) {
      const value = entryValue.getFieldValue('1')
      if (value) values.push(value)
    }
  }
  return buildValueUnion(mapValue, values, node)
}

function valueHasDirectSourceTrace(value: Unit | null | undefined): boolean {
  return !!(value?.taint?.isTainted || (value?.taint?.getTags?.().length ?? 0) > 0)
}

function mergeTraceFromValue(target: Unit | null | undefined, source: Unit | null | undefined): void {
  if (!target?.taint || !source?.taint || !valueHasDirectSourceTrace(source)) return
  target.taint.markSource?.()
  if (typeof target.taint.mergeTracesFrom === 'function') {
    target.taint.mergeTracesFrom(source.taint)
  }
}

function propagateMapReceiverTrace(target: Unit | null | undefined, receiver: Unit | null | undefined): void {
  if (!target || !receiver) return
  // 优先检查容器自身的直接污点（兼容非 precise Map 等路径）
  if (valueHasDirectSourceTrace(receiver)) {
    mergeTraceFromValue(target, receiver)
    return
  }
  // 容器自身未被 markSource，但 buffer 中可能有污点元素（来自 put 的 addElementToBuffer）
  const buf = typeof (receiver as any).getMisc === 'function' ? (receiver as any).getMisc('buffer') : undefined
  if (!Array.isArray(buf)) return
  for (const element of buf) {
    if (valueHasDirectSourceTrace(element)) {
      mergeTraceFromValue(target, element)
      return
    }
  }
}

function buildReceiverSelectedValue(mapValue: MapValue, node: BaseNode | undefined, scope: Unit | undefined): ObjectValue | null {
  // 检查容器直接污点或 buffer 中是否存在污点元素
  const hasTaint = valueHasDirectSourceTrace(mapValue)
  if (!hasTaint) {
    const buf = typeof (mapValue as any).getMisc === 'function' ? (mapValue as any).getMisc('buffer') : undefined
    if (!Array.isArray(buf) || !buf.some((e: any) => valueHasDirectSourceTrace(e))) return null
  }
  const res = new ObjectValue(scope?.qid || mapValue.qid || '', {
    sid: `${mapValue.sid || 'Map'}.get(<unknown>)`,
    qid: `${mapValue.qid || 'Map'}.get(<unknown>)`,
    ast: node,
    parent: mapValue,
    definiteType: mapValue.valueType,
  })
  propagateMapReceiverTrace(res, mapValue)
  return res
}

function getTupleElement(entryValue: AnalyzerValue | undefined, index: 0 | 1): AnalyzerValue | undefined {
  const elementValue = entryValue?.elements?.[index]?.value ?? entryValue?.elements?.get?.(index)
  if (elementValue) return elementValue as AnalyzerValue
  const fieldValue = entryValue?.getFieldValue?.(String(index))
  if (fieldValue && fieldValue !== entryValue?.parent) return fieldValue
  const rawValue = Array.isArray(entryValue?.value) ? entryValue.value[index] : undefined
  return rawValue as AnalyzerValue | undefined
}

function collectMapEntries(mapValue: AnalyzerValue, depth = 0, seen = new Set<AnalyzerValue>()): Array<[AnalyzerValue, AnalyzerValue]> {
  if (!mapValue || depth > 3 || seen.has(mapValue)) return []
  seen.add(mapValue)

  const entries: Array<[AnalyzerValue, AnalyzerValue]> = []
  if (mapValue.vtype === 'union' && Array.isArray(mapValue.value)) {
    for (const branch of mapValue.value as AnalyzerValue[]) {
      entries.push(...collectMapEntries(branch, depth + 1, seen))
    }
    return entries
  }

  const keyRefSet = mapValue.getFieldValue?.('keyRefSet')
  if (keyRefSet instanceof Set) {
    for (const storedKeyRef of keyRefSet) {
      const entryValue = mapValue.getFieldValue(storedKeyRef)
      const key = getTupleElement(entryValue, 0) ?? entryValue?.elements?.[0]
      const value = getTupleElement(entryValue, 1) ?? entryValue?.elements?.[1]
      if (key && value) entries.push([key, value])
    }
  }

  if (typeof mapValue.getMisc === 'function' && mapValue.getMisc('buffer')) {
    for (const element of getAllElementFromBuffer(mapValue)) {
      if (!element) continue
      const nestedEntries = collectMapEntries(element, depth + 1, seen)
      if (nestedEntries.length > 0) entries.push(...nestedEntries)
      else {
        propagateMapReceiverTrace(element, mapValue)
        entries.push([element, element])
      }
    }
  }

  return entries
}

/**
 * Map 容器污点清理：remove/replace 后检查剩余存储值是否还有污点，
 * 若全部干净则清除容器级 buffer 和 taint 标记，避免 FP。
 */
function cleanupContainerTaintIfClean(_this: any): void {
  const keyRefSet = _this.getFieldValue?.('keyRefSet')
  if (!(keyRefSet instanceof Set)) return

  // 遍历所有存储值，若任一仍有污点则保留容器污点
  for (const storedKeyRef of keyRefSet) {
    const entryValue = _this.getFieldValue(storedKeyRef)
    if (!entryValue) continue
    const value = Array.isArray(entryValue.value) && entryValue.value.length === 2
      ? (entryValue.getFieldValue?.('1') ?? entryValue.elements?.[1])
      : entryValue
    if (valueHasDirectSourceTrace(value)) {
      return
    }
  }

  // 所有存储值均干净，清除 buffer（移除 addElementToBuffer 残留的污点元素引用）
  clearBuffer(_this)
}

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
   * Map.compute
   * 语义：remapper.apply(key, oldValue) → newValue；oldValue 可为 null（key 不存在时）。
   * 实现：主动 executeCall(remapper, [key, oldValue]) 让闭包内污点传播；返回值写回 map。
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static compute(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    if (!argvalues || argvalues.length < 2) {
      return new UndefinedValue()
    }
    const remapper = argvalues[1]
    const oldValue = Map.get(fclos, [argvalues[0]], state, node, scope) || new UndefinedValue()
    let remapperResult: any
    if (remapper && _.isFunction((this as any).executeCall)) {
      remapperResult = (this as any).executeCall(node, remapper, state, scope, {
        callArgs: (this as any).buildCallArgs(node, [argvalues[0], oldValue], remapper),
      })
    }
    if (remapperResult && remapperResult.vtype && remapperResult.vtype !== 'undefine') {
      Map.put(fclos, [argvalues[0], remapperResult], state, node, scope)
      return remapperResult
    }
    return oldValue
  }

  /**
   * Map.computeIfAbsent
   * 语义：key 不存在时 mapper.apply(key) → newValue 并写回 map。
   * 实现：over-approximation 总执行 mapper（无论 key 是否真的存在），保证 lambda 内污点传播。
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static computeIfAbsent(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    if (!argvalues || argvalues.length < 2) {
      return new UndefinedValue()
    }
    const mapper = argvalues[1]
    let mapperResult: any
    if (mapper && _.isFunction((this as any).executeCall)) {
      mapperResult = (this as any).executeCall(node, mapper, state, scope, {
        callArgs: (this as any).buildCallArgs(node, [argvalues[0]], mapper),
      })
    }
    if (mapperResult && mapperResult.vtype && mapperResult.vtype !== 'undefine') {
      Map.put(fclos, [argvalues[0], mapperResult], state, node, scope)
      return mapperResult
    }
    return new UndefinedValue()
  }

  /**
   * Map.computeIfPresent
   * 语义：key 存在时 remapper.apply(key, oldValue) → newValue 写回 map。
   * 实现：复用 Map.compute 路径（taint 角度等价；real Java 在 key 不存在时不会调用 remapper，
   * 此处 over-approximation 仍调用以保证污点穿透）。
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static computeIfPresent(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return Map.compute.call(this, fclos, argvalues, state, node, scope)
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
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }
    const callback = argvalues[0]
    if (!callback || callback.vtype !== 'fclos' || typeof (this as any).executeCall !== 'function') {
      return new UndefinedValue()
    }

    const entries = collectMapEntries(_this)
    if (entries.length === 0) entries.push([_this, _this])
    for (const [key, value] of entries) {
      const callArgs = (this as any).buildCallArgs(node, [key, value], callback)
      ;(this as any).executeCall(node, callback, state, scope, {
        callArgs,
      })
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
    let _this = fclos.getThisObj()
    if (_this?.vtype === 'symbol') _this = fclos.parent
    if (!_this || !argvalues || argvalues.length === 0 || _this.vtype === 'primitive') {
      return new UndefinedValue()
    }

    const taintedKeyFallback = () => Map.buildKeySelectedValue(_this, argvalues[0], node, scope)
    const keyRef = getSymbolRef(argvalues[0])
    let keyRefSet = _this.getFieldValue('keyRefSet')
    if (keyRefSet === null || keyRefSet === undefined || keyRefSet.size === 0) {
      keyRefSet = new Set()
      _this.setFieldValue('keyRefSet', keyRefSet)
    }
    let entryValue
    if (keyRefSet.has(keyRef)) {
      entryValue = _this.getFieldValue(keyRef)
    } else {
      const classKeyValue = getClassKeyValue(_this, keyRefSet, argvalues[0], node)
      if (classKeyValue) {
        propagateMapReceiverTrace(classKeyValue, _this)
        return classKeyValue
      }
    }
    if (!entryValue) {
      const dynamicMapValues = getMapValues(_this, node)
      if (dynamicMapValues) {
        propagateMapReceiverTrace(dynamicMapValues, _this)
        return dynamicMapValues
      }
      if (!_this.getMisc('precise')) {
        const fallback = taintedKeyFallback()
        propagateMapReceiverTrace(fallback, _this)
        return fallback || _this
      }
      const fallback = taintedKeyFallback() || buildReceiverSelectedValue(_this, node, scope)
      propagateMapReceiverTrace(fallback, _this)
      return fallback || new UndefinedValue()
    }

    const storedValue = getTupleElement(entryValue, 1) ?? entryValue?.elements?.[1]
    if (storedValue) {
      // 精确 key 命中：直接返回存储值，不扩散容器级污点（保持 key-sensitivity）
      return storedValue
    }

    const fallback = taintedKeyFallback()
    propagateMapReceiverTrace(fallback, _this)
    return fallback
  }

  /**
   * 动态 key 选择未知 value 时，保留 key 对返回值的隐式影响。
   * @param mapValue Map 对象
   * @param keyValue 动态 key
   * @param node 调用节点
   * @param scope 当前作用域
   */
  static buildKeySelectedValue(mapValue: MapValue, keyValue: Unit, node: BaseNode | undefined, scope: Unit | undefined): ObjectValue | null {
    if (!valueHasDirectSourceTrace(keyValue)) {
      return null
    }

    const res = new ObjectValue(scope?.qid || mapValue.qid || '', {
      sid: `${mapValue.sid || 'Map'}.get(${keyValue.sid || '<key>'})`,
      qid: `${mapValue.qid || 'Map'}.get(${keyValue.qid || '<key>'})`,
      ast: node,
      parent: mapValue,
      definiteType: mapValue.valueType,
    })
    res.taint?.markSource()
    addElementToBuffer(res, keyValue)
    if (typeof res.taint?.mergeTracesFrom === 'function') {
      res.taint.mergeTracesFrom(keyValue.taint)
    }
    return res
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
   * 语义：key 存在时 remapper.apply(oldValue, newValue) → mergedValue 写回 map；key 不存在时直接 put(key, newValue)。
   * 实现：put 仍保留；若提供 remapper 且为 fclos，主动 executeCall(remapper, [oldValue, newValue]) 让闭包内污点传播。
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

    const oldValue = Map.get(fclos, [argvalues[0]], state, node, scope) || new UndefinedValue()
    const remapper = argvalues[2]
    let merged: any = argvalues[1]
    if (remapper && _.isFunction((this as any).executeCall)) {
      const res = (this as any).executeCall(node, remapper, state, scope, {
        callArgs: (this as any).buildCallArgs(node, [oldValue, argvalues[1]], remapper),
      })
      if (res && res.vtype && res.vtype !== 'undefine') {
        merged = res
      }
    }

    Map.put(fclos, [argvalues[0], merged], state, node, scope)

    return merged
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
      kvPair.isTuple = true
      kvPair.appendValue(argvalues[0], false, false)
      kvPair.appendValue(argvalues[1], false, false)
      _this.setFieldValue(keyRef, kvPair)
    }
    keyRefSet.add(keyRef)

    // 容器污点传播：put 的 value 有污点时加入 buffer，让 hasTag 深度遍历和 get 路径能追踪
    // 不直接 markSource 容器（避免 EdgeDB 永久记录导致 replace/remove 后无法清除）
    const putValue = argvalues[1]
    if (valueHasDirectSourceTrace(putValue)) {
      const existingBuf = typeof _this.getMisc === 'function' ? _this.getMisc('buffer') : undefined
      const bufLen = Array.isArray(existingBuf) ? existingBuf.length : 0
      if (bufLen < 16) {
        addElementToBuffer(_this, putValue)
      }
    }

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
        // 从 buffer 中移除被删除的 value，再删除 key
        if (value) removeElementFromBuffer(_this, value)
        keyRefSet.delete(keyRef)
        _this.members.delete(keyRef)
        cleanupContainerTaintIfClean(_this)
        return value
      }
      if (
        argvalues.length === 2 &&
        value?.logicalQid ===
          argvalues[1].logicalQid
      ) {
        if (value) removeElementFromBuffer(_this, value)
        keyRefSet.delete(keyRef)
        _this.members.delete(keyRef)
        cleanupContainerTaintIfClean(_this)
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
        // 旧值从 buffer 移除，替换为新值
        if (value) removeElementFromBuffer(_this, value)
        entryValue.setFieldValue('1', argvalues[1])
        // 同步更新 value 数组，避免递归污点检查找到旧值
        if (Array.isArray(entryValue.value)) entryValue.value[1] = argvalues[1]
        // 新值有污点则加入 buffer，否则检查是否可以清除容器污点
        if (valueHasDirectSourceTrace(argvalues[1])) {
          addElementToBuffer(_this, argvalues[1])
        } else {
          cleanupContainerTaintIfClean(_this)
        }
        return value
      }
      if (argvalues.length === 3 && value?.qid === argvalues[1].qid) {
        if (value) removeElementFromBuffer(_this, value)
        entryValue.setFieldValue('1', argvalues[2])
        if (Array.isArray(entryValue.value)) entryValue.value[1] = argvalues[2]
        if (valueHasDirectSourceTrace(argvalues[2])) {
          addElementToBuffer(_this, argvalues[2])
        } else {
          cleanupContainerTaintIfClean(_this)
        }
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
