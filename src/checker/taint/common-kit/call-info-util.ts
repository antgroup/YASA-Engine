import type { CallArg, CallInfo } from '../../../engine/analyzer/common/call-args'

/**
 * 统一处理 checkAtNewExprAfter payload 的 callInfo / legacy argvalues 不对称问题。
 * - common analyzer 在 processNewObject 传 callInfo（analyzer.ts:3707-3714）
 * - python/go-analyzer 早期走 legacy，只传 argvalues（兜底）
 * 参考 sanitizer-checker.ts:112/141 的既有兼容模式。
 */
export function getOrBuildCallInfo(info: any): CallInfo | undefined {
  if (info?.callInfo) return info.callInfo
  const argvalues = info?.argvalues
  if (!Array.isArray(argvalues)) return undefined
  const args: CallArg[] = argvalues.map((v: any, i: number) => ({
    index: i,
    value: v,
    kind: 'positional',
  }))
  return { callArgs: { args } }
}

module.exports = {
  getOrBuildCallInfo,
}
