const FunctionValue = require('../../../common/value/function')
const { getDataFromScope } = require('../../../../../util/common-util')

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processVisitArrayBuiltins(this: any, fclos: any, argvalues: any[], state: any, node: any, scope: any): any[] {
  // 拿到foreach的参数 该参数是一个functionvalue
  const forEachHandle = argvalues && argvalues[0]
  // 校验forEachHandle 是一个function value 不是则结束
  if (forEachHandle.vtype !== 'fclos' || !(forEachHandle instanceof FunctionValue)) return []
  const arrObj = fclos.parent
  const arrItems = getDataFromScope(arrObj)
  const resArray = []
  if (forEachHandle && Array.isArray(arrItems) && arrItems.length > 0) {
    for (const arrItem of arrItems) {
      const res = (this as any).executeCall(node, forEachHandle, [arrItem], state, scope)
      resArray.push(res)
    }
  }
  return resArray
}

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processArrayPushBuiltins(fclos: any, argvalues: any[], state: any, node: any, scope: any): void {
  const arrObj = fclos.parent
  // array没有初始化操作，没办法在array初始化的时候设置length的值
  const offset = Object.keys(getDataFromScope(arrObj)).length ?? 0
  if (Array.isArray(argvalues) && argvalues.length > 0) {
    for (let i = 0; i < argvalues.length; i++) {
      const index = (offset + i).toString()
      arrObj.setFieldValue(index, argvalues[i])
    }
  }
}

module.exports = {
  processVisitArray: processVisitArrayBuiltins,
  processArrayPush: processArrayPushBuiltins,
}
