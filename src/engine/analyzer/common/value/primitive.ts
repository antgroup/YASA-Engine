import { DataValue } from './data-value'

export interface PrimitiveValueOptions {
  sid?: string
  qid?: string
  parent?: any
  value?: any
  literalType?: 'string' | 'number' | 'boolean' | 'null' | null
  type?: string
  loc?: any
  ast?: any
}

/**
 * PrimitiveValue - 基本类型字面量
 * 
 * 固定构造函数：具名参数，不使用 opts 对象
 * sid 必须由调用者提供（因为它依赖上下文语义）
 */
export class PrimitiveValue extends DataValue {
  literalType: 'string' | 'number' | 'boolean' | 'null' | null

  /**
   * @param upperQid - 父作用域 qid
   * @param sid - 符号 ID（必须由调用者提供）
   * @param value - 字面量值
   * @param literalType - 字面量类型（可选，自动推断）
   * @param type - AST 节点类型（可选，默认 'Literal'）
   * @param loc - 源码位置（可选）
   * @param ast - AST 节点（可选）
   */
  constructor(
    upperQid: string,
    sid: string,
    value: any,
    literalType?: 'string' | 'number' | 'boolean' | 'null' | null,
    type?: string,
    loc?: any,
    ast?: any
  ) {
    // 不自动推断 literalType，保持调用者传入的值（可以是 null/undefined）
    const finalLiteralType = literalType ?? null
    
    super('primitive', upperQid, {
      sid,
      value,
      type: type || 'Literal',
      literalType: finalLiteralType,
      loc,
      ast: ast || null,
    })
    
    this.literalType = finalLiteralType
    this.type = type || 'Literal'
    this.rtype = {}
  }

  /**
   * 从序列化的 opts 对象恢复（仅用于反序列化）
   */
  static fromOpts(upperQid: string, opts: PrimitiveValueOptions): PrimitiveValue {
    const sid = opts?.sid || 'undefined'
    const value = opts?.value
    const literalType = opts?.literalType
    const type = opts?.type || 'Literal'
    const loc = opts?.loc
    const ast = opts?.ast
    
    const primitive = new PrimitiveValue(upperQid, sid, value, literalType, type, loc, ast)
    
    // 反序列化时恢复原始 qid
    if (opts?.qid) {
      primitive._qid = opts.qid
    }
    if (opts?.parent) {
      primitive.parent = opts.parent
    }
    
    return primitive
  }
}
