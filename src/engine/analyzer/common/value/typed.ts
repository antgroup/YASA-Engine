import { DataValue, RType } from './data-value'

/**
 * TypedValue - 仅有类型信息的值
 *
 * 用于：Java/Go 等静态类型语言中需要类型推断的场景
 *
 * 固定构造函数：具名参数，不使用 opts 对象
 */
export class TypedValue extends DataValue {
  override rtype: RType

  /**
   * @param rtype - 类型信息（必需）
   * @param sid - 符号 ID（可选）
   * @param qid - 限定 ID（可选）
   */
  constructor(
    rtype: RType,
    sid?: string,
    qid?: string
  ) {
    super('typed', {
      sid,
      qid,
    })
    this.rtype = rtype
  }
}
