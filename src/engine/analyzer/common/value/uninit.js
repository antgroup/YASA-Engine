const Unit = require('./unit')

module.exports = class UninitializedValue extends Unit {
  /**
   *
   * @param opts
   */
  constructor(opts) {
    super({
      vtype: 'uninitialized',
      ...opts,
    })
  }
}
