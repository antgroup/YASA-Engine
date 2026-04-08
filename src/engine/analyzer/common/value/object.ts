import { EntityValue } from './entity-value'
import type Unit from './unit'
const astUtil = require('../../../../util/ast-util')
const { TaintRecord, NULL_TAINT } = require('./taint-record')

export interface ObjectValueOptions {
  sid?: string
  qid?: string
  name?: string
  _meta?: {
    type?: any
    [key: string]: any
  }
  parent?: Unit | null
  _this?: Unit | null
  loc?: any
  ast?: any
  value?: any
  field?: any

  injected?: boolean
  keyType?: string
  valueType?: string
  size?: number
  element?: Unit | null
  length?: number
  node_module?: boolean

  uninit?: boolean
  definiteType?: string
  vagueType?: string
  literalType?: string
}

/**
 * ObjectValue class
 */
export class ObjectValue extends EntityValue {
  declare injected?: boolean
  declare keyType?: string
  declare valueType?: string
  declare size?: number
  declare element?: Unit | null
  declare length?: number
  declare node_module?: boolean

  constructor(upperQidOrOpts?: string | ObjectValueOptions, opts?: ObjectValueOptions) {
    const finalOpts = typeof upperQidOrOpts === 'string' ? (opts || {}) : (upperQidOrOpts || {})
    
    if (typeof upperQidOrOpts === 'string') {
      super('object', upperQidOrOpts, finalOpts)
    } else {
      super('object', finalOpts)
    }
    
    this.rtype = finalOpts._meta?.type
    // 递归类型必须有独立 TaintRecord（isTaintedRec 需要 _owner）
    if (this.taint === NULL_TAINT) this.taint = new TaintRecord(this)
    this.taint.markRecursive()

    // ObjectValue-specific properties
    if ('element' in finalOpts) this.element = finalOpts.element
    if ('uninit' in finalOpts) this.uninit = finalOpts.uninit
    if ('definiteType' in finalOpts) this.definiteType = finalOpts.definiteType
    if ('keyType' in finalOpts) this.keyType = finalOpts.keyType
    if ('node_module' in finalOpts) this.node_module = finalOpts.node_module
    if ('injected' in finalOpts) this.injected = finalOpts.injected
    if ('vagueType' in finalOpts) this.vagueType = finalOpts.vagueType
    if ('valueType' in finalOpts) this.valueType = finalOpts.valueType
    if ('size' in finalOpts) this.size = finalOpts.size
    if ('length' in finalOpts) this.length = finalOpts.length
    if ('literalType' in finalOpts) this.literalType = finalOpts.literalType
  }



  static fromOpts(upperQid: string, opts: ObjectValueOptions): ObjectValue {
    const objectValue = new ObjectValue(upperQid, opts)
    // 反序列化时恢复原始 qid
    if (opts?.qid) {
      objectValue._qid = opts.qid
    }
    if (opts?.parent) {
      objectValue.parent = opts.parent
    }
    return objectValue
  }

}
