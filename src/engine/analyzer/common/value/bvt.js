const _ = require('lodash')
const Unit = require('./unit')
const { hasTag } = require('../../../../util/ast-util')

/**
 *
 */
class BVT extends Unit {
  /**
   *
   * @param opts
   */
  constructor(opts) {
    super({
      vtype: 'BVT',
      ...opts,
    })
    if (!opts.children) {
      this.children = {}
    }
  }

  /**
   *
   */
  getRawValue() {
    const { children } = this
    const tmpArry = Object.values(children).filter((val) => !!val)
    return _.uniqWith(tmpArry, _.isEqual)
  }

  /**
   *
   */
  get hasTagRec() {
    const values = Object.values(this.value)
    return _.isFunction(values?.some) ? values.some((v) => v?.hasTagRec) : null
  }

  /**
   *
   */
  set hasTagRec(value) {
    return hasTag(this)
  }

  /**
   *
   */
  get value() {
    return this.children
  }

  /**
   *
   */
  set value(val) {
    this.children = val
  }

  /**
   *
   * @param tag
   */
  getTrace(tag) {
    return _.find(this.value, (v) => {
      if (_.isFunction(v?._tags?.has) && v._tags.has(tag)) {
        return v.trace
      }
    })
  }

  /**
   *
   * @param tag
   */
  getTaintInfo(tag) {
    const value = _.find(this.value, (v) => {
      return _.isFunction(v?._tags?.has) && v._tags.has(tag)
    })
    if (value) {
      return {
        value,
        trace: value.trace,
      }
    }
  }

  /**
   *
   * @param key
   */
  getMisc(key) {
    const values = this.getRawValue()
    return values.map((val) => val.getMisc(key))
  }
}

module.exports = BVT
