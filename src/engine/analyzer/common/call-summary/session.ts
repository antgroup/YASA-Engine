import { yasaLog, yasaWarning } from '../../../../util/format-util'
import { getCallSummaryStrategy } from './strategy'
import { CallSummaryLayeredStore } from './store'
import {
  buildCallSummaryArgKey,
  buildCallSummaryLayerLevelKey,
  buildCallSummaryTargetKey,
} from './keys'
import type {
  CallSummaryCallee,
  CallSummaryDisplayOptions,
  CallSummaryLayerLevel,
  CallSummaryLookupResult,
  CallSummaryObserveMetrics,
  CallSummaryRecordOptions,
  CallSummaryReplayDelta,
  CallSummaryReturnLike,
  CallSummaryRiskContext,
  CallSummaryRuntimeKeyOptions,
  CallSummaryStageConfig,
  CallSummaryStageCounters,
  CallSummaryStageSnapshot,
  CallSummaryStrategy,
} from './types'

interface CallSummaryExecutionFrame {
  nestedSideEffectObserved: boolean
}

export interface CallSummaryCallContext {
  readonly callerQid: string | undefined
  readonly callee: CallSummaryCallee
  readonly callArgs: readonly { readonly node?: unknown; readonly value?: unknown }[] | undefined
  readonly riskContext: Partial<CallSummaryRiskContext> | string | undefined
}

export interface CallSummaryLookupOptions {
  readonly context: CallSummaryCallContext
  readonly runtime?: CallSummaryRuntimeKeyOptions
  readonly canUse?: boolean
}

export interface CallSummaryRecordReturnOptions extends CallSummaryLookupOptions {
  readonly result: CallSummaryRecordOptions
}

export interface CallSummarySideEffectSnapshot {
  readonly findings: number
  readonly callGraphEdges: number
  readonly entrypoints: number
  readonly markedSources: number
  readonly matchedSinks: number
}


interface CallSummaryReplaySnapshot extends CallSummarySideEffectSnapshot {
  readonly returnUsed: boolean | 'unknown'
}

export interface CallSummaryExecutionOptions<TValue extends CallSummaryReturnLike> {
  readonly sessions: readonly CallSummaryStageSession[]
  readonly context: CallSummaryCallContext
  readonly canUse: boolean
  readonly includeStage?: boolean
  readonly runtime?: CallSummaryRuntimeKeyOptions
  readonly captureSideEffectSnapshot: () => CallSummarySideEffectSnapshot
  readonly getReturnUsed: () => boolean | 'unknown'
  readonly execute: () => TValue
  readonly getReplayValue?: (value: TValue) => CallSummaryReturnLike
  readonly applyReplayDelta: (replayDelta: CallSummaryReplayDelta) => void
  readonly buildReplayReturn: (replayDelta: CallSummaryReplayDelta) => TValue
  readonly buildHitReturn: () => TValue
}

interface CallSummarySessionConfig {
  readonly strategy: CallSummaryStrategy
  readonly layerLevel: CallSummaryLayerLevel
  readonly supportsReplayDelta?: boolean
  readonly displayOptions?: CallSummaryDisplayOptions
  readonly disabledReason: (language?: string) => string
}

export function createCallSummaryStageCounters(): CallSummaryStageCounters {
  return {
    calls: 0,
    hits: 0,
    estimatedKeyBytes: 0,
    storedKeyBytes: 0,
    argKeyBuilds: 0,
    runtimeStateKeyBuilds: 0,
    optionalStateKeys: 0,
    riskKeyBuilds: 0,
  }
}

export function cloneCallSummaryStageCounters(counters: CallSummaryStageCounters): CallSummaryStageCounters {
  return { ...counters }
}


function buildReplayDelta(
  snapshot: CallSummaryReplaySnapshot,
  current: CallSummarySideEffectSnapshot,
  nestedSideEffectObserved: boolean,
  value: CallSummaryReturnLike
): CallSummaryRecordOptions {
  if (current.findings !== snapshot.findings) return { disabledReason: 'findings-delta-unmodelled' }
  if (current.callGraphEdges !== snapshot.callGraphEdges) return { disabledReason: 'callgraph-delta-unmodelled' }
  if (current.entrypoints !== snapshot.entrypoints) return { disabledReason: 'entrypoint-delta-unmodelled' }
  if (nestedSideEffectObserved) return { disabledReason: 'nested-side-effect-unmodelled' }

  const markedSources = current.markedSources - snapshot.markedSources
  const matchedSinks = current.matchedSinks - snapshot.matchedSinks
  if (markedSources < 0 || matchedSinks < 0) return { disabledReason: 'counter-regression-unmodelled' }
  if (!value || value.vtype === 'undefine') return { replayDelta: { counters: { markedSources, matchedSinks }, returnMode: 'fresh-undefined' } }
  if (value.vtype === 'void') return { replayDelta: { counters: { markedSources, matchedSinks }, returnMode: 'fresh-void' } }
  return { disabledReason: 'return-value-unmodelled' }
}

