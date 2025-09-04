const _ = require('lodash')
const Scope = require('./scope')
const Config = require('../../../config')
const {
  ValueUtil: { ObjectValue, PrimitiveValue },
} = require('../../util/value-util')
const { cloneWithDepth } = require('../../../util/clone-util')

/**
 * get the constructor function
 * @param fdef
 * @param fbody
 * @param fname
 * @returns {*}
 */
function getConstructor(fbody, fname) {
  /**
   *
   * @param obj
   */
  function isIterable(obj) {
    // checks for null and undefined
    if (obj == null) {
      return false
    }
    return typeof obj[Symbol.iterator] === 'function'
  }

  let fconstructor
  fbody = isIterable(fbody) ? fbody : fbody.body
  if (!fbody) return
  for (const nd of fbody) {
    if (nd.type === 'FunctionDefinition') {
      if (nd._meta.isConstructor) {
        fconstructor = nd
        break
      }
    }
  }

  return fconstructor
}

/**
 * Reset / reinit global variables.
 * Particularly, reset the the line trace
 * @param node
 * @param res
 * @param scope
 */
function resetInitVariables(scope) {
  for (const field of Object.keys(scope.value)) {
    const v = scope.value[field]
    if (v.trace) delete v.trace
  }
}

/**
 * hovac shared variables for TOD checks
 * @param scope
 * @param node
 * @param should_taint
 * @param source_fdef
 * @returns {{vtype: string, id: *, value: {}, ast: null, parent: *}}
 */
function initVarScope(scope, node, should_taint, source_fdef) {
  if (!node) return

  switch (node.type) {
    case 'MemberAccess': {
      const subscope = initVarScope(scope, node.object, false, source_fdef)
      if (subscope) {
        return initVarScope(subscope, node.property, should_taint, source_fdef)
      }
      break
    }
    case 'Identifier':
    case 'Parameter':
    case 'VariableDeclarator':
    case 'Literal': {
      let obj
      const index = node.id?.name || node.name || node.value
      if (index) {
        obj = scope.value[index]
      }
      if (!obj || !_.isObject(obj)) obj = Scope.createIdentifierFieldValue(node, scope)

      if (should_taint) {
        obj.taint = new Set()
        obj.taint.add('TOD')
        obj.hasTagRec = true
        if (!obj.hasOwnProperty('source_fdef')) {
          obj.source_fdef = new Set()
        }

        if (obj.source_fdef.size < 10)
          // be defensive
          obj.source_fdef.add(source_fdef)
        if (node.loc) obj.trace = [{ line: node.loc.start.line, node }]
      }
      return obj
    }
  }
}

/**
 * Havocing the values of shared variables by assigning them unknown values
 * Specifically, delete the existing values
 * @param scope
 */
function havocSharedVariables(scope) {
  const { writes } = scope.fdata
  if (!writes) return
  for (const entry of writes.entries()) {
    const fdef = entry[0]
    const fwrites = entry[1]
    for (const wr of fwrites) {
      // find a valid access: x.y....
      let expr = wr
      let last = wr
      while (expr && expr.type === 'MemberAccess' && expr.property) {
        switch (expr.property.type) {
          case 'Identifier':
          case 'Parameter':
          case 'VariableDeclarator':
          case 'Literal': {
            break
          }
          default:
            last = expr
        }
        expr = expr.expression
      }

      // initialize the scope
      initVarScope(scope, last, true, fdef)
    }
  }
}

/**
 * process class inheritance
 * @param fclos
 */
function resolveClassInheritance(fclos) {
  const { fdef } = fclos
  const { supers } = fdef
  if (!supers || supers.length === 0) return

  const scope = fclos.parent

  for (const i in supers) {
    if (supers[i]) {
      _resolveClassInheritance(fclos, supers[i].name)
    }
  }

  /**
   *
   * @param fclos
   * @param base_name
   */
  function _resolveClassInheritance(fclos, base_name) {
    const base_fclos = scope.value[base_name]
    if (!base_fclos) return
    fclos.super = base_fclos

    // inherit definitions
    // superValue is used to record values of super class, so that we can handle cases like super.xxx() or super()
    const superValue = fclos.value.super || Scope.createSubScope('super', fclos, 'fclos')
    // super's parent should be assigned to base, _this will track on fclos
    superValue.parent = base_fclos
    for (const fieldName in base_fclos.value) {
      if (fieldName === 'super') continue
      const v = base_fclos.value[fieldName]
      if (v.readonly) continue
      const v_copy = cloneWithDepth(v)
      v_copy.inherited = true
      v_copy._this = fclos
      fclos.value[fieldName] = v_copy

      superValue.value[fieldName] = v_copy
      // super fclos should fill its fdef with ctor definition
      if (fieldName === '_CTOR_') {
        superValue.fdef = v_copy.fdef
        superValue.overloaded = superValue.overloaded || []
        superValue.overloaded.push(fdef)
      }

      // v_copy.parent = fclos;  // Important!
    }

    // inherit declarations
    for (const x in base_fclos.decls) {
      const v = base_fclos.decls[x]
      fclos.decls[x] = v
    }
    // inherit modifiers
    for (const x in base_fclos.modifier) {
      const v = base_fclos.modifier[x]
      fclos.modifier[x] = v
    }
    // inherit initialized variables
    if (base_fclos.inits) {
      for (const x of base_fclos.inits) {
        fclos.inits.add(x)
      }
    }
    // inherit the fdata
    if (base_fclos.fdata) {
      if (!fclos.fdata) fclos.fdata = {}
      for (const x in base_fclos.fdata) {
        fclos.fdata[x] = base_fclos.fdata[x]
      }
    }
  }
}

// ***

module.exports = {
  getConstructor,
  resolveClassInheritance,
  resetInitVariables,
  havocSharedVariables,
}
