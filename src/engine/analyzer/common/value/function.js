const Scoped = require('./scoped')

module.exports = class FunctionValue extends Scoped {
  /**
   *
   * @param opts
   */
  constructor(opts) {
    super({
      vtype: 'fclos',
      ...opts,
    })
  }
}
