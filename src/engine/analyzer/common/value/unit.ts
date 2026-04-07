import { AstBinding } from './ast-binding'
import { ValueRef } from './value-ref'
import { ScopeCtx } from './scope-ctx'
import { AstRefList } from './ast-ref-list'
import { TaintRecord } from './taint-record'

const _ = require('lodash')
const { Errors } = require('../../../../util/error-code')
const { getGlobalSymbolTable, getGlobalASTManager } = require('../../../../util/global-registry')
const { yasaWarning } = require('../../../../util/format-util')
const QidUnifyUtil = require('../../../../util/qid-unify-util')

class Unit {
  // Allows subclass properties assigned via constructor opts
  [key: string]: any

  // ===== Public fields =====
  vtype: string = ''
  uuid: string = ''
  declsNodehash: any = undefined
  _taint: TaintRecord | null = null
  misc_: Record<string, any> = {}

  // ===== Private fields =====
  _sid: string = ''
  _qid: string = ''
  _field: Record<string, any> = {}
  _ast: AstBinding | undefined = undefined
  _scopeCtx: ScopeCtx | undefined = undefined
  overloaded: AstRefList | undefined = undefined
  _parentRef: ValueRef | null = null
  _thisRef: ValueRef | null = null
  _superRef: ValueRef | null = null
  _packageScopeRef: ValueRef | null = null
  _isConstructing: boolean = false

  constructor(opts: Record<string, any>) {
    const { vtype, _field, value } = opts
    if (opts.qid === undefined || opts.sid === undefined) {
      if (opts._qid === undefined || opts._sid === undefined) {
        const _caller = new Error().stack?.split('\n').slice(1, 5).map((l: string) => l.trim()).join(' <- ')
        yasaWarning(`Missing qid/sid in ${vtype} Value (type: ${opts.type}, name: ${opts.name}, sid: ${opts.sid}, qid: ${opts.qid}) | ${_caller}`)
        opts.sid = opts.name || opts.type || '<unknown>'
        opts.qid = opts.sid
      }
    }
    this.vtype = vtype
    if (value !== undefined) {
      this.raw_value = value
    }

    this._field = _field ?? {}

    this.misc_ = new Object()

    this._ast = new AstBinding(this)
    const oldDecls = opts.decls
    if (oldDecls && typeof oldDecls === 'object' && !Array.isArray(oldDecls)) {
      this._ast.initDecls(oldDecls)
    }

    this._scopeCtx = new ScopeCtx(this)

    const getAM = () => this.getASTManager()
    const oldOverloaded = opts.overloaded
    this.overloaded = oldOverloaded && Array.isArray(oldOverloaded)
      ? AstRefList.from(oldOverloaded, getAM)
      : new AstRefList(getAM)

    if (opts.parent !== undefined) this.parent = opts.parent

    if (opts.parent_uuid !== undefined) {
      this._parentRef = opts.parent_uuid ? new ValueRef(opts.parent_uuid) : null
    }
    if (opts.__this !== undefined) {
      this._thisRef = opts.__this ? new ValueRef(opts.__this) : null
    }
    if (opts.__superUuid !== undefined) {
      this._superRef = opts.__superUuid ? new ValueRef(opts.__superUuid) : null
    }
    if (opts.__packageScopeUuid !== undefined) {
      this._packageScopeRef = opts.__packageScopeUuid ? new ValueRef(opts.__packageScopeUuid) : null
    }

    if (opts.ast !== undefined) this.ast = opts.ast

    if (opts.exports !== undefined) this._scopeCtx.exports = opts.exports

    this._isConstructing = true

    // --- Unit/ValueBase layer property assignments ---

    // Identity
    if ('sid' in opts) this.sid = opts.sid
    if ('qid' in opts) this.qid = opts.qid
    if ('_sid' in opts) this._sid = opts._sid
    if ('_qid' in opts) this._qid = opts._qid
    if ('name' in opts) this.name = opts.name

    // Value
    if ('raw_value' in opts) this.raw_value = opts.raw_value
    if ('values' in opts) this.values = opts.values

    // References (via setter → ValueRef)
    if ('_this' in opts) this._this = opts._this
    if ('super' in opts) this.super = opts.super
    if ('packageScope' in opts) this.packageScope = opts.packageScope

    // AST / Type (cross-layer)
    if ('loc' in opts) this.loc = opts.loc
    if ('declsNodehash' in opts) this.declsNodehash = opts.declsNodehash
    if ('type' in opts) this.type = opts.type
    if ('rtype' in opts) this.rtype = opts.rtype

    // Taint（懒分配：默认 _taint=null，getter 按需创建）
    // 来源 1：clone/显式传入 taint（data property）
    // 来源 2：{...unit} spread 传入 _taint（因 taint 是 getter 不被 spread 复制）
    const srcTaint = ('taint' in opts && opts.taint instanceof TaintRecord) ? opts.taint
      : ('_taint' in opts && opts._taint instanceof TaintRecord) ? opts._taint
      : null
    if (srcTaint) {
      this._taint = new TaintRecord(this)
      this._taint.copyFrom(srcTaint)
    }

    // Misc
    if ('misc_' in opts) this.misc_ = opts.misc_

    // Internal (via {...unit} spread / clone)
    if ('_ast' in opts) this._ast = opts._ast
    if ('_parentRef' in opts) this._parentRef = opts._parentRef
    if ('_thisRef' in opts) this._thisRef = opts._thisRef
    if ('_superRef' in opts) this._superRef = opts._superRef
    if ('_packageScopeRef' in opts) this._packageScopeRef = opts._packageScopeRef
    if ('_meta' in opts) this._meta = opts._meta
    if ('_declsNodehashMap' in opts) this._declsNodehashMap = opts._declsNodehashMap
    if ('_logicalQid' in opts) this._logicalQid = opts._logicalQid
    if ('_scopeCtx' in opts) this._scopeCtx = opts._scopeCtx
    if ('_dedup' in opts) this._dedup = opts._dedup
    if ('_isConstructor' in opts) this._isConstructor = opts._isConstructor

    // Control
    if ('_skipRegister' in opts) this._skipRegister = opts._skipRegister

    this._isConstructing = false

    if (!opts._skipRegister) {
      this.calculateAndRegisterUUID()
    }
  }

