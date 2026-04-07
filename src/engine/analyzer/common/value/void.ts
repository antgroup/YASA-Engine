import { SentinelValue } from './sentinel-value'

/**
 * VoidValue - 无返回值
 * 
 * 用于：Statement 的预期无返回值（区别于 UndefinedValue）
 * 语义：表示操作成功完成但无返回值
 * 
 * 固定属性：
 * - vtype: 'void'
 * - sid/qid: 标识符（默认 '<void>'）
 */
export class VoidValue extends SentinelValue {
  /**
   * Constructor for VoidValue
   * 无参数，sid/qid 固定为 '<void>'
   */
  constructor() {
    super('void', {
      sid: '<void>',
      qid: '<void>',
    })
  }
}
