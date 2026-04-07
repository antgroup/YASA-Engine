import { Scoped } from './scoped'
import type Unit from './unit'
import type { FuncMeta } from './value-base'

export interface FunctionValueOptions {
  sid?: string
  qid?: string
  name?: string
  parent?: Unit | null
  _this?: Unit | null
  exports?: any
  ast?: any
  fdef?: any
  overloaded?: any[]
  decls?: Record<string, any>
  execute?: ((...args: any[]) => any) | null
  func?: FuncMeta
  loc?: any
  value?: any
  field?: any
  _meta?: any

  arguments?: any[]
  functionName?: string
  decorators?: any[]
  id?: any
  attribute?: string
  filePath?: string
  receiverType?: string
  params?: any
  results?: any

  superDef?: any
  jumpLocate?: ((val: any, qid: any, scope: any) => any) | null
  inherited?: boolean
  typeArguments?: any
  typeParams?: any
}

/**
 * FunctionValue class
 */
export class FunctionValue extends Scoped {
  declare func?: FuncMeta
  declare _isConstructor: boolean

  declare arguments?: any[]
  declare functionName?: string
  declare decorators?: any[]
  declare id?: any
  declare attribute?: string
  declare filePath?: string
  declare receiverType?: string
  declare params?: any
  declare results?: any

  constructor(upperQidOrOpts?: string | FunctionValueOptions, opts?: FunctionValueOptions) {
    const finalOpts = typeof upperQidOrOpts === 'string' ? (opts || {}) : (upperQidOrOpts || {})

    // Override vtype for FunctionValue
    const optsWithVtype = { ...finalOpts, vtype: 'fclos' }

    if (typeof upperQidOrOpts === 'string') {
      super(upperQidOrOpts, optsWithVtype)
    } else {
      super(optsWithVtype)
    }
    this._isConstructor = false

    // FunctionValue-specific properties
    if ('func' in finalOpts) this.func = finalOpts.func
    if ('receiverType' in finalOpts) this.receiverType = finalOpts.receiverType
    if ('filePath' in finalOpts) this.filePath = finalOpts.filePath
    if ('superDef' in finalOpts) this.superDef = finalOpts.superDef
    if ('jumpLocate' in finalOpts) this.jumpLocate = finalOpts.jumpLocate
    if ('inherited' in finalOpts) this.inherited = finalOpts.inherited
    if ('attribute' in finalOpts) this.attribute = finalOpts.attribute
    if ('params' in finalOpts) this.params = finalOpts.params
    if ('results' in finalOpts) this.results = finalOpts.results
    if ('typeArguments' in finalOpts) this.typeArguments = finalOpts.typeArguments
    if ('typeParams' in finalOpts) this.typeParams = finalOpts.typeParams
  }

  /**
   * 从序列化的 opts 对象恢复 FunctionValue（仅用于反序列化）
   */
  static override fromOpts(upperQid: string, opts: FunctionValueOptions): FunctionValue {
    const functionValue = new FunctionValue(upperQid, opts)
    // 反序列化时恢复原始 qid
    if (opts?.qid) {
      functionValue._qid = opts.qid
    }
    if (opts?.parent) {
      functionValue.parent = opts.parent
    }
    return functionValue
  }
}
