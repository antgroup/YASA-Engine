import { ExprValue } from './expr-value'
import type Unit from './unit'

export interface IdentifierRefOptions {
  nameRef?: string
  name?: string
  sid?: string
  ast?: any
  loc?: any
  refKind?: string
  qid?: string
  parent?: any
}

/**
 * IdentifierRefValue - 标识符引用（变量名/类型名/标签名）
 * 表示无法 resolve 的标识符引用
 */
export class IdentifierRefValue extends ExprValue {
  nameRef: string
  refKind?: string

  constructor(upperQid: string, nameRef: string, ast: any, loc: any, refKind?: string) {
    super(upperQid, {
      sid: nameRef,
      exprKind: 'identifier',
      type: 'Identifier',
      name: nameRef,  // 必须通过 opts 传入，Unit 会设置为 own property
      ast,
      loc,
    })
    this.nameRef = nameRef
    if (refKind !== undefined) {
      this.refKind = refKind
    }
  }

  /**
   * 从序列化的 opts 对象恢复（仅用于反序列化）
   */
  static fromOpts(upperQid: string, opts: IdentifierRefOptions): IdentifierRefValue {
    const o = opts || {}
    return new IdentifierRefValue(
      upperQid,
      o.nameRef || o.name || o.sid || '',
      o.ast?.node ?? o.ast,
      o.loc,
      o.refKind,
    )
  }

  get operands(): (Unit | null)[] {
    return []
  }
}
