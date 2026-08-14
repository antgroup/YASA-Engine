import type { Value } from '../../../../types/analyzer'
import type { CallSummaryReplayDelta } from './types'
import type { CallSummarySideEffectSnapshot } from './session'

const SourceUtil = require('../../../../checker/taint/common-kit/source-util')
const SinkUtil = require('../../../../checker/taint/common-kit/sink-util')
const {
  ValueUtil: { UndefinedValue, VoidValue },
} = require('../../../util/value-util')

interface CallSummaryAnalyzerLike {
  readonly checkerManager?: {
    readonly getResultManager?: () => {
      readonly getFindings?: () => unknown
    }
  }
  readonly ainfo?: {
    readonly callgraph?: {
      readonly edges?: unknown
    }
  }
  readonly entryPoints?: unknown
}

function countResultFindings(analyzer: CallSummaryAnalyzerLike): number {
  const findings = analyzer.checkerManager?.getResultManager?.()?.getFindings?.()
  if (!findings || typeof findings !== 'object') return 0
  return Object.values(findings as Record<string, unknown>).reduce<number>((total, category) => {
    return total + (Array.isArray(category) ? category.length : 0)
  }, 0)
}

function countAnalyzerCallGraphEdges(analyzer: CallSummaryAnalyzerLike): number {
  const edges = analyzer.ainfo?.callgraph?.edges
  if (!edges || typeof edges !== 'object') return 0
  if (typeof (edges as { readonly size?: unknown }).size === 'number') return (edges as { readonly size: number }).size
  if (Array.isArray(edges)) return edges.length
  return Object.keys(edges).length
}

function countAnalyzerEntrypoints(analyzer: CallSummaryAnalyzerLike): number {
  return Array.isArray(analyzer.entryPoints) ? analyzer.entryPoints.length : 0
}

export function captureCallSummarySideEffectSnapshot(analyzer: CallSummaryAnalyzerLike): CallSummarySideEffectSnapshot {
  return {
    findings: countResultFindings(analyzer),
    callGraphEdges: countAnalyzerCallGraphEdges(analyzer),
    entrypoints: countAnalyzerEntrypoints(analyzer),
    markedSources: SourceUtil.getMarkedSourceCount?.() ?? 0,
    matchedSinks: SinkUtil.getMatchedSinkCount?.() ?? 0,
  }
}

export function applyCallSummaryReplayDelta(replayDelta: CallSummaryReplayDelta): void {
  SourceUtil.addMarkedSourceCount?.(replayDelta.counters.markedSources)
  SinkUtil.addMatchedSinkCount?.(replayDelta.counters.matchedSinks)
}

export function buildCallSummaryReplayReturn(scopeQid: string | undefined, replayDelta: CallSummaryReplayDelta): Value {
  if (replayDelta.returnMode === 'fresh-void') return new VoidValue()
  return new UndefinedValue(scopeQid)
}

export function buildHitReturn(scopeQid: string | undefined): Value {
  return new UndefinedValue(scopeQid ?? '')
}
