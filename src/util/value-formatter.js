const logger = require('./logger')(__filename)

// const logger = console; // require('../util/logger')(__filename);
// const _ = require('lodash');

// ***

// const printFieldFilters = ['id', 'name', 'value', 'type', 'operator', 'left', 'right', 'elements',
//    'argument', 'callee', 'arguments', 'object', 'params', 'property',
//    'ast', 'taint', 'info', 'trace', 'pscope', 'modifiers', 'code', '_this'];

//* ***************************** other utilities ********************************************

/**
 *
 * @param object
 * @param match
 */
function deepMatch(object, match) {
  if (object === match) return true
  if (typeof object !== typeof match) return false
  if (typeof object === 'object') {
    if (Array.isArray(object)) {
      if (!Array.isArray(match)) return false
      if (object.length !== match.length) return false
      var isMatch = true
      for (var i = 0; i < match.length; i++) {
        if (!deepMatch(object[i], match[i])) {
          isMatch = false
          break
        }
      }
      return isMatch
    }
    const objKeys = Object.keys(match)
    var isMatch = true
    for (var i = 0; i < objKeys.length; i++) {
      const prop = objKeys[i]
      if (prop === 'loc' || prop === 'info') continue
      if (!deepMatch(object[prop], match[prop])) {
        isMatch = false
        break
      }
    }
    return isMatch
  }
  return object === match
}

/**
 *
 * @param scope
 */
function shallowCloneScope(scope) {
  const res = {}
  for (const field in scope) {
    res[field] = scope[field]
  }
  return res
}

/**
 * set the id's value in a scope; the id "x.y.z" is of format [x, y, z]
 * @param scope
 * @param ids
 * @param value: the value to be assigned
 * @param value
 */
function setFieldValue(scope, ids, value) {
  let scp = scope
  for (let i = 0; i < ids.length - 1; i++) {
    const field = ids[i]
    const scp1 = scp.value[field]
    if (!scp1) scp.value[field] = { value: {} }
    scp = scp.value[field]
  }
  scp.value[ids[ids.length - 1]] = value
}

/**
 * set the value only if the first id can be found in the scope chain
 * @param scope
 * @param ids
 * @param value
 */
function setFieldValueIfExists(scope, ids, value) {
  const first = ids[0]
  let right_scope = scope
  while (right_scope && !_.has(right_scope.value, first)) right_scope = right_scope.parent
  if (right_scope) setFieldValue(right_scope, ids, value)
}

/// **
// * resolve specific internal values
// * @param val
// */
// function resolveValue(value) {
//    if (!value) return value;
//    if (value.vtype === 'fork') {
//        const okey = value.okey;
//        if (okey) {
//            const v = value.value[okey];
//            if (v) return v;
//        }
//    }
//    return value;
// }

/**
 * resolve specific internal values
 * @param val
 * @param value
 */
function resolveForkedValue(value) {
  if (!value) return value
  if (value.vtype === 'fork') {
    let tnode = value.btree
    value = value.value
    while (tnode) {
      const okey = tnode.index
      if (value.hasOwnProperty(okey)) return value[okey]
      tnode = tnode.parent
    }
  }
  return value
}

/**
 * obtain the id's value in a scope; the id "x.y.z" is of format [x, y, z]
 * @param scope
 * @param ids
 * @returns {*}
 */
function getFieldValue(scope, ids) {
  if (!scope || !scope.value || !ids) return
  if (!Array.isArray(ids)) {
    ids = ids.split('.')
  }
  const fieldIds = ids
  const end = ids.length - 1
  let scp = scope
  for (let i = 0; i < end; i++) {
    scp = scp.value[fieldIds[i]]
    if (!scp) return
  }
  if (!scp.value) return
  const res = scp.value[fieldIds[end]]
  return resolveForkedValue(res)
}

/**
 * get the value only if the first id can be found in the scope chain
 * @param scope
 * @param ids
 */
function getFieldValueInScopeChain(scope, ids) {
  if (!Array.isArray(ids)) {
    ids = ids.split('.')
  }
  const first = ids[0]
  let right_scope = scope
  while (right_scope && right_scope.value && !_.has(right_scope.value, first)) right_scope = right_scope.parent
  if (right_scope) return getFieldValue(right_scope, ids)
}

//* ***************************** for Debugging ********************************************

// for pretty printing
/**
 *
 * @param key
 * @param value
 */
function JSON_scope_replacer(key, value) {
  if (
    key === 'parent' ||
    key === 'pscope' ||
    key === 'loc' ||
    key === 'body' ||
    key === 'defaults' ||
    key === 'generator' ||
    key === 'sourcefile' ||
    key === 'modifiers' ||
    key === 'code' ||
    key === '_this' ||
    key === 'astparent' ||
    key === 'trace' ||
    key === 'ast' ||
    key === 'decl_scope' ||
    key === 'rrefs' ||
    key === 'extra'
  ) {
    return undefined
  }
  if (key === 'cdef') {
    return `{${value.fqdn}}`
  }
  if (value) {
    if (value.type === 'Literal') return value.raw
    if (value.type === 'Identifier') return `<${value.name}>`
    //			else if (value.type === 'MemberExpression') {
    //				var obj = formatScope(value.object);
    //				var prop = formatScope(value.property);
    //				return obj.replace('\"','') + '[' + prop.replace('\"','') + ']';
    //			}
  }
  return value
}

// for debugging
/**
 *
 * @param scope
 * @param delimit
 */
function formatScope(scope, delimit) {
  //		return JSON.stringify(scope, JSON_scope_replacer, 2);
  return JSON.stringify(scope, JSON_scope_replacer, delimit)
}

// for pretty printing
/**
 *
 * @param key
 * @param value
 */