  get sid(): string {
    return this._sid
  }

  set sid(value: string) {
    this._sid = value
  }

  setAlias(name: string): void {
    this._sid = name
  }

  get qid(): string {
    return this._qid
  }

  get logicalQid(): string {
    if (this._logicalQid === undefined) {
      this._logicalQid = QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(this)
    }
    return this._logicalQid
  }

  set qid(value: string) {
    const oldValue = this._qid
    this._qid = value
    if (oldValue !== value && !this._isConstructing) {
      if (oldValue !== undefined && oldValue !== null) {
        const _caller = new Error().stack?.split('\n').slice(1, 3).map((l: string) => l.trim()).join(' <- ')
        yasaWarning(`qid mutation after construction: "${oldValue}" → "${value}" (vtype=${this.vtype}) | ${_caller}`)
      }
    }
  }

  get value(): any {
    if (Object.prototype.hasOwnProperty.call(this, 'raw_value')) {
      return this.raw_value
    }
    return this._field
  }

  set value(val: any) {
    this._field = val ?? {}
  }

  getTrace(tag: string): any[] | null {
    return this.taint.getTrace(tag) ?? null
  }

  getMemberValue(fieldName: string): Unit | null {
    if (this.members) {
      const val = this.members.get(fieldName)
      if (val != null) return val
      // 回退：members 无此 key，继续查 _field
    }
    if (!Object.prototype.hasOwnProperty.call(this._field, fieldName)) {
      return null
    }
    const fieldValue = this._field[fieldName]
    if (typeof fieldValue === 'string' && fieldValue.startsWith('symuuid_')) {
      const symbolTable = this.getSymbolTable()
      if (symbolTable) {
        const resolved = symbolTable.get(fieldValue)
        if (resolved) {
          return resolved
        }
      }
    }
    return fieldValue
  }

