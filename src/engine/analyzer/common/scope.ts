const _ = require('lodash')
const config = require('../../../config')
const {
  ValueUtil: { FunctionValue, Scoped, SymbolValue, UninitializedValue },
} = require('../../util/value-util')
const { addSrcLineInfo } = require('./source-line')

//* *****************************  Scope Management ********************************************

/**
 *
 */
class Scope {
  /**
   * create a sub-scope within the given scope
   * @param name
   * @param scope
   * @param scopeName
   * @returns {{id: string, vtype: string, value: {}, parent: *}}
   */
  static createSubScope(name: any, scope: any, scopeName: any): any {
    let id = name
    if (!id) {
      id = '_scope'
    }
    if (scope.value[id]) {
      return scope.value[id]
    }
    const subscope = Scoped({
      sid: id,
      qid: scope.qid ? `${scope.qid}.${id}` : id,
      vtype: scopeName || 'scope',
      decls: {},
      parent: scope,
    })
    if (scope) {
      scope.value[id] = subscope
    }
    return subscope
  }

  /**
   * search the scope where the variable is defined
   * @param scope
   * @param node
   * @param limit
   * @returns {*}
   */
  static getDefScopeRec(scope: any, node: any, limit: any): any {
    if (!node || !limit) {
      return scope
    }
    switch (node.type) {
      case 'MemberAccess':
        return this.getDefScopeRec(scope, node.object, limit - 1)
      case 'Literal':
      case 'Identifier':
      case 'SuperExpression': {
        let node_name
        if (node.type === 'Literal') {
          node_name = node.value
        } else if (node.type === 'SuperExpression') {
          node_name = 'super'
        } else {
          node_name = node.name
        }
        const fields = scope.value
        if (fields) {
          const f = fields.hasOwnProperty
          if (f.vtype || f.type) return fields[node_name]
          if (fields.hasOwnProperty(node_name))
            // fields.__proto__.hasOwnProperty(fields, node.name)
            return scope
        }
        // // 如果当前 fields 没有匹配，递归检查 fields 的内容
        // for (let key in fields) {
        //   if (fields.hasOwnProperty(key) && typeof fields[key] === 'object') {
        //     // 对每个 field 递归调用
        //     let fieldScope = this.getDefScopeRec(fields[key], node, limit - 1)
        //     if (fieldScope) {
        //       return fieldScope
        //     }
        //   }
        // }
        if (scope.decls && typeof scope.decls.hasOwnProperty === 'function' && scope.decls.hasOwnProperty(node_name))
          return scope
        if (scope.parent && scope.parent !== scope) {
          return this.getDefScopeRec(scope.parent, node, limit - 1)
        }
        return undefined
      }
      case 'ThisExpression': {
        return scope.getThis()
      }
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param limit
   */
  getDefScopeRec(scope: any, node: any, limit: any): any {
    return Scope.getDefScopeRec(scope, node, limit)
  }

  /**
   * search the scope where the variable is defined
   * return scope itself if def scope is not found
   * @param scope
   * @param node
   * @returns {*}
   */
  static getDefScope(scope: any, node: any): any {
    const defScope = this.getDefScopeRec(scope, node, 20)
    if (defScope) return defScope
    // if (![ 'object' ].some(vtype => scope.vtype === vtype)) {
    //     while (scope) {
    //         defScope = scope.parent || scope;
    //         scope = scope.parent;
    //     }
    // }
    return defScope ?? scope
  }

  /**
   *
   * @param scope
   * @param node
   */
  getDefScope(scope: any, node: any): any {
    const res = Scope.getDefScope(scope, node)
    return res ?? scope
  }

  /**
   * create a field value for an unknown variable
   * @param identifier
   * @param scope
   * @returns {{vtype: string, id: *, value: {}, ast: null, parent: *}}
   */
  createIdentifierFieldValue(identifier: any, scope: any): any {
    const index =
      identifier.type === 'Identifier' || identifier.type === 'SuperExpression'
        ? identifier.name
        : identifier.value.toString()
    const scopeId = scope.getQualifiedId()
    const qid = Scope.joinQualifiedName(scopeId, index)
    let subscope = SymbolValue({
      sid: index,
      qid,
      ast: identifier,
      ...identifier,
      parent: scope,
    })

    if (config.language === 'js') {
      if (index === 'prototype') {
        subscope.value = scope.value
      }
    }
    // if (scope.vtype != 'scope')
    //     subscope.parent = scope;
    // // record type information
    // type.recordType(identifier, subscope, scope);
    if (scope.hasTagRec) {
      subscope.hasTagRec = true
      subscope._tags = scope._tags
      if (scope.trace) {
        subscope.trace = _.clone(scope.trace)
        subscope = addSrcLineInfo(subscope, identifier, identifier.loc?.sourcefile, 'Field: ', index)
      }
    }

    // link to the parent scope
    scope.field[index] = subscope
    return subscope
  }

  /**
   *
   * @param decl
   * @param scope
   * @returns {{vtype: string, id: *, value: {}, ast: null, parent: *}}
   */
  createVarDeclarationScope(decl: any, scope: any): any {
    const id = decl.name

    const subscope = UninitializedValue({
      id,
      qid: id,
      ast: decl,
      sort: decl.typeName,
      parent: scope, // refer to the parent scope
    })
    // link to the parent scope
    scope.value[id] = subscope
    return subscope
  }

  /**
   * create a function closure
   * @param node
   * @param scope
   * @returns {{vtype: string, fdef: *, id: (*|string), value: {}, decls: {}, parent: *}}
   */
  createFuncScope(node: any, scope: any): any {
    // new version uses keyword 'constructor' to refer to ctor, this will cause node.name being null
    // so  tweak name to _CTOR_ to facilitate following evaluating
    let funcName = node.id?.name || `<anonymous_${node.loc?.start.line}_${node.loc?.start.column}>` // <anonymous_[line]_[column]> for anonymous function
    if (node._meta.isConstructor) {
      funcName = '_CTOR_'
    }
    let fclos = Object.prototype.hasOwnProperty.call(scope.value, funcName) ? scope.value[funcName] : undefined
    // do not override ctor
    if (fclos && node.parameters) {
      // overloaded functions
      // if fclos is from the super, override it
      let cdef = fclos.fdef && fclos.fdef.parent
      while (cdef) {
        if (cdef.type === 'ClassDefinition') {
          break
        }
        cdef = cdef.parent
      }
      if (cdef && cdef.name !== scope.id) {
        const targetQid = scope.qid ? `${scope.qid}.${funcName}` : undefined
        fclos = FunctionValue({
          fdef: node, // record the function definition including its type and prototype information
          overloaded: [node],
          sid: funcName,
          qid: targetQid,
          decls: {},
          superDef: fclos.fdef,
          parent: scope,
          ast: node,
        })
        scope.value[funcName] = fclos
        if (targetQid) {
          let current = scope
          while (current) {
            if (current.sid === '<global>') {
              break
            }
            current = current.parent
          }
          current.funcSymbolTable[targetQid] = fclos
        }
        return fclos
      }

      const len = Array.isArray(node.parameters) ? node.parameters.length : node.parameters.parameters.length
      const parametersType = this.getParameterType(node)
      let matched = false
      if (!fclos.overloaded) fclos.overloaded = []

      if (funcName === '_CTOR_') {
        fclos.overloaded.push(node)
        return fclos
      }

      for (let k = 0; k < fclos.overloaded.length; k++) {
        const param = fclos.overloaded[k].parameters
        const overloadedLen = Array.isArray(param) ? param.length : param.parameters.length
        const overloadedParametersType = this.getParameterType(fclos.overloaded[k])
        if (overloadedLen === len) {
          let typeMatch = true
          for (let i = 0; i < overloadedLen; i++) {
            if (parametersType[i] !== overloadedParametersType[i]) {
              typeMatch = false
              break
            }
          }
          if (typeMatch) {
            fclos.overloaded[k] = node
            matched = true
            break
          }
        }
      }
      if (!matched) {
        fclos.overloaded.push(node)
      }
      fclos = _.clone(fclos)
      fclos.fdef = node
      fclos.ast = node
      fclos.vtype = 'fclos'
    } else {
      const targetQid = scope.qid && funcName ? `${scope.qid}.${funcName}` : undefined
      fclos = FunctionValue({
        fdef: node, // record the function definition including its type and prototype information
        overloaded: [node],
        sid: funcName || '<anonymous>',
        qid: targetQid,
        decls: {},
        parent: scope,
        ast: node,
      })
      if (targetQid && (this as any).funcSymbolTable && typeof (this as any).funcSymbolTable === 'object') {
        ;(this as any).funcSymbolTable[targetQid] = fclos
      }
      // 检查 scope 和 scope.value 的有效性
      if (typeof scope === 'object') {
        if (typeof scope.value === 'object' && scope.value !== undefined && scope.value !== null) {
          // 检查 funcName 是否为一个有效的字符串
          if (typeof funcName === 'string' && funcName !== '') {
            scope.value[funcName] = fclos
          }
        }
      }
    }
    return fclos
  }

  /**
   * 获取param的参数类型
   * @param node
   */
  getParameterType(node: any): string[] {
    const len = Array.isArray(node.parameters) ? node.parameters.length : node.parameters.parameters.length
    const parametersType: any[] = []

    if (len > 0) {
      for (const p of node.parameters) {
        if (p.type === 'VariableDeclaration' && p.varType?.id?.type === 'Identifier') {
          parametersType.push(p.varType.id.name)
        }
      }
    }
    return parametersType
  }

  /**
   * for debugging
   * @param scope
   * @param delimit
   * @returns {string}
   */
  formatScope(scope: any, delimit: any): string {
    //		return JSON.stringify(scope, JSON_scope_replacer_scope, 2);
    return (cache = []), JSON.stringify(scope, JSON_scope_replacer_scope, delimit)
  }

  /**
   *
   * @param {...any} args
   */
  static joinQualifiedName(...args: any[]): string {
    let res = ''
    if (!args) return res
    if (args.length === 1) return args[0]
    let separator = ''
    for (const i in args) {
      if (typeof args[i] !== 'string') continue
      const arg = args[i]?.trim()
      if (arg) {
        res += separator + arg
        separator = '.'
      }
    }
    return res
  }
}

let cache: any[] = []

/**
 * for pretty printing
 * @param key
 * @param value
 * @returns {*}
 * @constructor
 */
function JSON_scope_replacer_scope(key: any, value: any): any {
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
    key === 'decl_scope'
  ) {
    return undefined
  }
  if (key === 'cdef') {
    return `{${value.name}}`
  }
  if (value) {
    if (value.type === 'Literal') return value.raw
    if (value.type === 'Identifier') return `<${value.name}>`
    //			else if (value.type === 'MemberExpression') {
    //				var obj = formatScope(value.object);
    //				var prop = formatScope(value.property);
    //				return obj.replace('\"','') + '[' + prop.replace('\"','') + ']';
    //			}
    if (typeof value === 'object') {
      if (cache.includes(value)) {
        return undefined
      }
      cache.push(value)
    }
    return value
  }

  return value
}

// ***
module.exports = Scope
