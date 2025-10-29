const logger = require('./logger')(__filename)
import _ from 'lodash'
import escodegenValueFormatter from 'escodegen'

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
function deepMatch(object: any, match: any): boolean {
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
function shallowCloneScope(scope: any): Record<string, any> {
  const res: Record<string, any> = {}
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
function setFieldValue(scope: any, ids: any, value: any): void {
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
function setFieldValueIfExists(scope: any, ids: any, value: any): void {
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
function resolveForkedValue(value: any): any {
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
function getFieldValue(scope: any, ids: string | string[]): any {
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
function getFieldValueInScopeChain(scope: any, ids: string | string[]): any {
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
function JSON_scope_replacer(key: any, value: any): any {
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
function formatScope(scope: any, delimit?: any): string {
  //		return JSON.stringify(scope, JSON_scope_replacer, 2);
  return JSON.stringify(scope, JSON_scope_replacer, delimit)
}

// for pretty printing
/**
 *
 * @param key
 * @param value
 */
function JSON_scope_replacer2(key: any, value: any): any {
  if (value && value.ast) return value.ast
  return JSON_scope_replacer(key, value)
}

/**
 *
 * @param node
 */
function formatNode(node: any): string {
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
function formatScope2(node: any): string | any {
  try {
    return JSON.stringify(node, JSON_scope_replacer2)
  } catch (e) {
    return node
  }
}

/**
 *
 * @param value
 */
function valueToAST(value: any): any {
  // logger.info('visit: ' + formatScope(value));
  if (!value) return value
  if (value.vtype === 'object') {
    if (value.ast && _.isEmpty(value.value)) {
      return value.ast
    }
    var props: any[] = []
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
    const res: any[] = []
    value.forEach(function (el: any) {
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
      const elements: any[] = []
      value.elements.forEach(function (el: any) {
        elements.push(valueToAST(el))
      })
      return { type: 'ArrayExpression', elements }
    }
    case 'ObjectExpression': {
      var props: any[] = []
      value.properties.forEach(function (property: any) {
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
      const args: any[] = []
      value.arguments.forEach(function (el: any) {
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
function formatValue(value: any): any {
  if (typeof value !== 'object') return value

  let str: any
  try {
    str = valueToAST(value)
    //			logger.info('ASTstr: ' + formatScope(str));
    //			logger.info('ASTstr: ' + JSON.stringify(str));
    if (str.type == 'Literal') return str.value
    str = escodegenValueFormatter.generate(str)
  } catch (e) {
    str = formatScope2(value)
  }
  return str
}

/**
 *
 * @param scope
 */
function printScope(scope: any): void {
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
function printVarScopes(scopes: any): void {
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
function engineValueToJSValue(val: any): any {
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
      const res: Record<string, any> = {}
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

export {
  deepMatch,
  setFieldValue as setField,
  setFieldValueIfExists as setFieldIfExists,
  getFieldValue as getField,
  getFieldValueInScopeChain as getFieldInScopeChain,
  resolveForkedValue as resolveValue,
  printScope,
  printVarScopes,
  JSON_scope_replacer,
  formatScope,
  formatScope2,
  formatNode,
  formatValue,
  valueToAST,
  engineValueToJSValue,
}