  setMemberValue(fieldName: string, value: any): void {
    if (this.members) { this.members.set(fieldName, value); return }
    if (!value) {
      delete this._field[fieldName]
      return
    }

    if (value instanceof Unit || (value.vtype && value.qid)) {
      if (value.uuid) {
        this._field[fieldName] = value.uuid
      } else {
        const symbolTable = this.getSymbolTable()
        if (symbolTable) {
          const uuid = symbolTable.register(value)
          this._field[fieldName] = uuid
        } else {
          this._field[fieldName] = value
        }
      }
    } else {
      this._field[fieldName] = value
    }
  }

  getFieldValue(ids: string | string[], createIfNotExists?: boolean): Unit | undefined {
    if (!ids) {
      try {
        Errors.IllegalUse('getFieldValue ids should not be empty')
      } catch (e) {}
      return new Unit({
        vtype: 'unknown',
        sid: '<unknown>',
        qid: '<unknown>',
      })
    }

    if (!Array.isArray(ids)) {
      ids = ids.split('.')
    }

    let fval: Unit = this
    for (let i = 0; i < ids.length; i++) {
      const fname = ids[i]
      let sub_fval = fval.getMemberValue(fname)
      if (!sub_fval) {
        if (createIfNotExists) {
          sub_fval = new Unit({
            vtype: 'object',
            sid: fname,
            qid: `${fval.sid}.${fname}`,
            parent: fval,
          })

          if (fval._taint) sub_fval._taint = fval._taint._clone(sub_fval)

          fval.setMemberValue(fname, sub_fval)
        } else {
          return
        }
      }
      fval = sub_fval
    }

    return fval
  }

  getFieldValueIfNotExists(fieldName: string): Unit | undefined {
    return this.getFieldValue(fieldName, true)
  }

  setFieldValue(ids: string | string[], value: Unit | null): void {
    let scp: Unit = this
    ids = Array.isArray(ids) ? ids : ids.toString().split('.')

    for (let i = 0; i < ids.length - 1; i++) {
      const fname = ids[i]
      let scp1 = scp.getMemberValue(fname)
      if (!scp1) {
        scp1 = new Unit({
          vtype: 'object',
          sid: '<tmp>',
          qid: '<tmp>',
          parent: scp,
        })
        scp.setMemberValue(fname, scp1)
      } else {
        scp1.parent = scp
      }
      scp = scp1
    }
    scp.setMemberValue(ids[ids.length - 1], value)
  }

  getRawValue(): any {
    return this.value
  }

  getQualifiedId(): string {
    return this.qid
  }

  get _this(): Unit | null { return this._resolveValueRef(this._thisRef) }
  set _this(unit: Unit | null) { this._thisRef = this._makeValueRef(unit) }

  getThisObj(): Unit {
    let scp: Unit | null = this
    let _this: Unit | null
    let depth = 0
    const maxDepth = 100
    while (scp && depth < maxDepth) {
      _this = scp._this
      if (_this) {
        return _this
      }
      if (this.vtype === 'object') {
        return this
      }
      scp = scp.parent
      depth++
    }
    return this
  }

  setMisc(key: string, value: any): void {
    this.misc_[key] = value
  }

  getMisc(key: string): any {
    return this.misc_[key]
  }

  reset(): void {
    this.misc_ = new Object()
    this.taint.clear()
  }




  getASTManager(): any {
    const globalASTManager = getGlobalASTManager()
    if (globalASTManager) {
      return globalASTManager
    }
    return null
  }

