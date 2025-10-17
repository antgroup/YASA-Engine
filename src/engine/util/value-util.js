const _ = require('lodash')
const loader = require('../../util/loader')

/**
 * replace an analysis value
 * discard non-relevant information
 * @param node
 * @param f
 * @returns {*}
 */
function replaceValue(node, f) {
  if (!node) return

  if (Array.isArray(node)) {
    const res = []
    for (const child of node) {
      res.push(replaceValue(child, f))
    }
    return res
  }
  if (node.type) {
    let res = f[node]
    if (res) return res

    res = { type: node.type }
    for (const child in node) {
      if (child != 'parent' && child != 'rrefs' && child != 'trace' && node.hasOwnProperty(child)) {
        const v = node[child]
        if (v.type || v.vtype || Array.isArray(v)) {
          res[child] = replaceValue(v, f)
        }
      }
    }
    return res
  }
  if (node.vtype) {
    return f(node)
  }
  return node
}

/**
 *
 * @param node
 */
function normalizeVarAccess(node) {
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
    case 'Parameter':
    case 'VariableDeclarator':
      return node
    case 'MemberAccess':
      return {
        type: node.type,
        expression: normalizeVarAccess(node.object),
        property: normalizeVarAccess(node.property),
      }
  }
  switch (node.vtype) {
    case 'object': {
      const { parent } = node
      if (!parent || parent.vtype === 'scope') {
        return node.ast
      }
      return { type: 'MemberAccess', expression: normalizeVarAccess(parent), property: node.ast }
    }
  }
}

/**
 *
 * @param val1
 * @param val2
 * @returns {*}
 */
function isSameAddress(val1, val2) {
  if (val1 === val2) return true
  if (!val1 || !val2) return false

  switch (val1.type) {
    case 'MemberAccess':
      return isSameAddress(val1.expression, val2.expression) && isSameAddress(val1.property, val2.property)
    case 'Identifier':
    case 'Parameter':
      if (val2.type) return val1.name === val2.name
    case 'Literal':
      return val1.value === val2.value
  }
  return false
}

/**
 * compare two values, e.g. two field objects with parents
 * @param val1
 * @param val2
 * @returns {*}
 */
function isSameValue(val1, val2) {
  if (val1 === val2) return true
  if (!val1 || !val2) return false

  switch (val1.type) {
    case 'MemberAccess':
      return isSameValue(val1.expression, val2.expression) && isSameValue(val1.property, val2.property)
    case 'Identifier':
    case 'Parameter':
      if (val2.type) return val1.name === val2.name
    case 'Literal':
      return val1.value === val2.value
    case 'UnaryOperation':
      return val1.operator === val2.operator && isSameValue(val1.subExpression, val2.subExpression)
    case 'BinaryOperation':
      return val1.operator === val2.operator && isSameValue(val1.left, val2.left) && isSameValue(val1.right, val2.right)
    // default:
    //     return false;
  }
  switch (val1.vtype) {
    case 'object':
      if (val1.id !== val2.id) return false
      return isSameValue(val1.parent, val2.parent)
    case 'scope':
      return val1.id === val2.id
  }
  return false
}

/**
 * whether the value is associated with a shared variable
 * @param val
 * @returns {*}
 */
function isFromSharedVar(val) {
  if (!val) return false
  // the case of heap field
  switch (val.vtype) {
    case 'object': {
      const node = val.ast
      if (node) {
        if (node.type === 'VariableDeclaration' && node.isStateVar) return node
      }
      return isFromSharedVar(val.parent)
    }
    case 'union': {
      for (const v of val.value) {
        const res = isFromSharedVar(v)
        if (res) return res
      }
      return
    }
  }
  // the case of symbolic identity
  switch (val.type) {
    case 'MemberAccess':
      return isFromSharedVar(val.expression)
  }
}

/**
 * get value from package manager by qid
 * @param scope
 * @param qid
 */
function getValueFromPackageByQid(scope, qid) {
  if (!qid || !qid.includes('.')) {
    return null
  }

  qid = qid.startsWith('.') ? qid.slice(1) : qid
  const arr = loader.getPackageNameProperties(qid)
  let packageManagerT = scope
  arr.forEach((path) => {
    packageManagerT = packageManagerT?.field[path]
  })

  return packageManagerT
}

// ***

module.exports = {
  replaceValue,
  normalizeVarAccess,

  isSameAddress,
  isSameValue,

  isFromSharedVar,
  getValueFromPackageByQid,

  ValueUtil: require('../analyzer/common/value/constructor'),
  Unit: require('../analyzer/common/value/unit'),
  Scoped: require('../analyzer/common/value/scoped'),
  ObjectValue: require('../analyzer/common/value/object'),
  FunctionValue: require('../analyzer/common/value/function'),
  PrimitiveValue: require('../analyzer/common/value/primitive'),
  SymbolValue: require('../analyzer/common/value/symbolic'),
}
