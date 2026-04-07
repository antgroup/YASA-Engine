const _ = require('lodash')
const logger = require('../../../util/logger')(__filename)
const memState = require('./memState')
const Scope = require('./scope')
const symAddress = require('./sym-address')
const { Errors } = require('../../../util/error-code')
const {
  ValueUtil: { UndefinedValue, ObjectValue, PrimitiveValue, UnionValue, SymbolValue, MemberExprValue, IdentifierRefValue },
  Unit,
} = require('../../util/value-util')
const AstUtil = require('../../../util/ast-util')
const varUtil = require('../../../util/variable-util')
const { handleException } = require('./exception-handler')

import type UnitType from './value/unit'
type FilterFn = ((scope: UnitType) => boolean) | null

// ***
/**
 *
 */
class MemSpace extends Scope {
  /**
   *
   * @param unit
   * @param ids
   * @param createIfNotExists
   */
  getFieldValue(unit: any, ids: any, createIfNotExists?: boolean): UnitType | null {
    if (!unit) {
      return null
    }

    if (!(unit instanceof Unit)) {
      unit = new ObjectValue('', { sid: '<wrapped_object>', ...unit })
    }

    return unit.getFieldValue(ids, createIfNotExists)
  }

  /**
   *
   * @param unit
   * @param ids
   */
  getFieldValueIfNotExists(unit: any, ids: any): UnitType | null {
    return this.getFieldValue(unit, ids, true)
  }

  /**
   * calculate the indices of an object access; resolve non-atomic expressions
   * for instance, expression A[x][y] will be converted into A[v1][v2] where v1 and v2 are values of x and y respectively
   * need to calculate the index value upon the current scope
   * @param scope
   * @param node
   * @param state
   * @returns {*}
   */
  resolveIndices(scope: UnitType, node: any, state: any): any {
    if (!node) return node
    // 针对error类型特别适配
    if (node?.rtype?.type === 'Identifier' && node?.rtype?.name === 'error') {
      return node
    }

    if (typeof node === 'string') node = new IdentifierRefValue(scope.qid, node, null, null)

    if (node.type === 'MemberAccess') {
      let index: any
      let prop: any
      if (!node.computed) {
        prop = index = node.property
      } else if (node.type === 'Literal') {
        prop = index = node.property
      } else {
        const prop = node.property
        index = this.processInstruction(scope, prop, state)
        if (!index) index = new SymbolValue(scope.qid, { sid: `<indice_process_prop_failed>`, ...prop })
      }
      const object = this.resolveIndices(scope, node.object, state)
      if (object === node.object && index === prop) return node
      return new MemberExprValue(object.qid, object, index, node.computed, node, node.loc)
    }
    if (node.type === 'Identifier' || node.type === 'Parameter') {
      return new SymbolValue(scope.qid, { sid: `<indice_${node.name}>`, ...node })
    }
    if (node.type === 'Literal') {
      return new SymbolValue(scope.qid, { sid: `<indice_${node.value}>`, ...node })
    }
    if (node.type === 'ThisExpression') {
      return new SymbolValue(scope.qid, {
        sid: `<indice_thisExpression_${node.loc.start?.line}_${node.loc.start?.column}_${node.loc.end?.line}_${node.loc.end?.column}>`,
        ...node,
      })
    }
    if (node.type === 'SuperExpression') {
      return new SymbolValue(scope.qid, {
        sid: `<indice_superExpression_${node.loc.start?.line}_${node.loc.start?.column}_${node.loc.end?.line}_${node.loc.end?.column}>`,
        ...node,
      })
    }
    if (node.vtype === 'union') {
      const res: UnitType[] = []
      let values = node.value
      if (values && !Array.isArray(values)) {
        values = Object.values(values)
      }
      if (Array.isArray(values)) {
        for (const el of values) {
          const v = this.resolveIndices(scope, el, state)
          if (v) res.push(v)
        }
      }
      return new UnionValue(res, undefined, `${scope.qid}.<union@idx:${node.loc?.start?.line}:${node.loc?.start?.column}>`, node.ast?.node)
    }
    // for Parameter and Return Parameter
    if (node.type === 'VariableDeclaration') {
      return new SymbolValue(scope.qid, {
        sid: `<indice_${node.id?.name}>`,
        type: 'Parameter',
        name: node.id?.name,
        ast: node,
      })
    }
    if (node.type === 'DereferenceExpression') {
      return new SymbolValue(scope.qid, {
        sid: `<indice_DereferenceExpression_${node.loc.start?.line}_${node.loc.start?.column}_${node.loc.end?.line}_${node.loc.end?.column}>`,
        ...node.argument,
      })
    }
    return this.processInstruction(scope, node, state)
  }

