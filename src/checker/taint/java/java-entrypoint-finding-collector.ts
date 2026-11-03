/**
 * Java 逻辑入口的 finding 候补生命周期。
 *
 * 候补只在入口正常完成时转交给全局结果管理器；timeout、skip 和异常
 * 不会提前写入全局，也不会把上一次入口的状态带到下一次入口。
 */

export type JavaEntrypointTerminalOutcome = 'completed' | 'timeout' | 'skip' | 'exception'

export type JavaCandidateEmitter<TFinding> = (finding: TFinding) => void
export type JavaCandidateDeduplicator<TFinding> = (finding: TFinding) => boolean
export type JavaCandidatePromotionAdapter<TFinding> = {
  isNewFinding: JavaCandidateDeduplicator<TFinding>
  emit: JavaCandidateEmitter<TFinding>
}

export type JavaEntrypointFindingState<TSignature extends string, TFinding> = {
  readonly normalSignatures: Set<TSignature>
  readonly candidates: Map<TSignature, TFinding>
}

/** 单个逻辑 Java/Spring 入口的状态容器。overload/rerun 共用同一个实例。 */
export class JavaEntrypointFindingCollector<TSignature extends string, TFinding> {
  private promotionAdapter?: JavaCandidatePromotionAdapter<TFinding>

  private readonly state: JavaEntrypointFindingState<TSignature, TFinding> = {
    normalSignatures: new Set<TSignature>(),
    candidates: new Map<TSignature, TFinding>(),
  }

  /** 注入现有全局 dedup 与写入适配器，避免候补在生产路径被静默清空。 */
  configurePromotion(adapter: JavaCandidatePromotionAdapter<TFinding>): void {
    this.promotionAdapter = adapter
  }

  /** 当前入口的正常 finding 签名，供入口内仲裁使用。 */
  get normalSignatures(): ReadonlySet<TSignature> {
    return this.state.normalSignatures
  }

  /** 当前入口按首次出现顺序去重的候补。 */
  get candidates(): ReadonlyMap<TSignature, TFinding> {
    return this.state.candidates
  }

  /** 登记正常 finding；同签名重复登记不改变稳定顺序。 */
  registerNormal(signature: TSignature): void {
    this.state.normalSignatures.add(signature)
    this.state.candidates.delete(signature)
  }

  /** 登记候补；同签名候补只保留第一个，正常 finding 不在此处写全局。 */
  registerCandidate(signature: TSignature, finding: TFinding): void {
    if (this.state.normalSignatures.has(signature) || this.state.candidates.has(signature)) return
    this.state.candidates.set(signature, finding)
  }

  recordNormal(signature: TSignature): void {
    this.registerNormal(signature)
  }

  recordCandidate(signature: TSignature, finding: TFinding): void {
    this.registerCandidate(signature, finding)
  }

  /**
   * 入口正常完成时仲裁候补，并在回调返回后清空入口状态。
   * 候补再次走现有全局 dedup；正常签名优先于候补。
   */
  complete(
    isNewFinding?: JavaCandidateDeduplicator<TFinding>,
    emit?: JavaCandidateEmitter<TFinding>,
  ): void {
    try {
      const promoter = isNewFinding && emit ? { isNewFinding, emit } : this.promotionAdapter
      if (!promoter) return
      for (const [signature, finding] of this.state.candidates) {
        if (this.state.normalSignatures.has(signature)) continue
        if (promoter.isNewFinding(finding)) promoter.emit(finding)
      }
    } finally {
      this.clear()
    }
  }

  /**
   * 入口结束异常、skip 或最终 timeout 时丢弃全部临时状态。
   * 非正常 outcome 不调用全局写入回调。
   */
  finalize(outcome: Exclude<JavaEntrypointTerminalOutcome, 'completed'>): void {
    if (outcome === 'timeout' || outcome === 'skip' || outcome === 'exception') this.clear()
  }

  /** 首次 timeout 后保留状态，供同一逻辑入口的 rerun 继续登记。 */
  deferForRerun(): void {
    // 有意保持状态；rerun 完成后调用 complete，最终失败时调用 finalize。
  }

  /** 清空入口状态，保证 collector 可安全复用于下一逻辑入口。 */
  clear(): void {
    this.state.normalSignatures.clear()
    this.state.candidates.clear()
  }

