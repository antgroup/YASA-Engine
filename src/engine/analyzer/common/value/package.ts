import { Scoped } from './scoped'
import type Unit from './unit'
const { Errors } = require('../../../../util/error-code')

export interface PackageValueOptions {
  sid?: string
  qid?: string
  name?: string
  vtype?: string
  parent?: Unit | null
  _this?: Unit | null
  loc?: any
  ast?: any
  value?: any
  field?: any
  _meta?: any
}

/**
 * PackageValue class
 */
export class PackageValue extends Scoped {
  declare packageProcessed?: boolean

  constructor(upperQidOrOpts: string | PackageValueOptions, opts?: PackageValueOptions) {
    const finalOpts = typeof upperQidOrOpts === 'string' ? (opts || {}) : (upperQidOrOpts || {})
    
    // Override vtype for PackageValue
    const optsWithVtype = { ...finalOpts, vtype: 'package' }
    
    if (typeof upperQidOrOpts === 'string') {
      super(upperQidOrOpts, optsWithVtype)
    } else {
      super(optsWithVtype)
    }
  }

  /**
   * 从序列化的 opts 对象恢复 PackageValue（仅用于反序列化）
   */
  static override fromOpts(upperQid: string, opts: PackageValueOptions): PackageValue {
    const packageValue = new PackageValue(upperQid, opts)
    // 反序列化时恢复原始 qid
    if (opts?.qid) {
      packageValue._qid = opts.qid
    }
    if (opts?.parent) {
      packageValue.parent = opts.parent
    }
    return packageValue
  }

  /**
   *
   * @param ids
   * @param createIfNotExists
   */
  getSubPackage(ids: string | string[], createIfNotExists?: boolean): any {
    if (typeof ids !== 'string') {
      // error should not be thrown out
      try {
        Errors.IllegalUse('getSubPackage ids should not be empty')
      } catch (e) {}
      return undefined
    }

    if (!Array.isArray(ids)) {
      ids = ids.split('.')
    }

    let fval: any = this
    for (let i = 0; i < ids.length; i++) {
      const fname = ids[i]
      let sub_fval = fval.members?.get(fname) ?? fval.getMemberValue?.(fname)
      if (!sub_fval) {
        if (createIfNotExists) {
          sub_fval = new PackageValue(`${fval.qid}.${fname}`, {
            vtype: 'package',
            sid: fname,
            qid: `${fval.qid}.${fname}`,
            parent: this,
          })
          sub_fval.scope.exports = new Scoped(`${fval.qid}.${fname}.exports`, {
            sid: 'exports',
            parent: null,
          })
          if (fval.members) {
            fval.members.set(fname, sub_fval)
          } else {
            fval.setFieldValue(fname, sub_fval)
          }
        } else {
          // Errors.UnexpectedValue(`getFieldValue: ${i} is not in ${sub_fval.sid}`, {no_throw: true});
          return
        }
      }
      fval = sub_fval
    }

    return fval
  }
}
