import { Scoped } from './scoped'

interface ClassValueOptions {
  sid?: string
  parent?: any
  decls?: Record<string, any>
  name?: string
  ast?: any
  value?: any
  field?: any
  annotations?: any
  modifier?: any
  inits?: any
}

/**
 * ClassValue - 类定义
 *
 * 继承 ScopeValue（类体是作用域），固定 vtype='class'
 */
export class ClassValue extends Scoped {
  // 注意：super 在 Unit 中是 accessor（通过 UUID 查符号表），不能在此重新声明为类属性
  // 注意：annotations/modifier/inits 不能声明为类属性（会覆盖 Unit 构造函数中的赋值）
  declare isInterface: boolean

  constructor(upperQid: string, sid: string, parent: any, decls?: Record<string, any>) {
    super(upperQid, {
      sid,
      vtype: 'class',
      parent,
      decls: decls || {},
    })
  }

  /**
   * 从序列化的 opts 对象恢复（仅用于反序列化）
   */
  static override fromOpts(upperQid: string, opts: ClassValueOptions): ClassValue {
    const o = opts || {}
    const cv = new ClassValue(upperQid, o.sid || '<ClassValue>', o.parent, o.decls)
    // 恢复其他属性（通过赋值而非构造函数，因为这些是 Unit 的 accessor）
    if (o.name !== undefined) cv.name = o.name
    if (o.ast !== undefined) cv.ast = o.ast?.node ?? o.ast
    if (o.value !== undefined) cv.value = o.value
    if (o.field !== undefined) cv.value = o.field
    if (o.annotations !== undefined) cv.annotations = o.annotations
    if (o.modifier !== undefined) cv.modifier = o.modifier
    if (o.inits !== undefined) cv.inits = o.inits
    return cv
  }

  /**
   * 从 SymbolValue (vtype='class') 创建 ClassValue，复制所有属性
   */
  static fromSymbolValue(symbolValue: ClassValueOptions & { qid?: string }): ClassValue {
    return ClassValue.fromOpts(symbolValue.qid || '', symbolValue)
  }
}
