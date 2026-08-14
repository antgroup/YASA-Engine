import { buildNewValueInstance } from '../../../../../util/clone-util'
import type { CallInfo } from '../../../common/call-args'

const UastSpec = require('@ant-yasa/uast-spec')
import { UndefinedValue } from '../../../common/value/undefine'
const Executor = require('./executor-builtins')
const MemState = require('../../../common/memState')
const MemSpace = require('../../../common/memSpace')

const memSpaceUtil = new MemSpace()

type CompletableFutureCallbackContext = {
  executeCall(node: unknown, fclos: unknown, state: unknown, scope: unknown, callInfo: CallInfo): unknown
  buildCallArgs(node: unknown, argvalues: unknown, fclos: unknown): CallInfo['callArgs']
  processAndCallFuncDef(
    scope: unknown,
    node: unknown,
    fclos: unknown,
    state: unknown,
    argValues?: unknown,
    traceCallNode?: unknown
  ): unknown
}

type CompletableFutureTraceItem = {
  file?: string
  line?: number | number[]
  tag?: string
  affectedNodeName?: string
}

type CompletableFutureTaintedValue = {
  taint?: {
    isTaintedRec?: boolean
    getTags?: () => string[]
    getTrace?: (tag: string) => CompletableFutureTraceItem[] | null
    addTag?: (tag: string) => void
    addTraceToTag?: (tag: string, item: CompletableFutureTraceItem) => void
    clearTrace?: () => void
  }
}

function isSameTraceItem(left: CompletableFutureTraceItem, right: CompletableFutureTraceItem): boolean {
  return left.file === right.file &&
    left.tag === right.tag &&
    JSON.stringify(left.line) === JSON.stringify(right.line) &&
    left.affectedNodeName === right.affectedNodeName
}

function mergeTraceItems(left: CompletableFutureTraceItem[], right: CompletableFutureTraceItem[]): CompletableFutureTraceItem[] {
  const merged = [...left]
  for (const traceItem of right) {
    if (!merged.some((current) => isSameTraceItem(current, traceItem))) merged.push(traceItem)
  }
  return merged
}

function mergePreviousFutureTrace(previousResult: unknown, callbackResult: unknown): void {
  const previous = previousResult as CompletableFutureTaintedValue | undefined
  const callback = callbackResult as CompletableFutureTaintedValue | undefined
  const callbackTaint = callback?.taint
  if (!previous?.taint?.isTaintedRec || !callbackTaint?.isTaintedRec || previous === callback) return
  const tags = new Set([...(previous.taint.getTags?.() || []), ...(callbackTaint.getTags?.() || [])])
  if (tags.size === 0 || !callbackTaint.clearTrace || !callbackTaint.addTag || !callbackTaint.addTraceToTag) return
  const mergedByTag = new Map<string, CompletableFutureTraceItem[]>()
  for (const tag of tags) {
    const merged = mergeTraceItems(previous.taint.getTrace?.(tag) || [], callbackTaint.getTrace?.(tag) || [])
    if (merged.length > 0) mergedByTag.set(tag, merged)
  }
  if (mergedByTag.size === 0) return
  callbackTaint.clearTrace()
  for (const [tag, trace] of mergedByTag) {
    callbackTaint.addTag(tag)
    for (const traceItem of trace) callbackTaint.addTraceToTag(tag, traceItem)
  }
}

function getRuntimeCallInfo(args: IArguments): CallInfo | undefined {
  return args[5] as CallInfo | undefined
}

/**
 * 在 runnable 对象的成员中按 run/doRun/runInner/call/doCall 顺序找出方法体闭包。
 * 优先返回带 fdef 的方法（用户提供的实现），其次返回任意命中的方法名，
 * 最后兜底返回首个非 _CTOR_/super 的 fclos 成员，覆盖匿名 Runnable 字面量。
 */
function resolveRunnableMethod(runnable: any): any {
  if (!runnable || typeof runnable !== 'object') return undefined
  const methodNames = ['run', 'doRun', 'runInner', 'call', 'doCall']
  for (const methodName of methodNames) {
    const method = runnable.members?.get?.(methodName)
    if (method?.ast?.fdef) return method
  }
  for (const methodName of methodNames) {
    const method = runnable.members?.get?.(methodName)
    if (method) return method
  }
  if (runnable.members?.forEach) {
    let fallback: any
    runnable.members.forEach((memberValue: any, memberName: string) => {
      if (!fallback && memberName !== '_CTOR_' && memberName !== 'super' && memberValue?.vtype === 'fclos') fallback = memberValue
    })
    return fallback
  }
  return undefined
}

