const Unit = require('./unit')

module.exports = class PrimitiveValue extends Unit {
  /**
   *
   * @param opts
   */
  constructor(opts) {
    super({
      vtype: 'primitive',
      ...opts,
    })
  }
}