  getSymbolTable(): any {
    const globalSymbolTable = getGlobalSymbolTable()
    if (globalSymbolTable) {
      return globalSymbolTable
    }
    return null
  }

  _resolveValueRef(ref: ValueRef | null): Unit | null {
    if (!ref) return null
    const st = this.getSymbolTable()
    return st ? st.get(ref.uuid) : null
  }

  _makeValueRef(unit: Unit | null): ValueRef | null {
    if (!unit) return null
    if (unit.uuid) return new ValueRef(unit.uuid)
    const st = this.getSymbolTable()
    if (st) {
      const uuid = st.register(unit)
      return new ValueRef(uuid)
    }
    return null
  }

  _makeValueRefDirect(unit: Unit | string | null | undefined): ValueRef | null {
    if (unit == null) return null
    if (typeof unit === 'string' && unit.startsWith('symuuid')) {
      return new ValueRef(unit)
    }
    const uuid = (typeof unit === 'object' && unit.uuid) ? unit.uuid : ''
    return new ValueRef(uuid, unit)
  }

  calculateAndRegisterUUID(): void {
    const symbolTable = this.getSymbolTable()
    if (!symbolTable) {
      return
    }
    symbolTable.register(this)
  }

  get taint(): TaintRecord {
    if (!this._taint) this._taint = new TaintRecord(this)
    return this._taint
  }

  set taint(val: TaintRecord) {
    this._taint = val
  }

  get ast(): AstBinding {
    return this._ast!
  }

  set ast(astNode: any) {
    if (this._ast) this._ast.node = astNode
  }

  get scope(): ScopeCtx {
    return this._scopeCtx!
  }

  get parent(): Unit | null { return this._resolveValueRef(this._parentRef) }
  set parent(unit: Unit | null) { this._parentRef = this._makeValueRef(unit) }

  get packageScope(): Unit | null { return this._resolveValueRef(this._packageScopeRef) }
  set packageScope(unit: Unit | null) { this._packageScopeRef = this._makeValueRef(unit) }

  get super(): Unit | null { return this._resolveValueRef(this._superRef) }
  set super(unit: Unit | null) { this._superRef = this._makeValueRef(unit) }

