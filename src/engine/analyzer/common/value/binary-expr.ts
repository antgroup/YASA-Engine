import { ExprValue } from './expr-value'
import { ValueRef } from './value-ref'
import type Unit from './unit'

interface BinaryExprOptions {
  operator?: string
  left?: Unit | null
  right?: Unit | null
  ast?: any
  loc?: any
  arithAssign?: boolean
}

/**
 * BinaryExprValue - 二元运算表达式（a + b, a > b, ...）
 *
 * left/right 通过 instance-level own enumerable accessor properties 实现：
 * - 内部走 _leftRef/_rightRef (ValueRef) 存储
 * - hasOwnProperty('left') 返回 true（satisfy() 遍历兼容）
 * - for...in 可枚举（enumerable: true）
 */
export class BinaryExprValue extends ExprValue {
  _leftRef!: ValueRef | null
  _rightRef!: ValueRef | null
  declare left: Unit | null
  declare right: Unit | null
  operator: string
  arithAssign: boolean

  constructor(upperQid: string, operator: string, left: Unit | null, right: Unit | null, ast: any, loc: any, arithAssign: boolean = false) {
    const sid = `<operatorExp_${operator}_${loc?.start?.line}_${loc?.start?.column}_${loc?.end?.line}_${loc?.end?.column}>`
    super(upperQid, {
      sid,
      exprKind: 'binary',
      type: 'BinaryExpression',
      ast,
      loc,
    })
    this.operator = operator
    this.arithAssign = arithAssign
    Object.defineProperty(this, '_leftRef', { value: this._makeValueRefDirect(left), writable: true, enumerable: false, configurable: true })
    Object.defineProperty(this, '_rightRef', { value: this._makeValueRefDirect(right), writable: true, enumerable: false, configurable: true })
    Object.defineProperty(this, 'left', {
      get(this: BinaryExprValue) { return this._leftRef?.resolve(this.getSymbolTable()) ?? null },
      set(this: BinaryExprValue, val: Unit | null) { this._leftRef = val != null ? this._makeValueRefDirect(val) : null },
      enumerable: true,
      configurable: true,
    })
    Object.defineProperty(this, 'right', {
      get(this: BinaryExprValue) { return this._rightRef?.resolve(this.getSymbolTable()) ?? null },
      set(this: BinaryExprValue, val: Unit | null) { this._rightRef = val != null ? this._makeValueRefDirect(val) : null },
      enumerable: true,
      configurable: true,
    })
  }

  static fromOpts(upperQid: string, opts: BinaryExprOptions): BinaryExprValue {
    const o = opts || {}
    return new BinaryExprValue(
      upperQid,
      o.operator || '',
      o.left ?? null,
      o.right ?? null,
      o.ast?.node ?? o.ast,
      o.loc,
      o.arithAssign || false,
    )
  }

  get operands(): (Unit | null)[] {
    const ops: (Unit | null)[] = []
    if (this._leftRef) ops.push(this.left)
    if (this._rightRef) ops.push(this.right)
    return ops
  }
}
