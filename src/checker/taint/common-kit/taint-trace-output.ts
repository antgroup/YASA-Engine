import type { TaintFinding } from '../../../engine/analyzer/common/common-types'
import type { TraceItem } from '../../../util/finding-util'

const Config = require('../../../config')
const AstUtil = require('../../../util/ast-util')
function normalizeTraceStrategy(strategy: string | undefined): string {
  if (strategy === 'folded') return 'callstack-only'
  return strategy || 'callstack-only'
}

function isLineInScope(line: any, scope: { startLine: number; endLine: number }): boolean {
  if (Array.isArray(line)) {
    return line.some(
      (singleLine) => typeof singleLine === 'number' && singleLine >= scope.startLine && singleLine <= scope.endLine
    )
  }
  return typeof line === 'number' && line >= scope.startLine && line <= scope.endLine
}

function getTraceLineKey(item: any): string {
  const line = item?.line ?? item?.node?.loc?.start?.line
  return Array.isArray(line) ? line.join(',') : String(line ?? '')
}

function getTraceFileKey(item: any): string {
  return item?.node?.loc?.sourcefile || item?.file || ''
}

function isTerminalStringValueOfVarPass(item: any, sink: any): boolean {
  if (item?.tag?.trim() !== 'Var Pass:') return false
  if (item?.affectedNodeName !== 'String' && item?.affectedNodeName !== 'Runtime.getRuntime()') return false
  if (getTraceFileKey(item) !== getTraceFileKey(sink)) return false
  if (getTraceLineKey(item) !== getTraceLineKey(sink)) return false
  const nodeText = item?.node?._prettyPrint ?? AstUtil.prettyPrint(item?.node)
  return typeof nodeText === 'string' && nodeText.includes('String.valueOf') && !nodeText.includes('Runtime.getRuntime().exec')
}

function normalizeTerminalStringValueOfTrace(trace: any[] | undefined): any[] | undefined {
  if (!Array.isArray(trace) || trace.length < 3) return trace
  const sinkIdx = trace.length - 1
  const sink = trace[sinkIdx]
  if (sink?.tag !== 'SINK: ') return trace
  const terminalIdx = sinkIdx - 1
  if (!isTerminalStringValueOfVarPass(trace[terminalIdx], sink)) return trace
  return [...trace.slice(0, terminalIdx), sink]
}

function getTerminalStringValueOfNormalizedTrace(finding: TaintFinding): TraceItem[] | undefined {
  return normalizeTerminalStringValueOfTrace(getOutputTrace(finding))
}

function getSarifTrace(finding: TaintFinding): TraceItem[] | undefined {
  return finding.trace
}

function filterOutSyntheticSteps(trace: TraceItem[] | undefined): TraceItem[] | undefined {
  return Array.isArray(trace) ? trace.filter((step) => !step?._synthetic) : trace
}

function getDedupTrace(finding: TaintFinding): TraceItem[] | undefined {
  return filterOutSyntheticSteps(finding.trace)
}


function isTemporaryAffectedNodeName(name: unknown): boolean {
  return typeof name === 'string' && /^__tmp\d+__$/.test(name)
}

function getCanonicalStepKey(item: TraceItem): string {
  const file = getTraceFileKey(item)
  const line = getTraceLineKey(item)
  return `${item?.tag ?? ''}|${file}|${line}`
}

function filterTemporaryAliasSteps(trace: TraceItem[]): TraceItem[] {
  const out: TraceItem[] = []
  for (let i = 0; i < trace.length; i++) {
    const step = trace[i]
    if (isTemporaryAffectedNodeName(step?.affectedNodeName)) {
      const next = trace[i + 1]
      if (next && getCanonicalStepKey(next) === getCanonicalStepKey(step)) continue
    }
    out.push(step)
  }
  return out
}

function filterRedundantBuiltinCallSteps(trace: TraceItem[]): TraceItem[] {
  const out: TraceItem[] = []
  for (let i = 0; i < trace.length; i++) {
    const step = trace[i]
    if (step?.tag === 'CALL: ') {
      const next = trace[i + 1]
      if (next?.tag === 'CALL: ' && getCanonicalStepKey(next) === getCanonicalStepKey(step)) continue
    }
    out.push(step)
  }
  return out
}

function deriveDisplayTrace(trace: TraceItem[]): TraceItem[] {
  return filterRedundantBuiltinCallSteps(filterTemporaryAliasSteps(trace))
}

function getOutputTrace(finding: TaintFinding): TraceItem[] | undefined {
  const strategy = normalizeTraceStrategy(Config.taintTraceOutputStrategy)
  const rawTrace = finding.trace
  if (!Array.isArray(rawTrace)) return rawTrace
  if (strategy !== 'callstack-only') return rawTrace
  if (rawTrace.length === 0) return rawTrace
  const displayTrace = deriveDisplayTrace(rawTrace)

  const scopes: Array<{ file: string; startLine: number; endLine: number }> = []

  if (Array.isArray(finding.callstack)) {
    for (const fclos of finding.callstack) {
      const loc = fclos?.ast?.node?.loc
      if (loc?.sourcefile && loc.start?.line != null && loc.end?.line != null) {
        scopes.push({
          file: loc.sourcefile,
          startLine: loc.start.line,
          endLine: loc.end.line,
        })
      }
    }
  }

  const entryLoc = finding.entrypointLoc
  if (entryLoc?.sourcefile && entryLoc.start?.line != null && entryLoc.end?.line != null) {
    scopes.push({
      file: entryLoc.sourcefile,
      startLine: entryLoc.start.line,
      endLine: entryLoc.end.line,
    })
  }

  if (scopes.length === 0) return rawTrace

  const filtered = displayTrace.filter((step: TraceItem) => {
    if (step?.tag === 'SOURCE: ' || step?.tag === 'SINK: ') return true
    const stepFile = step?.node?.loc?.sourcefile || step?.file
    const stepLine = step?.node?.loc?.start?.line ?? step?.line
    return scopes.some(
      (scope) => stepFile === scope.file && isLineInScope(stepLine, scope)
    )
  })

  return filtered.length > 0 ? filtered : displayTrace
}

export { getDedupTrace, getOutputTrace, getSarifTrace, getTerminalStringValueOfNormalizedTrace, normalizeTerminalStringValueOfTrace }
