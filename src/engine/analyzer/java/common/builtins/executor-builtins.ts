const _ = require('lodash')
const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')

/**
 * java.util.concurrent.Executor
 */
class Executor {
  /**
   * 将外层 scope 链中带 taint 的变量传播到 runnable 实例。
   * Java 匿名类通过 val$xxx 合成字段捕获外层变量，
   * 引擎不模拟此机制，因此需要显式传播使闭包变量可被方法体解析。
   */
  static propagateClosureTaint(runnable: any, scope: any, maxDepth: number = 3, forcePropagate: boolean = false): void {
    if (!runnable || !scope) return
    // fclos（lambda）通过 parent scope chain 已有闭包访问，注入会产生影子变量
    // 绕过正常作用域链（如 thenApply 中 result.set("clean") 后 result.get()
    // 应得到 clean 值，但注入的 taint 值会覆盖清理效果导致误报）。
    if (runnable.vtype === 'fclos') return
    // 仅对匿名类生效：Java 匿名类通过 val$xxx 合成字段捕获闭包变量，
    // 引擎不模拟此机制需要显式传播。普通类（如 R implements Runnable）通过
    // 构造器传参，不需要闭包变量注入，否则会造成外层作用域同名变量
    // 覆盖实例字段导致误报。fclos 的传播由调用方内联处理。
    // 匿名类实例 sid 为 <ClassName><instance_...> 不含 <anonymous，sid 守卫恒 false，
    // 调用方在已用内联声明位置判定为匿名类时传 forcePropagate=true 绕过该守卫。
    const isAnonymous = runnable.sid?.includes('<anonymous')
    if (!forcePropagate && !isAnonymous) return
    let currentScope = scope
    let depth = 0
    while (currentScope && depth < maxDepth) {
      const values = currentScope.value
      if (values && typeof values === 'object') {
        for (const key of Object.keys(values)) {
          if (key.startsWith('__') || key === '_CTOR_') continue
          const val = values[key]
          if (!val || typeof val !== 'object') continue
          const hasTaint = val.taint?.isTaintedRec
          if (!hasTaint) continue
          // 写入 runnable.value 使 scope chain（通过类闭包）可解析
          if (!runnable.value[key]) {
            runnable.value[key] = val
          }
          // 不写入 fclos.value：fclos.value 优先级高于 parent scope chain，
          // 注入后会使 lambda 内同名变量直接命中注入值，绕过正常作用域链
          // （如 thenApply 中 result.set("clean") 后 result.get() 应得到 clean 值，
          // 但注入的 taint 值会覆盖清理效果导致误报）。
          // 传播 taint 到 runnable 实例本身
          if (typeof runnable.taint?.markSource === 'function') {
            runnable.taint.markSource()
          }
          if (typeof runnable.taint?.mergeTracesFrom === 'function' && val.taint) {
            runnable.taint.mergeTracesFrom(val.taint)
          }
          if (typeof runnable.setMisc === 'function') {
            const buf = runnable.getMisc('buffer')
            if (!Array.isArray(buf) || !buf.includes(val)) {
              runnable.setMisc('buffer', [...(buf || []), val])
            }
          }
        }
      }
      currentScope = currentScope.parent
      depth++
    }
  }

