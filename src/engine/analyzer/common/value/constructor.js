const _ = require('lodash')
const Unit = require('./unit')
const UnknownValue = require('./unkown')
const ObjectValue = require('./object')
const Scoped = require('./scoped')
const FunctionValue = require('./function')
const UndefinedValue = require('./undefine')
const UninitializedValue = require('./uninit')
const UnionValue = require('./union')
const SymbolValue = require('./symbolic')
const PrimitiveValue = require('./primitive')
const BVT = require('./bvt')
const PackageValue = require('./package')

const Constructor = {
  UnknownValue(opts) {
    opts = prepareOpts(opts)
    return new UnknownValue(opts)
  },

  ObjectValue(opts) {
    opts = prepareOpts(opts)
    return new ObjectValue(opts)
  },

  Scoped(opts) {
    opts = prepareOpts(opts)
    return new Scoped(opts)
  },

  FunctionValue(opts) {
    opts = prepareOpts(opts)
    return new FunctionValue(opts)
  },
  PackageValue(opts) {
    opts = prepareOpts(opts)
    return new PackageValue(opts)
  },
  UndefinedValue(opts) {
    opts = prepareOpts(opts)
    return new UndefinedValue(opts)
  },
  UninitializedValue(opts) {
    opts = prepareOpts(opts)
    return new UninitializedValue(opts)
  },
  UnionValue(opts) {
    opts = prepareOpts(opts)
    return new UnionValue(opts)
  },

  SymbolValue(opts) {
    opts = prepareOpts(opts)
    opts.parent = opts.parent || null
    return new SymbolValue(opts)
  },

  PrimitiveValue(opts) {
    opts = prepareOpts(opts)
    return new PrimitiveValue(opts)
  },

  BVT(opts) {
    opts = prepareOpts(opts)
    return new BVT(opts)
  },
}

/**
 *
 * @param opts
 */
function prepareOpts(opts) {
  return opts || {}
}

module.exports = Constructor