export function executeWithCallSummary<TValue extends CallSummaryReturnLike>(options: CallSummaryExecutionOptions<TValue>): TValue {
  let replaySession: CallSummaryStageSession | undefined
  for (const session of options.sessions) {
    if (options.includeStage === false && session.usesRuntimeState()) continue
    const result = session.lookupReturn({
      context: options.context,
      runtime: undefined,
      canUse: options.canUse,
    })
    if (!result) continue
    if (result.replayDelta) {
      options.applyReplayDelta(result.replayDelta)
      return options.buildReplayReturn(result.replayDelta)
    }
    return options.buildHitReturn()
  }

  replaySession = options.sessions.find((session) => session.supportsReplayDelta())
  const replaySnapshot = replaySession?.isActive()
    ? { ...options.captureSideEffectSnapshot(), returnUsed: options.getReturnUsed() }
    : undefined
  if (replaySnapshot) replaySession?.beginExecutionFrame()

  const value = options.execute()
  const replayValue = options.getReplayValue ? options.getReplayValue(value) : value
  const replayResult = replaySnapshot && replaySession
    ? buildReplayDelta(
      replaySnapshot,
      options.captureSideEffectSnapshot(),
      replaySession.hasNestedSideEffectObserved(),
      replayValue
    )
    : {}
  if (replaySnapshot && replaySession) {
    const observedSideEffect = Boolean(replayResult.disabledReason) || replaySession.hasNestedSideEffectObserved()
    replaySession.endExecutionFrame(observedSideEffect)
  }

  for (const session of options.sessions) {
    if (options.includeStage === false && session.usesRuntimeState()) continue
    const result = session.supportsReplayDelta()
      ? replayResult
      : value ? { disabledReason: 'shared-return-reference-disabled' } : {}
    session.recordSharedReturn({
      context: options.context,
      runtime: undefined,
      canUse: options.canUse,
      result,
    })
  }
  return value
}


export function createDefaultCallSummarySessions(config?: CallSummaryStageConfig): CallSummaryStageSession[] {
  return [
    new CallSummaryStageSession({
      strategy: getCallSummaryStrategy('processModule', config),
      layerLevel: 'basic',
      supportsReplayDelta: true,
      displayOptions: { stages: ['preProcess', 'processModule'] },
      disabledReason: (language) => `language:${language ?? 'unknown'};strategy:${getCallSummaryStrategy('processModule', config)}`,
    }),
    new CallSummaryStageSession({
      strategy: getCallSummaryStrategy('symbolInterpret', config),
      layerLevel: 'runtime',
      disabledReason: (language) => `language:${language ?? 'unknown'};strategy:${getCallSummaryStrategy('symbolInterpret', config)}`,
    }),
  ]
}

export class CallSummaryStageSession {
  private currentStrategy: CallSummaryStrategy = 'bypass'

  private readonly stageStack: Array<CallSummaryStageSnapshot<CallSummaryLayeredStore>> = []

  constructor(private readonly config: CallSummarySessionConfig) {}

  keys: CallSummaryLayeredStore | undefined

  counters: CallSummaryStageCounters = createCallSummaryStageCounters()

  disabledReason: string = ''

  instructionTotal: number = 0

  prunedInstructionsEstimated: number = 0

  private executionStack: CallSummaryExecutionFrame[] = []

  lastStats: Record<string, number | string> | undefined

  begin(disabledReason: string): void {
    this.stageStack.push(this.snapshot())
    this.currentStrategy = this.config.strategy
    const enabled = this.currentStrategy === 'skip-only'
    // 阶段开始时重建命中存储，避免上一轮会话状态串入当前边界。
    this.keys = enabled ? new CallSummaryLayeredStore() : undefined
    this.counters = createCallSummaryStageCounters()
    this.disabledReason = enabled ? '' : disabledReason
    this.instructionTotal = 0
    this.prunedInstructionsEstimated = 0
    this.executionStack = []
  }

  beginForLanguage(language?: string): void {
    this.begin(this.config.disabledReason(language))
  }

  usesRuntimeState(): boolean {
    return this.config.layerLevel === 'runtime'
  }