function JSON_scope_replacer2(key, value) {
  if (value && value.ast) return value.ast
  return JSON_scope_replacer(key, value)
}

/**
 *
 * @param node
 */
function formatNode(node) {
  try {
    return JSON.stringify(node, JSON_scope_replacer)
  } catch (e) {
    return '{...}'
  }
}

/**
 *
 * @param node
 */
function formatScope2(node) {
  try {
    JSON.stringify(node, JSON_scope_replacer2)
  } catch (e) {
    return node
  }
}

/**
 *
 * @param value
 */
function valueToAST(value) {
  // logger.info('visit: ' + formatScope(value));
  if (!value) return value
  if (value.vtype === 'object') {
    if (value.ast && _.isEmpty(value.value)) {
      return value.ast
    }
    var props = []
    for (const field in value.value) {
      const prop = {
        type: 'Property',
        key: { type: 'Literal', value: field, raw: field },
        value: valueToAST(value.value[field]),
      }
      props.push(prop)
    }
    return { type: 'ObjectExpression', properties: props }
  }
  if (value.vtype === 'fclos') {
    if (value.fdef) return value.fdef
  } else if (value.vtype === 'union') {
    return value
  } else if (Array.isArray(value)) {
    const res = []
    value.forEach(function (el) {
      res.push(valueToAST(el))
    })
    return { type: 'ArrayExpression', elements: res }
  }

  if (!value.type) return value
  switch (value.type) {
    case 'Literal':
    case 'Identifier':
    case 'ThisExpression':
    case 'FunctionDeclaration':
      return value
    case 'MemberAccess': {
      return {
        type: 'MemberAccess',
        expression: valueToAST(value.expression),
        property: valueToAST(value.property),
      }
    }
    case 'ArrayExpression': {
      const elements = []
      value.elements.forEach(function (el) {
        elements.push(valueToAst(el))
      })
      return { type: 'ArrayExpression', elements }
    }
    case 'ObjectExpression': {
      var props = []
      value.properties.forEach(function (property) {
        const name = property.key.type == 'Literal' ? property.key.value : property.key.name
        const prop = { type: 'Property', key: property.key, value: valueToAST(property.value) }
        props.push(prop)
      })
      return { type: 'ObjectExpression', properties: props }
    }
    case 'UnaryOperation':
      return {
        type: value.type,
        operator: value.operator,
        prefix: value.prefix,
        argument: valueToAST(value.argument),
      }
    case 'BinaryOperation':
    case 'AssignmentExpression':
      return {
        type: value.type,
        operator: value.operator,
        left: valueToAST(value.left),
        right: valueToAST(value.right),
      }
    case 'Conditional':
      return {
        type: value.type,
        test: valueToAST(value.test),
        alternate: valueToAST(value.alternate),
        consequent: valueToAST(value.consequent),
      }
    case 'NewExpression':
    case 'CallExpression': {
      const args = []
      value.arguments.forEach(function (el) {
        args.push(valueToAST(el))
      })
      return { type: value.type, callee: valueToAST(value.callee), arguments: args }
    }
    default:
      if (logger.isTraceEnabled()) logger.trace(`warning: valueToAST: unkown exp ${formatNode(value)}`)
  }
  return value
}

/**
 *
 * @param value
 */
function formatValue(value) {
  if (typeof value !== 'object') return value

  let str
  try {
    str = valueToAST(value)
    //			logger.info('ASTstr: ' + formatScope(str));
    //			logger.info('ASTstr: ' + JSON.stringify(str));
    if (str.type == 'Literal') return str.value
    str = escodegen.generate(str)
  } catch (e) {
    str = formatScope2(value)
  }
  return str
}

/**
 *
 * @param scope
 */
function printScope(scope) {
  if (scope.id) logger.info(`----------------------${scope.id}---------------------------`)
  const { value } = scope
  if (scope.ast) logger.info(`-- ast: ${scope.ast}${scope.taint ? ' (tainted)' : ''}`)
  logger.info('-- value: ')
  logger.info(formatScope(value, 2))
}

/**
 *
 * @param scopes
 */
function printVarScopes(scopes) {
  logger.info('*************************** VAR SCOPES ***************************')
  if (scopes && Array.isArray(scopes)) {
    scopes.forEach(printScope)
  }
  logger.info('*************************** VAR SCOPES END ***********************')
}

//* ***************************** value format conversion ******************************

/**
 * convert engine internal data into javascript format
 * @param val
 * @returns {*}
 */
function engineValueToJSValue(val) {
  if (typeof val !== 'object') return val
  if (Array.isArray(val)) {
    return val.map(engineValueToJSValue)
  }
  switch (val.type) {
    case 'Literal':
      return val.value
  }
  switch (val.vtype) {
    case 'object': {
      const res = {}
      for (const v in val.value) {
        res[v] = engineValueToJSValue(val.value[v])
      }
      return res
    }
    case 'fclos': {
      return val.fdef
    }
    case 'union': {
      return {
        vtype: 'union',
        value: engineValueToJSValue(val),
      }
    }
  }
  return val
}

//* ***************************** exports ********************************************

exports.deepMatch = deepMatch

exports.setField = setFieldValue
exports.setFieldIfExists = setFieldValueIfExists
exports.getField = getFieldValue
exports.getFieldInScopeChain = getFieldValueInScopeChain
exports.resolveValue = resolveForkedValue

exports.printScope = printScope
exports.printVarScopes = printVarScopes
exports.JSON_scope_replacer = JSON_scope_replacer

exports.formatScope = formatScope
exports.formatScope2 = formatScope2
exports.formatNode = formatNode
exports.formatValue = formatValue

exports.valueToAST = valueToAST
exports.engineValueToJSValue = engineValueToJSValue
