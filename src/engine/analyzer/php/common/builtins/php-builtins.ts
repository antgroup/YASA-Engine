/**
 * PHP 内置函数 taint passthrough 注册
 *
 * PHP 内置函数（json_decode、base64_decode 等）没有函数体（fdef），
 * 引擎在 executeCall 时返回无 taint 的 CallExprValue，导致 taint 断链。
 *
 * 此模块为这些函数注册 runtime.execute，实现 taint passthrough：
 * 如果任意输入参数带 taint，则返回值也带 taint。
 */
import { FunctionValue } from '../../../common/value/function'
import { SymbolValue } from '../../../common/value/symbolic'
import type { Scoped } from '../../../common/value/scoped'
import type { State } from '../../../../../types/analyzer'

/**
 * 通用 taint passthrough 执行器
 * 将输入参数的 taint 传播到返回值
 */
function createPassthroughExecute(name: string) {
  return function passthroughExecute(
    this: any,
    _fclos: FunctionValue,
    argvalues: any[],
    _state: State,
    node: any,
    _scope: any
  ): any {
    const resultQid = `<builtin>.${name}`
    const result = new SymbolValue(resultQid, {
      sid: `${name}_result`,
      qid: `${resultQid}.result`,
    })

    // 传播所有输入参数的 taint 到返回值（对齐 processLibArgToRet 行为）
    let isTainted = false
    for (const arg of argvalues) {
      if (arg?.taint?.isTaintedRec) {
        isTainted = true
        result.taint?.propagateFrom(arg)
      }
    }
    if (isTainted) {
      result.taint?.markSource()
    }
    // 将参数存入 misc_，使 hasTagRec 迭代时能追踪到 taint 参数
    if (argvalues.length > 0 && result.setMisc) {
      result.setMisc('pass-in', argvalues)
    }

    return result
  }
}

/**
 * 需要显式 taint passthrough 的 PHP 内置函数
 *
 * 注意：只注册引擎 processLibArgToRet 默认路径无法正确传播的函数。
 * sprintf/substr/array_filter/reset 等引擎默认已能正确传播 taint，
 * 不要在此注册，否则会覆盖默认路径导致 taint 断链。
 */
const PASSTHROUGH_FUNCTIONS: string[] = [
  // 暂为空——当前引擎默认的 processLibArgToRet 已能处理所有 PHP 内置函数的 taint 传播。
  // 仅在发现具体函数的 taint 断链时，才添加到此列表。
]

/**
 * 在 topScope 中注册 PHP 内置函数的 taint passthrough
 *
 * 在 preProcess 后、startAnalyze 前调用
 */
export function initPhpBuiltins(topScope: Scoped): void {
  for (const funcName of PASSTHROUGH_FUNCTIONS) {
    const builtinQid = `${topScope.qid}.<php_builtin>`
    const fv = new FunctionValue(builtinQid, {
      sid: funcName,
      qid: `${builtinQid}.${funcName}`,
    })
    fv.runtime = { execute: createPassthroughExecute(funcName) }
    topScope.value[funcName] = fv
  }
}
