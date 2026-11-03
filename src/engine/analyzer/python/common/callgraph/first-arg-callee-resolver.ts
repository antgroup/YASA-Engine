/**
 * 通用 first-arg-is-callee callgraph 解析
 *
 * 识别已知调度函数（asyncio.to_thread / loop.run_in_executor / functools.partial），
 * 把 first-arg（或 second-arg for run_in_executor）解析为被调函数，建立 callgraph 边，
 * 把剩余 args 作为被调函数的入参 taint 传播。
 *
 * 解决 asyncio.to_thread(_http_get, *args) 跨线程调用不被识别的 taint 断点。
 */
import type { CallExpression } from '../../../../../types/uast'
import type { CallInfo } from '../../../common/call-args'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../../../../../config')

interface FirstArgCalleeMatch {
  calleeArgIndex: number
}

// 已知调度函数名列表（完整 object.property 或通配 *.property）
// - asyncio.to_thread: first-arg 是被调函数
// - functools.partial: first-arg 是被调函数
// - *.run_in_executor: second-arg 是被调函数（first-arg 是 executor）
const DEFAULT_FIRST_ARG_CALLEE_PATTERNS: Array<{ qualifier: string | null; method: string; argIndex: number }> = [
  { qualifier: 'asyncio', method: 'to_thread', argIndex: 0 },
  { qualifier: 'functools', method: 'partial', argIndex: 0 },
  { qualifier: null, method: 'run_in_executor', argIndex: 1 },
]

interface ResolverConfig {
  patterns: Array<{ qualifier: string | null; method: string; argIndex: number }>
  enabled: boolean
}

function loadResolverConfig(): ResolverConfig {
  const enabled = config.pythonFirstArgCalleeResolverEnabled !== false
  const configured = config.pythonFirstArgCalleePatterns
  if (Array.isArray(configured) && configured.length > 0) {
    const patterns = configured.map((entry: any) => ({
      qualifier: entry.qualifier ?? null,
      method: String(entry.method),
      argIndex: Number(entry.argIndex) || 0,
    }))
    return { patterns, enabled }
  }
  return { patterns: DEFAULT_FIRST_ARG_CALLEE_PATTERNS, enabled }
}

/**
 * 从 callee AST 节点提取 (qualifier, method)
 * - MemberAccess(object=Identifier(asyncio), property=Identifier(to_thread)) → ('asyncio', 'to_thread')
 * - Identifier(to_thread) → (null, 'to_thread')
 */
function extractCalleeQualifierMethod(callee: any): { qualifier: string | null; method: string | null } {
  if (!callee) return { qualifier: null, method: null }
  if (callee.type === 'MemberAccess') {
    const objectName = callee.object?.type === 'Identifier' ? callee.object.name : null
    const propertyName = callee.property?.type === 'Identifier' ? callee.property.name : null
    return { qualifier: objectName, method: propertyName }
  }
  if (callee.type === 'Identifier') {
    return { qualifier: null, method: callee.name }
  }
  return { qualifier: null, method: null }
}

/**
 * 匹配调度函数模式
 */
function matchFirstArgCalleePattern(
  callee: any,
  patterns: Array<{ qualifier: string | null; method: string; argIndex: number }>
): FirstArgCalleeMatch | null {
  const { qualifier, method } = extractCalleeQualifierMethod(callee)
  if (!method) return null
  for (const pattern of patterns) {
    if (pattern.method !== method) continue
    // qualifier 为 null 表示通配（如 *.run_in_executor）
    if (pattern.qualifier === null) return { calleeArgIndex: pattern.argIndex }
    if (pattern.qualifier === qualifier) return { calleeArgIndex: pattern.argIndex }
  }
  return null
}

/**
 * 构建 first-arg-callee 调用的 callInfo
 *
 * 把原调用的 args（除 callee arg 外）作为被调函数的参数。
 * 保留原 callInfo 的 spread/kwspread kind，使 bindCallArgs 能正确解包 *args / **kwargs。
 */
function buildCalleeCallInfo(
  originalCallInfo: CallInfo,
  argvalues: any[],
  calleeArgIndex: number,
  node: CallExpression
): CallInfo {
  const originalArgs = originalCallInfo?.callArgs?.args || []
  // 过滤掉 callee arg，保留其余 args
  const remainingArgs = originalArgs
    .filter((arg: any) => arg && arg.index !== calleeArgIndex)
    .map((arg: any, idx: number) => ({
      ...arg,
      index: idx,
    }))
  const remainingArgvalues = argvalues
    .slice(0, calleeArgIndex)
    .concat(argvalues.slice(calleeArgIndex + 1))
  return {
    callArgs: {
      args: remainingArgs,
      receiver: originalCallInfo?.callArgs?.receiver,
      node,
    },
    callsiteNode: node,
    boundCall: undefined,
  }
}

/**
 * 尝试解析 first-arg-is-callee 调用，如果匹配则触发对被调函数的 executeCall
 *
 * @returns true 如果已处理（caller 是已知调度函数且 first-arg 是 fclos）；false 否则
 */
export function tryExecuteFirstArgCallee(
  analyzer: any,
  scope: any,
  node: CallExpression,
  state: any,
  fclos: any,
  argvalues: any[],
  callInfo: CallInfo
): boolean {
  const { patterns, enabled } = loadResolverConfig()
  if (!enabled) return false

  const match = matchFirstArgCalleePattern(node?.callee, patterns)
  if (!match) return false

  const calleeArg = argvalues[match.calleeArgIndex]
  if (!calleeArg || calleeArg.vtype !== 'fclos') return false

  // 被调函数有 fdef（FunctionDefinition）才触发，避免对任意可调用对象误识别
  if (!calleeArg.ast?.fdef && !calleeArg.fdef) return false

  const calleeFclos = calleeArg
  const calleeCallInfo = buildCalleeCallInfo(callInfo, argvalues, match.calleeArgIndex, node)

  try {
    analyzer.executeCall(node, calleeFclos, state, scope, calleeCallInfo)
  } catch {
    // 调用失败不阻塞分析
  }
  return true
}
