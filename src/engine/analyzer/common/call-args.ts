/**
 * Call argument types and utility functions for structured call info.
 *
 * CallArgs: call-site view — records each argument's kind/name/value
 * BoundCall: declaration-side view — binds arguments to parameters
 * CallInfo: container passed through the call chain
 */

export type CallArgKind = 'positional' | 'keyword' | 'spread' | 'kwspread'

export interface CallArg {
  index: number        // original position in node.arguments
  value: any           // evaluated result
  node?: any           // AST node (for SourceLine)
  name?: string        // keyword name (keyword/kwspread only)
  kind: CallArgKind
}

export interface CallArgs {
  receiver?: any       // MemberAccess thisObj
  args: CallArg[]
}

export interface BoundParam {
  index: number
  name: string
  value?: any
  provided: boolean
  argIndexes: number[]
}

export interface BoundCall {
  receiver?: any
  params: BoundParam[]
}

export interface CallInfo {
  callArgs?: CallArgs
  boundCall?: BoundCall
}

/**
 * Info object passed from analyzer to checkers via checkAtFunctionCallBefore/After.
 * Unifies the `info: any` parameter in all triggerAtFunctionCall* methods.
 */
export interface FunctionCallInfo {
  callInfo: CallInfo | undefined
  fclos: any
  ret?: any
  pcond?: any[]
  entry_fclos?: any
  einfo?: any
  ainfo?: any
  [key: string]: any
}

/** analyzer 主动触发的函数执行（无真实调用方、无参数） */
export const INTERNAL_CALL: CallInfo = { callArgs: { args: [] } }

/**
 * Extract legacy argvalues array from callInfo for backward compatibility.
 * Returns the values of all call args, or an empty array if callInfo is undefined.
 */
export function getLegacyArgValues(callInfo: CallInfo | undefined): any[] {
  if (!callInfo) return []
  const callArgs = callInfo.callArgs
  if (!callArgs) return []
  return callArgs.args.map((a: CallArg) => a.value)
}

/**
 * Get the count of explicit (non-spread) arguments.
 */
export function getExplicitArgCount(callInfo: CallInfo | undefined): number {
  if (!callInfo) return 0
  const callArgs = callInfo.callArgs
  if (!callArgs) return 0
  return callArgs.args.filter((a: CallArg) => a.kind !== 'spread' && a.kind !== 'kwspread').length
}

/**
 * Extract CallArgs from a CallInfo object.
 */
export function getCallArgsFromInfo(callInfo: CallInfo | undefined): CallArgs | undefined {
  if (!callInfo) return undefined
  return callInfo.callArgs
}

/**
 * Extract BoundCall from a CallInfo object.
 */
export function getBoundCallFromInfo(callInfo: CallInfo | undefined): BoundCall | undefined {
  if (!callInfo) return undefined
  return callInfo.boundCall
}