  supportsReplayDelta(): boolean {
    return Boolean(this.config.supportsReplayDelta)
  }

  isActive(): boolean {
    return Boolean(this.keys)
  }

  restore(snapshot: CallSummaryStageSnapshot<CallSummaryLayeredStore>): void {
    this.currentStrategy = snapshot.strategy
    this.keys = snapshot.keys
    this.counters = cloneCallSummaryStageCounters(snapshot.counters)
    this.disabledReason = snapshot.disabledReason
    this.instructionTotal = snapshot.instructionTotal
    this.prunedInstructionsEstimated = snapshot.prunedInstructionsEstimated
    if (!snapshot.active && !snapshot.keys) {
      this.keys = undefined
    }
  }

  snapshot(): CallSummaryStageSnapshot<CallSummaryLayeredStore> {
    return {
      active: Boolean(this.keys),
      strategy: this.currentStrategy,
      keys: this.keys,
      counters: cloneCallSummaryStageCounters(this.counters),
      disabledReason: this.disabledReason,
      instructionTotal: this.instructionTotal,
      prunedInstructionsEstimated: this.prunedInstructionsEstimated,
    }
  }

  addObserveResult(result: CallSummaryObserveMetrics): void {
    this.counters.estimatedKeyBytes += result.estimatedKeyBytes
    this.counters.storedKeyBytes += result.storedKeyBytes
    this.counters.argKeyBuilds += result.argKeyBuilds
    this.counters.runtimeStateKeyBuilds += result.runtimeStateKeyBuilds
    this.counters.optionalStateKeys += result.optionalStateKeys
    this.counters.riskKeyBuilds += result.riskKeyBuilds
  }

  lookupReturn(options: CallSummaryLookupOptions): CallSummaryLookupResult | undefined {
    const callArgs = options.context.callArgs
    if (!this.keys) return undefined
    if (this.currentStrategy !== 'skip-only') return undefined
    if (!options.context.callee || !callArgs) {
      this.setDisabledReason('missing-call-info')
      return undefined
    }
    if (options.canUse === false) {
      this.setFirstDisabledReason('capability-disabled')
      return undefined
    }
    const summaryResult = this.observeCall({
      callerQid: options.context.callerQid,
      callee: options.context.callee,
      callArgs,
      riskContext: options.context.riskContext,
    })
    if (!summaryResult?.hit) return undefined
    if (summaryResult.disabledReason) {
      this.setFirstDisabledReason(summaryResult.disabledReason)
      return undefined
    }
    if (!summaryResult.replayDelta) {
      this.setFirstDisabledReason('replay-delta-missing')
      return undefined
    }
    this.recordHit()
    return summaryResult
  }

  recordSharedReturn(options: CallSummaryRecordReturnOptions): void {
    const callArgs = options.context.callArgs
    if (!this.keys || !options.context.callee || !callArgs) return
    if (this.currentStrategy !== 'skip-only') return
    if (options.canUse === false) return
    if (!options.result.replayDelta && !options.result.disabledReason) return
    this.recordReturn(
      {
        callerQid: options.context.callerQid,
        callee: options.context.callee,
        callArgs,
        riskContext: options.context.riskContext,
      },
      options.result
    )
  }

  recordCall(): void {
    this.counters.calls++
  }

  recordHit(): void {
    this.counters.hits++
  }

  observeCall(
    options: {
      readonly callerQid: string | undefined
      readonly callee: CallSummaryCallee
      readonly callArgs: readonly { readonly node?: unknown; readonly value?: unknown }[]
      readonly riskContext: Partial<CallSummaryRiskContext> | string | undefined
    }
  ): CallSummaryLookupResult | undefined {
    if (!this.keys) return undefined
    this.recordCall()
    // L1/L2 是共同基础边界；L3 只由 basic/runtime 配置决定。
    const targetResult = this.keys.observeTargetLayer({ callerQid: options.callerQid, callee: options.callee })
    this.addObserveResult(targetResult)

    const shapeResult = this.keys.observeShapeLayer(targetResult.targetKey, options.callArgs)
    this.addObserveResult(shapeResult)
    if (!shapeResult.shapeKey) return undefined

    const levelKey = buildCallSummaryLayerLevelKey(this.config.layerLevel)
    const levelResult = this.keys.observeRiskLayerByKey(targetResult.targetKey, shapeResult.shapeKey, levelKey)
    this.addObserveResult(levelResult)

    const replayDelta = this.keys.getReplayDelta(targetResult.targetKey, shapeResult.shapeKey, levelKey)
    const disabledReason = this.keys.getDisabledReason(targetResult.targetKey, shapeResult.shapeKey, levelKey)
    return {
      hit: targetResult.hit && shapeResult.hit && levelResult.hit,
      estimatedKeyBytes: 0,
      storedKeyBytes: 0,
      argKeyBuilds: 0,
      runtimeStateKeyBuilds: 0,
      optionalStateKeys: 0,
      riskKeyBuilds: 0,
      replayDelta,
      disabledReason,
    }
  }

