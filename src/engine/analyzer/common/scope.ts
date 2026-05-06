const _ = require('lodash')
const { lodashCloneWithTag } = require('../../../util/clone-util')

const QidUnifyUtil = require('../../../util/qid-unify-util')
const config = require('../../../config')
const {
  ValueUtil: { FunctionValue, Scoped, ClassValue, SymbolValue, UninitializedValue },
} = require('../../util/value-util')
const { addSrcLineInfo } = require('./source-line')
const ASTUtil = require('../../../util/ast-util')

import type Unit from './value/unit'
import { AstRefList } from './value/ast-ref-list'
import { TaintRecord } from './value/taint-record'

//* *****************************  Scope Management ********************************************

/**
 *
 */
class Scope {
  static createSubScope(name: any, scope: Unit, scopeName: string, qid?: string): Unit {
    let id = name
    if (!id) {
      id = '_scope'
    }
    if (scope.value[id]) {
      return scope.value[id]
    }
    // scopeName='class' 时使用 ClassValue，其余用 Scoped
    const subscope = scopeName === 'class'
      ? new ClassValue(scope.qid, id, scope)
      : new Scoped(scope.qid, {
          sid: id,
          vtype: scopeName || 'scope',
          decls: {},
          parent: scope,
        })
    if (qid) {
      subscope._qid = qid
      subscope.uuid = null
      subscope.calculateAndRegisterUUID()
    }
    if (scope) {
      scope.value[id] = subscope
    }
    return subscope
  }

  static getDefScopeRec(scope: Unit, node: any, limit: number): Unit | undefined {
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
          if (fields.hasOwnProperty(node_name)) return scope
        }
        if (scope.ast && scope.ast.hasDecl(node_name))
          return scope
        if (scope.parent && scope.parent !== scope) {
          return this.getDefScopeRec(scope.parent, node, limit - 1)
        }
        return undefined
      }
      case 'ThisExpression': {
        return scope.getThisObj()
      }
    }
  }

  static getDefScope(scope: Unit, node: any): Unit | undefined {
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

  getDefScope(scope: Unit, node: any): Unit | undefined {
    const res = Scope.getDefScope(scope, node)
    return res ?? scope
  }

  createIdentifierFieldValue(identifier: any, scope: Unit): Unit {
    let index
    if (identifier.type === 'Identifier') {
      index = identifier.name
    } else if (identifier.type === 'SuperExpression') {
      index = 'super'
    } else {
      index = identifier.value.toString()
    }

    const scopeId = scope.getQualifiedId()
    const qid = Scope.joinQualifiedName(scopeId, index)
    let subscope = new SymbolValue('', {
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
    if (scope._taint?.isTaintedRec) {
      subscope.taint?.markSource()
      subscope._taint = scope._taint._clone(subscope)
      if (scope._taint.hasTraces()) {
        subscope = addSrcLineInfo(subscope, identifier, identifier.loc?.sourcefile, 'Field: ', index)
      }
    }

    if (scope.members) {
      scope.members.set(index, subscope)
    }
    return subscope
  }

  createVarDeclarationScope(decl: any, scope: Unit): Unit {
    const id = decl.name

    const sid = typeof id === 'string' ? id : ASTUtil.prettyPrint(id)
    const subscope = new UninitializedValue(scope.qid, sid, decl)
    subscope.parent = scope // refer to the parent scope
    // link to the parent scope
    scope.value[id] = subscope
    return subscope
  }

  createFuncScope(node: any, scope: Unit): Unit {
    // new version uses keyword 'constructor' to refer to ctor, this will cause node.name being null
    // so  tweak name to _CTOR_ to facilitate following evaluating
    let funcName =
      node.id?.name ||
      `<anonymousFunc_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>` // <anonymous_[line]_[column]> for anonymous function
    if (node._meta.isConstructor) {
      funcName = '_CTOR_'
    }
    let fclos =
      Object.prototype.hasOwnProperty.call(scope.value, funcName) && scope.value[funcName]?.vtype === 'fclos'
        ? scope.value[funcName]
        : undefined
    // do not override ctor
    if (fclos && node.parameters) {
      // overloaded functions
      // if fclos is from the super, override it
      let cdef = fclos.ast.fdef && fclos.ast.fdef.parent
      while (cdef) {
        if (cdef.type === 'ClassDefinition') {
          break
        }
        cdef = cdef.parent
      }
      if (cdef && cdef.name !== scope.sid) {
        const targetQid = `${scope.qid}.${funcName}`
        fclos = new FunctionValue('', {
          overloaded: [node],
          sid: funcName,
          qid: targetQid,
          decls: {},
          func: { superDef: fclos.ast.fdef },
          parent: scope,
          ast: node,
        })
        fclos.ast.fdef = node
        scope.value[funcName] = fclos
        if (targetQid) {
          let current: Unit | null = scope
          while (current) {
            if (current.sid === '<global>') {
              break
            }
            current = current.parent
          }
          if (current) current.context.funcs[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)] = fclos
        }
        return fclos
      }

      const len = Array.isArray(node.parameters) ? node.parameters.length : node.parameters.parameters.length
      const parametersType = this.getParameterType(node)
      let matched = false
      if (funcName === '_CTOR_') {
        if (!fclos.overloaded) {
          fclos.overloaded = new AstRefList(() => fclos.getASTManager())
        }
        fclos.overloaded.push(node)
        return fclos
      }

      for (let k = 0; k < (fclos.overloaded?.length ?? 0); k++) {
        const resolved = fclos.overloaded!.get(k)
        if (!resolved) continue
        const param = resolved.parameters
        const overloadedLen = Array.isArray(param) ? param.length : param.parameters.length
        const overloadedParametersType = this.getParameterType(resolved)
        if (overloadedLen === len) {
          let typeMatch = true
          for (let i = 0; i < overloadedLen; i++) {
            if (parametersType[i] !== overloadedParametersType[i]) {
              typeMatch = false
              break
            }
          }
          if (typeMatch) {
            fclos.overloaded!.set(k, node)
            matched = true
            break
          }
        }
      }
      if (!matched) {
        if (!fclos.overloaded) {
          fclos.overloaded = new AstRefList(() => fclos.getASTManager())
        }
        fclos.overloaded.push(node)
      }
      fclos = lodashCloneWithTag(fclos)
      fclos.ast = node
      fclos.ast.fdef = node
      fclos.vtype = 'fclos'
    } else {
      const sid =
        funcName ||
        `<anonymousFunc_${node?.loc?.start?.line}_${node?.loc?.start?.column}_${node?.loc?.end?.line}_${node?.loc?.end?.column}>`
      const targetQid = `${scope.qid}.${sid}`
      fclos = new FunctionValue('', {
        overloaded: [node],
        sid,
        qid: targetQid,
        decls: {},
        parent: scope,
        ast: node,
      })
      fclos.ast.fdef = node
      if (targetQid && (this as any).funcSymbolTable && typeof (this as any).funcSymbolTable === 'object') {
        ;(this as any).funcSymbolTable[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)] = fclos
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

  formatScope(scope: Unit, delimit: number): string {
    //		return JSON.stringify(scope, JSON_scope_replacer_scope, 2);
    return ((cache = []), JSON.stringify(scope, JSON_scope_replacer_scope, delimit))
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
