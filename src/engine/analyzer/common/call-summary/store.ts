import type {
  BuildCallSummaryKeyOptions,
  CallSummaryLayerKey,
  CallSummaryLayerResult,
  CallSummaryObserveMetrics,
  CallSummaryObserveResult,
  CallSummaryReplayDelta,
  CallSummaryRiskContext,
  CallSummaryStoreStats,
} from './types'
import { buildCallSummaryArgKey, buildCallSummaryRiskKey, buildCallSummaryTargetKey } from './keys'

interface CallSummaryRiskSlot {
  readonly stateKeys: Set<string>
  readonly replayDelta?: CallSummaryReplayDelta
  readonly disabledReason?: string
}

export class CallSummaryLayeredStore {
  private readonly l1 = new Map<string, Map<string, Map<string, CallSummaryRiskSlot>>>()

  observeTargetLayer(
    options: Pick<BuildCallSummaryKeyOptions, 'callerQid' | 'callee'>
  ): CallSummaryLayerResult {
    const targetKey = buildCallSummaryTargetKey(options)
    const result = this.observeTarget(targetKey)
    return {
      ...result,
      targetKey,
      argKeyBuilds: 0,
      runtimeStateKeyBuilds: 0,
      optionalStateKeys: 0,
      riskKeyBuilds: 0,
    }
  }

  observeShapeLayer(
    targetKey: CallSummaryLayerKey,
    callArgs: readonly { readonly node?: unknown; readonly value?: unknown }[]
  ): CallSummaryLayerResult {
    const shapeKey = buildCallSummaryArgKey(callArgs)
    const result = this.observeShape(targetKey, shapeKey)
    return {
      ...result,
      targetKey,
      shapeKey,
      argKeyBuilds: 1,
      runtimeStateKeyBuilds: 0,
      optionalStateKeys: 0,
      riskKeyBuilds: 0,
    }
  }

  observeRiskLayer(
    targetKey: CallSummaryLayerKey,
    shapeKey: CallSummaryLayerKey,
    riskContext: Partial<CallSummaryRiskContext> | string | undefined
  ): CallSummaryObserveMetrics {
    return this.observeRiskLayerByKey(targetKey, shapeKey, buildCallSummaryRiskKey(riskContext))
  }

  observeRiskLayerByKey(
    targetKey: CallSummaryLayerKey,
    shapeKey: CallSummaryLayerKey,
    riskKey: CallSummaryLayerKey
  ): CallSummaryObserveMetrics {
    const result = this.observeRisk(targetKey, shapeKey, riskKey)
    return {
      ...result,
      argKeyBuilds: 0,
      runtimeStateKeyBuilds: 0,
      optionalStateKeys: 0,
      riskKeyBuilds: 1,
    }
  }

  observe(
    targetKey: CallSummaryLayerKey,
    argKey: CallSummaryLayerKey,
    riskKey: CallSummaryLayerKey,
    runtimeStateKey?: CallSummaryLayerKey
  ): CallSummaryObserveResult {
    let estimatedKeyBytes = 0
    let storedKeyBytes = 0
    let l2 = this.l1.get(targetKey.key)
    if (!l2) {
      l2 = new Map<string, Map<string, CallSummaryRiskSlot>>()
      this.l1.set(targetKey.key, l2)
      estimatedKeyBytes += targetKey.rawBytes
      storedKeyBytes += targetKey.storedBytes
    }

    let l3 = l2.get(argKey.key)
    if (!l3) {
      l3 = new Map<string, CallSummaryRiskSlot>()
      l2.set(argKey.key, l3)
      estimatedKeyBytes += argKey.rawBytes
      storedKeyBytes += argKey.storedBytes
    }

    let slot = l3.get(riskKey.key)
    if (!slot) {
      slot = { stateKeys: new Set<string>() }
      l3.set(riskKey.key, slot)
      estimatedKeyBytes += riskKey.rawBytes
      storedKeyBytes += riskKey.storedBytes
    }

    const stateKey = runtimeStateKey?.key ?? 'preprocess'
    if (slot.stateKeys.has(stateKey)) {
      return { hit: true, estimatedKeyBytes: 0, storedKeyBytes: 0 }
    }
    slot.stateKeys.add(stateKey)
    if (runtimeStateKey) {
      estimatedKeyBytes += runtimeStateKey.rawBytes
      storedKeyBytes += runtimeStateKey.storedBytes
    }
    return { hit: false, estimatedKeyBytes, storedKeyBytes }
  }

