import { DataValue } from './data-value'

/**
 * TaintedValue - 携带污点标记的值
 *
 * 固定构造函数：具名参数，不使用 opts 对象
 */
export class TaintedValue extends DataValue {
  annotations?: Array<{
    type: string
    value?: any
    [key: string]: any
  }>

  /**
   * @param isTainted - 污点标记（必需）
   * @param sid - 符号 ID（可选）
   * @param qid - 限定 ID（可选）
   * @param annotations - 污点注解（可选）
   */
  constructor(
    isTainted: boolean,
    sid?: string,
    qid?: string,
    annotations?: Array<{ type: string; value?: any; [key: string]: any }>
  ) {
    super('tainted', { sid, qid })
    if (isTainted) this.taint?.markSource()
    this.annotations = annotations
  }
}
