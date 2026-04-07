import { ExprValue } from './expr-value'
import { ValueRef } from './value-ref'
import type Unit from './unit'

interface UnaryExprOptions {
  operator?: string
  argument?: Unit | null
  ast?: any
  loc?: any
  isSuffix?: boolean
}

/**
 * UnaryExprValue - 一元运算表达式（++i, -x, !flag, ...）
 *
 * argument 通过 instance-level own enumerable accessor 实现：
 * - 内部走 _argumentRef (ValueRef) 存储
 * - hasOwnProperty('argument') 返回 true（satisfy() 遍历兼容）
 */
export class UnaryExprValue extends ExprValue {
  _argumentRef!: ValueRef | null
  declare argument: Unit | null
  operator: string
  isSuffix: boolean

  constructor(upperQid: string, operator: string, argument: Unit | null, ast: any, loc: any, isSuffix: boolean = true) {
    const sid = `<operatorExp_${operator}_${loc?.start?.line}_${loc?.start?.column}_${loc?.end?.line}_${loc?.end?.column}>`
    super(upperQid, {
      sid,
      exprKind: 'unary',
      type: 'UnaryExpression',
      ast,
      loc,
    })
    this.operator = operator
    this.isSuffix = isSuffix
    Object.defineProperty(this, '_argumentRef', { value: this._makeValueRefDirect(argument), writable: true, enumerable: false, configurable: true })
    Object.defineProperty(this, 'argument', {
      get(this: UnaryExprValue) { return this._argumentRef?.resolve(this.getSymbolTable()) ?? null },
      set(this: UnaryExprValue, val: Unit | null) { this._argumentRef = val != null ? this._makeValueRefDirect(val) : null },
      enumerable: true,
      configurable: true,
    })
  }

  static fromOpts(upperQid: string, opts: UnaryExprOptions): UnaryExprValue {
    const o = opts || {}
    return new UnaryExprValue(
      upperQid,
      o.operator || '',
      o.argument ?? null,
      o.ast?.node ?? o.ast,
      o.loc,
      o.isSuffix !== undefined ? o.isSuffix : true,
    )
  }

  get operands(): (Unit | null)[] {
    return this._argumentRef ? [this.argument] : []
  }
}
