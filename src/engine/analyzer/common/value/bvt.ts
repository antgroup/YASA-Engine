const _ = require('lodash')
const Unit = require('./unit')
const astUtil = require('../../../../util/ast-util')

/**
 * BVT (Basic Value Type) class
 */
class BVT extends Unit {
  children!: Record<string, any>

  /**
   * Constructor for BVT
   * @param opts - Options for constructing BVT
   */
  constructor(opts: any) {
    super({
      vtype: 'BVT',
      ...opts,
    })
    if (!opts.children) {
      this.children = {}
    }
  }

  /**
   * Get raw value from children
   */
  getRawValue(): any[] {
    const { children } = this
    const tmpArry = Object.values(children).filter((val) => !!val)
    return _.uniqWith(tmpArry, _.isEqual)
  }

  /**
   * Check if any child value has a tag recursively
   */
  get hasTagRec(): boolean | null {
    const values = Object.values(this.value)
    return _.isFunction(values?.some) ? values.some((v: any) => v?.hasTagRec) : null
  }

  /**
   * Set hasTagRec (uses hasTag utility)
   */
  set hasTagRec(value: boolean | null) {
    astUtil.hasTag(this, null)
  }

  /**
   * Get the value (children)
   */
  get value(): Record<string, any> {
    return this.children
  }

  /**
   * Set the value (children)
   */
  set value(val: Record<string, any>) {
    this.children = val
  }

  /**
   * Get trace by tag
   * @param tag - Tag to search for
   */
  getTrace(tag: any): any {
    return _.find(this.value, (v: any) => {
      if (_.isFunction(v?._tags?.has) && v._tags.has(tag)) {
        return v.trace
      }
    })
  }

  /**
   * Get taint info by tag
   * @param tag - Tag to search for
   */
  getTaintInfo(tag: any): { value: any; trace: any } | undefined {
    const value = _.find(this.value, (v: any) => {
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
   * Get miscellaneous data by key
   * @param key - Key to get misc data
   */
  getMisc(key: string): any[] {
    const values = this.getRawValue()
    return values.map((val: any) => val.getMisc(key))
  }
}

module.exports = BVT
