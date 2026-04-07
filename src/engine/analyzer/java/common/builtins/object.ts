const _ = require('lodash')
const {
  ValueUtil: { UndefinedValue },
  getValueFromPackageByQid,
} = require('../../../../util/value-util')
const { buildNewValueInstance } = require('../../../../../util/clone-util')
/**
 * newInstance
 * @param analyzer
 * @param packageManager
 * @param type
 * @returns {*}
 */
function newInstance(analyzer: any, packageManager: any, type: string, node?: any) {
  if (!packageManager || !type) {
    return undefined
  }

  const classVal = getValueFromPackageByQid(packageManager, type)
  if (!classVal) {
    return new UndefinedValue()
  }
  const obj = buildNewValueInstance(
    analyzer,
    classVal,
    node || null,
    classVal.parent,
    (x: any) => {
      return false
    },
    (v: any) => {
      return !v
    }
  )
  if (obj.members.get('_CTOR_') && _.isFunction(analyzer?.initState) && _.isFunction(analyzer?.processAndCallFuncDef)) {
    const state = analyzer.initState(obj)
    analyzer.processAndCallFuncDef(obj, obj.members.get('_CTOR_')!.ast?.node, obj.members.get('_CTOR_')!, state)
  }
  return obj
}

module.exports = {
  newInstance,
}
