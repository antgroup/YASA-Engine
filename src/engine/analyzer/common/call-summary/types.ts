import type { State, Value } from '../../../../types/analyzer'

export type CallSummaryStrategy = 'skip-only' | 'bypass' | 'return-clone' | 'summary-replay'

export type CallSummaryLayerLevel = 'basic' | 'runtime'

export type CallSummaryStage = 'processModule' | 'symbolInterpret' | 'unknown'

export interface CallSummaryStageConfig {
  readonly [stage: string]: CallSummaryStrategy | undefined
}

export interface CallSummaryRiskContext {
  readonly callKind: string
  readonly receiverShape: string
  readonly argEffectShape: string
  readonly resultUse: string
  readonly sideEffectRisk: string
}

export interface BuildCallSummaryKeyOptions {
  readonly callerQid: string | undefined
  readonly callee: Value | undefined
  readonly callArgs: readonly { readonly node?: unknown; readonly value?: unknown }[]
  readonly pcond: State['pcond'] | undefined
  readonly riskContext?: Partial<CallSummaryRiskContext> | string
}

export interface CallSummaryLayerKey {
  readonly key: string
  readonly rawBytes: number
  readonly storedBytes: number
}

export interface CallSummaryStoreStats {
  readonly l1Keys: number
  readonly l2Keys: number
  readonly l3Keys: number
  readonly l4Keys: number
  readonly replayReadyKeys: number
  readonly fallbackKeys: number
}

export interface CallSummaryCounterDelta {
  readonly markedSources: number
  readonly matchedSinks: number
}

export type CallSummaryReplayReturnMode = 'fresh-undefined' | 'fresh-void'

export interface CallSummaryReplayDelta {
  readonly counters: CallSummaryCounterDelta
  readonly returnMode: CallSummaryReplayReturnMode
}

export interface CallSummaryObserveResult {
  readonly hit: boolean
  readonly estimatedKeyBytes: number
  readonly storedKeyBytes: number
}

export interface CallSummaryObserveMetrics extends CallSummaryObserveResult {
  readonly argKeyBuilds: number
  readonly runtimeStateKeyBuilds: number
  readonly optionalStateKeys: number
  readonly riskKeyBuilds: number
}

export interface CallSummaryLayerResult extends CallSummaryObserveMetrics {
  readonly targetKey: CallSummaryLayerKey
  readonly shapeKey?: CallSummaryLayerKey
}

export type CallSummaryCallee = BuildCallSummaryKeyOptions['callee']

export interface CallSummaryLookupResult extends CallSummaryObserveMetrics {
  readonly replayDelta?: CallSummaryReplayDelta
  readonly disabledReason?: string
}

export interface CallSummaryRecordOptions {
  readonly replayDelta?: CallSummaryReplayDelta
  readonly disabledReason?: string
}

export interface CallSummaryRuntimeKeyOptions {
  readonly receiver?: unknown
  readonly pcond?: State['pcond']
}

export type CallSummaryReturnLike = { readonly vtype?: string } | undefined

export interface CallSummaryStageCounters {
  calls: number
  hits: number
  estimatedKeyBytes: number
  storedKeyBytes: number
  argKeyBuilds: number
  runtimeStateKeyBuilds: number
  optionalStateKeys: number
  riskKeyBuilds: number
}

export interface CallSummaryStageSnapshot<TStore = unknown> {
  readonly active: boolean
  readonly strategy: CallSummaryStrategy
  readonly keys: TStore | undefined
  readonly counters: CallSummaryStageCounters
  readonly disabledReason: string
  readonly instructionTotal: number
  readonly prunedInstructionsEstimated: number
}

export interface CallSummaryDisplayOptions {
  readonly stages: readonly string[]
}

export const DEFAULT_CALL_SUMMARY_RISK_CONTEXT: CallSummaryRiskContext = {
  callKind: 'unknown',
  receiverShape: 'unknown',
  argEffectShape: 'unknown',
  resultUse: 'unknown',
  sideEffectRisk: 'unknown',
}

export const DEFAULT_CALL_SUMMARY_STAGE_CONFIG: CallSummaryStageConfig = {
  processModule: 'bypass',
  symbolInterpret: 'bypass',
  unknown: 'bypass',
}
