import { DataValue } from './data-value'
import type { Value } from '../../../../types/value'

/**
 * SpreadValue - 展开运算结果
 * 
 * 固定构造函数：具名参数，不使用 opts 对象
 */
export class SpreadValue extends DataValue {
  elements: Value[]

  /**
   * @param elements - 展开后的元素列表（必需）
   * @param isTainted - 污点标记（必需）
   * @param sid - 符号 ID（可选）
   * @param qid - 限定 ID（可选）
   */
  constructor(
    elements: Value[],
    isTainted: boolean,
    sid?: string,
    qid?: string
  ) {
    super('spread', { sid, qid })
    this.elements = elements
    if (isTainted) this.taint?.markSource()
  }
}
