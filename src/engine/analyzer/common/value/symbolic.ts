const ObjectValue = require('./object')

interface SymbolicValueOptions {
  vtype?: string
  parent?: any
  [key: string]: any
}

/**
 * SymbolValue class
 */
class SymbolValue extends ObjectValue {
  parent: any

  /**
   * Constructor for SymbolValue
   * @param opts - Options for constructing SymbolValue
   */
  constructor(opts?: SymbolicValueOptions) {
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
