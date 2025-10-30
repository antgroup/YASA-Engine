import * as _ from 'lodash'

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
  UnknownValue(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    return new UnknownValue(opts)
  },

  ObjectValue(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    return new ObjectValue(opts)
  },

  Scoped(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    return new Scoped(opts)
  },

  FunctionValue(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    return new FunctionValue(opts)
  },

  PackageValue(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    return new PackageValue(opts)
  },

  UndefinedValue(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    return new UndefinedValue(opts)
  },

  UninitializedValue(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    return new UninitializedValue(opts)
  },

  UnionValue(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    return new UnionValue(opts)
  },

  SymbolValue(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    opts.parent = opts.parent || null
    return new SymbolValue(opts)
  },

  PrimitiveValue(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    return new PrimitiveValue(opts)
  },

  BVT(opts: Record<string, any>) {
    opts = prepareOpts(opts)
    return new BVT(opts)
  },
}

/**
 * Prepare options for constructor
 * @param opts - Options to prepare
 */
function prepareOpts(opts: Record<string, any>): any {
  return opts || {}
}

module.exports = Constructor
