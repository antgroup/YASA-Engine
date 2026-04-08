const {
  valueUtil: {
    ValueUtil: { UndefinedValue, UnionValue },
  },
} = require('../../../common')
const { getSymbolRef } = require('../../../../../util/common-util')
const SourceLine = require('../../../common/source-line')

// map的set建模3个核心点
// mapObj的field里既要包含keyvalue(argvalues[0]) 也要包含value符号值(argvalues[1])
// mapObj 需要包含keyvalue和value符号值之间的映射关系
// 在特定情况下要支持覆盖(污点清除)
// key为基本数据类型时 内容一致则会覆盖
// key为引用类型时，地址一致才覆盖

// 注意字符串
// let obj1 = 'obj' let obj2 = 'obj'
//  和 let obj1 = new String('obj')  let obj2 = new String('obj')
// 前者会覆盖，后者不会覆盖

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processMapGet(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
  const mapObj = fclos.parent
  let res = new UndefinedValue()
  if (!argvalues || !Array.isArray(argvalues) || argvalues.length !== 1) return res
  const keyRef = getSymbolRef(argvalues[0])
  const keyRefSet = mapObj.getFieldValue('keyRefSet')
  if (!keyRefSet.has(keyRef)) return res
  const entryValue = mapObj.getFieldValue(keyRef)
  if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
    res = entryValue.getFieldValue('1') ?? res
  }
  return res
}

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 * @returns {*}
 */
function processMapSet(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
  const mapObj = fclos.parent
  if (argvalues && Array.isArray(argvalues) && argvalues.length === 2) {
    const keyRef = getSymbolRef(argvalues[0])
    const keyRefSet = mapObj.getFieldValue('keyRefSet')
    // key 相同时 覆盖
    if (keyRefSet.has(keyRef)) {
      const entryValue = mapObj.getFieldValue(keyRef)
      if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
        entryValue.setFieldValue('1', argvalues[1])
      }
    } else {
      // 否则新增
      const kvPair = new UnionValue(undefined, 'map-key-value-pair', `${mapObj.qid}.<map-kvp:${keyRef}>`, node)
      kvPair.parent = mapObj
      kvPair.appendValue(argvalues[0])
      kvPair.appendValue(argvalues[1])
      mapObj.setFieldValue(keyRef, kvPair)
    }
    keyRefSet.add(keyRef)
  }
  return mapObj
}

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processMapDelete(fclos: any, argvalues: any[], state: any, node: any, scope: any): void {
  const mapObj = fclos.parent
  if (!argvalues || !Array.isArray(argvalues) || argvalues.length !== 1) return
  const keyRef = getSymbolRef(argvalues[0])
  const keyRefSet = mapObj.getFieldValue('keyRefSet')
  if (!keyRefSet.has(keyRef)) return
  const entryValue = mapObj.getFieldValue(keyRef)
  if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
    keyRefSet.delete(keyRef)
    mapObj.members.delete(keyRef)
  }
}

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processMapClear(fclos: any, argvalues: any[], state: any, node: any, scope: any): void {
  const mapObj = fclos.parent
  const keyRefSet = mapObj.getFieldValue('keyRefSet')
  for (const keyRef of keyRefSet) {
    const entryValue = mapObj.getFieldValue(keyRef)
    if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
      mapObj.members.delete(keyRef)
    }
  }
  keyRefSet.clear()
}

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processMapKeys(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
  const mapObj = fclos.parent
  const resSet = new UnionValue(undefined, `${mapObj.sid}-keySet`, `${mapObj.qid}-keySet`, node)
  resSet.parent = mapObj
  const keyRefSet = mapObj.getFieldValue('keyRefSet')
  for (const keyRef of keyRefSet) {
    const entryValue = mapObj.getFieldValue(keyRef)
    if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
      resSet.appendValue(entryValue.getFieldValue('0'))
    }
  }
  return resSet
}

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processMapValues(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
  const mapObj = fclos.parent
  const resSet = new UnionValue(undefined, `${mapObj.sid}-valueSet`, `${mapObj.qid}-valueSet`, node)
  resSet.parent = mapObj
  const keyRefSet = mapObj.getFieldValue('keyRefSet')
  for (const keyRef of keyRefSet) {
    const entryValue = mapObj.getFieldValue(keyRef)
    if (Array.isArray(entryValue.value) && entryValue.value.length === 2) {
      resSet.appendValue(entryValue.getFieldValue('1'))
    }
  }
  return resSet
}

/**
 * @param map
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 * @returns {*}
 */

/**
 *
 * @param map
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processNewMapBuiltins(map: any, argvalues: any[], state: any, node: any, scope: any): any {
  const builtinMap = {
    get: processMapGet,
    set: processMapSet,
    delete: processMapDelete,
    clear: processMapClear,
    keys: processMapKeys,
    values: processMapValues,
  }
  const { initInnerFunctionBuiltin } = require('../js-initializer')
  initInnerFunctionBuiltin(map, builtinMap, 'Map')

  const keyRefSet = new Set()
  // 有参数初始化map
  if (Array.isArray(argvalues) && argvalues.length > 0) {
    const entries = argvalues[0]?.members && [...argvalues[0].members.entries()]
    // map的初始化
    // 通过数组显示初始化 可能有 ObjectValue符号值
    // 通过其他map初始化 可能有 keyRefSet UnionValue 还有prototype
    if (Array.isArray(entries) && entries.length > 0) {
      for (const entry of entries) {
        // 通过数组显示初始化 可能有 ObjectValue符号值
        const entryValue = Array.isArray(entry) && entry.length === 2 ? entry[1] : null
        if (entryValue == null) continue
        if (typeof entryValue === 'object' && (entryValue as any)?.vtype === 'object') {
          // 过滤prototype
          if ((entryValue as any).sid === 'prototype') continue
          const kvPair = [...(entryValue as any).members.values()]
          if (Array.isArray(kvPair) && kvPair.length === 2) {
            const keyRef = getSymbolRef(kvPair[0])
            const kvPairValue = new UnionValue(undefined, 'map-key-value-pair', `${map.qid}.map-kvp.${keyRef}`, node)
            kvPairValue.parent = map
            kvPairValue.appendValue(kvPair[0])
            kvPairValue.appendValue(kvPair[1])
            const newPairValue = SourceLine.addSrcLineInfo(
              kvPairValue,
              node,
              node.loc && node.loc.sourcefile,
              'ARG PASS: ',
              map.sid
            )
            map.setFieldValue(keyRef, newPairValue)
            keyRefSet.add(keyRef)
          }
        } else if (typeof entryValue === 'object' && (entryValue as any)?.vtype === 'union') {
          if ((entryValue as any).value && (entryValue as any).value.length === 2) {
            map.setFieldValue(entry[0], entryValue)
          }
        } else if (entryValue && entryValue instanceof Set && entryValue.size > 0) {
          map.setFieldValue(entry[0], entryValue)
        }
      }
    }
  }
  if (!map.members.has('keyRefSet')) {
    map.setFieldValue('keyRefSet', keyRefSet)
  }
  return map
}

module.exports = {
  processNewMap: processNewMapBuiltins,
}
