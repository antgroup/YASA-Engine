import { SentinelValue } from './sentinel-value'

interface UninitializedValueOptions {
  sid?: string
  qid?: string
  ast?: any
  parent?: any
}

/**
 * UninitializedValue - 未初始化的值
 *
 * BVT 模式：固定构造函数签名
 */
export class UninitializedValue extends SentinelValue {
  /**
   * 创建 UninitializedValue
   * @param upperQid - 父作用域的 qid（可选，默认 ''）
   * @param sid - 符号 ID（可选，默认 '<uninitializedValue>'）
   * @param ast - AST 节点（可选）
   */
  constructor(upperQid: string = '', sid: string = '<uninitializedValue>', ast?: any) {
    super('uninitialized', upperQid, { sid })
    // ast 通过基类的 accessor 赋值（不重新声明）
    if (ast !== undefined) {
      this.ast = ast
    }
  }

  /**
   * 从序列化的 opts 对象恢复 UninitializedValue（仅用于反序列化）
   */
  static fromOpts(upperQid: string, opts: UninitializedValueOptions): UninitializedValue {
    const sid = opts?.sid || '<uninitializedValue>'
    const ast = opts?.ast
    const qid = opts?.qid
    const parent = opts?.parent
    const uninitializedValue = new UninitializedValue(upperQid, sid, ast)
    // 反序列化时恢复原始属性
    if (qid) {
      uninitializedValue._qid = qid
    }
    if (parent) {
      uninitializedValue.parent = parent
    }
    return uninitializedValue
  }
}
