const Unit = require('./unit')
const astUtil = require('../../../../util/ast-util')

interface ObjectValueOptions {
  _meta?: {
    type?: any
    [key: string]: any
  }
  [key: string]: any
}

/**
 * ObjectValue class
 */
module.exports = class ObjectValue extends Unit {
  rtype: any

  _has_tags: boolean | undefined

  /**
   * Constructor for ObjectValue
   * @param opts - Options for constructing ObjectValue
   */
  constructor(opts?: ObjectValueOptions) {
    super({
      vtype: 'object',
      ...opts,
    })
    this.rtype = opts?._meta?.type
  }

  /**
   * Check if this object has a tag recursively
   */
  get hasTagRec(): boolean {
    return astUtil.hasTag(this, null)
  }

  /**
   * Set hasTagRec
   * @param val - Value to set
   */
  set hasTagRec(val: boolean) {
    this._has_tags = val
  }
}