/**
 * 当 runAsync/supplyAsync 接收到的不是 fclos 而是 Runnable 对象时，
 * 在传播闭包 taint 后解析其 run 等方法体并真实执行，与 fclos 路径对齐。
 * 失败时返回 false，由调用方走默认（lib propagation / 静默）路径。
 */
function executeRunnableObject(context: any, runnable: any, state: any, node: any, scope: any, traceCallNode: any): boolean {
  if (!runnable || runnable.vtype === 'fclos' || !context?.executeCall || !context?.buildCallArgs) return false
  Executor.propagateClosureTaint(runnable, scope)
  Executor.propagateEnclosingMembers(runnable, scope)
  const method = resolveRunnableMethod(runnable)
  if (!method) return false
  const oldThis = method._this
  method._this = runnable
  try {
    context.executeCall(node, method, state, scope, {
      callArgs: context.buildCallArgs(node, [], method),
      callsiteNode: traceCallNode || node,
    })
  } finally {
    method._this = oldThis
  }
  return true
}

/**
 * java.util.concurrent.CompletableFuture
 */
class CompletableFuture {
  /**
   * constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   * @constructor
   */
  static CompletableFuture(_this: any, argvalues: any[], state: any, node: any, scope: any) {
    if (_this) {
      return _this
    }

    if (argvalues.length > 0) {
      memSpaceUtil.saveVarInScope(_this, '_result', argvalues[0], state)
      _this.setMisc('thenFuncsWithContext', [])
    }

    return _this
  }

