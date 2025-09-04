const Unit = require('./unit')
const { hasTag } = require('../../../../util/ast-util')

module.exports = class ObjectValue extends Unit {
  /**
   *
   * @param opts
   */
  constructor(opts) {
    super({
      vtype: 'object',
      ...opts,
    })
    this.rtype = opts._meta?.type
  }

  /**
   *
   */
  get hasTagRec() {
    return hasTag(this)
  }

  /**
   *
   */
  set hasTagRec(val) {
    this._has_tags = val
  }
}
