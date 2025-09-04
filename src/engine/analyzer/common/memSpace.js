const _ = require('lodash')
const logger = require('../../../util/logger')(__filename)
const TypeUtil = require('../../util/type-util')
const MemState = require('./memState')
const Scope = require('./scope')
const NativeResolver = require('./native-resolver')
const SymAddress = require('./sym-address')
const ValueFormatter = require('../../../util/value-formatter')
const { Errors } = require('../../../util/error-code')
const {
  ValueUtil: { UndefinedValue, ObjectValue, PrimitiveValue, UnionValue, SymbolValue },
  Unit,
  ValueUtil,
} = require('../../util/value-util')
const AstUtil = require('../../../util/ast-util')
const varUtil = require('../../../util/variable-util')
const { handleException } = require('./exception-handler')

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
  getFieldValue(unit, ids, createIfNotExists) {
    if (!unit) {
      return null
    }

    if (!(unit instanceof Unit)) {
      unit = ValueUtil.ObjectValue(unit)
    }

    return unit.getFieldValue(ids, createIfNotExists)
  }

  /**
   *
   * @param unit
   * @param ids
   */
  getFieldValueIfNotExists(unit, ids) {
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
  resolveIndices(scope, node, state) {
    if (!node) return node
    // 针对error类型特别适配
    if (node?.rtype?.type === 'Identifier' && node?.rtype?.name === 'error') {
      return node
    }

    if (typeof node === 'string') node = SymbolValue({ type: 'Identifier', name: node })

    if (node.type === 'MemberAccess') {
      let index
      let prop
      if (!node.computed) {
        prop = index = node.property
      } else if (node.type === 'Literal') {
        prop = index = node.property
      } else {
        const prop = node.property
        index = this.processInstruction(scope, prop, state)
        // if (!index || !(index.type === 'Literal' || index.type === 'Identifier' || index.vtype === 'union')) {
        //    index = prop;
        // }
        if (!index) index = SymbolValue(prop)
      }
      const object = this.resolveIndices(scope, node.object, state)
      if (object === node.object && index === prop) return node
      return SymbolValue({
        type: 'MemberAccess',
        object,
        property: index,
      })
    }
    if (
      node.type === 'Identifier' ||
      node.type === 'Literal' ||
      node.type === 'ThisExpression' ||
      node.type === 'Parameter' ||
      node.type === 'SuperExpression'
    ) {
      return SymbolValue(node)
    }
    if (node.vtype === 'union') {
      const res = []
      for (const el of node.value) {
        const v = this.resolveIndices(scope, el, state)
        if (v) res.push(v)
      }
      return UnionValue({ value: res })
    }
    // for Parameter and Return Parameter
    if (node.type === 'VariableDeclaration') {
      return SymbolValue({ type: 'Parameter', name: node.id?.name, ast: node })
    }
    if (node.type === 'DereferenceExpression') {
      return SymbolValue(node.argument)
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
  getMemberValue(scope, node, state, filter = null) {
    return this._getMemberValue(scope, node, state, true, null, filter)
  }

  /**
   * read the value of a variable from the scope
   * value will not be created if not existing
   * @param scope
   * @param node  node value, this should not be raw uast node
   * @param state
   * @returns {{type, object, property}|*}
   */
  getMemberValueNoCreate(scope, node, state) {
    return this._getMemberValue(scope, node, state, false)
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
  _getMemberValue(scope, node, state, createIfNotExists, limit, filter) {
    if (typeof node === 'string') {
      return this._getMemberValue(scope, AstUtil.qualifiedNameToMemberAccess(node), state, createIfNotExists, limit)
    }
    if (filter && filter(scope)) return UndefinedValue()

    let defscope = scope
    if (scope.vtype === 'union') {
      if (!limit) limit = 200
      const res = UnionValue()
      for (const scp of scope.value) {
        if (scp && limit > 0) {
          res.appendValue(this._getMemberValue(scp, node, state, createIfNotExists, limit--, filter))
        }
      }
      return res
    }
    // 如果scope.vtype是object 则传入的scope就是当前obj的defscope 直接从scope中取值即可
    if (!['object', 'symbol', 'undefine'].includes(scope.vtype)) {
      // find the scope defining this object (e.g. for obj.x)
      defscope = this.getDefScope(scope, node)
    }

    if (state?.brs) state.br_index = 0
    const res = this._getMemberValueRec(defscope, node, state, createIfNotExists)
    if (res && !res?.sort) {
      res.sort = res.qid
    }
    if (res && res.type === 'MemberAccess') {
      if (res.object) {
        const { hasTagRec } = res.object // the property is usually tainted (e.g. user-controlled)
        if (hasTagRec) res.hasTagRec = hasTagRec
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
  _getMemberValueRec(scope, node, state, createIfNotExists) {
    // if (DEBUG) logger.info('\nGet value: ' + formatNode(node) + ' in ' + Scope.formatScope(scope));
    if (!node) return node // FIXME: check oldAST

    if (node.vtype === 'union') {
      // value union
      const res = UnionValue()
      for (const el of node.value) {
        const val = this._getMemberValueRec(scope, el, state, createIfNotExists)
        if (val) res.appendValue(val)
      }
      return res
    }

    switch (node.type) {
      case 'MemberAccess': {
        const { object } = node
        let subscope
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
  saveVarInScope(scope, node, value, state, oldVal = null) {
    if (!value.rtype && oldVal && oldVal.rtype) value.rtype = oldVal.rtype
    const resolvedNode = this.resolveIndices(scope, node, state)

    // find the scope defining this object (e.g. for obj.x)
    const defscope = this.getDefScope(scope, node)
    // // use the top scope if not found
    // if (!defscope) {
    //     defscope = scope;
    //     let limit = 20;      // control circular pointers
    //     while (defscope.parent && defscope.parent.id !== 'top' && (limit--)) {
    //         defscope = defscope.parent;
    //     }
    // }

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
  saveVarInCurrentScope(scope, node, value, state) {
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
  saveVarInScopeRec(scope, node, value, state) {
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
        const sid = SymAddress.toStringID(node)
        if (sid) scope.value[sid] = value
      }
      return
    }

    if (typeof node === 'string') node = SymbolValue({ type: 'Identifier', name: node })

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
            scope = MemState.loadForkedValue(scope, state)
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
      const sid = SymAddress.toStringID(node)
      let u_sid = sid
      if (node.trans_dep && state.tid) {
        u_sid = `${sid}~${state.tid}`
      }

      if (sid) scope.value[u_sid] = value
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  _removeMemberValueDirect(scope, node, state) {
    if (!scope) return // FIXME

    if (scope.vtype === 'union') {
      const res = []
      scope.value.forEach((s) => {
        res.push(this._removeMemberValueDirect(s, node, state))
      })
      if (res.length === 0) return undefined
      if (res.length === 1) return res[0]

      return UnionValue({ value: res })
    }
    if (scope.vtype === 'BVT') {
      scope = MemState.loadForkedValue(scope, state)
      return this._removeMemberValueDirect(scope, node, state)
    }

    let index
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

        const scopeId = scope.getQualifiedId()
        const qid = Scope.joinQualifiedName(scopeId, index)
        const sid = index
        if (isArray) {
          // interpret native members
          const native = NativeResolver.simplifyArrayExpression(scope, index)
          if (native) return native
        }

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
  _getMemberValueDirect(scope, node, state, createIfNotExists, stack, visited) {
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
      const res = []
      scope.value.forEach((s) => {
        res.push(this._getMemberValueDirect(s, node, state, createIfNotExists, stack, visited))
      })
      if (res.length === 0) return undefined
      if (res.length === 1) return res[0]

      return UnionValue({ value: res })
    }
    if (scope.vtype === 'BVT') {
      scope = MemState.loadForkedValue(scope, state)
      return this._getMemberValueDirect(scope, node, state, createIfNotExists, stack, visited)
    }

    let index
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
        let scopeId
        if (typeof scope?.getQualifiedId === 'function') {
          scopeId = scope.getQualifiedId()
        }
        const qid = Scope.joinQualifiedName(scopeId, index)
        const sid = index?.toString()
        if (isArray) {
          // interpret native members
          const native = NativeResolver.simplifyArrayExpression(scope, index)
          if (native) return native
        }
        let val
        if (fields && _.has(fields, index)) {
          // todo 还需要判断当前的val 是否state匹配
          val = fields[index]
          if (Object.prototype.hasOwnProperty.call(val, 'jumpLocate')) {
            const targetVal = val.jumpLocate(val, qid, scope)
            if (targetVal) {
              val = targetVal
            }
          }
        } else if (!createIfNotExists && !scope.hasTagRec) {
          // notice that if scope has taint, sub field will always be created
          return UndefinedValue({
            index,
            qid: index,
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
                ObjectValue({
                  id: 'prototype',
                  sid: 'prototype',
                  qid: 'prototype',
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
            // val = _.has(fields['prototype'].field ,index) ? fields['prototype'].field[index] : SymbolValue({ type: 'MemberAccess', object: scope, property: node, ast: node.ast, sid, qid,})
          }
        }
        if (!val) {
          // if (DEBUG) logger.info(val = ' + val);
          // otherwise possibly symbolic access
          if (isArray || scope.type === 'MemberAccess' || scope.vtype === 'object' || scope.vtype === 'symbol') {
            // do not create a value, instead return the "scope.index" expression
            val = SymbolValue({
              type: 'MemberAccess',
              object: scope,
              property: node,
              ast: node.ast,
              sid,
              qid,
            })
            if (scope.value && typeof scope.value === 'object') {
              scope.value[index] = val
            }

            if (scope.hasTagRec) {
              val.hasTagRec = scope.hasTagRec
            }
            if (varUtil.isNotEmpty(scope._tags)) {
              val._tags = _.clone(scope._tags)
            }
            if (scope.trace) {
              val.trace = _.clone(scope.trace)
            }
          } else if (scope.value && scope.type !== 'Literal') {
            try {
              val = this.createIdentifierFieldValue(node, scope)
              val.sid = sid
              val.qid = qid
            } catch (e) {
              handleException(e, '', 'Error occurred in Memspace.getValueDirect')
            }
          }
        }

        if (val) {
          if (typeof val === 'string' || typeof val === 'number') {
            return PrimitiveValue({ value: val, type: 'Literal' })
          }
          if (!val.hasTagRec && scope.hasTagRec) {
            val.hasTagRec = scope.hasTagRec
          }
          if (varUtil.isEmpty(val._tags) && varUtil.isNotEmpty(scope._tags)) {
            val._tags = _.clone(scope._tags)
          }
          if (!val.trace && scope.trace) {
            val.trace = _.clone(scope.trace)
          }
          val = MemState.loadForkedValue(val, state) // may need to resolve branch-dependent values
          if (!val) {
            // val = Scope.createSubScope(index, scope);
            val = UndefinedValue({
              index,
              qid: index,
              parent: scope, // refer to the parent scope
            })
            return val
          }
          // if (typeof val === 'string' || typeof val === 'number') {
          //   return PrimitiveValue({ value: val, type: 'Literal' })
          // }
          if (val && typeof val === 'string') {
            val = PrimitiveValue({ type: 'Literal', value: val })
          }
          if (!val.sort) val.sort = TypeUtil.inferType({ type: 'MemberAccess', expression: scope, property: val })

          if (!val.sort && val.type === 'Literal') {
            val.sort = TypeUtil.inferType(val)
          }

          // set the "this" pointer for objects
          if (val.vtype === 'fclos') {
            val._this = scope.getThis()
          }
          if (node.hasTagRec) {
            // 一般情况下 对象的key的符号值是不会存储到field里的，field只用来存储value的符号值
            // 当污点在key上时，key的符号值会被转换成普通字符串，并且不会存储到field中 此时污点信息taint和trace丢失发生断链
            // 为了解决上述问题 若key携带污点，则将key的符号值存储到misc里 只要后续worklist能遍历到misc 这条污点链路即可建立起来
            scope.setMisc(sid, node)
          }
          return val
        }
        const res =
          scope.vtype === 'scope'
            ? node
            : SymbolValue({
                type: 'MemberAccess',
                object: scope,
                property: node,
                ast: node.ast,
                sid,
                qid,
              })
        res.sort = TypeUtil.inferType(res)
        if (scope.vtype === 'primitive') {
          if (!res.hasTagRec && scope.hasTagRec) {
            res.hasTagRec = scope.hasTagRec
          }
          if (varUtil.isEmpty(res._tags) && varUtil.isNotEmpty(scope._tags)) {
            res._tags = _.clone(scope._tags)
          }
          if (!res.trace && scope.trace) {
            res.trace = _.clone(scope.trace)
          }
        }
        return res
      }
      case 'ThisExpression': {
        return scope.getThis()
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
      if (!node.trans_dep) {
        const v = updates.get(node)
        if (v) return v
      }
    }
    // a short-cut from the identity to the value
    if (scope.value) {
      const sid = SymAddress.toStringID(node)
      if (sid) {
        let u_sid = sid
        if (node.trans_dep && state.tid) {
          u_sid = `${sid}~${state.tid}`
        }
        // if (scope.value.hasOwnProperty(u_sid))
        if (Object.prototype.hasOwnProperty.call(scope.value, u_sid)) return scope.value[u_sid]
        // const val = Scope.createIdentifierScope({type: 'Literal', value: sid},
        //                                          scope);
        // val.sort = TypeUtil.inferType({type: 'MemberAccess', expression: scope, property: node});
        const val =
          scope.vtype === 'scope' && node.vtype
            ? node
            : SymbolValue({
                type: 'MemberAccess',
                object: scope,
                property: node,
                sid,
                qid: sid,
              })
        if (node.hasTagRec) {
          // 一般情况下 对象的key的符号值是不会存储到field里的，field只用来存储value的符号值
          // 当污点在key上时，key的符号值会被转换成普通字符串，并且不会存储到field中 此时污点信息taint和trace丢失发生断链
          // 为了解决上述问题 若key携带污点，则将key的符号值存储到misc里 只要后续worklist能遍历到misc 这条污点链路即可建立起来
          scope.setMisc(u_sid, node)
        }
        if (scope.type !== 'Literal' && typeof scope.value !== 'string') {
          scope.value[u_sid] = val
        }
        val.sort = TypeUtil.inferType(val)
        return val
      }
    }

    // other cases, e.g. unknown value
    const res = scope.vtype === 'scope' ? node : SymbolValue({ type: 'MemberAccess', object: scope, property: node })
    res.sort = TypeUtil.inferType(res)
    return res
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
  getPropertyFromPrototype(proto, index) {
    if (proto && proto.field && _.has(proto.field, index)) {
      return proto.field[index]
    }
    return proto?.field.prototype != null ? this.getPropertyFromPrototype(proto?.field.prototype, index) : undefined
  }

  /**
   * for declaration/definition hoisting; consider only one block (and not the sub blocks)
   * @param scope
   * @param node
   * @param state
   */
  recordFunctionDefinitions(scope, node, state) {
    if (logger.isTraceEnabled()) logger.trace(`recordFunctionDefinition: ${ValueFormatter.formatNode(node)}\n`)
    if (!node) return

    if (Array.isArray(node)) {
      for (const statement of node) {
        this.recordFunctionDefinitions(scope, statement, state)
      }
      return
    }

    switch (node.type) {
      case 'FunctionDefinition': {
        // let clos = Scope.createFunctionClosure(scope, node);
        // analysisUtil.saveOverloadedFunctionInScope(scope, node.id, clos);
        break
      }
      case 'BlockStatement': {
        this.recordFunctionDefinitions(scope, node.body, state)
        break
      }
      case 'ClassDeclaration': {
        if (logger.isTraceEnabled()) logger.trace(`allocate class members: ${ValueFormatter.formatNode(node)}`)
        const clos = this.createClassClosure(scope, node)
        if (logger.isTraceEnabled()) logger.trace(`node.id = ${ValueFormatter.formatNode(node.id)}`)
        const id = node.id.type ? node.id : { type: 'Literal', value: node.id }
        this.saveVarInCurrentScope(scope, id, clos, state)
        break
      }
      case 'VariableDeclaration': {
        this.recordFunctionDefinitions(scope, node.declarations, state)
        break
      }
      case 'ExpressionStatement': {
        this.recordFunctionDefinitions(scope, node.expression, state)
        break
      }
    } // end switch
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
function saveVarInScopeDirect(scope, id, value, state) {
  let fields = Array.isArray(scope) ? scope : scope.value
  if (!fields) fields = scope.value = {}
  // fields[id] = value;
  MemState.writeValue(fields, id, value, state, scope)
}

module.exports = MemSpace
