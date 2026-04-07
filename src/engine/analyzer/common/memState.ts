const _ = require('lodash')

const Config = require('../../../config')
const StateBVT = require('./memStateBVT')
const { lodashCloneWithTag } = require('../../../util/clone-util')
const {
  ValueUtil: { UnionValue },
} = require('../../util/value-util')

/** ********************* analysis state management ********************** */

/**
 * Control which union algorithm to be used.
 * @type {{Basic: number, BVT: number}}
 */
const UnionAlgorithmOpt = {
  Basic: 1, // a basic one with approximation
  BVT: 2, // an optimized fork-tree based one; supposed to be accurate
}

let unionAlgo: number
{
  switch (Config.stateUnionLevel) {
    case 1:
      unionAlgo = UnionAlgorithmOpt.Basic
      break
    default:
      unionAlgo = UnionAlgorithmOpt.BVT
  }
}

const options = {
  unionValueLimit: 20,
  maxFPRounds: 10,
}

//* *****************************  Interface ********************************************

/**
 * 待删除，新增逻辑不要再用了
 * @param object
 * @param state: e.g. side effects
 * @param state
 * @returns {*}
 */
function cloneObject(object: any, state: any): any {
  switch (unionAlgo) {
    case UnionAlgorithmOpt.Basic:
      return simpleObjectClone(object)
    case UnionAlgorithmOpt.BVT:
      return StateBVT.cloneScope(object, state)
  }
}

/**
 * entry point of the scope union
 * @param scopes
 * @param states
 * @param brs
 */
function unionValuesMemState(scopes: any, states: any, brs: any): void {
  switch (unionAlgo) {
    case UnionAlgorithmOpt.BVT:
      StateBVT.unionValues(scopes[0], states[0], brs)
      break
    case UnionAlgorithmOpt.Basic:
    default:
      scopes[0].value = unionScopeValuesMemState(scopes[0], scopes[1])
      break
  }
}

/**
 * fork states at branching points
 * @param state
 * @param n
 * @returns {Array}
 */
function forkStates(state: any, n: number = 2): any[] {
  if (n === undefined) n = 2
  switch (unionAlgo) {
    case UnionAlgorithmOpt.BVT: {
      if (!state.hasOwnProperty('brs')) break
      if (n === 2) {
        const pair = [_.clone(state), _.clone(state)]
        const lstate = pair[0]
        const rstate = pair[1]
        const { pcond } = state
        if (pcond) {
          lstate.pcond = pcond.slice(0)
          rstate.pcond = pcond.slice(0)
        }
        lstate.brs = `${state.brs}L`
        rstate.brs = `${state.brs}R`
        lstate.parent = state
        rstate.parent = state
        return pair
      }
      if (n === 1) {
        // in case of condition with no false branch
        const res: any[] = []
        const sclone = _.clone(state)
        const { pcond } = state
        if (pcond) {
          sclone.pcond = pcond.slice(0)
          sclone.brs = `${state.brs}T`
        }
        sclone.parent = state
        res.push(sclone)
        return res
      }
      const res: any[] = []
      for (let k = 0; k < n; k++) {
        const sclone = _.clone(state)
        const { pcond } = state
        if (pcond) {
          sclone.pcond = pcond.slice(0)
          sclone.brs = state.brs + k
        }
        sclone.parent = state
        res.push(sclone)
      }
      return res
    }
  }

  // basic cases
  const rstate = _.clone(state)
  rstate.parent = state
  rstate.pcond = _.clone(state.pcond)
  return [state, rstate]
}

//* ***************************** Utility ********************************************

/**
 *
 * @param v1
 * @param v2
 */
function isEqValue(v1: any, v2: any): boolean {
  if (v1 === v2) return true
  if (v1.type === 'Literal') return v1.type === v2.type && v1.value === v2.value
  const vtp1 = v1.vtype
  if (vtp1 === 'fclos' || vtp1 === 'object') {
    if (v2.vtype !== vtp1) return false
    return v1.value === v2.value
  }
  return false
}

//* ***************************** value processing *******************************

/**
 * resolve the branches to locate the right value
 * @param fvalue
 * @param state
 * @returns {*}
 */
