import type { TaintFinding } from '../../../engine/analyzer/common/common-types'

const Config = require('../../../config')
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

function getOutputTrace(finding: TaintFinding): any[] | undefined {
  const strategy = normalizeTraceStrategy(Config.taintTraceOutputStrategy)
  const rawTrace = finding.trace
  if (!Array.isArray(rawTrace)) return rawTrace
  if (strategy !== 'callstack-only') return rawTrace
  if (rawTrace.length === 0) return rawTrace

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

  const filtered = rawTrace.filter((step: any) => {
    if (step?.tag === 'SOURCE: ' || step?.tag === 'SINK: ') return true
    const stepFile = step?.loc?.sourcefile || step?.file
    const stepLine = step?.loc?.start?.line ?? step?.line
    return scopes.some(
      (scope) => stepFile === scope.file && isLineInScope(stepLine, scope)
    )
  })

  return filtered.length > 0 ? filtered : rawTrace
}

export { getOutputTrace }
