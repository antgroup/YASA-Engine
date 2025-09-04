const _ = require('lodash')
const Unit = require('./unit')
const { hasTag } = require('../../../../util/ast-util')

/**
 *
 */
class UnionValue extends Unit {
  /**
   *
   * @param opts
   */
  constructor(opts) {
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
    let oldValue = []
    let { raw_value } = this
    if (raw_value) {
      if (!_.isArray(value)) {
        oldValue = Object.values(value)
      }

      // 确保raw_value为数组
      if (!_.isArray(this.raw_value)) {
        raw_value = Object.values(this.raw_value)
      }

      raw_value.forEach((element) => oldValue.push(element))

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
   *
   */
  get value() {
    // if (Object.prototype.hasOwnProperty.call(this, 'raw_value')) {
    //   return this.raw_value
    // }
    return this.field
  }

  /**
   *
   */
  set value(v) {
    this.field = v
    this.set = new WeakSet()
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
  set hasTagRec(value) {
    super._has_tags = value
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
   */
  getThis() {
    return new UnionValue({ value: this.value.map((v) => v.getThis()) })
  }

  /**
   *
   * @param val
   * @param uniqueFlag 标识是否需要去重
   */
  appendValue(val, uniqueFlag = true) {
    if (!val) return

    if (Array.isArray(val)) {
      val.forEach((v) => {
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
   *
   * @param val
   * @param uniqueFlag
   */
  _pushValue(val, uniqueFlag = true) {
    if (this === val) return
    if (this.isUnionInBVT(this, val)) return
    if (this.set.has(val) && uniqueFlag) return
    const isEqual = this.value.some((ele) => {
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
   * 处理BVT向union push时容易出现的死循环问题
   * @param targetUnion
   * @param baseBVT
   */
  isUnionInBVT(targetUnion, baseBVT) {
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
