const {
  valueUtil: {
    ValueUtil: { FunctionValue, UndefinedValue },
  },
} = require('../../../common')

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processThen(this: any, fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
  const handleFulfilled = argvalues && argvalues[0]
  const promise = fclos.parent
  if (handleFulfilled) {
    if (promise && (promise.sid === 'Promise' || promise.sid.includes('Promise<instance'))) {
      let resolve = promise.getMisc('promise')?.resolve
      if (!resolve) {
        resolve = new UndefinedValue()
      }
      const thenRes = (this as any).executeCall(node, handleFulfilled, state, scope, { callArgs: (this as any).buildCallArgs(node, [resolve], handleFulfilled) })
      if (thenRes && promise.getMisc('promise')) {
        promise.getMisc('promise').resolve = thenRes
      }
    }
  }
  return promise
}

/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processCatch(this: any, fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
  const handleFulfilled = argvalues && argvalues[0]
  const promise = fclos.parent
  if (handleFulfilled) {
    if (promise && (promise.sid === 'Promise' || promise.sid.includes('Promise<instance'))) {
      // 存到reject的参数
      let reject = promise.getMisc('promise')?.reject
      if (!reject) {
        reject = new UndefinedValue()
      }
      // 把catch的参数值当成 fclos 参数error替换成reject接受的参数信息
      ;(this as any).executeCall(node, handleFulfilled, state, scope, { callArgs: (this as any).buildCallArgs(node, [reject], handleFulfilled) })
    }
  }
  return promise
}

module.exports = {
  processPromise(promise: any, argvalues: any[], state: any, node: any, scope: any): void {
    /**
     *
     * @param val
     * @param name
     */
    function _process(val: any, name: string): void {
      let promiseMisc = promise.getMisc('promise')
      if (!promiseMisc) {
        promiseMisc = {}
        promise.setMisc('promise', promiseMisc)
      }
      promiseMisc[name] = val
    }

    // 将resolve/reject的参数的符号值argvalue存到当前promise的misc中
    /**
     *
     * @param fclos
     * @param argvalues
     * @param state
     * @param node
     * @param scope
     */
    function processReject(fclos: any, argvalues: any[], state: any, node: any, scope: any): void {
      _process(argvalues[0], 'reject')
    }

    /**
     *
     * @param fclos
     * @param argvalues
     * @param state
     * @param node
     * @param scope
     */
    function processResolve(fclos: any, argvalues: any[], state: any, node: any, scope: any): void {
      _process(argvalues[0], 'resolve')
    }

    const executorArgs = [
      new FunctionValue('', {
        sid: 'resolve',
        qid: 'promise.resolve',
        parent: null,
        runtime: { execute: processResolve },
      }),
      new FunctionValue('', {
        sid: 'reject',
        qid: 'promise.reject',
        parent: null,
        runtime: { execute: processReject },
      }),
    ]

    promise.setFieldValue(
      'then',
      new FunctionValue('', {
        sid: 'then',
        qid: 'promise.then',
        runtime: { execute: processThen },
        parent: promise,
      })
    )

    // 创建promise的时候 要对该promise对象进行建模
    // 新增对catch的建模以后就能执行到catch的处理
    promise.setFieldValue(
      'catch',
      new FunctionValue('', {
        sid: 'catch',
        qid: 'promise.catch',
        runtime: { execute: processCatch },
        parent: promise,
      })
    )

    const executor = argvalues && argvalues[0]
    if (executor) {
      this.executeCall(node, executor, state, scope, { callArgs: this.buildCallArgs(node, executorArgs, executor) })
    }
  },
}
