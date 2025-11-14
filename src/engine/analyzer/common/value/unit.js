const _ = require('lodash')
const { Errors } = require('../../../../util/error-code')

/**
 *
 */
class Unit {
  vtype // value type

  field //  indicates the fields of the value, TODO rename to [field] when backward compatibility is take out

  // value has different meaning in different type of Value
  // in most cases value is the ref of field
  // value and field are different in few scenes, e.g.
  //  string type in javascript, 'hello' is value, and field has toString, toUpperCase, etc in it,
  //  representing the member access of it
  // value;
  // raw_value;
  _sid // symbolic id

  _id

  _qid //  qualified sid

  sort // type of the value, in order to tell apart from type of the node, we use sort here

  ast // uast node where the value be retrieved

  decl // uast node where the value be declared

  trace

  misc_ // misc information

  _has_tags

  _tags

  /**
   *
   * @param root0
   * @param root0.vtype
   * @param root0.field
   * @param root0.value
   */
  constructor({ vtype, field, value, ...opts }) {
    this.vtype = vtype
    if (value !== undefined) {
      this.raw_value = value
    }

    this.field = field || createField()

    this.misc_ = new Object()
    // this._tags = new Set()

    this.decls = this.decls || {}
    this.id = this.id || this.sid

    for (const key of Object.keys(opts)) {
      if (key === 'parent' && !opts[key]?.vtype && opts[key]?.type) {
        continue
      }
      this[key] = opts[key]
    }
  }

  /**
   *
   */
  get qid() {
    return this._qid || this._sid || this._id
  }

  /**
   *
   */
  set qid(id) {
    this._qid = id
  }

  /**
   *
   */
  get id() {
    return this._id || this._sid || this._qid
  }

  /**
   *
   */
  set id(id) {
    this._id = id
  }

  /**
   *
   */
  get sid() {
    return this._sid || this._id || this._qid
  }

  /**
   *
   */
  set sid(id) {
    this._sid = id
  }

  /**
   *
   */
  get value() {
    if (Object.prototype.hasOwnProperty.call(this, 'raw_value')) {
      return this.raw_value
    }
    return this.field
  }

  /**
   *
   */
  set value(val) {
    // this.
    this.field = val
  }

  /**
   *
   * @param tag
   */
  getTrace(tag) {
    if (!this._has_tags) return null
    if (this._tags.has(tag)) {
      return this.trace
    }
  }

  /**
   *
   * @param ids
   * @param createIfNotExists
   */
  getFieldValue(ids, createIfNotExists) {
    if (!ids) {
      // error should not be thrown out
      try {
        Errors.IllegalUse('getFieldValue ids should not be empty')
      } catch (e) {}
      return new Unit({
        vtype: 'unknown',
      })
    }

    if (!Array.isArray(ids)) {
      ids = ids.split('.')
    }

    let fval = this
    for (let i = 0; i < ids.length; i++) {
      const fname = ids[i]
      let sub_fval
      if (Object.prototype.hasOwnProperty.call(fval.field, fname)) {
        sub_fval = fval.field[fname]
      }
      if (!sub_fval) {
        if (createIfNotExists) {
          sub_fval = new Unit({
            vtype: 'object',
            sid: fname,
            qid: `${this.sid}.${fname}`,
          })

          if (this._has_tags) {
            sub_fval.hasTagRec = this._has_tags
          }
          if (typeof this._tags !== 'undefined') {
            sub_fval._tags = _.clone(this._tags)
          }
          if (this.trace) {
            sub_fval.trace = _.clone(this.trace)
          }

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

  /**
   *
   * @param fieldName
   */
  getFieldValueIfNotExists(fieldName) {
    return this.getFieldValue(fieldName, true)
  }

  /**
   * set the id's value in this; the id "x.y.z" is of format [x, y, z] or 'x.y.z'
   * @param ids: 'x.y.z' or ['x', 'y', 'z']
   * @param value: the value to be assigned
   * @param ids
   * @param value
   */
  setFieldValue(ids, value) {
    let scp = this
    ids = Array.isArray(ids) ? ids : ids.toString().split('.')

    for (let i = 0; i < ids.length - 1; i++) {
      const fname = ids[i]
      const scp1 = scp.field[fname]
      if (!scp1) {
        scp.field[fname] = new Unit({
          vtype: 'object',
        })
      } else {
        scp1.parent = scp
      }
      scp = scp.field[fname]
    }
    scp.value[ids[ids.length - 1]] = value
  }

  /**
   *
   */
  getRawValue() {
    return this.value
  }

  /**
   *
   */
  getQualifiedId() {
    return this.qid
  }

  /**
   *
   */
  get _this() {
    return this.__this
  }

  /**
   *
   */
  set _this(value) {
    this.__this = value
  }

  /**
   *
   */
  getThis() {
    let scp = this
    let _this
    while (scp) {
      _this = scp._this
      if (_this) {
        return _this
      }
      if (this.vtype === 'object') {
        return this
      }
      scp = scp.parent
    }
    return this
  }

  /**
   *
   * @param key
   * @param value
   */
  setMisc(key, value) {
    this.misc_[key] = value
  }

  /**
   *
   * @param key
   */
  getMisc(key) {
    return this.misc_[key]
  }

  /**
   *
   */
  reset() {
    this.misc_ = new Object()
    // TODO taint reset
  }

  /**
   *
   */
  get hasTagRec() {
    return this._has_tags
  }

  /**
   *
   * @param value
   */
  set hasTagRec(value) {
    this._has_tags = value
  }
}

// TODO return new Map() instead of {} when backward compatibility is take out
/**
 *
 */
function createField() {
  return {}
  // return new Map();
}

module.exports = Unit
