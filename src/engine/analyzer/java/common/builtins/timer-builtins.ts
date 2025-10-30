const _ = require('lodash')

/**
 * java.util.Timer
 */
class Timer {
  /**
   * Timer.schedule
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static schedule(fclos: any, argvalues: any[], state: any, node: any, scope: any): void {
    if (argvalues.length < 1) {
      return
    }
    const maybeFn = (this as any).executeCall
    if (argvalues[0].field?.run && _.isFunction(maybeFn)) {
      ;(this as any).executeCall(node, argvalues[0].field?.run, [], state, scope)
    }
  }

  /**
   * Timer.scheduleAtFixedRate
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static scheduleAtFixedRate(fclos: any, argvalues: any[], state: any, node: any, scope: any): void {
    Timer.schedule(fclos, argvalues, state, node, scope)
  }
}

module.exports = Timer
