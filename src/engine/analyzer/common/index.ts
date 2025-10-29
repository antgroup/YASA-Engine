const valueUtil = require('../../util/value-util')
const stateUtil = require('../../util/state-util')

const symAddress = require('./sym-address')
const Analyzer = require('./analyzer')
const ScopeClass = require('./scope')

module.exports = {
  Analyzer,
  valueUtil,
  stateUtil,
  symAddress,
  Scope: ScopeClass,
}
