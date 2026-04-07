import { ExprValue } from './expr-value'
import { ValueRef } from './value-ref'
import type Unit from './unit'

interface CallExprOptions {
  callee?: Unit | null
  arguments?: (Unit | null)[]
  ast?: any
  loc?: any
  expression?: Unit | null
}

/**
 * CallExprValue - 函数调用表达式（f(a, b)）
 *
 * callee/arguments/expression: instance-level own enumerable accessor + ValueRef 存储
 * arguments getter 返回 resolved 数组，setter 整体替换 _argumentRefs
 */
export class CallExprValue extends ExprValue {
  _calleeRef!: ValueRef | null
  _argumentRefs!: (ValueRef | null)[]
  _expressionRef!: ValueRef | null
  declare callee: Unit | null
  declare arguments: (Unit | null)[]
  declare expression: Unit | null

  constructor(upperQid: string, callee: Unit | null, args: (Unit | null)[], ast: any, loc: any, expression?: Unit | null) {
    const sid = `<callExp_${loc?.start?.line}_${loc?.start?.column}>`
    super(upperQid, {
      sid,
      exprKind: 'call',
      type: 'FunctionCall',
      ast,
      loc,
    })
    Object.defineProperty(this, '_calleeRef', { value: this._makeValueRefDirect(callee), writable: true, enumerable: false, configurable: true })
    Object.defineProperty(this, '_argumentRefs', { value: (args || []).map((v: Unit | null) => this._makeValueRefDirect(v)), writable: true, enumerable: false, configurable: true })

    Object.defineProperty(this, 'callee', {
      get(this: CallExprValue) { return this._calleeRef?.resolve(this.getSymbolTable()) ?? null },
      set(this: CallExprValue, val: Unit | null) { this._calleeRef = val != null ? this._makeValueRefDirect(val) : null },
      enumerable: true,
      configurable: true,
    })

    Object.defineProperty(this, 'arguments', {
      get(this: CallExprValue) {
        if (!this._argumentRefs) return []
        return this._argumentRefs.map((ref: ValueRef | null) => ref?.resolve(this.getSymbolTable()) ?? null)
      },
      set(this: CallExprValue, val: (Unit | null)[]) {
        this._argumentRefs = Array.isArray(val)
          ? val.map((v: Unit | null) => v != null ? this._makeValueRefDirect(v) : null)
          : []
      },
      enumerable: true,
      configurable: true,
    })

    if (expression !== undefined) {
      Object.defineProperty(this, '_expressionRef', { value: this._makeValueRefDirect(expression), writable: true, enumerable: false, configurable: true })
      Object.defineProperty(this, 'expression', {
        get(this: CallExprValue) { return this._expressionRef?.resolve(this.getSymbolTable()) ?? null },
        set(this: CallExprValue, val: Unit | null) { this._expressionRef = val != null ? this._makeValueRefDirect(val) : null },
        enumerable: true,
        configurable: true,
      })
    }
  }

  static fromOpts(upperQid: string, opts: CallExprOptions): CallExprValue {
    const o = opts || {}
    return new CallExprValue(
      upperQid,
      o.callee ?? null,
      o.arguments || [],
      o.ast?.node ?? o.ast,
      o.loc,
      o.expression ?? null,
    )
  }

  get operands(): (Unit | null)[] {
    const ops: (Unit | null)[] = []
    if (this._calleeRef) ops.push(this.callee)
    if (this._argumentRefs) {
      for (const ref of this._argumentRefs) {
        if (ref) {
          const val = ref.resolve(this.getSymbolTable())
          if (val !== undefined) ops.push(val)
        }
      }
    }
    return ops
  }
}