  /**
   * CompletableFuture.join
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static join(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !(this as any).executeCall) {
      return new UndefinedValue()
    }

    const thenFuncsWithContext = _this.getMisc('thenFuncsWithContext') || []
    let res = new UndefinedValue()
    for (const element of thenFuncsWithContext) {
      let elementArgvalues = element.argvalues
      if (elementArgvalues?.length > 0) {
        elementArgvalues = [res]
      }
      const callbackContext = this as unknown as CompletableFutureCallbackContext
      res = callbackContext.executeCall(element.node, element.fclos, element.state, element.scope, {
        callArgs: callbackContext.buildCallArgs(element.node, elementArgvalues, element.fclos),
        callsiteNode: element.callsiteNode || element.node,
      }) as UndefinedValue
    }

    _this.setMisc('thenFuncsWithContext', [])

    return new UndefinedValue()
  }

  /**
   * CompletableFuture.runAsync
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static runAsync(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    let instance: any = new UndefinedValue()
    if (
      !(this as any).processNewExpression ||
      argvalues.length < 1 ||
      !(this as any).processAndCallFuncDef
    ) {
      return instance
    }

    const identifer = UastSpec.identifier('CompletableFuture')
    const newExpression = UastSpec.newExpression(identifer, [])
    if (!newExpression) {
      return instance
    }
    instance = (this as any).processNewExpression(scope, newExpression, state)

    const futureScope = buildNewValueInstance(
      this,
      scope,
      node,
      scope,
      () => {
        return false
      },
      (v: any) => {
        return !v
      },
      2
    )
    const thenFuncsWithContext: any[] = []
    const callbackValue = argvalues[0]
    const callInfo = getRuntimeCallInfo(arguments)
    const traceCallNode = callInfo?.callsiteNode || node
    const callbackContext = this as unknown as CompletableFutureCallbackContext
    if (callbackValue.vtype === 'fclos') {
      // fclos 通过 parent scope chain 已有闭包访问，不需要 propagateClosureTaint 注入
      // （注入会产生影子变量绕过 thenApply 等链式调用中的 taint 清理导致误报）
      const funcOldScope = callbackValue.parent
      callbackValue.parent = futureScope
      // 保留外层 _this 引用，使 lambda 体内 this.field 仍能沿 parent 链解析到 enclosing class
      const enclosingThisObj = (typeof scope.getThisObj === 'function' ? scope.getThisObj() : scope._this)
      if (enclosingThisObj && !futureScope._this) futureScope._this = enclosingThisObj
      // 将外层 scope 链中带 taint 的变量注入 futureScope.value 和 fclos.value，
      // 补偿 callbackValue.parent = futureScope 切断 scope chain 的影响。
      // 只注入 isTaintedRec 变量，不注入 enclosing class 成员（防执行爆炸）。
      // 绕过 Executor.propagateClosureTaint 的 isAnonymous 守卫（lambda sid 不含 <anonymous）
      let currentScope = scope; let _depth = 0
      while (currentScope && _depth < 3) {
        const _values = currentScope.value
        if (_values && typeof _values === 'object') {
          for (const _key of Object.keys(_values)) {
            if (_key.startsWith('__') || _key === '_CTOR_') continue
            const _val = _values[_key]
            if (!_val || typeof _val !== 'object') continue
            if (!_val.taint?.isTaintedRec) continue
            if (!futureScope.value[_key]) futureScope.value[_key] = _val
            const _fclosInner = callbackValue._fclos || callbackValue
            if (_fclosInner.value && !_fclosInner.value[_key]) _fclosInner.value[_key] = _val
          }
        }
        currentScope = currentScope.parent; _depth++
      }
      callbackContext.processAndCallFuncDef(futureScope, node.arguments[0], callbackValue, state, undefined, traceCallNode)
      callbackValue.parent = funcOldScope
    } else {
      // 非 fclos：例如 new MyRunnable() 或 TracerRunnable 包装对象。
      // 解析其 run/doRun/call 方法体真实执行，让 closure/enclosing 成员 taint 仍能进入任务体。
      executeRunnableObject(callbackContext, callbackValue, state, node.arguments?.[0] || node, futureScope, traceCallNode)
    }
    scope.value = MemState.unionScopeValues(scope, futureScope)
    thenFuncsWithContext.push({
      scope,
      node: node.arguments[0],
      fclos: callbackValue,
      state,
      argvalues: [],
      callsiteNode: traceCallNode,
    })

    instance.setMisc('futureScope', futureScope)
    instance.setMisc('thenFuncsWithContext', thenFuncsWithContext)

    return instance
  }

  /**
   * CompletableFuture.supplyAsync
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static supplyAsync(fclos: any, argvalues: any[], state: any, node: any, scope: any, callInfo?: CallInfo) {
    let instance: any = new UndefinedValue()
    if (
      !(this as any).processNewExpression ||
      argvalues.length < 1 ||
      argvalues[0].vtype !== 'fclos' ||
      !(this as any).processAndCallFuncDef
    ) {
      return instance
    }

    const identifer = UastSpec.identifier('CompletableFuture')
    const newExpression = UastSpec.newExpression(identifer, [])
    if (!newExpression) {
      return instance
    }
    instance = (this as any).processNewExpression(scope, newExpression, state)

    const futureScope = buildNewValueInstance(
      this,
      scope,
      node,
      scope,
      () => {
        return false
      },
      (v: any) => {
        return !v
      },
      2
    )
    const thenFuncsWithContext: any[] = []
    // fclos 通过 parent scope chain 已有闭包访问，不需要 propagateClosureTaint 注入
    const funcOldScope = argvalues[0].parent
    const traceCallNode = callInfo?.callsiteNode || node
    argvalues[0].parent = futureScope
    // 保留外层 _this 引用（与 runAsync 对称）
    const enclosingThisObj2 = (typeof scope.getThisObj === 'function' ? scope.getThisObj() : scope._this)
    if (enclosingThisObj2 && !futureScope._this) futureScope._this = enclosingThisObj2
    // 与 runAsync 对称：内联 taint 传播，绕过 isAnonymous 守卫
    let currentScope2 = scope; let _depth2 = 0
    while (currentScope2 && _depth2 < 3) {
      const _values2 = currentScope2.value
      if (_values2 && typeof _values2 === 'object') {
        for (const _key2 of Object.keys(_values2)) {
          if (_key2.startsWith('__') || _key2 === '_CTOR_') continue
          const _val2 = _values2[_key2]
          if (!_val2 || typeof _val2 !== 'object') continue
          if (!_val2.taint?.isTaintedRec) continue
          if (!futureScope.value[_key2]) futureScope.value[_key2] = _val2
          const _fclosInner2 = argvalues[0]._fclos || argvalues[0]
          if (_fclosInner2.value && !_fclosInner2.value[_key2]) _fclosInner2.value[_key2] = _val2
        }
      }
      currentScope2 = currentScope2.parent; _depth2++
    }
    const result = (this as any).processAndCallFuncDef(futureScope, node.arguments[0], argvalues[0], state, undefined, traceCallNode)
    memSpaceUtil.saveVarInScope(instance, '_result', result, state)
    argvalues[0].parent = funcOldScope
    scope.value = MemState.unionScopeValues(scope, futureScope)
    thenFuncsWithContext.push({
      scope,
      node: node.arguments[0],
      fclos: argvalues[0],
      state,
      argvalues: [],
      callsiteNode: traceCallNode,
    })

    instance.setMisc('futureScope', futureScope)
    instance.setMisc('thenFuncsWithContext', thenFuncsWithContext)

    return instance
  }

  /**
   * CompletableFuture.thenRun
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static thenRun(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || argvalues.length < 1 || argvalues[0].vtype !== 'fclos' || !(this as any).processAndCallFuncDef) {
      return new UndefinedValue()
    }

    const futureScope =
      _this.getMisc('futureScope') ||
      buildNewValueInstance(
        this,
        scope,
        node,
        scope,
        () => {
          return false
        },
        (v: any) => {
          return !v
        },
        2
      )
    const thenFuncsWithContext = _this.getMisc('thenFuncsWithContext') || []
    const funcOldScope = argvalues[0].parent
    argvalues[0].parent = futureScope
    const _thenRunThisObj = (typeof scope.getThisObj === 'function' ? scope.getThisObj() : scope._this)
    if (_thenRunThisObj && !futureScope._this) futureScope._this = _thenRunThisObj
    const callInfo = getRuntimeCallInfo(arguments)
    const traceCallNode = callInfo?.callsiteNode || node
    const callbackContext = this as unknown as CompletableFutureCallbackContext
    callbackContext.processAndCallFuncDef(futureScope, node.arguments[0], argvalues[0], state, undefined, traceCallNode)
    argvalues[0].parent = funcOldScope
    scope.value = MemState.unionScopeValues(scope, futureScope)
    thenFuncsWithContext.push({
      scope,
      node: node.arguments[0],
      fclos: argvalues[0],
      state,
      argvalues: [],
      callsiteNode: traceCallNode,
    })

    _this.setMisc('thenFuncsWithContext', thenFuncsWithContext)

    return _this
  }

  /**
   * CompletableFuture.thenRunAsync
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static thenRunAsync(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const callInfo = getRuntimeCallInfo(arguments)
    return (CompletableFuture.thenRun as unknown as (...args: unknown[]) => unknown).call(
      this,
      fclos,
      argvalues,
      state,
      node,
      scope,
      callInfo
    )
  }

  /**
   * CompletableFuture.thenApply
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static thenApply(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || argvalues.length < 1 || argvalues[0].vtype !== 'fclos' || !(this as any).executeCall) {
      return new UndefinedValue()
    }

    const futureScope =
      _this.getMisc('futureScope') ||
      buildNewValueInstance(
        this,
        scope,
        node,
        scope,
        () => {
          return false
        },
        (v: any) => {
          return !v
        },
        2
      )
    const thenFuncsWithContext = _this.getMisc('thenFuncsWithContext') || []
    const funcOldScope = argvalues[0].parent
    argvalues[0].parent = futureScope
    const _thenApplyThisObj = (typeof scope.getThisObj === 'function' ? scope.getThisObj() : scope._this)
    if (_thenApplyThisObj && !futureScope._this) futureScope._this = _thenApplyThisObj
    const previousResult = memSpaceUtil.getMemberValueNoCreate(_this, '_result', state)
    const callInfo = getRuntimeCallInfo(arguments)
    const traceCallNode = callInfo?.callsiteNode || node
    const callbackContext = this as unknown as CompletableFutureCallbackContext
    const result = callbackContext.executeCall(node.arguments[0], argvalues[0], state, futureScope, {
      callArgs: callbackContext.buildCallArgs(node.arguments[0], [previousResult], argvalues[0]),
      callsiteNode: traceCallNode,
    }) as any
    mergePreviousFutureTrace(previousResult, result)
    argvalues[0].parent = funcOldScope
    memSpaceUtil.saveVarInScope(_this, '_result', result, state)
    scope.value = MemState.unionScopeValues(scope, futureScope)
    thenFuncsWithContext.push({
      scope,
      node: node.arguments[0],
      fclos: argvalues[0],
      state,
      argvalues: [result],
      callsiteNode: traceCallNode,
    })

    _this.setMisc('thenFuncsWithContext', thenFuncsWithContext)

    return _this
  }

  /**
   * CompletableFuture.thenApplyAsync
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {UndefinedValue|*}
   */
  static thenApplyAsync(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const callInfo = getRuntimeCallInfo(arguments)
    return (CompletableFuture.thenApply as unknown as (...args: unknown[]) => unknown).call(
      this,
      fclos,
      argvalues,
      state,
      node,
      scope,
      callInfo
    )
  }

