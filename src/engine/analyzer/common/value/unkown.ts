import { SentinelValue } from './sentinel-value'

interface UnknownValueOptions {
  sid?: string
  qid?: string
}

/**
 * UnknownValue - 未知类型的值
 *
 * BVT 模式：固定构造函数签名
 */
export class UnknownValue extends SentinelValue {
  /**
   * 创建 UnknownValue
   * @param upperQid - 父作用域的 qid（可选，默认 ''）
   * @param sid - 符号 ID（可选，默认 '<unknownValue>'）
   */
  constructor(upperQid: string = '', sid: string = '<unknownValue>') {
    super('unknown', upperQid, { sid })
  }

  /**
   * 从序列化的 opts 对象恢复 UnknownValue（仅用于反序列化）
   */
  static fromOpts(upperQid: string, opts: UnknownValueOptions): UnknownValue {
    const sid = opts?.sid || '<unknownValue>'
    const qid = opts?.qid
    const unknownValue = new UnknownValue(upperQid, sid)
    // 反序列化时恢复原始 qid
    if (qid) {
      unknownValue._qid = qid
    }
    return unknownValue
  }
}
