import { ObjectValue } from './object'
import type Unit from './unit'

export interface SymbolicValueOptions {
  sid?: string
  qid?: string
  name?: string
  vtype?: string
  type?: string
  
  object?: Unit | null
  property?: any
  annotations?: any[]
  argument?: Unit | null
  left?: Unit | null
  right?: Unit | null
  operator?: string
  expression?: Unit | null
  arguments?: any[]
  
  parent?: Unit | null
  _this?: Unit | null
  
  loc?: any
  ast?: any
  value?: any
  field?: any
  _meta?: any
  [key: string]: any
}

/**
 * SymbolValue class
 */
export class SymbolValue extends ObjectValue {
  object?: Unit | null
  property?: any
  annotations?: any[]
  argument?: Unit | null
  left?: Unit | null
  right?: Unit | null
  operator?: string
  expression?: Unit | null
  arguments?: any[]

  constructor(upperQidOrOpts?: string | SymbolicValueOptions, opts?: SymbolicValueOptions) {
    const finalOpts = typeof upperQidOrOpts === 'string' ? (opts || {}) : (upperQidOrOpts || {})
    
    // Ensure parent is set
    finalOpts.parent = finalOpts.parent || null
    
    // Override vtype for SymbolValue
    const optsWithVtype = { ...finalOpts, vtype: 'symbol' }
    
    if (typeof upperQidOrOpts === 'string') {
      super(upperQidOrOpts, optsWithVtype)
    } else {
      super(optsWithVtype)
    }

    if (finalOpts.object !== undefined) this.object = finalOpts.object
    if (finalOpts.property !== undefined) this.property = finalOpts.property
    if (finalOpts.annotations !== undefined) this.annotations = finalOpts.annotations
    if (finalOpts.argument !== undefined) this.argument = finalOpts.argument
    if (finalOpts.left !== undefined) this.left = finalOpts.left
    if (finalOpts.right !== undefined) this.right = finalOpts.right
    if (finalOpts.operator !== undefined) this.operator = finalOpts.operator
    if (finalOpts.expression !== undefined) this.expression = finalOpts.expression
    if (finalOpts.arguments !== undefined) this.arguments = finalOpts.arguments

    // remove parent if it is assigned from ast than value
    if (!this.parent?.vtype) {
      this.parent = null
    }
  }

  /**
   * 从序列化的 opts 对象恢复 SymbolValue（仅用于反序列化）
   */
  static override fromOpts(upperQid: string, opts: SymbolicValueOptions): SymbolValue {
    const symbolValue = new SymbolValue(upperQid, opts)
    // 反序列化时恢复原始 qid
    if (opts?.qid) {
      symbolValue._qid = opts.qid
    }
    if (opts?.parent) {
      symbolValue.parent = opts.parent
    }
    return symbolValue
  }
}
