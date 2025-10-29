const Unit = require('./unit')
const logger = require('../../../../util/logger')(__filename)

interface ScopedOptions {
  parent?: any
  name?: string
  [key: string]: any
}

module.exports = class Scoped extends Unit {
  parent: any // the parent of the scope

  name: string | undefined

  /**
   *
   * @param opts
   */
  constructor(opts?: ScopedOptions) {
    super({
      vtype: 'scope',
      ...opts,
    })
    this.parent = opts?.parent
    this.name = opts?.name
    if (this.parent === undefined) {
      logger.warn('parent is not set when creating scope value')
    }
  }
}
