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
  static execute(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    if (argvalues.length < 1) {
      return
    }
    if (argvalues[0].field?.run && _.isFunction((this as any).executeCall)) {
      ;(this as any).executeCall(node, argvalues[0].field?.run, [], state, scope)
    }
  }
}

export = Executor
