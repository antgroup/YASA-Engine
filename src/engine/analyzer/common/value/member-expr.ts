import { ExprValue } from './expr-value'
import { ValueRef } from './value-ref'
import type Unit from './unit'

interface MemberExprOptions {
  object?: Unit | null
  property?: Unit | null
  computed?: boolean
  ast?: any
  loc?: any
}

/**
 * MemberExprValue - 成员访问表达式（a.b, a[b]）
 *
 * object/property 通过 instance-level own enumerable accessor properties 实现：
 * - 内部走 _objectRef/_propertyRef (ValueRef) 存储
 * - hasOwnProperty('object') 返回 true（satisfy() 遍历兼容）
 * - for...in 可枚举（enumerable: true）
 */
export class MemberExprValue extends ExprValue {
  _objectRef!: ValueRef | null
  _propertyRef!: ValueRef | null
  declare object: Unit | null
  declare property: Unit | null
  computed: boolean

  constructor(upperQid: string, object: Unit | null, property: Unit | null, computed: boolean, ast: any, loc: any) {
    const propStr = computed ? '[...]' : `.${property?.name || property?.sid || '?'}`
    const sid = `<memberExp${propStr}_${loc?.start?.line}_${loc?.start?.column}>`
    super(upperQid, {
      sid,
      exprKind: 'member',
      type: 'MemberAccess',
      ast,
      loc,
    })
    this.computed = computed
    Object.defineProperty(this, '_objectRef', { value: this._makeValueRefDirect(object), writable: true, enumerable: false, configurable: true })
    Object.defineProperty(this, '_propertyRef', { value: this._makeValueRefDirect(property), writable: true, enumerable: false, configurable: true })
    Object.defineProperty(this, 'object', {
      get(this: MemberExprValue) { return this._objectRef?.resolve(this.getSymbolTable()) ?? null },
      set(this: MemberExprValue, val: Unit | null) { this._objectRef = val != null ? this._makeValueRefDirect(val) : null },
      enumerable: true,
      configurable: true,
    })
    Object.defineProperty(this, 'property', {
      get(this: MemberExprValue) { return this._propertyRef?.resolve(this.getSymbolTable()) ?? null },
      set(this: MemberExprValue, val: Unit | null) { this._propertyRef = val != null ? this._makeValueRefDirect(val) : null },
      enumerable: true,
      configurable: true,
    })
  }

  static fromOpts(upperQid: string, opts: MemberExprOptions): MemberExprValue {
    const o = opts || {}
    return new MemberExprValue(
      upperQid,
      o.object ?? null,
      o.property ?? null,
      o.computed || false,
      o.ast?.node ?? o.ast,
      o.loc,
    )
  }

  get operands(): (Unit | null)[] {
    const ops: (Unit | null)[] = []
    if (this._objectRef) ops.push(this.object)
    if (this._propertyRef) ops.push(this.property)
    return ops
  }
}
