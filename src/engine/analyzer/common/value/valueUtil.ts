const Unknown = require('./unkown')
const ObjectClass = require('./object')
const Scoped = require('./scoped')
const FunctionClass = require('./function')
const Undefined = require('./undefine')
const Uninitialized = require('./uninit')
const Union = require('./union')
const SymbolClass = require('./symbolic')
const Primitive = require('./primitive')
const BVT = require('./bvt')
const Package = require('./package')

const ValueUtil = {
  UnknownValue(opts: any) {
    opts = prepareOpts(opts)
    return new Unknown(opts)
  },

  ObjectValue(opts: any) {
    opts = prepareOpts(opts)
    return new ObjectClass(opts)
  },

  Scoped(opts: any) {
    opts = prepareOpts(opts)
    return new Scoped(opts)
  },

  FunctionValue(opts: any) {
    opts = prepareOpts(opts)
    return new FunctionClass(opts)
  },
  PackageValue(opts: any) {
    opts = prepareOpts(opts)
    return new Package(opts)
  },
  UndefinedValue(opts: any) {
    opts = prepareOpts(opts)
    return new Undefined(opts)
  },
  UninitializedValue(opts: any) {
    opts = prepareOpts(opts)
    return new Uninitialized(opts)
  },
  UnionValue(opts: any) {
    opts = prepareOpts(opts)
    return new Union(opts)
  },

  SymbolValue(opts: any) {
    opts = prepareOpts(opts)
    opts.parent = opts.parent || null
    return new SymbolClass(opts)
  },

  PrimitiveValue(opts: any) {
    opts = prepareOpts(opts)
    return new Primitive(opts)
  },

  BVT(opts: any) {
    opts = prepareOpts(opts)
    return new BVT(opts)
  },
}

/**
 *
 * @param opts
 */
function prepareOpts(opts: any): any {
  return opts || {}
}

module.exports = ValueUtil
