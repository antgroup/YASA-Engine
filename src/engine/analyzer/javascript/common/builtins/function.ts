const _ = require('lodash')
const { Errors } = require('../../../../../util/error-code')
const { lodashCloneWithTag } = require('../../../../../util/clone-util')

const {
  valueUtil: {
    ValueUtil: { UndefinedValue },
  },
} = require('../../../common')

module.exports = {
  /**
   * function.call()
   * @param invoke
   * @param argvalues (thisObj, ...)
   * @param state
   * @param node
   * @param scope
   */
  processFunctionCall(invoke: any, argvalues: any[], state: any, node: any, scope: any) {
    if (argvalues.length <= 0) {
      Errors.UnexpectedValue(`argvalues.length should greater than 0`, { no_throw: true })
    }

    return processFunctionInvoke.call(this, invoke, argvalues[0], argvalues.slice(1), state, node, scope)
  },

  /**
   * function.apply()
   * @param invoke
   * @param argvalues (thisObj, [...])
   * @param state
   * @param node
   * @param scope
   */
  processFunctionApply(invoke: any, argvalues: any[], state: any, node: any, scope: any) {
    if (argvalues.length <= 0) {
      Errors.UnexpectedValue(`argvalues.length should greater than 0`, { no_throw: true })
    }
    if (argvalues.length <= 1) {
      argvalues.push(new UndefinedValue())
      argvalues.push(new UndefinedValue())
    }
    return processFunctionInvoke.call(this, invoke, argvalues[0], Object.values(argvalues[1].value), state, node, scope)
  },
}

/*
 * *
 * function invoke with thisObj
 */
/**
 *
 * @param invoke
 * @param _this
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processFunctionInvoke(
  this: any,
  invoke: any,
  _this: any,
  argvalues: any[],
  state: any,
  node: any,
  scope: any
) {
  const fclos = invoke.parent
  const fscope = lodashCloneWithTag(fclos)
  fscope._this = _this

  // handle through executeSingleCall instead of executeCall is to prevent
  // decorator process redundantly, which will cause infinite loop
  return (this as any).executeSingleCall(fscope, state, node, scope, { callArgs: (this as any).buildCallArgs(node, argvalues, fscope) })
}
