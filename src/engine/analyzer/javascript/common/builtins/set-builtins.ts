const {
  valueUtil: {
    ValueUtil: { ObjectValue: SetObjectValue, PrimitiveValue: SetPrimitiveValue, FunctionValue: SetFunctionValue },
  },
} = require('../../../common')
const { getSymbolRef } = require('../../../../../util/common-util')

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processSetAdd(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
  const setObj = fclos.parent
  const argval = argvalues && argvalues[0]
  if (!argval) return setObj
  const eleRef = getSymbolRef(argval)
  if (!setObj.getFieldValue('curSet').has(eleRef)) {
    setObj.getFieldValue('curSet').add(eleRef)
    setObj.setFieldValue(eleRef, argval)
  }
  return setObj
}

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processSetDelete(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
  const setObj = fclos.parent
  const argval = argvalues && argvalues[0]
  if (!argval) return setObj
  const eleRef = getSymbolRef(argval)
  if (setObj.getFieldValue('curSet').has(eleRef)) {
    setObj.getFieldValue('curSet').delete(eleRef)
    delete setObj.field[eleRef]
  }
  return setObj
}

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processSetClear(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
  const setObj = fclos.parent
  const curSet = setObj.getFieldValue('curSet')
  for (const eleRef of curSet) {
    delete setObj.field[eleRef]
  }
  curSet.clear()
  // setObj.getFieldValue('curSet')?.clear()
  // Object.values(setObj.field)
  //     .filter(ele=>ele && ele?.vtype!=='fclos')
  //     .forEach(ele=>{delete setObj.field[ele.sid]})
  return setObj
}

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processSetKeys(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
  return fclos.parent
}

/**
 *
 * @param set
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processNewSetBuiltins(set: any, argvalues: any[], state: any, node: any, scope: any): any {
  const builtinMap = {
    add: processSetAdd,
    clear: processSetClear,
    delete: processSetDelete,
    keys: processSetKeys,
    values: processSetKeys,
  }
  const { initInnerFunctionBuiltin } = require('../js-initializer')
  initInnerFunctionBuiltin(set, builtinMap, 'Set')

  const curSet = new Set()
  if (Array.isArray(argvalues) && argvalues.length > 0) {
    // 去重添加
    for (const ele of argvalues) {
      const uid = getSymbolRef(ele)
      if (!curSet.has(uid)) {
        curSet.add(uid)
        set.setFieldValue(uid, ele)
      }
    }
  }
  set.setFieldValue('curSet', curSet)
  return set
}

module.exports = {
  processNewSet: processNewSetBuiltins,
}
