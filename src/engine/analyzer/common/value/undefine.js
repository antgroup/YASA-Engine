const Unit = require('./unit')

module.exports = class UndefinedValue extends Unit {
  /**
   *
   * @param opts
   */
  constructor(opts) {
    super({
      vtype: 'undefine',
      ...opts,
    })
  }
}
