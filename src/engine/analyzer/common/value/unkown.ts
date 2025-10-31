const Unit = require('./unit')

interface UnknownValueOptions {
  [key: string]: any
}

/**
 *
 */
class UnknownValue extends Unit {
  /**
   *
   * @param opts
   */
  constructor(opts?: UnknownValueOptions) {
    super({
      vtype: 'unknown',
      ...opts,
    })
  }
}

module.exports = UnknownValue
