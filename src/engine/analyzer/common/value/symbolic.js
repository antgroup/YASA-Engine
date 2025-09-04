const ObjectValue = require('./object')
const { Errors } = require('../../../../util/error-code')

/**
 *
 */
class SymbolValue extends ObjectValue {
  /**
   *
   * @param opts
   */
  constructor(opts) {
    super({
      vtype: 'symbol',
      ...opts,
    })
    // remove parent if it is assigned from ast than value
    if (!this.parent?.vtype) {
      delete this.parent
    }
    // if (!opts.value) {
    //     try{ Errors.UnexpectedValue('symbol value should have value init when being created'); }catch (e) {}
    // }
  }
}

module.exports = SymbolValue
