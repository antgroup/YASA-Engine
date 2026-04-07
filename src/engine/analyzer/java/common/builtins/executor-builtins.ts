const _ = require('lodash')
const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')

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
      return new UndefinedValue()
    }
    const runMethod = argvalues[0]?.members?.get('run')
    if (runMethod && _.isFunction((this as any).executeCall)) {
      ;(this as any).executeCall(node, runMethod, state, scope, { callArgs: (this as any).buildCallArgs(node, [], runMethod) })
    } else if (argvalues[0].vtype === 'fclos' && _.isFunction((this as any).executeCall)) {
      ;(this as any).executeCall(node, argvalues[0], state, scope, { callArgs: (this as any).buildCallArgs(node, [], argvalues[0]) })
    }
  }
}

export = Executor