  recordReturn(
    options: {
      readonly callerQid: string | undefined
      readonly callee: CallSummaryCallee
      readonly callArgs: readonly { readonly node?: unknown; readonly value?: unknown }[]
      readonly riskContext: Partial<CallSummaryRiskContext> | string | undefined
    },
    result: CallSummaryRecordOptions
  ): void {
    if (!this.keys) return
    const targetKey = buildCallSummaryTargetKey({ callerQid: options.callerQid, callee: options.callee })
    // 只回写已观测过的边界，避免返回摘要反向创建新会话槽位。
    if (!this.keys.hasShapeLayer(targetKey)) return
    const shapeKey = buildCallSummaryArgKey(options.callArgs)
    if (!this.keys.hasRiskLayer(targetKey, shapeKey)) return
    const levelKey = buildCallSummaryLayerLevelKey(this.config.layerLevel)
    this.keys.recordReturn(targetKey, shapeKey, levelKey, result.replayDelta, result.disabledReason)
  }

  setDisabledReason(reason: string): void {
    this.disabledReason = reason
  }

  setFirstDisabledReason(reason: string): void {
    this.disabledReason = this.disabledReason || reason
  }

  finish(): Record<string, number | string> {
    const stats = this.getStatsRecord()
    const snapshot = this.stageStack.pop()
    this.lastStats = stats
    this.emitDisplaySummary(stats)
    if (snapshot) {
      this.restore(snapshot)
    }
    return stats
  }

  beginExecutionFrame(): void {
    this.executionStack.push({ nestedSideEffectObserved: false })
  }

  hasNestedSideEffectObserved(): boolean {
    return Boolean(this.executionStack[this.executionStack.length - 1]?.nestedSideEffectObserved)
  }

  endExecutionFrame(observedSideEffect: boolean): void {
    this.executionStack.pop()
    if (observedSideEffect && this.executionStack.length > 0) {
      this.executionStack[this.executionStack.length - 1].nestedSideEffectObserved = true
    }
  }

  private emitDisplaySummary(stats: Record<string, number | string>): void {
    if (!this.config.displayOptions) return
    const calls = typeof stats.calls === 'number' ? stats.calls : 0
    const hits = typeof stats.hits === 'number' ? stats.hits : 0
    const hitRate = typeof stats.hitRate === 'number' ? stats.hitRate : 0
    const disabledReason = typeof stats.disabledReason === 'string' ? stats.disabledReason : 'none'
    if (disabledReason !== 'none') {
      if (this.currentStrategy === 'skip-only') {
        yasaLog(`call summary: disabled, reason=${disabledReason}`, [...this.config.displayOptions.stages])
      }
      return
    }
    yasaLog(`call summary: enabled, calls=${calls}, hits=${hits}, hitRate=${(hitRate * 100).toFixed(2)}%`, [...this.config.displayOptions.stages])
  }

  getStatsRecord(): Record<string, number | string> {
    const stats = this.keys?.getStats() ?? { l1Keys: 0, l2Keys: 0, l3Keys: 0, l4Keys: 0, replayReadyKeys: 0, fallbackKeys: 0 }
    const hitRate = this.counters.calls > 0 ? this.counters.hits / this.counters.calls : 0
    return {
      calls: this.counters.calls,
      hits: this.counters.hits,
      hitRate,
      disabledReason: this.disabledReason || 'none',
      l1Keys: stats.l1Keys,
      l2Keys: stats.l2Keys,
      l3Keys: stats.l3Keys,
      l4Keys: stats.l4Keys,
      replayReadyKeys: stats.replayReadyKeys,
      fallbackKeys: stats.fallbackKeys,
      estimatedKeyBytes: this.counters.estimatedKeyBytes,
      storedKeyBytes: this.counters.storedKeyBytes,
      argKeyBuilds: this.counters.argKeyBuilds,
      runtimeStateKeyBuilds: this.counters.runtimeStateKeyBuilds,
      optionalStateKeys: this.counters.optionalStateKeys,
      riskKeyBuilds: this.counters.riskKeyBuilds,
      instructionTotal: this.instructionTotal,
      prunedInstructionsEstimated: this.prunedInstructionsEstimated,
    }
  }
}
