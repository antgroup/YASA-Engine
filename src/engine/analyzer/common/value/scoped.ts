import { handleException } from '../exception-handler'
import { EntityValue } from './entity-value'
import type Unit from './unit'
const logger = require('../../../../util/logger')(__filename)

export interface ScopedOptions {
  sid?: string
  qid?: string
  name?: string
  vtype?: string
  
  parent?: Unit | null
  _this?: Unit | null
  
  decls?: Record<string, any>
  
  loc?: any
  ast?: any
  value?: any
  field?: any
  _meta?: any

  declarationMap?: any
  context?: any
  spring?: any
  beanMap?: any
  springReferenceMap?: any
  springServiceMap?: any
}

/**
 * Scoped class
 */
export class Scoped extends EntityValue {
  override name: string | undefined

  declare symbolTable?: any
  declare funcSymbolTable?: any
  declare invocationMap?: any
  declare isProcessed?: boolean
  declare updates?: any
  declare context?: any
  declare pointerReference?: boolean

  constructor(upperQidOrOpts?: string | ScopedOptions, opts?: ScopedOptions) {
    const finalOpts: any = typeof upperQidOrOpts === 'string' ? (opts || {}) : (upperQidOrOpts || {})
    
    if (typeof upperQidOrOpts === 'string') {
      super('scope', upperQidOrOpts, finalOpts)
    } else {
      super('scope', finalOpts)
    }
    
    this.name = finalOpts.name

    // Scoped-specific properties
    if ('declarationMap' in finalOpts) this.declarationMap = finalOpts.declarationMap
    if ('context' in finalOpts) this.context = finalOpts.context
    if ('spring' in finalOpts) this.spring = finalOpts.spring
    if ('beanMap' in finalOpts) this.beanMap = finalOpts.beanMap
    if ('springReferenceMap' in finalOpts) this.springReferenceMap = finalOpts.springReferenceMap
    if ('springServiceMap' in finalOpts) this.springServiceMap = finalOpts.springServiceMap

    if (this.parent === undefined) {
      handleException(
        null,
        'parent is not set when creating scope value',
        'parent is not set when creating scope value'
      )
    }
  }

  /**
   * 从序列化的 opts 对象恢复 Scoped（仅用于反序列化）
   */
  static fromOpts(upperQid: string, opts: ScopedOptions): Scoped {
    const scoped = new Scoped(upperQid, opts)
    // 反序列化时恢复原始 qid
    if (opts?.qid) {
      scoped._qid = opts.qid
    }
    if (opts?.parent) {
      scoped.parent = opts.parent
    }
    return scoped
  }
}
