// Merge Coordinator：EP 执行结束后将 LocalResultBuffer 中的 findings 合并到全局 ResultManager。
// 按 strategyId 分桶，对每个 finding 调用对应 OutputStrategy 的 isNewFinding 做跨 EP 去重，
// 通过的才写入全局 ResultManager。

import type { IResultManager } from '../result-manager'
import type { LocalResultBuffer, Finding } from '../local-result-buffer'

type IsNewFindingFn = (resultManager: IResultManager, finding: Finding) => boolean

// strategyId → isNewFinding 函数的注册表。
// Strategy 模块加载时通过 registerDedupFunction 注册；
// 当前 slice 为 no-op（executor scope 不被触发），registry 不会被查询。
const dedupRegistry = new Map<string, IsNewFindingFn>()

/**
 * 注册 strategyId 对应的 isNewFinding 去重函数。
 * 供各 OutputStrategy 模块加载时调用。
 */
export function registerDedupFunction(strategyId: string, fn: IsNewFindingFn): void {
  dedupRegistry.set(strategyId, fn)
}

/**
 * 将 LocalResultBuffer 中的 findings merge 到全局 ResultManager。
 * 按 strategyId 分桶，对每个 finding 调用已注册的 isNewFinding 做去重，
 * 通过的才写入全局。未注册 dedup 函数的 strategyId 直接写入。
 */
export function mergeBufferToGlobal(
  buffer: LocalResultBuffer,
  globalResultManager: IResultManager,
): void {
  const allFindings = buffer.getFindings()
  for (const strategyId of Object.keys(allFindings)) {
    const findings = allFindings[strategyId]
    if (!findings || findings.length === 0) continue

    const dedupFn = dedupRegistry.get(strategyId)
    for (const finding of findings) {
      if (dedupFn) {
        if (!dedupFn(globalResultManager, finding)) continue
      }
      globalResultManager.newFinding(finding as Record<string, any>, strategyId)
    }
  }
  buffer.clear()
}
