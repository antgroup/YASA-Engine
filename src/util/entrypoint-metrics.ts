const fs = require('fs')
const path = require('path')

export type EntryPointMetricType = 'function' | 'file'

export interface EntryPointMetricInput {
  type: EntryPointMetricType
  entryPoint: unknown
  durationMs: number
  skipped?: boolean
  skipReason?: string
  overloadCount?: number
  findingDelta?: number
  diagnostics?: EntryPointMetricDiagnostics
}

export type EntryPointDiagnosticValue = string | number | boolean | null | undefined

export interface EntryPointMetricDiagnostics {
  epId?: string
  runtimeLocKey?: string
  qidCloneChain?: string
  dedupKey?: string
  details?: Record<string, EntryPointDiagnosticValue>
}

export interface EntryPointMetric {
  index: number
  epKey: string
  file?: string
  function?: string
  type: EntryPointMetricType
  attribute?: string
  durationMs: number
  skipped: boolean
  skipReason?: string
  overloadCount: number
  findingDelta?: number
  epId?: string
  runtimeLocKey?: string
  qidCloneChain?: string
  dedupKey?: string
  details?: Record<string, EntryPointDiagnosticValue>
}

interface SourceLocationShape {
  sourcefile?: unknown
  start?: { line?: unknown; column?: unknown }
  end?: { line?: unknown; column?: unknown }
}

interface EntryPointShape {
  filePath?: unknown
  functionName?: unknown
  attribute?: unknown
  entryPointSymVal?: {
    qid?: unknown
    ast?: {
      node?: {
        id?: { name?: unknown }
        loc?: SourceLocationShape
        parameters?: unknown
      }
    }
  }
}