  /**
   * CompletableFuture.thenAccept
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static thenAccept(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || argvalues.length < 1 || argvalues[0].vtype !== 'fclos' || !(this as any).executeCall) {
      return new UndefinedValue()
    }

    const futureScope =
      _this.getMisc('futureScope') ||
      buildNewValueInstance(
        this,
        scope,
        node,
        scope,
        () => {
          return false
        },
        (v: any) => {
          return !v
        },
        2
      )
    const thenFuncsWithContext = _this.getMisc('thenFuncsWithContext') || []
    const funcOldScope = argvalues[0].parent
    argvalues[0].parent = futureScope
    const _thenAcceptThisObj = (typeof scope.getThisObj === 'function' ? scope.getThisObj() : scope._this)
    if (_thenAcceptThisObj && !futureScope._this) futureScope._this = _thenAcceptThisObj
    const result = memSpaceUtil.getMemberValueNoCreate(_this, '_result', state)
    const callInfo = getRuntimeCallInfo(arguments)
    const traceCallNode = callInfo?.callsiteNode || node
    const callbackContext = this as unknown as CompletableFutureCallbackContext
    callbackContext.executeCall(node.arguments[0], argvalues[0], state, futureScope, {
      callArgs: callbackContext.buildCallArgs(node.arguments[0], [result], argvalues[0]),
      callsiteNode: traceCallNode,
    })
    argvalues[0].parent = funcOldScope
    scope.value = MemState.unionScopeValues(scope, futureScope)
    thenFuncsWithContext.push({
      scope,
      node: node.arguments[0],
      fclos: argvalues[0],
      state,
      argvalues: [result],
      callsiteNode: traceCallNode,
    })

    _this.setMisc('thenFuncsWithContext', thenFuncsWithContext)

    return _this
  }

  /**
   * CompletableFuture.thenAcceptAsync
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static thenAcceptAsync(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const callInfo = getRuntimeCallInfo(arguments)
    return (CompletableFuture.thenAccept as unknown as (...args: unknown[]) => unknown).call(
      this,
      fclos,
      argvalues,
      state,
      node,
      scope,
      callInfo
    )
  }

  /**
   * CompletableFuture.get / CompletableFuture.get(timeout, unit)
   * 阻塞等待 future 完成，返回 future 的结果。
   * 对于 runAsync，返回值来自 futureScope 中的 taint 传播；
   * 对于 supplyAsync，返回值来自 supplyAsync 存储的 _supplyAsyncResult。
   */
  static get(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj?.() ?? fclos._this
    if (!_this) {
      return new UndefinedValue()
    }

    // 取 futureScope 中 runAsync/supplyAsync 执行 lambda 后合并回 scope 的变量
    const futureScope = _this.getMisc('futureScope')
    if (futureScope && typeof futureScope.value === 'object') {
      // 在 futureScope 中查找带 taint 的返回值候选
      // 典型模式：AtomicReference<String> resultRef; runAsync(() -> resultRef.set(X)); return resultRef.get();
      // futureScope.value 中 resultRef 携带了 callForCC 返回值的 taint
      scope.value = MemState.unionScopeValues(scope, futureScope)
    }

    // 执行 thenChain（与 join 对称）
    const thenFuncsWithContext = _this.getMisc('thenFuncsWithContext') || []
    let res: any = new UndefinedValue()
    const callbackContext = this as unknown as CompletableFutureCallbackContext
    for (const element of thenFuncsWithContext) {
      let elementArgvalues = element.argvalues
      if (elementArgvalues?.length > 0) {
        elementArgvalues = [res]
      }
      if (callbackContext.executeCall) {
        res = callbackContext.executeCall(element.node, element.fclos, element.state, element.scope, {
          callArgs: callbackContext.buildCallArgs(element.node, elementArgvalues, element.fclos),
          callsiteNode: element.callsiteNode || element.node,
        })
      }
    }
    _this.setMisc('thenFuncsWithContext', [])

    // 优先返回 supplyAsync 存储的结果（supplyAsync 有返回值）
    const supplyResult = _this.getMisc('_supplyAsyncResult') || _this.value?._result
    if (supplyResult && supplyResult.vtype !== 'undefined') {
      return supplyResult
    }

    return res
  }
}

export = CompletableFuture