  /** collector 完成或中止后必须为空。 */
  get isEmpty(): boolean {
    return this.state.normalSignatures.size === 0 && this.state.candidates.size === 0
  }
}

/**
 * 按逻辑入口 key 隔离 collector；同一 key 的 overload/rerun 会复用状态，
 * 不同 key 即使并发执行也不会互相覆盖。
 */
export class JavaEntrypointFindingCollectorRegistry<TSignature extends string, TFinding> {
  private readonly collectors = new Map<string, JavaEntrypointFindingCollector<TSignature, TFinding>>()
  private promotionAdapter?: JavaCandidatePromotionAdapter<TFinding>

  /** 开启新的分析运行，丢弃上一次运行遗留的逻辑入口状态。 */
  beginRun(): void {
    this.clear()
  }

  configurePromoter(adapter: JavaCandidatePromotionAdapter<TFinding>): void {
    this.promotionAdapter = adapter
    for (const collector of this.collectors.values()) collector.configurePromotion(adapter)
  }

  get(logicalEntrypointKey: string): JavaEntrypointFindingCollector<TSignature, TFinding> {
    const existing = this.collectors.get(logicalEntrypointKey)
    if (existing) return existing
    const collector = new JavaEntrypointFindingCollector<TSignature, TFinding>()
    if (this.promotionAdapter) collector.configurePromotion(this.promotionAdapter)
    this.collectors.set(logicalEntrypointKey, collector)
    return collector
  }

  /** 正常完成并移除入口 collector，避免生命周期状态泄漏。 */
  complete(
    logicalEntrypointKey: string,
    isNewFinding?: JavaCandidateDeduplicator<TFinding>,
    emit?: JavaCandidateEmitter<TFinding>,
  ): void {
    const collector = this.collectors.get(logicalEntrypointKey)
    if (!collector) return
    try {
      collector.complete(isNewFinding, emit)
    } finally {
      this.collectors.delete(logicalEntrypointKey)
    }
  }

  /** timeout/skip/异常最终结束时清理；首次 timeout 不应调用此方法。 */
  finalize(logicalEntrypointKey: string, outcome: Exclude<JavaEntrypointTerminalOutcome, 'completed'>): void {
    const collector = this.collectors.get(logicalEntrypointKey)
    if (!collector) return
    collector.finalize(outcome)
    this.collectors.delete(logicalEntrypointKey)
  }

  /** 调试及生命周期测试使用；返回仍存活的逻辑入口数量。 */
  get size(): number {
    return this.collectors.size
  }

  /** 强制清空所有入口，供分析器退出保护路径使用。 */
  clear(): void {
    for (const collector of this.collectors.values()) collector.clear()
    this.collectors.clear()
  }
}

import type { TaintFinding } from '../../../engine/analyzer/common/common-types'

/** Java/Spring 主循环共享的入口候补 registry；候补实现接入时复用同一实例。 */
export const javaEntrypointFindingCollectors =
  new JavaEntrypointFindingCollectorRegistry<string, TaintFinding>()

/** 从当前入口对象生成稳定的逻辑入口隔离键。 */
export function getJavaLogicalEntrypointKey(entryPoint: unknown): string {
  if (!entryPoint || typeof entryPoint !== 'object') return '<unknown-entrypoint>'
  const candidate = entryPoint as {
    filePath?: unknown
    functionName?: unknown
    type?: unknown
    attribute?: unknown
    funcLocStart?: unknown
    funcLocEnd?: unknown
    entryPointSymVal?: { ast?: { node?: { loc?: { sourcefile?: unknown; start?: { line?: unknown }; end?: { line?: unknown } } } } }
  }
  const loc = candidate.entryPointSymVal?.ast?.node?.loc
  return [
    candidate.filePath ?? loc?.sourcefile ?? '',
    candidate.functionName ?? '',
    candidate.type ?? '',
    candidate.funcLocStart ?? loc?.start?.line ?? '',
    candidate.funcLocEnd ?? loc?.end?.line ?? '',
    candidate.attribute ?? '',
  ].map(String).join('|')
}

export function getJavaEntrypointFindingCollector(logicalEntrypointKey: string): JavaEntrypointFindingCollector<string, TaintFinding> {
  return javaEntrypointFindingCollectors.get(logicalEntrypointKey)
}
