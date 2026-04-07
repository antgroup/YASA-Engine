import { SentinelValue } from './sentinel-value'

interface UndefinedValueOptions {
  sid?: string
  qid?: string
  parent?: any
}

/**
 * UndefinedValue class
 *
 * BVT 模式：固定构造函数签名
 */
export class UndefinedValue extends SentinelValue {
  /**
   * 创建 UndefinedValue
   * @param upperQid - 父作用域的 qid（可选，默认 ''）
   * @param sid - 符号 ID（可选，默认 '<undefinedValue>'）
   */
  constructor(upperQid: string = '', sid: string = '<undefinedValue>') {
    super('undefine', upperQid, { sid })
  }

  /**
   * 从序列化的 opts 对象恢复 UndefinedValue（仅用于反序列化）
   */
  static fromOpts(upperQid: string, opts: UndefinedValueOptions): UndefinedValue {
    const sid = opts?.sid || '<undefinedValue>'
    const qid = opts?.qid
    const parent = opts?.parent
    const undefinedValue = new UndefinedValue(upperQid, sid)
    // 反序列化时恢复原始属性
    if (qid) {
      undefinedValue._qid = qid
    }
    if (parent) {
      undefinedValue.parent = parent
    }
    return undefinedValue
  }
}
