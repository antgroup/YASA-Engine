const Unit = require('./unit')
const logger = require('../../../../util/logger')(__filename)
const { Errors } = require('../../../../util/error-code')

module.exports = class Scoped extends Unit {
  parent // the parent of the scope

  name

  /**
   *
   * @param opts
   */
  constructor(opts) {
    super({
      vtype: 'scope',
      ...opts,
    })
    this.parent = opts.parent
    this.name = opts.name
    if (this.parent === undefined) {
      logger.warn('parent is not set when creating scope value')
    }
  }
}
