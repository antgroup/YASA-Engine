const _ = require('lodash')
const Executor = require('./executor-builtins')
const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')
const AstUtil = require('../../../../../util/ast-util')
const { getAllElementFromBuffer } = require('./buffer')

/**
 * java.util.concurrent.ExecutorService
 */
class ExecutorService extends Executor {
  /**
   * submit
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static submit(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    if (argvalues.length < 1) {
      return new UndefinedValue()
    }
    if (argvalues[0]?.members?.get('run') && _.isFunction((this as any).executeCall)) {
      ;(this as any).executeCall(node, argvalues[0].members.get('run')!, state, scope, { callArgs: (this as any).buildCallArgs(node, [], argvalues[0].members.get('run')!) })
    } else if (argvalues[0]?.members?.get('call') && _.isFunction((this as any).executeCall)) {
      ;(this as any).executeCall(node, argvalues[0].members.get('call')!, state, scope, { callArgs: (this as any).buildCallArgs(node, [], argvalues[0].members.get('call')!) })
    } else if (argvalues[0]?.members?.get('doCall') && _.isFunction((this as any).executeCall)) {
      ;(this as any).executeCall(node, argvalues[0].members.get('doCall')!, state, scope, { callArgs: (this as any).buildCallArgs(node, [], argvalues[0].members.get('doCall')!) })
    } else if (argvalues[0].vtype === 'fclos') {
      ;(this as any).executeCall(node, argvalues[0], state, scope, { callArgs: (this as any).buildCallArgs(node, [], argvalues[0]) })
    }
    return new UndefinedValue()
  }

  /**
   * invokeAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static invokeAll(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    if (argvalues.length < 1 || !argvalues[0]) {
      return new UndefinedValue()
    }

    let funcs: any[] = []

    // 优先从 buffer 获取元素（Stream.collect 收集的元素存储在 _misc.buffer 中）
    const buffer = argvalues[0]?.getMisc?.('buffer')
    if (buffer) {
      funcs = getAllElementFromBuffer(argvalues[0])
    }

    // fallback: 通过 satisfy 遍历
    if (funcs.length === 0) {
      const satisfyResult = AstUtil.satisfy(
        argvalues[0],
        (n: any) =>
          n?.members?.get('call')?.vtype === 'fclos' ||
          n?.members?.get('doCall')?.vtype === 'fclos' ||
          (n.vtype === 'fclos' && n.sid?.includes('<anonymous')),
        null,
        null,
        true
      )
      if (satisfyResult) {
        funcs = Array.isArray(satisfyResult) ? satisfyResult : [satisfyResult]
      }
    }

    if (funcs.length === 0) {
      return new UndefinedValue()
    }

    // invokeAll 语义：每个 Callable 独立并行执行，不应共享污点状态。
    // 为每次迭代创建独立的 state 快照，防止前一个 Callable 的污点 trace 泄漏到后续 Callable。
    for (const func of funcs) {
      const isolatedState = _.clone(state)
      isolatedState.callstack = state.callstack ? [...state.callstack] : []
      isolatedState.callsites = state.callsites ? [...state.callsites] : []
      if (func.vtype === 'object' && func.members?.get('call')?.vtype === 'fclos') {
        // 对象实例的 call 方法：绑定 _this 指向对象实例
        const callMethod = func.members.get('call')
        const oldThis = callMethod._this
        callMethod._this = func
        ;(this as any).executeCall(node, callMethod, isolatedState, scope, { callArgs: (this as any).buildCallArgs(node, [], callMethod) })
        callMethod._this = oldThis
      } else if (func.members?.get('call')) {
        ;(this as any).executeCall(node, func.members.get('call')!, isolatedState, scope, { callArgs: (this as any).buildCallArgs(node, [], func.members.get('call')!) })
      } else if (func.members?.get('doCall')) {
        ;(this as any).executeCall(node, func.members.get('doCall')!, isolatedState, scope, { callArgs: (this as any).buildCallArgs(node, [], func.members.get('doCall')!) })
      } else if (func.vtype === 'fclos') {
        ;(this as any).executeCall(node, func, isolatedState, scope, { callArgs: (this as any).buildCallArgs(node, [], func) })
      }
    }

    return new UndefinedValue()
  }

  /**
   * invokeAny
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static invokeAny(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return ExecutorService.invokeAll(fclos, argvalues, state, node, scope)
  }
}

export = ExecutorService