  clone(): this {
    const copy: this = Object.create(Object.getPrototypeOf(this))
    const keys = Object.keys(this)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const desc = Object.getOwnPropertyDescriptor(this, key)
      if (!desc || !('value' in desc)) continue
      if (key === '_field') {
        // 跳过 _field，clone 完成后通过 field setter 处理
      } else {
        copy[key] = desc.value
      }
    }
    // 克隆 _field：浅拷贝 plain object，保留 UUID 字符串
    const fieldValue = this._field
    if (fieldValue && typeof fieldValue === 'object') {
      const fieldCopy: Record<string, any> = {}
      for (const fk in fieldValue) {
        if (!Object.prototype.hasOwnProperty.call(fieldValue, fk)) continue
        const fd = Object.getOwnPropertyDescriptor(fieldValue, fk)
        if (fd && 'value' in fd && typeof fd.value === 'string' && fd.value.startsWith('symuuid')) {
          fieldCopy[fk] = fd.value
        } else {
          fieldCopy[fk] = fieldValue[fk]
        }
      }
      copy._field = fieldCopy
    } else {
      copy._field = fieldValue
    }
    if (copy._taint) copy._taint = copy._taint._clone(copy)
    if (copy._ast && typeof copy._ast._clone === 'function') {
      copy._ast = copy._ast._clone(copy)
    }
    if (copy._scopeCtx && typeof copy._scopeCtx._clone === 'function') {
      copy._scopeCtx = copy._scopeCtx._clone(copy)
    }
    copy._skipRegister = true
    return copy
  }

  /**
   * Shallow copy that shares _field Proxy (alias semantics).
   * Multiple Values reference the same field storage.
   * Property groups (taint/runtime/func/_ast/_scopeCtx) get independent shallow copies.
   */
  cloneAlias(): this {
    const copy: this = Object.create(Object.getPrototypeOf(this))
    const keys = Object.keys(this)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const desc = Object.getOwnPropertyDescriptor(this, key)
      if (!desc || !('value' in desc)) continue
      copy[key] = desc.value
    }
    const exprRefKeys = ['_objectRef', '_propertyRef', '_leftRef', '_rightRef', '_calleeRef', '_argumentRefs', '_expressionRef', '_argumentRef']
    for (let i = 0; i < exprRefKeys.length; i++) {
      const key = exprRefKeys[i]
      if (!Object.prototype.hasOwnProperty.call(this, key)) continue
      const sourceDesc = Object.getOwnPropertyDescriptor(this, key)
      if (!sourceDesc || !('value' in sourceDesc)) continue
      Object.defineProperty(copy, key, {
        value: sourceDesc.value,
        writable: sourceDesc.writable ?? true,
        enumerable: false,
        configurable: sourceDesc.configurable ?? true,
      })
    }
    // Rebuild own enumerable accessors for getter-based operands so that
    // satisfy() (for...in + hasOwnProperty) can traverse them on the clone.
    const exprPropPairs: [string, string][] = [
      ['_leftRef', 'left'],
      ['_rightRef', 'right'],
      ['_objectRef', 'object'],
      ['_propertyRef', 'property'],
      ['_calleeRef', 'callee'],
      ['_argumentRef', 'argument'],
    ]
    for (let i = 0; i < exprPropPairs.length; i++) {
      const [refKey, propKey] = exprPropPairs[i]
      if (!Object.prototype.hasOwnProperty.call(this, refKey)) continue
      const propVal = (this as any)[propKey]
      if (propVal !== undefined) {
        Object.defineProperty(copy, propKey, {
          value: propVal,
          writable: true,
          enumerable: true,
          configurable: true,
        })
      }
    }
    // Rebuild arguments accessor for CallExprValue clones
    if (Object.prototype.hasOwnProperty.call(this, '_argumentRefs')) {
      Object.defineProperty(copy, 'arguments', {
        get(this: any) {
          if (!this._argumentRefs) return []
          return this._argumentRefs.map((ref: any) => ref?.resolve(this.getSymbolTable()) ?? undefined)
        },
        set(this: any, val: any) {
          this._argumentRefs = Array.isArray(val)
            ? val.map((v: any) => v != null ? this._makeValueRefDirect(v) : null)
            : []
        },
        enumerable: true,
        configurable: true,
      })
    }
    // Rebuild expression accessor for CallExprValue clones
    if (Object.prototype.hasOwnProperty.call(this, '_expressionRef')) {
      Object.defineProperty(copy, 'expression', {
        get(this: any) { return this._expressionRef?.resolve(this.getSymbolTable()) ?? undefined },
        set(this: any, val: any) { this._expressionRef = val != null ? this._makeValueRefDirect(val) : null },
        enumerable: true,
        configurable: true,
      })
    }
    if (copy._taint) copy._taint = copy._taint._clone(copy)
    if (copy.runtime && typeof copy.runtime === 'object') {
      copy.runtime = { ...copy.runtime }
    }
    if (copy.func && typeof copy.func === 'object') {
      copy.func = { ...copy.func }
    }
    if (copy._ast && typeof copy._ast._clone === 'function') {
      copy._ast = copy._ast._clone(copy)
    }
    if (copy._scopeCtx && typeof copy._scopeCtx._clone === 'function') {
      copy._scopeCtx = copy._scopeCtx._clone(copy)
    }
    // Share _members for EntityValue aliases (non-enumerable, not copied by Object.keys)
    if ((this as any)._members) {
      Object.defineProperty(copy, '_members', {
        value: (this as any)._members,
        writable: true,
        enumerable: false,
        configurable: true,
      })
    }
    copy._skipRegister = true
    return copy
  }
}

export = Unit
