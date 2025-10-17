const { FunctionValue } = require('../../../../util/value-util')
const _ = require('lodash')

/**
 * java.util.concurrent.Executor
 */
class Executor {
  /**
   * Executor.execute
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static execute(fclos, argvalues, state, node, scope) {
    if (argvalues.length < 1) {
      return
    }
    if (argvalues[0].field?.run && _.isFunction(this.executeCall)) {
      this.executeCall(node, argvalues[0].field?.run, [], state, scope)
    }
  }
}

module.exports = Executor