function asEntryPointShape(value: unknown): EntryPointShape {
  return value && typeof value === 'object' ? (value as EntryPointShape) : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeDuration(durationMs: number): number {
  return Number.isFinite(durationMs) ? Math.round(durationMs * 1000) / 1000 : 0
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function buildLocKey(loc: SourceLocationShape | undefined): string | undefined {
  if (!loc) return undefined
  const sourcefile = stringValue(loc.sourcefile)
  const startLine = numberValue(loc.start?.line)
  const startColumn = numberValue(loc.start?.column)
  const endLine = numberValue(loc.end?.line)
  const endColumn = numberValue(loc.end?.column)
  const parts = [sourcefile]
  if (startLine !== undefined || startColumn !== undefined || endLine !== undefined || endColumn !== undefined) {
    parts.push(`${startLine ?? '?'}:${startColumn ?? '?'}-${endLine ?? '?'}:${endColumn ?? '?'}`)
  }
  return parts.filter(Boolean).join('#') || undefined
}

function buildEntryPointKey(type: EntryPointMetricType, ep: EntryPointShape): string {
  const file = stringValue(ep.filePath) || stringValue(ep.entryPointSymVal?.ast?.node?.loc?.sourcefile) || '<unknown>'
  const fn =
    stringValue(ep.functionName) ||
    stringValue(ep.entryPointSymVal?.ast?.node?.id?.name) ||
    stringValue(ep.entryPointSymVal?.qid) ||
    '<module>'
  const attr = stringValue(ep.attribute)
  const locKey = buildLocKey(ep.entryPointSymVal?.ast?.node?.loc)
  const qid = stringValue(ep.entryPointSymVal?.qid)
  const identity = locKey || qid || `${file}:${fn}`
  return attr ? `${type}:${identity}:${attr}` : `${type}:${identity}`
}


interface NormalizedLocation {
  sourcefile: string
  start: string
  end: string
}

const NO_PARAM0_SHAPE = '<no-param0>'

export interface EntryPointAnalysisMark {
  analysisKey: string
  skipped: boolean
  skipReason?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stringDiagnosticValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function stringifyLocationScalar(value: unknown): string | undefined {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : undefined
}

function stringifyLocationPoint(point: unknown): string | undefined {
  if (!point || typeof point !== 'object') return undefined
  const pointRecord = point as Record<string, unknown>
  const line = stringifyLocationScalar(pointRecord.line ?? pointRecord.row)
  const column = stringifyLocationScalar(pointRecord.column ?? pointRecord.col)
  if (!line || !column) return undefined
  return `${line}:${column}`
}

function normalizeLocation(loc: unknown): NormalizedLocation | undefined {
  if (!loc || typeof loc !== 'object') return undefined
  const locRecord = loc as { sourcefile?: unknown; start?: unknown; end?: unknown }
  if (typeof locRecord.sourcefile !== 'string') return undefined
  const start = stringifyLocationPoint(locRecord.start)
  const end = stringifyLocationPoint(locRecord.end)
  if (!start || !end) return undefined
  return { sourcefile: locRecord.sourcefile, start, end }
}

function formatLocationSummary(loc: NormalizedLocation | undefined): string {
  return loc ? `${loc.sourcefile}#${loc.start}-${loc.end}` : ''
}

function extractQidCloneTokens(rawQid: string): string[] {
  return rawQid.match(/<cloned_[^>]*_endtag>/g) ?? []
}

function stripQidCloneTokens(rawQid: string): string {
  return rawQid.replace(/<cloned_[^>]*_endtag>/g, '')
}

function formatShapeField(value: string): string {
  return value.replace(/[\r\n|]/g, (char) => (char === '|' ? '\\|' : '\\n'))
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function extractCallableResult(record: Record<string, unknown>, methodName: string): Record<string, unknown> | undefined {
  const method = record[methodName]
  if (typeof method !== 'function') return undefined
  try {
    return asOptionalRecord(method.call(record))
  } catch {
    return undefined
  }
}

function firstStringField(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = stringValue(record[field])
    if (value) return value
  }
  return undefined
}

function buildValueLocationShape(record: Record<string, unknown>): string | undefined {
  const loc = normalizeLocation(record.loc) ?? normalizeLocation(asRecord(asRecord(record.ast).node).loc)
  return formatLocationSummary(loc) || undefined
}

function buildParam0ValueShape(value: unknown): string | undefined {
  const record = asOptionalRecord(value)
  if (!record) return undefined

  const semanticQid = firstStringField(record, ['logicalQid', 'qid', '_qid'])
  const normalizedQid = semanticQid ? stripQidCloneTokens(semanticQid) : undefined
  const vtype = firstStringField(record, ['vtype', 'type'])
  const loc = buildValueLocationShape(record)
  const fields: string[] = []
  if (normalizedQid) fields.push(`qid=${normalizedQid}`)
  if (vtype) fields.push(`vtype=${vtype}`)
  if (loc) fields.push(`loc=${loc}`)
  return fields.length > 0 ? fields.map(formatShapeField).join(';') : undefined
}

function collectParam0Candidates(
  entryPointRecord: Record<string, unknown>,
  entryPointSymVal: Record<string, unknown>
): unknown[] {
  const scopeVal = asRecord(entryPointRecord.scopeVal)
  return [
    entryPointSymVal._this,
    extractCallableResult(entryPointSymVal, 'getThisObj'),
    scopeVal._this,
    extractCallableResult(scopeVal, 'getThisObj'),
  ]
}

function buildParam0Shape(entryPointRecord: Record<string, unknown>, entryPointSymVal: Record<string, unknown>): string {
  for (const candidate of collectParam0Candidates(entryPointRecord, entryPointSymVal)) {
    const shape = buildParam0ValueShape(candidate)
    if (shape) return shape
  }
  return NO_PARAM0_SHAPE
}

function formatEntryPointIdValue(value: string): string {
  if (!value) return '<empty>'
  return value.replace(/[\r\n|]/g, (char) => (char === '|' ? '\\|' : '\\n'))
}

function formatFullEntryPointId(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${formatEntryPointIdValue(value)}`)
    .join('|')
}

export function getEntryPointMetricType(entryPoint: unknown, fileBeginType: unknown): EntryPointMetricType {
  return asRecord(entryPoint).type === fileBeginType ? 'file' : 'function'
}

function summarizeEntryPointFile(filePath: unknown): string {
  if (typeof filePath !== 'string' || filePath.length === 0) return '<unknown>'
  const baseName = filePath.split(/[\/]/).pop() || filePath
  return baseName.replace(/\.[^.]+$/, '')
}

export function describeEntryPointForLog(entryPoint: unknown): string {
  const entryPointRecord = asRecord(entryPoint)
  const filePath = typeof entryPointRecord.filePath === 'string' ? entryPointRecord.filePath : '<unknown>'
  if (typeof entryPointRecord.functionName !== 'string' || entryPointRecord.functionName.length === 0) {
    return `[${filePath}]`
  }
  const extensionIndex = filePath.lastIndexOf('.')
  const fileWithoutExtension = extensionIndex >= 0 ? filePath.substring(0, extensionIndex) : filePath
  return `[${fileWithoutExtension}.${entryPointRecord.functionName}]`
}

export function buildEntryPointAnalysisKey(entryPoint: unknown, funcallType: unknown, fileBeginType: unknown): string {
  const entryPointRecord = asRecord(entryPoint)
  if (entryPointRecord.type === funcallType) {
    return buildRuntimeEntryPointAnalysisKey(entryPointRecord, asRecord(entryPointRecord.entryPointSymVal))
  }
  if (entryPointRecord.type === fileBeginType) {
    return `fileBegin:${entryPointRecord.filePath}.${entryPointRecord.attribute}`
  }
  return ''
}

function buildRuntimeEntryPointAnalysisKey(
  entryPointRecord: Record<string, unknown>,
  entryPointSymVal: Record<string, unknown>
): string {
  const ast = asRecord(entryPointSymVal.ast)
  const node = asRecord(ast.node)
  const fdef = asRecord(ast.fdef)
  const loc = normalizeLocation(node.loc) ?? normalizeLocation(fdef.loc)
  const runtimeLocKey = formatLocationSummary(loc)
  const rawQid = stringDiagnosticValue(entryPointSymVal.qid)
  const qidCloneChain = extractQidCloneTokens(rawQid).join('')

  const param0Shape = buildParam0Shape(entryPointRecord, entryPointSymVal)

  return buildEntryPointDedupKey(entryPointRecord, runtimeLocKey, qidCloneChain, param0Shape)
}

function buildEntryPointDedupKey(
  entryPointRecord: Record<string, unknown>,
  runtimeLocKey: string,
  _qidCloneChain: string,
  param0Shape: string
): string {
  return [
    entryPointRecord.type,
    entryPointRecord.filePath,
    entryPointRecord.functionName,
    entryPointRecord.attribute,
    runtimeLocKey,
    param0Shape,
  ].join('|')
}

export function markEntryPointForAnalysis(
  entryPoint: unknown,
  analyzedEntryPointKeys: Set<string>,
  funcallType: unknown,
  fileBeginType: unknown
): EntryPointAnalysisMark {
  const analysisKey = buildEntryPointAnalysisKey(entryPoint, funcallType, fileBeginType)
  if (!analysisKey) return { analysisKey, skipped: false }
  if (analyzedEntryPointKeys.has(analysisKey)) {
    return { analysisKey, skipped: true, skipReason: getDuplicateEntryPointSkipReason(entryPoint, fileBeginType) }
  }
  analyzedEntryPointKeys.add(analysisKey)
  return { analysisKey, skipped: false }
}

function getDuplicateEntryPointSkipReason(entryPoint: unknown, fileBeginType: unknown): string {
  return asRecord(entryPoint).type === fileBeginType ? 'duplicate-file-entrypoint' : 'duplicate-runtime-entrypoint'
}

export function buildEntryPointMetricDiagnostics(
  entryPoint: unknown,
  funcallType: unknown,
  fileBeginType: unknown
): EntryPointMetricDiagnostics | undefined {
  const entryPointRecord = asRecord(entryPoint)
  const symVal = asRecord(entryPointRecord.entryPointSymVal)
  const ast = asRecord(symVal.ast)
  const node = asRecord(ast.node)
  const fdef = asRecord(ast.fdef)
  const loc = normalizeLocation(node.loc) ?? normalizeLocation(fdef.loc)
  const runtimeLocKey = formatLocationSummary(loc)
  const rawQid = stringDiagnosticValue(symVal.qid)
  const qidCloneTokens = extractQidCloneTokens(rawQid)
  const qidCloneChain = qidCloneTokens.join('')
  const cloneReadableTag = stringDiagnosticValue(symVal._cloneReadableTag)
  const cloneReason = stringDiagnosticValue(symVal._cloneReason)
  const cloneParentQid = stringDiagnosticValue(symVal._cloneParentQid)
  const param0Shape = buildParam0Shape(entryPointRecord, symVal)
  const dedupKey = buildEntryPointAnalysisKey(entryPoint, funcallType, fileBeginType)
  const epId = formatFullEntryPointId({
    type: getEntryPointMetricType(entryPoint, fileBeginType),
    filePath: stringDiagnosticValue(entryPointRecord.filePath),
    functionName: stringDiagnosticValue(entryPointRecord.functionName),
    attribute: stringDiagnosticValue(entryPointRecord.attribute),
    runtimeLocKey,
    param0Shape,
    qidCloneChain,
    cloneReadableTag,
    dedupKey,
  })

  return {
    epId,
    runtimeLocKey,
    qidCloneChain,
    dedupKey,
    details: {
      rawQid,
      qidCloneDepth: qidCloneTokens.length,
      cloneReadableTag,
      cloneReason,
      cloneParentQid,
      param0Shape,
    },
  }
}

export class EntryPointMetricsCollector {
  private readonly metrics: EntryPointMetric[] = []

  record(input: EntryPointMetricInput): void {
    const ep = asEntryPointShape(input.entryPoint)
    const metric: EntryPointMetric = {
      index: this.metrics.length,
      epKey: buildEntryPointKey(input.type, ep),
      file: stringValue(ep.filePath) || stringValue(ep.entryPointSymVal?.ast?.node?.loc?.sourcefile),
      function: stringValue(ep.functionName) || stringValue(ep.entryPointSymVal?.ast?.node?.id?.name),
      type: input.type,
      attribute: stringValue(ep.attribute),
      durationMs: normalizeDuration(input.durationMs),
      skipped: input.skipped ?? false,
      skipReason: input.skipReason,
      overloadCount: input.overloadCount ?? 0,
      findingDelta: input.findingDelta,
      ...input.diagnostics,
    }
    this.metrics.push(metric)
  }

  snapshot(): EntryPointMetric[] {
    return this.metrics.map((metric) => ({ ...metric }))
  }
}

export function writeEntryPointMetrics(reportDir: string, metrics: readonly EntryPointMetric[]): void {
  if (!reportDir || metrics.length === 0) return
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true })
  }
  const outputPath = path.join(reportDir, 'entrypoint-metrics.json')
  fs.writeFileSync(outputPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8')
}
