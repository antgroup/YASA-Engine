const Unit = require('./unit')

interface UndefinedValueOptions {
  [key: string]: any
}

/**
 * UndefinedValue class
 */
module.exports = class UndefinedValue extends Unit {
  /**
   * Constructor for UndefinedValue
   * @param opts - Options for constructing UndefinedValue
   */
  constructor(opts?: UndefinedValueOptions) {
    super({
      vtype: 'undefine',
      ...opts,
    })
  }
}