  hasShapeLayer(targetKey: CallSummaryLayerKey): boolean {
    return this.l1.has(targetKey.key)
  }

  hasRiskLayer(targetKey: CallSummaryLayerKey, shapeKey: CallSummaryLayerKey): boolean {
    return Boolean(this.l1.get(targetKey.key)?.has(shapeKey.key))
  }

  getReplayDelta(
    targetKey: CallSummaryLayerKey,
    shapeKey: CallSummaryLayerKey,
    riskKey: CallSummaryLayerKey
  ): CallSummaryReplayDelta | undefined {
    return this.l1.get(targetKey.key)?.get(shapeKey.key)?.get(riskKey.key)?.replayDelta
  }

  getDisabledReason(
    targetKey: CallSummaryLayerKey,
    shapeKey: CallSummaryLayerKey,
    riskKey: CallSummaryLayerKey
  ): string | undefined {
    return this.l1.get(targetKey.key)?.get(shapeKey.key)?.get(riskKey.key)?.disabledReason
  }

  recordReturn(
    targetKey: CallSummaryLayerKey,
    shapeKey: CallSummaryLayerKey,
    riskKey: CallSummaryLayerKey,
    replayDelta: CallSummaryReplayDelta | undefined,
    disabledReason: string | undefined
  ): void {
    const slot = this.l1.get(targetKey.key)?.get(shapeKey.key)?.get(riskKey.key)
    if (!slot) return
    const nextSlot: CallSummaryRiskSlot = {
      stateKeys: slot.stateKeys,
      replayDelta,
      disabledReason,
    }
    this.l1.get(targetKey.key)?.get(shapeKey.key)?.set(riskKey.key, nextSlot)
  }

  private observeTarget(targetKey: CallSummaryLayerKey): CallSummaryObserveResult {
    if (this.l1.has(targetKey.key)) return { hit: true, estimatedKeyBytes: 0, storedKeyBytes: 0 }
    this.l1.set(targetKey.key, new Map<string, Map<string, CallSummaryRiskSlot>>())
    return { hit: false, estimatedKeyBytes: targetKey.rawBytes, storedKeyBytes: targetKey.storedBytes }
  }

  private observeShape(targetKey: CallSummaryLayerKey, shapeKey: CallSummaryLayerKey): CallSummaryObserveResult {
    const l2 = this.l1.get(targetKey.key)
    if (!l2) {
      this.l1.set(targetKey.key, new Map<string, Map<string, CallSummaryRiskSlot>>())
      return { hit: false, estimatedKeyBytes: targetKey.rawBytes, storedKeyBytes: targetKey.storedBytes }
    }
    if (l2.has(shapeKey.key)) return { hit: true, estimatedKeyBytes: 0, storedKeyBytes: 0 }
    l2.set(shapeKey.key, new Map<string, CallSummaryRiskSlot>())
    return { hit: false, estimatedKeyBytes: shapeKey.rawBytes, storedKeyBytes: shapeKey.storedBytes }
  }

  private observeRisk(
    targetKey: CallSummaryLayerKey,
    shapeKey: CallSummaryLayerKey,
    riskKey: CallSummaryLayerKey
  ): CallSummaryObserveResult {
    const l2 = this.l1.get(targetKey.key)
    const l3 = l2?.get(shapeKey.key)
    if (!l2 || !l3) return { hit: false, estimatedKeyBytes: 0, storedKeyBytes: 0 }
    if (l3.has(riskKey.key)) return { hit: true, estimatedKeyBytes: 0, storedKeyBytes: 0 }
    l3.set(riskKey.key, { stateKeys: new Set<string>(['preprocess']) })
    return { hit: false, estimatedKeyBytes: riskKey.rawBytes, storedKeyBytes: riskKey.storedBytes }
  }

  getStats(): CallSummaryStoreStats {
    let l2Keys = 0
    let l3Keys = 0
    let l4Keys = 0
    let replayReadyKeys = 0
    let fallbackKeys = 0
    for (const l2 of this.l1.values()) {
      l2Keys += l2.size
      for (const l3 of l2.values()) {
        l3Keys += l3.size
        for (const l4 of l3.values()) {
          l4Keys += l4.stateKeys.size
          if (l4.replayDelta) replayReadyKeys++
          if (l4.disabledReason) fallbackKeys++
        }
      }
    }
    return {
      l1Keys: this.l1.size,
      l2Keys,
      l3Keys,
      l4Keys,
      replayReadyKeys,
      fallbackKeys,
    }
  }
}
