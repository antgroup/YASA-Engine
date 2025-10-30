const _ = require('lodash')
const Unit = require('./unit')
const astUtil = require('../../../../util/ast-util')

interface UnionValueOptions {
  value?: any[] | Record<string, any>
  raw_value?: any[] | Record<string, any>
  [key: string]: any
}

/**
 * UnionValue class
 */
class UnionValue extends Unit {
  set: WeakSet<any>

  field!: any[]

  raw_value: any

  _has_tags: boolean | undefined

  /**
   * Constructor for UnionValue
   * @param opts - Options for constructing UnionValue
   */
  constructor(opts?: UnionValueOptions) {
    super({
      vtype: 'union',
      ...opts,
    })

    this.set = new WeakSet()

    const value = opts?.value
    // 确保value为数组
    if (!value) {
      this.value = []
    }
    let oldValue: any[] = []
    let { raw_value } = this
    if (raw_value) {
      if (!_.isArray(value)) {
        oldValue = Object.values(value || {}) as any[]
      }

      // 确保raw_value为数组
      if (!_.isArray(this.raw_value)) {
        raw_value = Object.values(this.raw_value)
      }

      raw_value.forEach((element: any) => oldValue.push(element))

      this.value = oldValue

      if (Array.isArray(this.raw_value)) {
        this.raw_value.length = 0
      } else if (typeof this.raw_value === 'object' && this.raw_value !== undefined && this.raw_value !== null) {
        for (const key in this.raw_value) {
          if (this.raw_value.hasOwnProperty(key)) {
            delete this.raw_value[key]
          }
        }
      }
    }
  }

  /**
   * Get value
   */
  get value(): any[] {
    // if (Object.prototype.hasOwnProperty.call(this, 'raw_value')) {
    //   return this.raw_value
    // }
    return this.field
  }

  /**
   * Set value
   * @param v - New value
   */
  set value(v: any[]) {
    this.field = v
    this.set = new WeakSet()
  }

  /**
   * Check if has tag recursively
   */
  get hasTagRec(): boolean {
    return astUtil.hasTag(this, null)
  }

  /**
   * Set hasTagRec
   * @param value - Tag value
   */
  set hasTagRec(value: boolean) {
    this._has_tags = value
  }

  /**
   * Get trace by tag
   * @param tag - Tag to search for
   */
  getTrace(tag: string): any {
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
  getTaintInfo(tag: string): { value: any; trace: any } | undefined {
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
   * Get this instance
   */
  getThis(): UnionValue {
    return new UnionValue({ value: this.value.map((v: any) => v.getThis()) })
  }

  /**
   * Append value to union
   * @param val - Value to append
   * @param uniqueFlag - Whether to deduplicate
   */
  appendValue(val: any, uniqueFlag: boolean = true): void {
    if (!val) return

    if (Array.isArray(val)) {
      val.forEach((v: any) => {
        this._pushValue(v, uniqueFlag)
      })
      return
    }

    if (val instanceof UnionValue) {
      for (const v of val.value) {
        this.appendValue(v, uniqueFlag)
      }
    } else if (val instanceof Unit) {
      // other type of Value
      this._pushValue(val, uniqueFlag)
    }
  }

  /**
   * Push value to union
   * @param val - Value to push
   * @param uniqueFlag - Whether to deduplicate
   */
  private _pushValue(val: any, uniqueFlag: boolean = true): void {
    if (this === val) return
    if (this.isUnionInBVT(this, val)) return
    if (this.set.has(val) && uniqueFlag) return
    const isEqual = this.value.some((ele: any) => {
      return (
        _.isEqual(ele, val) ||
        (val.vtype === ele.vtype && val.vtype === 'symbol' && ele.hasOwnProperty('loc') && _.isEqual(ele.loc, val.loc))
      )
    })
    if (isEqual && uniqueFlag) return
    this.value.push(val)
    this.set.add(val)
  }

  /**
   * Check if union is in BVT to prevent infinite loops
   * @param targetUnion - Target union
   * @param baseBVT - Base BVT
   */
  private isUnionInBVT(targetUnion: UnionValue, baseBVT: any): boolean {
    if (!targetUnion || !baseBVT) return false
    if (baseBVT.vtype === 'BVT') {
      // 如果存在 children 属性，则递归检查每个子对象
      if (baseBVT.children && typeof baseBVT.children === 'object') {
        for (const key in baseBVT.children) {
          const child = baseBVT.children[key]

          // 如果子对象的 vtype 为 "union"，检查其值是否为 "this"
          if (child.vtype === 'union') {
            if (child.field === targetUnion.field) {
              return true
            }
          }
          // 如果子对象的 vtype 为 "BVT"，递归检查它
          else if (child.vtype === 'BVT') {
            if (this.isUnionInBVT(targetUnion, child)) {
              return true // 如果递归检查失败，返回 false
            }
          }
        }
      }

      return false
    }

    // 如果当前对象的 vtype 不是 "BVT"，返回 false
    return false
  }
}

module.exports = UnionValue
