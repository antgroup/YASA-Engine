import { ValueBase } from './value-base'

/**
 * 运行时类型信息接口
 *
 * 用于 Java/Go 等静态类型语言的类型推断和传播
 */
export interface RType {
  /**
   * 类型名称（如 "PointerType"）
   */
  type?: string

  /**
   * 确定类型：AST Identifier node 或类型字符串
   *
   * 通常由 UastSpec.identifier() 生成或直接使用 node.varType.id
   */
  definiteType?: any

  /**
   * 模糊类型路径（如 "com.example.Foo.bar"）
   *
   * 用于成员访问时的类型路径追踪
   */
  vagueType?: string

  /**
   * 指针类型的元素类型（Go 特有）
   */
  element?: any
}

/**
 * DataValue - 有确定类型的计算结果
 *
 * 表示具有明确类型和值的数据（与 SentinelValue 的占位符、ExprValue 的未求值相对）
 *
 * 子类：
 * - PrimitiveValue: 基本类型字面量
 * - BVTValue: 分支值树
 * - UnionValue: 联合值
 * - TypedValue: 仅有类型信息
 * - TaintedValue: 携带污点标记
 * - SpreadValue: 展开运算结果
 */
export abstract class DataValue extends ValueBase {
  /**
   * AST 节点类型（DataValue 必需）
   */
  declare type: string

  /**
   * 运行时类型信息（DataValue 必需）
   */
  declare rtype: RType

  constructor(vtype: string, upperQidOrOpts?: string | any, opts?: any) {
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
