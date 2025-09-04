const _ = require('lodash')

const config = require('../../../config')
const stateBVT = require('./memStateBVT')
const {
  ValueUtil: { ObjectValue, Scoped, PrimitiveValue, UndefinedValue, UnionValue, SymbolValue },
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

let unionAlgo
{
  switch (config.stateUnionLevel) {
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
 * deep object cloning
 * @param object
 * @param state: e.g. side effects
 * @param state
 * @returns {*}
 */
function cloneObject(object, state) {
  switch (unionAlgo) {
    case UnionAlgorithmOpt.Basic:
      return simpleObjectClone(object)
    case UnionAlgorithmOpt.BVT:
      return stateBVT.cloneScope(object, state)
  }
}

/**
 * entry point of the scope union
 * @param scopes
 * @param states
 * @param brs
 */
function unionValues(scopes, states, brs) {
  switch (unionAlgo) {
    case UnionAlgorithmOpt.BVT:
      stateBVT.unionValues(scopes[0], states[0], brs)
      break
    case UnionAlgorithmOpt.Basic:
    default:
      scopes[0].value = unionScopeValues(scopes[0], scopes[1])
      break
  }
}

/**
 * fork states at branching points
 * @param state
 * @param n
 * @returns {Array}
 */
function forkStates(state, n) {
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

        // lstate.pcond = _.clone(state.pcond);
        // rstate.pcond = _.clone(state.pcond);
        return pair
      }
      if (n === 1) {
        // in case of condition with no false branch
        const res = []
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
      const res = []
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
 * simplify the union expression
 * @param v1
 * @param v2
 * @param reuse
 * @returns {*}
 */
function mk_union(v1, v2, reuse) {
  if (!v1) return v2
  if (!v2) return v1
  if (v1.vtype === 'union') {
    if (v2.vtype === 'union') {
      if (reuse) {
        for (const el of v2.value) {
          if (!v1.value.some((x) => isEqValue(x, el))) v1.value.push(el)
        }
        return v1
      }
      return UnionValue({ value: v1.value.concat(v2.value) })
    }
    if (v1.value.some((x) => isEqValue(x, v2))) return v1

    if (reuse) {
      v1.value.push(v2)
      return v1
    }
    return UnionValue({ value: v1.value.concat([v2]) })
  }
  if (v2.vtype === 'union') {
    if (v2.value.some((x) => isEqValue(x, v1))) return v2

    if (reuse) {
      v2.value.push(v1)
      return v2
    }
    return UnionValue({ value: v2.value.concat([v1]) })
  }
  if (isEqValue(v1, v2)) return v1
  return UnionValue({ value: [v1, v2] })
}

/**
 *
 * @param v1
 * @param v2
 */
function isEqValue(v1, v2) {
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
function loadForkedValue(fvalue, state) {
  if (!fvalue || !state) return fvalue

  switch (fvalue.vtype) {
    case 'BVT': {
      return stateBVT.readValue(fvalue, state.brs, state.br_index)
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
function writeValue(fields, id, value, state, scope) {
  // BVT scheme
  if (state && unionAlgo === UnionAlgorithmOpt.BVT)
    return stateBVT.writeValue(fields, id, value, state.brs, state.br_index, scope)

  // normal processing
  fields[id] = value
}

//* ***************************** local scope union ********************************************

/**
 * limited cloning of a scope/object
 * @param scope
 */
function simpleObjectClone(scope) {
  if (scope.readonly) return scope

  const clone = _.clone(scope)
  switch (clone.vtype) {
    case 'object':
    case 'fclos':
    case 'scope':
      clone.value = _.clone(scope.value)
  }
  return clone
}

/**
 * deep scope of a scope with meta-information sharing
 * @param scope
 * @param filter
 * @param visited
 */
function deepScopeClone(scope, filter, visited) {
  if (scope.readonly) return scope
  if (!filter(scope)) return scope

  const old = visited.get(scope)
  if (old) return old
  const clone = _.clone(scope)
  visited.set(scope, clone)

  switch (clone.vtype) {
    case 'object':
    case 'fclos':
    case 'scope': {
      const res = {}
      for (const field of Object.keys(clone.value)) {
        const val = clone.value[field]
        const v1 = deepScopeClone(val, filter, visited)
        res[field] = v1
        // if (val.parent === scope)     // adjust the parent pointer to the clone
        if (v1 !== clone) v1.parent = clone // Important!!!
        // v1.parent === visited.get(val.parent);    // Important!!!: adjust the parent pointer to the clone
      }
      clone.value = res
    }
  }
  return clone
}

/**
 * limited union of two scopes/objects
 * @param value1
 * @param value2
 * @returns {*}: the union of the two values (with deep cloning)
 */
function unionScopeValues(value1, value2) {
  if (value1 === value2) return value1
  if (value1.value === value2.value) return value1
  const tp1 = value1.vtype
  if (tp1 === 'object' || tp1 === 'fclos' || tp1 === 'scope') {
    const res_value = {}
    const vvalue1 = value1.value
    const vvalue2 = value2.value
    for (const field of Object.keys(vvalue1)) {
      // if (field === 'parent') continue;
      const v1 = vvalue1[field]
      if (vvalue2) {
        const v2 = vvalue2[field]
        if (v2) {
          const new_v = unionPrimitiveValues(v1, v2)
          res_value[field] = new_v
        } else res_value[field] = v1
      } else res_value[field] = v1
    }
    for (const field of Object.keys(vvalue2)) {
      if (!vvalue1[field]) res_value[field] = vvalue2[field]
    }
    return res_value
  }
  return unionPrimitiveValues(value1, value2)
}

/**
 * union two values, merging the value sets when needed
 * @param v1
 * @param v2
 * @returns {*}
 */
function unionPrimitiveValues(v1, v2) {
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
    return { vtype: v1.vtype, value: res }
  }
  if (v2.vtype && Array.isArray(val2)) {
    const res = val2.slice()
    if (!res.includes(v1)) res.push(v1)
    if (res.length >= options.unionValueLimit) return v2
    return { vtype: v2.vtype, value: res }
  }
  return UnionValue({ value: [v1, v2] })
}

//* ***************************** exports ***************************************

module.exports = {
  cloneScope: cloneObject,
  deepScopeClone: (scope, filter) => {
    return deepScopeClone(scope, filter, new Map())
  },
  loadForkedValue,
  writeValue,
  unionValues,
  forkStates,
}