  /**
   * read the value of a variable from the scope
   * by default, create if value is not existing
   * @param scope
   * @param node  node value, this may not be raw uast node, uast node | symbol val | string
   * @param state
   * @param filter specify the scope to skip
   * @returns {{type, object, property}|*}
   */
  getMemberValue(scope: UnitType, node: any, state: any, filter: FilterFn = null): any {
    return this._getMemberValue(scope, node, state, true, undefined, filter, false)
  }

  /**
   * read the value of a variable from the scope
   * value will not be created if not existing
   * @param scope
   * @param node  node value, this should not be raw uast node
   * @param state
   * @param limit
   * @returns {{type, object, property}|*}
   */
  getMemberValueNoCreate(scope: UnitType, node: any, state: any, limit?: number): any {
    return this._getMemberValue(scope, node, state, false, limit, undefined, false)
  }

  /**
   * read the value of a variable from the current scope only
   * value will be created if not existing
   * @param scope
   * @param node
   * @param state
   * @param filter
   * @returns {{type, object, property}|*}
   */
  getMemberValueInCurrentScope(scope: UnitType, node: any, state: any, filter: FilterFn = null): any {
    return this._getMemberValue(scope, node, state, true, undefined, filter, true)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   * @param createIfNotExists
   * @param limit
   * @param filter
   */
  _getMemberValue(
    scope: any,
    node: any,
    state: any,
    createIfNotExists: boolean,
    limit?: number,
    filter?: FilterFn,
    currentScopeOnly?: boolean
  ): any {
    if (typeof node === 'string') {
      return this._getMemberValue(
        scope,
        AstUtil.qualifiedNameToMemberAccess(node),
        state,
        createIfNotExists,
        limit,
        filter,
        currentScopeOnly
      )
    }
    if (filter && filter(scope)) return new UndefinedValue()

    let defscope = scope
    if (scope.vtype === 'union') {
      if (!limit) limit = 30
      const res = new UnionValue(undefined, undefined, `${scope.qid}.<union@mem:${node?.loc?.start?.line}:${node?.loc?.start?.column}>`, node)
      let values = scope.value
      if (values && !Array.isArray(scope.value)) {
        values = Object.values(scope.value)
      }
      for (const scp of values) {
        if (scp && limit > 0) {
          res.appendValue(this._getMemberValue(scp, node, state, createIfNotExists, limit--, filter))
        }
      }
      return res
    }
    // 如果scope.vtype是object 则传入的scope就是当前obj的defscope 直接从scope中取值即可
    if (!['object', 'symbol', 'undefine', 'uninitialized'].includes(scope.vtype)) {
      // find the scope defining this object (e.g. for obj.x)
      if (!currentScopeOnly) {
        defscope = this.getDefScope(scope, node)
      }
    }

    if (state?.brs) state.br_index = 0
    const res = this._getMemberValueRec(defscope, node, state, createIfNotExists)
    if (res && res.type === 'MemberAccess') {
      if (res.object) {
        // res.object 可能非 Unit，先检查 taint 存在
        const isTainted = res.object.taint ? res.object.taint.isTainted : false
        if (isTainted) res.taint?.propagateFrom(res.object)
      }
    }
    return res
  }

  /**
   * get the value of a variable or a field within a scope (may chase the parent scopes)
   * the recursive version
   * @param scope
   * @param node
   * @param state
   * @param createIfNotExists
   * @returns {*}
   */
  _getMemberValueRec(scope: any, node: any, state: any, createIfNotExists: boolean): any {
    // if (DEBUG) logger.info('\nGet value: ' + formatNode(node) + ' in ' + Scope.formatScope(scope));
    if (!node) return node // FIXME: check oldAST

    if (node.vtype === 'union') {
      // value union
      const res = new UnionValue(undefined, undefined, `${scope.qid}.<union@memR:${node.qid}>`, node.ast?.node)
      for (const el of node.value) {
        const val = this._getMemberValueRec(scope, el, state, createIfNotExists)
        if (val) res.appendValue(val)
      }
      return res
    }

    switch (node.type) {
      case 'MemberAccess': {
        const { object } = node
        let subscope: any
        if (!object) return node
        if (object.type === 'Identifier' || object.type === 'MemberAccess') {
          subscope = this._getMemberValueRec(scope, object, state, createIfNotExists)
        } else if (object.type === 'Literal' || Array.isArray(object))
          // the object part is already resolved
          subscope = object
        else {
          subscope = this._getMemberValueRec(scope, object, state, createIfNotExists)
        }
        if (!subscope) {
          // subscope = this.getMemberValueRec(scope, object, state);
          return
        }

        subscope.value = subscope.value || {}

        const prop = node.property
        // record the read references
        // if (res && subscope.rrefs)
        //     subscope.rrefs.push(res);
        // else
        //     subscope.rrefs = [res];
        // if (res)
        //     res.dsrc = { scope: subscope, property: prop };

        return this._getMemberValueDirect(subscope, prop, state, createIfNotExists, 0, new Set())
      }

      case 'Literal':
      case 'Identifier':
        return this._getMemberValueDirect(scope, node, state, createIfNotExists, 0, new Set())
      case 'ThisExpression':
        return this._getMemberValueDirect(this.thisFClos, node, state, createIfNotExists, 0, new Set())
      case 'SuperExpression':
        return this._getMemberValueDirect(this.thisFClos, node, state, createIfNotExists, 0, new Set())
      default:
        return this._getMemberValueDirect(scope, node, state, createIfNotExists, 0, new Set())
    }
  }

  //* ***************************** Write Operations *************************************

  /**
   * write the value of a variable into the scope; search the right scope when neccessary
   * @param scope
   * @param node: AST node
   * @param value: value to be stored
   * @param state: extra analysis data
   * @param node
   * @param value
   * @param state
   * @param oldVal
   * @returns {*}
   */
  saveVarInScope(scope: UnitType, node: any, value: UnitType, state: any, oldVal: UnitType | null = null): any {
    if (!value.rtype && oldVal && oldVal.rtype) value.rtype = oldVal.rtype
    const resolvedNode = this.resolveIndices(scope, node, state)

    const defscope = this.getDefScope(scope, node)

    if (state && state.brs) state.br_index = 0
    return this.saveVarInCurrentScope(defscope, resolvedNode, value, state)
  }

  /**
   * write the value of a variable into the current scope
   * @param scope
   * @param node
   * @param value
   * @param state
   * @returns {*}
   */
  saveVarInCurrentScope(scope: UnitType, node: any, value: UnitType, state: any): any {
    const resolvedNode = this.resolveIndices(scope, node, state)
    if (value && resolvedNode?.rtype && !value?.rtype) {
      value.rtype = resolvedNode.rtype
    }
    return this.saveVarInScopeRec(scope, resolvedNode, value, state)
  }

  /**
   * write the value of a variable into the scope
   * @param scope
   * @param node
   * @param value
   * @param state
   * @returns {*}
   */
  saveVarInScopeRec(scope: any, node: any, value: any, state: any): any {
    if (!node || !value || scope.type === 'Literal') {
      return
    }

    if (node.vtype === 'union') {
      // union
      for (const el of node.value) {
        this.saveVarInScopeRec(scope, el, value, state)
      }
      // a short-cut from the identity to the value
      if (scope.value) {
        const sid = symAddress.toStringID(node)
        if (sid) scope.value[sid] = value
      }
      return
    }

    if (typeof node === 'string') node = new IdentifierRefValue(scope.qid, node, null, null)

    switch (node.type) {
      case 'MemberAccess': {
        const prop = node.property
        let subscope = this.getMemberValue(scope, node.object, state)
        if (!subscope) {
          // important: e.g. the object scope is an expression
          if (!node.object) {
            logger.info(node)
          }
          const scp = Scope.createSubScope(node.object.name, scope, state)
          subscope = scp
        }

        // update the read references
        // if (subscope.rrefs) {
        //     for (let r of subscope.rrefs)
        //         if (r)
        //             r._changed = true;
        // }

        this.saveVarInScopeRec(subscope, prop, value, state)
        return
      }
      case 'Identifier':
      case 'Parameter': {
        if (scope.type === 'Literal') return

        if (scope.vtype === 'BVT') {
          if (true) {
            scope = memState.loadForkedValue(scope, state)
          } else if (state.br_index !== undefined && state.br_index < state.brs.length) {
            const br = state.brs[state.br_index]
            state.br_index++
            return this.saveVarInScopeRec(scope.children[br], node, value, state)
          } else {
            this.saveVarInScopeRec(scope.children.L, node, value, state)
            this.saveVarInScopeRec(scope.children.R, node, value, state)
            return
          }
        }

        if (Array.isArray(scope)) {
          const { name } = node
          if (name === 'length') {
            if (value.type === 'Literal') scope.length = value.value
          } else {
            scope[name] = value
          }
        } else {
          saveVarInScopeDirect(scope, node.name, value, state)
        }
        // fields[node.name] = shallowCloneScope(value);

        // // record state information
        // type.recordType(node, value, scope);
        return
      }
      case 'Literal': {
        if (scope.type === 'Literal') return
        saveVarInScopeDirect(scope, node.value, value, state)
        return
      }
    }

    // other cases, e.g. the identity is symbolic
    switch (node.vtype) {
      case 'object': {
        // other cases, e.g. the identity is a non-primitive expression
        let { updates } = scope
        if (!updates) updates = scope.updates = new Map()
        updates.set(node, value)
        break
      }
      case 'scope':
      case 'fclos':
        return value
    }
    // a short-cut from the identity to the value
    if (scope.value) {
      const sid = symAddress.toStringID(node)
      let usid = sid
      if (node.runtime?.transDep && state.tid) {
        usid = `${sid}~${state.tid}`
      }

      if (sid) scope.value[usid] = value
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  _removeMemberValueDirect(scope: any, node: any, state: any): any {
    if (!scope) return // FIXME

    if (scope.vtype === 'union') {
      const res: UnitType[] = []
      scope.value.forEach((s: UnitType) => {
        res.push(this._removeMemberValueDirect(s, node, state))
      })
      if (res.length === 0) return undefined
      if (res.length === 1) return res[0]

      return new UnionValue(res, undefined, `${scope.qid}.<union@rm:${node?.loc?.start?.line}:${node?.loc?.start?.column}>`, node)
    }
    if (scope.vtype === 'BVT') {
      scope = memState.loadForkedValue(scope, state)
      return this._removeMemberValueDirect(scope, node, state)
    }

    let index: any
    switch (node.type) {
      case 'Identifier':
      case 'Literal':
      case 'SuperExpression': {
        const { type } = node
        switch (type) {
          case 'Literal':
            index = node.value
            break
          case 'Identifier':
            index = node.name
            break
          case 'SuperExpression':
            index = 'super'
            break
        }

        if (scope.type === 'TupleExpression') scope = scope.components
        const isArray = Array.isArray(scope)
        const fields = isArray ? scope : scope.value

        // if (fields && fields.hasOwnProperty(index)) {
        if (fields && _.has(fields, index)) {
          delete fields[index]
        }
      }
    }
  }

  /**
   * get the value of a variable or a field directly within a scope
   * @param scope
   * @param node
   * @param state
   * @param createIfNotExists
   * @param stack
   * @param visited
   * @returns {*}
   */
  _getMemberValueDirect(
    scope: any,
    node: any,
    state: any,
    createIfNotExists: boolean,
    stack: number,
    visited: Set<UnitType>
  ): any {
    if (!scope) return // FIXME
    visited = visited || new Set()
    // if (stack > 20) {
    //   return undefined
    // }
    if (!scope || visited.has(scope)) {
      return undefined
    }
    visited.add(scope)
    if (scope.vtype === 'union') {
      const res: UnitType[] = []
      scope.value.forEach((s: UnitType) => {
        res.push(this._getMemberValueDirect(s, node, state, createIfNotExists, stack, visited))
      })
      if (res.length === 0) return undefined
      if (res.length === 1) return res[0]

      return new UnionValue(res, undefined, `${scope.qid}.<union@memD:${node?.loc?.start?.line}:${node?.loc?.start?.column}>`, node)
    }
    if (scope.vtype === 'BVT') {
      scope = memState.loadForkedValue(scope, state)
      return this._getMemberValueDirect(scope, node, state, createIfNotExists, stack, visited)
    }

    let index: any
    if (!node) {
      return undefined
    }
    switch (node.type) {
      case 'Identifier':
      case 'Literal':
      case 'SuperExpression': {
        const { type } = node
        switch (type) {
          case 'Literal':
            index = node.value
            break
          case 'Identifier':
            index = node.name
            break
          case 'SuperExpression':
            index = 'super'
            break
        }

        if (scope.type === 'TupleExpression') scope = scope.components
        const isArray = Array.isArray(scope)
        const fields = isArray ? scope : scope.value
        let scopeId: any
        if (typeof scope?.getQualifiedId === 'function') {
          scopeId = scope.getQualifiedId()
        }
        const qid = Scope.joinQualifiedName(scopeId, index)
        const sid = index?.toString()
        let val: any
        if (fields && _.has(fields, index)) {
          // todo 还需要判断当前的val 是否state匹配
          val = fields[index]
          if (val.func?.jumpLocate) {
            const targetVal = val.func.jumpLocate(val, qid, scope)
            if (targetVal) {
              val = targetVal
            }
          }
        } else if (!createIfNotExists && !scope.taint?.isTaintedRec) {
          // notice that if scope has taint, sub field will always be created
          return new UndefinedValue({
            sid: index,
            qid: scope.qid + index,
            parent: scope, // refer to the parent scope
          })
        } else if (fields && (!!fields.prototype || index === '__proto__' || index === 'prototype')) {
          // 如果是要取prototype 则直接取
          // 注意！！！访问field中名为prototype的属性时，为了避免引起预期外的行为(访问到fields真正的原型了)
          // 应该使用field['prototype']  而不是field.prototype
          if (index === '__proto__' || index === 'prototype') {
            // 如果fields的proto不存在，则创建一个
            if (!fields.prototype) {
              scope.setFieldValue(
                'prototype',
                new ObjectValue(scope.qid, {
                  sid: 'prototype',
                  parent: scope,
                })
              )
            }
            val = fields.prototype
          } else {
            // 否则从prototype中查看是否存在index
            // 先在field找，如果没有，则看field是否有prototype的符号值 prototype如果有index则返回prototype中的index
            // prototype中如果没有，但prototype中还有prototype则递归从原型符号链查找
            val = this.getPropertyFromPrototype(fields.prototype, index)
          }
        }
        if (!val) {
          // if (DEBUG) logger.info(val = ' + val);
          // otherwise possibly symbolic access
          if (isArray || scope.type === 'MemberAccess' || scope.vtype === 'object' || scope.vtype === 'symbol') {
            // do not create a value, instead return the "scope.index" expression
            val = new MemberExprValue('', scope, node, false, node.ast?.node, node.loc)
            val._sid = sid
            val._qid = qid
            if (scope.value && typeof scope.value === 'object') {
              scope.value[index] = val
            }

            if (scope.taint?.isTaintedRec && val.taint) {
              val.taint?.propagateFrom(scope)
            }
            if (scope.taint?.hasTags() && val.taint) {
              for (const t of scope.taint.getTags()) val.taint.addTag(t)
            }
            if (scope.taint.hasTraces() && val.taint) {
              val.taint.inheritTracesFrom(scope.taint)
            }
          } else if (scope.value && scope.type !== 'Literal') {
            try {
              val = this.createIdentifierFieldValue(node, scope)
              val.sid = sid
              val._qid = qid
              val.uuid = null
              val.calculateAndRegisterUUID()
            } catch (e) {
              handleException(e, '', 'Error occurred in Memspace.getValueDirect')
            }
          }
        }

        if (val) {
          if (typeof val === 'string') {
            return new PrimitiveValue('', val, val, null, 'Literal')
          }
          if (typeof val === 'number') {
            return new PrimitiveValue('', `<number_${val}>`, val, null, 'Literal')
          }
          if (typeof val === 'boolean') {
            return new PrimitiveValue('', `<boolean_${val}>`, val, null, 'Literal')
          }
          if (val.taint && !val.taint?.isTaintedRec && scope.taint?.isTaintedRec) {
            val.taint?.propagateFrom(scope)
          }
          if (val.taint && !val.taint?.hasTags() && scope.taint?.hasTags()) {
            for (const t of scope.taint.getTags()) val.taint.addTag(t)
          }
          if (val.taint && !val.taint.hasTraces() && scope.taint.hasTraces()) {
            val.taint.inheritTracesFrom(scope.taint)
          }
          val = memState.loadForkedValue(val, state) // may need to resolve branch-dependent values
          if (!val) {
            // val = Scope.createSubScope(index, scope);
            val = new UndefinedValue({
              sid: index,
              qid: `${scope.qid}.${index}`,
              parent: scope, // refer to the parent scope
            })
            return val
          }
          // if (typeof val === 'string' || typeof val === 'number') {
          //   return PrimitiveValue({ value: val, type: 'Literal' })
          // }
          if (val && typeof val === 'string') {
            val = new PrimitiveValue('', val, val, null, 'Literal')
          }

          // set the "this" pointer for objects
          if (val.vtype === 'fclos') {
            val._this = scope.getThisObj()
          }
          if (node.taint && node.taint?.isTaintedRec) {
            // 当 key 携带污点，存储到 misc 避免断链
            scope.setMisc(sid, node)
          }
          return val
        }
        const memberExpr = new MemberExprValue('', scope, node, false, node.ast?.node, node.loc)
        memberExpr._sid = sid
        memberExpr._qid = qid
        const res =
          scope.vtype === 'scope'
            ? node
            : memberExpr
        if (scope.vtype === 'primitive') {
          if (res.taint && !res.taint?.isTaintedRec && scope.taint?.isTaintedRec) {
            res.taint?.propagateFrom(scope)
          }
          if (res.taint && !res.taint?.hasTags() && scope.taint?.hasTags()) {
            for (const t of scope.taint.getTags()) res.taint.addTag(t)
          }
          if (res.taint && !res.taint.hasTraces() && scope.taint.hasTraces()) {
            res.taint.mergeTracesFrom(scope.taint)
          }
        }
        return res
      }
      case 'ThisExpression': {
        return scope.getThisObj()
      }
      case 'UnaryOperation': {
        switch (node.operator) {
          case '++':
          case '--':
          case '!':
          case '&':
          case '-':
          case '+':
          case 'typeof':
          case 'void':
            node = node.subExpression
            break
          default:
            Errors.UnsupportedOperator(`unsupported operator:${node.operator}`)
        }
      }
    }

    // the identity/index is an expression
    // check the update list
    const { updates } = scope
    if (updates) {
      // if node is transaction related, don't get from updates
      if (!node.runtime?.transDep) {
        const v = updates.get(node)
        if (v) return v
      }
    }
    // a short-cut from the identity to the value
    if (scope.value) {
      const sid = symAddress.toStringID(node)
      if (sid) {
        let usid = sid
        if (node.runtime?.transDep && state.tid) {
          usid = `${sid}~${state.tid}`
        }
        // if (scope.value.hasOwnProperty(usid))
        if (Object.prototype.hasOwnProperty.call(scope.value, usid)) return scope.value[usid]
        // const val = Scope.createIdentifierScope({type: 'Literal', value: sid},
        //                                          scope);
        const memberExpr3 = new MemberExprValue('', scope, node, false, node.ast?.node, node.loc)
        memberExpr3._sid = sid
        memberExpr3._qid = sid
        const val =
          scope.vtype === 'scope' && node.vtype
            ? node
            : memberExpr3
        if (node.taint && node.taint?.isTaintedRec) {
          // 当 key 携带污点，存储到 misc 避免断链
          scope.setMisc(usid, node)
        }
        if (scope.type !== 'Literal' && typeof scope.value !== 'string') {
          scope.value[usid] = val
        }
        return val
      }
    }

    // other cases, e.g. unknown value
    if (scope.vtype === 'scope') return node
    const fallbackMember = new MemberExprValue(scope.qid, scope, node, false, node.ast?.node, node.loc)
    fallbackMember._sid = AstUtil.prettyPrint(node)
    return fallbackMember
  }

  /**
   *
   * 从prototype的field中寻找index，如果没有则递归从原型链中找
   *
   * @param proto
   * @param index
   * @param scope
   * @param node
   * @param sid
   */
  getPropertyFromPrototype(proto: UnitType | undefined, index: string): UnitType | undefined {
    if (!proto?.members) return undefined
    if (proto.members.has(index)) return proto.members.get(index)
    const nextProto = proto.members.get('prototype')
    return nextProto != null ? this.getPropertyFromPrototype(nextProto, index) : undefined
  }
}

//* *******************************************
/**
 *
 * @param scope
 * @param id
 * @param value
 * @param state
 */
function saveVarInScopeDirect(scope: any, id: string | number, value: UnitType, state: any): void {
  let fields = Array.isArray(scope) ? scope : scope.value
  if (!fields) fields = scope.value = {}
  // fields[id] = value;
  memState.writeValue(fields, id, value, state, scope)
}

module.exports = MemSpace