  /**
   * 将外部类（enclosing class）的成员（方法 + 字段）传播到匿名类实例，
   * 模拟 Java this$0 引用使匿名类方法体内可解析外部类方法和字段。
   * Java 匿名内部类对外部类的引用通过合成字段 this$0 实现，
   * 引擎不模拟此机制，因此需要显式传播使外部类成员可被解析。
   */
  static propagateEnclosingMembers(runnable: any, scope: any, maxDepth: number = 5, forcePropagate: boolean = false): void {
    if (!runnable || !scope) return
    // fclos（lambda）通过 parent scope chain 已有闭包访问，不需要 this$0 模拟。
    if (runnable.vtype === 'fclos') return
    // 仅对匿名类生效：propagateEnclosingMembers 模拟 this$0 外部类引用，
    // 只有匿名类才有外部类引用，普通类不需要注入外部类方法。
    // fclos 的传播由调用方内联处理。
    // 匿名类实例 sid 不含 <anonymous，调用方已用内联声明位置判定时传 forcePropagate=true 绕过。
    const isAnonymous = runnable.sid?.includes('<anonymous')
    if (!forcePropagate && !isAnonymous) return
    const runnableFclos = runnable._fclos || runnable
    // Object 基类方法名黑名单，避免注入 hashCode/toString 等无关方法
    const skipNames = new Set(['_CTOR_', 'super', 'hashCode', 'toString', 'equals', 'getClass', 'clone', 'finalize', 'notify', 'notifyAll', 'wait'])
    let currentScope = scope
    let depth = 0
    while (currentScope && depth < maxDepth) {
      const thisObj = currentScope._this
      if (thisObj && thisObj !== runnable && thisObj !== runnableFclos && thisObj.members) {
        // 找到外部类作用域，将其方法和字段注入到匿名类实例
        thisObj.members.forEach((memberVal: any, memberName: string) => {
          if (memberName.startsWith('__') || skipNames.has(memberName)) return
          if (!memberVal || typeof memberVal !== 'object') return
          // fclos（方法）和非 fclos（字段，如 @SofaReference 注入的 DI 字段）均传播
          const vtype = memberVal.vtype
          if (vtype !== 'fclos' && vtype !== 'object' && vtype !== 'symbol') return
          // 注入到 runnable._fclos.members（影响 thisFClos.members.get() 标识符解析）
          if (runnableFclos.members && typeof runnableFclos.members.has === 'function' && !runnableFclos.members.has(memberName)) {
            runnableFclos.members.set(memberName, memberVal)
          }
          // 注入到 runnable._fclos.value（影响 getDefScopeRec 作用域链解析）
          if (runnableFclos.value && typeof runnableFclos.value === 'object' && !runnableFclos.value[memberName]) {
            runnableFclos.value[memberName] = memberVal
          }
          // 注入到 runnable.members（实例级成员查找备用）
          if (runnable.members && typeof runnable.members.has === 'function' && !runnable.members.has(memberName)) {
            runnable.members.set(memberName, memberVal)
          }
          // 注入到 runnable.value（实例级变量查找备用）
          if (runnable.value && typeof runnable.value === 'object' && !runnable.value[memberName]) {
            runnable.value[memberName] = memberVal
          }
        })
      }
      currentScope = currentScope.parent
      depth++
    }
  }

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
    const runnable = argvalues[0]
    // 闭包变量 taint 传播：将外层 scope 中带 taint 的变量注入 runnable
    Executor.propagateClosureTaint(runnable, scope)
    // 外部类方法传播：Java 匿名类 this$0 引用模拟，使外部类方法可被匿名类方法体解析
    Executor.propagateEnclosingMembers(runnable, scope)
    const runMethod = runnable?.members?.get('run')
    // 当 run 没有 fdef（来自外部 JAR 无方法体），fallback 到 doRun/runInner
    // 覆盖 tracer 继承模式：run()→doRun()→runInner()
    const doRunMethod = runnable?.members?.get('doRun')
    const runInnerMethod = runnable?.members?.get('runInner')
    const resolvedMethod = runMethod?.ast?.fdef ? runMethod
      : doRunMethod?.ast?.fdef ? doRunMethod
      : runInnerMethod?.ast?.fdef ? runInnerMethod
      : runMethod  // 全都没 fdef，保持原行为走 lib-propagation
    if (resolvedMethod && _.isFunction((this as any).executeCall)) {
      ;(this as any).executeCall(node, resolvedMethod, state, scope, { callArgs: (this as any).buildCallArgs(node, [], resolvedMethod) })
    } else if (runnable.vtype === 'fclos' && _.isFunction((this as any).executeCall)) {
      ;(this as any).executeCall(node, runnable, state, scope, { callArgs: (this as any).buildCallArgs(node, [], runnable) })
    }
  }
}

export = Executor
