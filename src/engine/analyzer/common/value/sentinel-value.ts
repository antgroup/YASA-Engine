import { ValueBase } from './value-base'

/**
 * SentinelValue - 占位符值基类
 * 
 * 表示特殊状态的值（void/undefined/uninitialized/unknown）
 * 不表示具体的计算结果，仅作为控制流和状态标记
 * 
 * 子类：
 * - VoidValue: 函数无返回值
 * - UndefinedValue: 变量未定义
 * - UninitializedValue: 变量已声明但未赋值
 * - UnknownValue: 无法推断的值
 */
export abstract class SentinelValue extends ValueBase {
  /**
   * 是否为未初始化状态（仅 UninitializedValue 使用）
   */
  uninit?: boolean

  constructor(vtype: string, upperQidOrOpts?: string | Record<string, any>, opts?: Record<string, any>) {
    // 抽象基类构造函数：支持两种调用方式
    // 1. super(vtype, upperQid, opts) - 子类常用
    // 2. super(vtype, opts) - 可选
    if (typeof upperQidOrOpts === 'string') {
      super(vtype, upperQidOrOpts, opts)
    } else {
      super(vtype, upperQidOrOpts)
    }
  }
}
