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
  static schedule(fclos, argvalues, state, node, scope) {
    if (argvalues.length < 1) {
      return
    }
    if (argvalues[0].field?.run && _.isFunction(this.executeCall)) {
      this.executeCall(node, argvalues[0].field?.run, [], state, scope)
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
  static scheduleAtFixedRate(fclos, argvalues, state, node, scope) {
    Timer.schedule(fclos, argvalues, state, scope)
  }
}

module.exports = Timer
