import { ValueBase } from './value-base'
import { ValueRef } from './value-ref'
import type Unit from './unit'

interface ExprValueOptions {
  sid?: string
  name?: string
  type?: string
  exprKind?: string
  rst?: Unit | null
  ast?: any
  loc?: any
}

/**
 * ExprValue - 未求值的表达式（延迟计算）
 *
 * operand 属性通过 getter/setter + ValueRef 存储，
 * 外部访问透明 resolve，内部存 UUID，序列化/clone 安全。
 */
export abstract class ExprValue extends ValueBase {
  exprKind: string | undefined
  _rstRef!: ValueRef | null

  constructor(upperQidOrOpts?: string | ExprValueOptions, opts?: ExprValueOptions) {
    const finalOpts = typeof upperQidOrOpts === 'string' ? (opts || {}) : (upperQidOrOpts || {})

    if (typeof upperQidOrOpts === 'string') {
      super('symbol', upperQidOrOpts, finalOpts)
    } else {
      super('symbol', finalOpts)
    }

    this._rstRef = null
    if (finalOpts.exprKind !== undefined) this.exprKind = finalOpts.exprKind
    if (finalOpts.rst !== undefined) this.rst = finalOpts.rst
  }

  get rst(): Unit | null {
    if (!this._rstRef) return null
    return this._rstRef.resolve(this.getSymbolTable())
  }

  set rst(val: Unit | null) {
    this._rstRef = val != null ? this._makeValueRefDirect(val) : null
  }

  abstract get operands(): (Unit | null)[]
}
