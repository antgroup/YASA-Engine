const Unit = require('./unit')

/**
 *
 */
class UnknownValue extends Unit {
  /**
   *
   * @param opts
   */
  constructor(opts) {
    super({
      vtype: 'unknown',
      ...opts,
    })
  }
}

module.exports = UnknownValue