function loadForkedValue(fvalue: any, state: any): any {
  if (!fvalue || !state) return fvalue

  switch (fvalue.vtype) {
    case 'BVT': {
      return StateBVT.readValue(fvalue, state.brs, state.br_index)
    }
  }
  return fvalue
}

/**
 *
 * @param fields
 * @param id
 * @param value
 * @param state
 * @param scope
 */
function writeValueMemState(fields: any, id: any, value: any, state: any, scope: any): void {
  // BVT scheme
  if (state && unionAlgo === UnionAlgorithmOpt.BVT)
    return StateBVT.writeValue(fields, id, value, state.brs, state.br_index, scope)

  // normal processing
  fields[id] = value
}

//* ***************************** local scope union ********************************************

/**
 * limited cloning of a scope/object
 * @param scope
 */
function simpleObjectClone(scope: any): any {
  if (scope.runtime?.readonly) return scope

  const clone = lodashCloneWithTag(scope)
  switch (clone.vtype) {
    case 'object':
    case 'fclos':
    case 'scope':
      clone.value = lodashCloneWithTag(scope.value)
  }
  return clone
}

/**
 * limited union of two scopes/objects
 * @param value1
 * @param value2
 * @returns {*}: the union of the two values (with deep cloning)
 */
function unionScopeValuesMemState(value1: any, value2: any): any {
  if (value1 === value2) return value1
  if (value1.value === value2.value) return value1
  const tp1 = value1.vtype
  if (tp1 === 'object' || tp1 === 'fclos' || tp1 === 'scope') {
    const res_value: any = {}
    const vvalue1 = value1.value
    const vvalue2 = value2.value
    for (const field of Object.keys(vvalue1)) {
      // if (field === 'parent') continue;
      const v1 = vvalue1[field]
      if (vvalue2) {
        const v2 = vvalue2[field]
        if (v2) {
          const new_v = unionPrimitiveValuesMemState(v1, v2)
          res_value[field] = new_v
        } else res_value[field] = v1
      } else res_value[field] = v1
    }
    for (const field of Object.keys(vvalue2)) {
      if (!vvalue1[field]) res_value[field] = vvalue2[field]
    }
    return res_value
  }
  return unionPrimitiveValuesMemState(value1, value2)
}

/**
 * union two values, merging the value sets when needed
 * @param v1
 * @param v2
 * @returns {*}
 */
function unionPrimitiveValuesMemState(v1: any, v2: any): any {
  if (!v1) return v2
  if (!v2) return v1
  if (v1 === v2) return v1

  const val1 = v1.value
  const val2 = v2.value
  if (v1.vtype && Array.isArray(val1)) {
    if (val1.length >= options.unionValueLimit) return v1
    const res = val1.slice()
    if (v2.vtype && Array.isArray(val2)) {
      for (const v2_el of val2) {
        if (!res.includes(v2_el)) res.push(v2_el)
        if (res.length >= options.unionValueLimit)
          return {
            vtype: v1.vtype,
            value: res,
          }
      }
    } else if (!res.includes(v2)) res.push(v2)
    if (v1.vtype === 'union') {
      return new UnionValue(res, undefined, `${v1.qid}.<union@ms>`, v1.ast?.node)
    }
    return { vtype: v1.vtype, value: res }
  }
  if (v2.vtype && Array.isArray(val2)) {
    const res = val2.slice()
    if (!res.includes(v1)) res.push(v1)
    if (res.length >= options.unionValueLimit) return v2
    if (v2.vtype === 'union') {
      return new UnionValue(res, undefined, `${v2.qid}.<union@ms>`, v2.ast?.node)
    }
    return { vtype: v2.vtype, value: res }
  }
  return new UnionValue([v1, v2], undefined, `${v1.qid}.<union@ms>`, v1.ast?.node)
}

//* ***************************** exports ***************************************

module.exports = {
  cloneScope: cloneObject,
  loadForkedValue,
  writeValue: writeValueMemState,
  unionValues: unionValuesMemState,
  forkStates,
  unionScopeValues: unionScopeValuesMemState,
}
