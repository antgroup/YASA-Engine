const Scoped = require('./scoped')

interface FunctionValueOptions {
  [key: string]: any
}

/**
 * FunctionValue class
 */
module.exports = class FunctionValue extends Scoped {
  /**
   * Constructor for FunctionValue
   * @param opts - Options for constructing FunctionValue
   */
  constructor(opts?: FunctionValueOptions) {
    super({
      vtype: 'fclos',
      ...opts,
    })
  }
}
