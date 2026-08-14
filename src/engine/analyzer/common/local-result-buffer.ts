// EP-owned 本地 findings buffer，形状对齐 ResultManager.findings（Record<strategyId, Finding[]>）。
// 每个 executor 持有独立 buffer，EP 执行完毕后通过 mergeCoordinator 合并到全局 ResultManager。

// Finding 类型与 ResultManager 对齐（运行期形态为 plain object），
// 这里以最小强类型骨架声明，避免绑定 ResultManager 实现细节。
export type Finding = Record<string, unknown>

/**
 * LocalResultBuffer：单个 EntryPointExecutor 持有的 finding 暂存接口。
 * append/getFindings/clear 形状与 ResultManager 对齐，便于 end-of-EP
 * 把本地 findings merge 回全局 ResultManager。
 */
export interface LocalResultBuffer {
  append(strategyId: string, finding: Finding): void
  getFindings(): Record<string, Finding[]>
  clear(): void
}

/**
 * 进程内默认实现：按 strategyId 分桶追加；不做去重，dedup 仍由 OutputStrategy 负责。
 */
export class InMemoryLocalResultBuffer implements LocalResultBuffer {
  private findingsByStrategy: Record<string, Finding[]>

  constructor() {
    this.findingsByStrategy = {}
  }

  append(strategyId: string, finding: Finding): void {
    const bucket = this.findingsByStrategy[strategyId] ?? []
    bucket.push(finding)
    this.findingsByStrategy[strategyId] = bucket
  }

  getFindings(): Record<string, Finding[]> {
    return this.findingsByStrategy
  }

  clear(): void {
    this.findingsByStrategy = {}
  }
}

export function createEmptyLocalResultBuffer(): LocalResultBuffer {
  return new InMemoryLocalResultBuffer()
}
