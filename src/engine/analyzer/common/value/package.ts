const Scoped = require('./scoped')
const { Errors } = require('../../../../util/error-code')

module.exports = class PackageValue extends Scoped {
  /**
   *
   * @param opts
   */
  constructor(opts: any) {
    super({
      vtype: 'package',
      ...opts,
    })
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
      return new PackageValue({
        vtype: 'unknown',
      })
    }

    if (!Array.isArray(ids)) {
      ids = ids.split('.')
    }

    let fval: any = this
    for (let i = 0; i < ids.length; i++) {
      const fname = ids[i]
      let sub_fval: any
      if (Object.prototype.hasOwnProperty.call(fval.field, fname)) {
        sub_fval = fval.field[fname]
      }
      if (!sub_fval) {
        if (createIfNotExists) {
          sub_fval = new PackageValue({
            vtype: 'package',
            sid: fname,
            qid: fval.qid ? `${fval.qid}.${fname}` : fname,
            exports: new Scoped({
              sid: 'exports',
              id: 'exports',
              parent: null,
            }),
            parent: this,
          })
          fval.field[fname] = sub_fval
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
