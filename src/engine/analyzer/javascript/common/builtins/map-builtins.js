const _ = require('lodash')
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
function processMapGet(fclos, argvalues, state, node, scope) {
  const mapObj = fclos.parent
  let res = UndefinedValue()
  if (!argvalues || !Array.isArray(argvalues) || argvalues.length !== 1) return res
  const keyRef = getSymbolRef(argvalues[0])
  const keyRefSet = mapObj.getFieldValue('keyRefSet')
  if (!keyRefSet.has(keyRef)) return res
  const entryValue = mapObj.getFieldValue(keyRef)
  if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
    res = entryValue.field[1] ?? res
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
function processMapSet(fclos, argvalues, state, node, scope) {
  const mapObj = fclos.parent
  if (argvalues && Array.isArray(argvalues) && argvalues.length === 2) {
    const keyRef = getSymbolRef(argvalues[0])
    const keyRefSet = mapObj.getFieldValue('keyRefSet')
    // key 相同时 覆盖
    if (keyRefSet.has(keyRef)) {
      const entryValue = mapObj.getFieldValue(keyRef)
      if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
        entryValue.field[1] = argvalues[1]
      }
    } else {
      // 否则新增
      const kvPair = UnionValue({
        sid: 'key-value-pair',
        parent: mapObj,
      })
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
function processMapDelete(fclos, argvalues, state, node, scope) {
  const mapObj = fclos.parent
  if (!argvalues || !Array.isArray(argvalues) || argvalues.length !== 1) return
  const keyRef = getSymbolRef(argvalues[0])
  const keyRefSet = mapObj.getFieldValue('keyRefSet')
  if (!keyRefSet.has(keyRef)) return
  const entryValue = mapObj.getFieldValue(keyRef)
  if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
    keyRefSet.delete(keyRef)
    delete mapObj.field[keyRef]
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
function processMapClear(fclos, argvalues, state, node, scope) {
  const mapObj = fclos.parent
  const keyRefSet = mapObj.getFieldValue('keyRefSet')
  for (const keyRef of keyRefSet) {
    const entryValue = mapObj.getFieldValue(keyRef)
    if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
      delete mapObj.field[keyRef]
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
function processMapKeys(fclos, argvalues, state, node, scope) {
  const mapObj = fclos.parent
  const resSet = UnionValue({
    id: `${mapObj.id}-keySet`,
    sid: `${mapObj.sid}-keySet`,
    qid: `${mapObj.qid}-keySet`,
    parent: mapObj,
  })
  const keyRefSet = mapObj.getFieldValue('keyRefSet')
  for (const keyRef of keyRefSet) {
    const entryValue = mapObj.getFieldValue(keyRef)
    if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
      resSet.appendValue(entryValue.field[0])
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
function processMapValues(fclos, argvalues, state, node, scope) {
  const mapObj = fclos.parent
  const resSet = UnionValue({
    id: `${mapObj.id}-valueSet`,
    sid: `${mapObj.sid}-valueSet`,
    qid: `${mapObj.qid}-valueSet`,
    parent: mapObj,
  })
  const keyRefSet = mapObj.getFieldValue('keyRefSet')
  for (const keyRef of keyRefSet) {
    const entryValue = mapObj.getFieldValue(keyRef)
    if (Array.isArray(entryValue.field) && entryValue.field.length === 2) {
      resSet.appendValue(entryValue.field[1])
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
function processNewMap(map, argvalues, state, node, scope) {
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
    const entries = argvalues[0]?.field && Object.entries(argvalues[0]?.field)
    // map的初始化
    // 通过数组显示初始化 可能有 ObjectValue符号值
    // 通过其他map初始化 可能有 keyRefSet UnionValue 还有prototype
    if (Array.isArray(entries) && entries.length > 0) {
      for (const entry of entries) {
        // 通过数组显示初始化 可能有 ObjectValue符号值
        const entryValue = Array.isArray(entry) && entry.length === 2 ? entry[1] : null
        if (entryValue == null) continue
        if (typeof entryValue === 'object' && entryValue?.vtype === 'object') {
          // 过滤prototype
          if (entryValue.sid === 'prototype') continue
          const kvPair = Object.values(entryValue.field)
          if (Array.isArray(kvPair) && kvPair.length === 2) {
            const keyRef = getSymbolRef(kvPair[0])
            const kvPairValue = UnionValue({
              sid: 'key-value-pair',
              parent: map,
            })
            kvPairValue.appendValue(kvPair[0])
            kvPairValue.appendValue(kvPair[1])
            const newPairValue = SourceLine.addSrcLineInfo(
              kvPairValue,
              node,
              node.loc && node.loc.sourcefile,
              'Arg Pass: ',
              map.sid
            )
            map.setFieldValue(keyRef, newPairValue)
            keyRefSet.add(keyRef)
          }
        } else if (typeof entryValue === 'object' && entryValue?.vtype === 'union') {
          if (entryValue.field && Object.keys(entryValue.field).length === 2) {
            map.setFieldValue(entry[0], entryValue)
          }
        } else if (entryValue && entryValue instanceof Set && entryValue.size > 0) {
          map.setFieldValue(entry[0], entryValue)
        }
      }
    }
  }
  if (!map.field.hasOwnProperty('keyRefSet')) {
    map.setFieldValue('keyRefSet', keyRefSet)
  }
  return map
}

module.exports = {
  processNewMap,
}
