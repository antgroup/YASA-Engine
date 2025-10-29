const Unit = require('./unit')

interface PrimitiveValueOptions {
  value?: any
  field?: any
  [key: string]: any
}

/**
 * PrimitiveValue class
 */
module.exports = class PrimitiveValue extends Unit {
  /**
   * Constructor for PrimitiveValue
   * @param opts - Options for constructing PrimitiveValue
   */
  constructor(opts: PrimitiveValueOptions) {
    super({
      vtype: 'primitive',
      ...opts,
    })
  }
}
