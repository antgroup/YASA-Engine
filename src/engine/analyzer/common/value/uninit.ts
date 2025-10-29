const Unit = require('./unit')

interface UninitializedValueOptions {
  [key: string]: any
}

module.exports = class UninitializedValue extends Unit {
  /**
   *
   * @param opts
   */
  constructor(opts?: UninitializedValueOptions) {
    super({
      vtype: 'uninitialized',
      ...opts,
    })
  }
}
