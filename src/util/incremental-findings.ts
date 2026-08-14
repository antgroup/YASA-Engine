import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export type EntrypointStatus = 'unaffected' | 'modified' | 'added' | 'deleted' | 'unknown'
export type FindingStatus = 'active' | 'resolved' | 'stale'
export type MergeMode = 'partial' | 'full-fallback'

export interface SarifLocationRegion {
  startLine?: number
  startColumn?: number
  endLine?: number
  endColumn?: number
  snippet?: { text?: string }
}

export interface SarifPhysicalLocation {
  artifactLocation?: { uri?: string }
  region?: SarifLocationRegion
}

export interface SarifLocation {
  physicalLocation?: SarifPhysicalLocation
}

export interface SarifThreadFlowLocation {
  location?: {
    message?: { text?: string }
    physicalLocation?: SarifPhysicalLocation
  }
}

export interface SarifCodeFlow {
  threadFlows?: Array<{ locations?: SarifThreadFlowLocation[] }>
}

export interface SarifResult {
  ruleId?: string
  rule?: { id?: string }
  level?: string
  message?: { text?: string }
  entrypoint?: EntrypointLike
  locations?: SarifLocation[]
  codeFlows?: SarifCodeFlow[]
  [key: string]: unknown
}

export interface SarifRun {
  results?: SarifResult[]
  [key: string]: unknown
}

export interface SarifLog {
  runs?: SarifRun[]
  version?: string
  [key: string]: unknown
}

export interface EntrypointLike {
  key?: string
  epKey?: string
  entrypointKey?: string
  filePath?: string
  file?: string
  functionName?: string
  type?: string
  attribute?: string
  funcLocStart?: number
  funcLocEnd?: number
  range?: [number, number]
  [key: string]: unknown
}

export interface FindingLocation {
  file: string
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
}

export interface FindingIndexEntry {
  findingId: string
  ruleId: string
  level?: string
  message?: string
  entrypointKey: string
  entrypointFile?: string
  entrypointFunction?: string
  sink: FindingLocation
  source: FindingLocation | null
  traceDigest: string
  sarifResultIndex: number
  status: FindingStatus
}

export interface FindingsIndex {
  schemaVersion: 1
  project?: string
  commit?: string
  findings: FindingIndexEntry[]
}

export interface EntrypointChange {
  status: EntrypointStatus
  epKey?: string
  entrypointKey?: string
  epIdOld?: string | null
  epIdNew?: string | null
  fileOld?: string | null
  fileNew?: string | null
  rangeOld?: [number, number] | null
  rangeNew?: [number, number] | null
  reasons?: string[]
}

interface LineRemapChange {
  file: string
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
  kind: 'added' | 'deleted' | 'modified'
}

interface LineRemapper {
  remapLocation(location: FindingLocation): FindingLocation
  remapPhysicalLocation(location: SarifPhysicalLocation): SarifPhysicalLocation
}

interface SourceRootRemap {
  baseRoot: string
  headRoot: string
}

export interface EpChangesDocument {
  epChanges?: EntrypointChange[]
  fallbacks?: Array<{ level?: string; reason?: string }>
}

export interface MergeSummary {
  schemaVersion: 1
  mode: MergeMode
  reason?: string
  counts: {
    baseFindings: number
    selectedFindings: number
    finalFindings: number
    keptUnaffected: number
    removedModified: number
    addedOrModifiedNew: number
    resolvedDeleted: number
    staleDeleted: number
  }
}

export interface AuditLogEntry {
  findingId: string
  entrypointKey: string
  action: 'kept_unaffected' | 'removed_for_rerun' | 'added_from_selected' | 'resolved_deleted' | 'stale_deleted' | 'full_fallback'
  status: FindingStatus
  sarifResultIndex: number
  reason: string
}

export interface MergeOutputs {
  sarif: SarifLog
  findingsIndex: FindingsIndex
  summary: MergeSummary
  auditLog: AuditLogEntry[]
}

export interface MergeFileOptions {
  baseSarifPath: string
  selectedSarifPath: string
  baseFindingsIndexPath?: string
  selectedFindingsIndexPath?: string
  epChangesPath: string
  outputDir: string
  project?: string
  commit?: string
  baseSourcePath?: string
  headSourcePath?: string
}

export interface MergeFileResult {
  mergedSarifPath: string
  findingsIndexPath: string
  summaryPath: string
  auditLogPath: string
  outputs: MergeOutputs
}

interface ChangeBuckets {
  modified: Set<string>
  added: Set<string>
  deleted: Set<string>
  unknownOrFallback: boolean
  fallbackReason?: string
}

export function buildFindingId(ruleId: string, sink: FindingLocation, source: FindingLocation | null, entrypointKey: string, traceDigest: string): string {
  return sha1([ruleId, normalizeLocationForId(sink), normalizeLocationForId(source), entrypointKey, traceDigest].join('|'))
}

export function buildEntrypointKey(entrypoint: EntrypointLike | undefined): string {
  if (!entrypoint) return 'unknown-entrypoint'
  const existing = firstString(entrypoint.entrypointKey, entrypoint.epKey, entrypoint.key)
  if (existing) return existing
  const filePath = firstString(entrypoint.filePath, entrypoint.file) ?? ''
  const functionName = firstString(entrypoint.functionName) ?? ''
  const type = firstString(entrypoint.type) ?? ''
  const attribute = firstString(entrypoint.attribute) ?? ''
  const range = Array.isArray(entrypoint.range) ? entrypoint.range : undefined
  const start = numberOrEmpty(entrypoint.funcLocStart) || numberOrEmpty(range?.[0])
  const end = numberOrEmpty(entrypoint.funcLocEnd) || numberOrEmpty(range?.[1])
  return [normalizePath(filePath), functionName, type, start, end, attribute].join('|')
}

export function buildFindingsIndexFromSarif(sarif: SarifLog, project?: string, commit?: string): FindingsIndex {
  const findings: FindingIndexEntry[] = []
  const results = sarif.runs?.[0]?.results ?? []
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const ruleId = result.ruleId ?? result.rule?.id ?? 'unknown'
    const entrypointKey = buildEntrypointKey(result.entrypoint)
    const sink = extractSinkLocation(result)
    const source = extractSourceLocation(result)
    const traceDigest = digestCodeFlows(result.codeFlows)
    findings.push({
      findingId: buildFindingId(ruleId, sink, source, entrypointKey, traceDigest),
      ruleId,
      level: result.level,
      message: result.message?.text,
      entrypointKey,
      entrypointFile: firstString(result.entrypoint?.filePath, result.entrypoint?.file),
      entrypointFunction: firstString(result.entrypoint?.functionName),
      sink,
      source,
      traceDigest,
      sarifResultIndex: index,
      status: 'active',
    })
  }
  return { schemaVersion: 1, project, commit, findings }
}

export function mergeSarifFindings(baseSarif: SarifLog, baseIndex: FindingsIndex, selectedSarif: SarifLog, selectedIndex: FindingsIndex, epChanges: EpChangesDocument, sourceRootRemap?: SourceRootRemap): MergeOutputs {
  const buckets = buildChangeBuckets(epChanges)
  if (buckets.unknownOrFallback) {
    return buildFullFallbackOutputs(selectedSarif, selectedIndex, buckets.fallbackReason)
  }

  const lineRemapper = buildLineRemapper(epChanges, sourceRootRemap)
  const baseResults = baseSarif.runs?.[0]?.results ?? []
  const selectedResults = selectedSarif.runs?.[0]?.results ?? []
  const mergedResults: SarifResult[] = []
  const finalFindings: FindingIndexEntry[] = []
  const auditLog: AuditLogEntry[] = []
  let keptUnaffected = 0
  let removedModified = 0
  let resolvedDeleted = 0

  for (const finding of baseIndex.findings) {
    const result = baseResults[finding.sarifResultIndex]
    if (!result) continue
    const canonicalEntrypointKey = canonicalizeEntrypointKey(finding.entrypointKey)
    if (buckets.deleted.has(canonicalEntrypointKey)) {
      resolvedDeleted += 1
      auditLog.push(auditEntry(finding, 'resolved_deleted', 'resolved', 'deleted entrypoint'))
      continue
    }
    if (buckets.modified.has(canonicalEntrypointKey)) {
      removedModified += 1
      auditLog.push(auditEntry(finding, 'removed_for_rerun', 'stale', 'modified entrypoint rerun replaces base finding'))
      continue
    }
    const remappedResult = remapSarifResult(result, lineRemapper)
    mergedResults.push(remappedResult)
    finalFindings.push(remapFindingIndexEntry(finding, lineRemapper, mergedResults.length - 1))
    keptUnaffected += 1
    auditLog.push(auditEntry(finding, 'kept_unaffected', 'active', 'unaffected entrypoint kept from base'))
  }

  for (const finding of selectedIndex.findings) {
    const result = selectedResults[finding.sarifResultIndex]
    if (!result) continue
    mergedResults.push(result)
    finalFindings.push({ ...finding, sarifResultIndex: mergedResults.length - 1, status: 'active' })
    auditLog.push(auditEntry(finding, 'added_from_selected', 'active', 'selected rerun result'))
  }

  const sarif = cloneSarifWithResults(baseSarif, mergedResults)
  const findingsIndex: FindingsIndex = {
    schemaVersion: 1,
    project: baseIndex.project ?? selectedIndex.project,
    commit: selectedIndex.commit ?? baseIndex.commit,
    findings: finalFindings,
  }
  return {
    sarif,
    findingsIndex,
    summary: {
      schemaVersion: 1,
      mode: 'partial',
      counts: {
        baseFindings: baseIndex.findings.length,
        selectedFindings: selectedIndex.findings.length,
        finalFindings: finalFindings.length,
        keptUnaffected,
        removedModified,
        addedOrModifiedNew: selectedIndex.findings.length,
        resolvedDeleted,
        staleDeleted: 0,
      },
    },
    auditLog,
  }
}

export function mergeSarifFindingFiles(options: MergeFileOptions): MergeFileResult {
  const baseSarif = readJson<SarifLog>(options.baseSarifPath)
  const selectedSarif = readJson<SarifLog>(options.selectedSarifPath)
  const baseIndex = readFindingsIndexOrBuild(options.baseFindingsIndexPath, baseSarif, options.project, options.commit)
  const selectedIndex = readFindingsIndexOrBuild(options.selectedFindingsIndexPath, selectedSarif, options.project, options.commit)
  const epChanges = readJson<EpChangesDocument>(options.epChangesPath)
  const outputs = mergeSarifFindings(baseSarif, baseIndex, selectedSarif, selectedIndex, epChanges, buildSourceRootRemap(options.baseSourcePath, options.headSourcePath))

  fs.mkdirSync(options.outputDir, { recursive: true })
  const mergedSarifPath = path.join(options.outputDir, 'merged-report.sarif')
  const findingsIndexPath = path.join(options.outputDir, 'findings-index.json')
  const summaryPath = path.join(options.outputDir, 'incremental-summary.json')
  const auditLogPath = path.join(options.outputDir, 'audit-log.jsonl')
  fs.writeFileSync(mergedSarifPath, `${JSON.stringify(outputs.sarif)}\n`, 'utf-8')
  fs.writeFileSync(findingsIndexPath, `${JSON.stringify(outputs.findingsIndex, null, 2)}\n`, 'utf-8')
  fs.writeFileSync(summaryPath, `${JSON.stringify(outputs.summary, null, 2)}\n`, 'utf-8')
  fs.writeFileSync(auditLogPath, outputs.auditLog.map(entry => JSON.stringify(entry)).join('\n') + (outputs.auditLog.length > 0 ? '\n' : ''), 'utf-8')
  return { mergedSarifPath, findingsIndexPath, summaryPath, auditLogPath, outputs }
}

function readFindingsIndexOrBuild(filePath: string | undefined, sarif: SarifLog, project?: string, commit?: string): FindingsIndex {
  const built = buildFindingsIndexFromSarif(sarif, project, commit)
  if (!filePath || !fs.existsSync(filePath)) return built
  const existing = readJson<FindingsIndex>(filePath)
  if (!findingsIndexMatchesSarif(existing, built)) return built
  return existing
}

function findingsIndexMatchesSarif(existing: FindingsIndex, built: FindingsIndex): boolean {
  if (existing.findings.length !== built.findings.length) return false
  return existing.findings.every((finding, index) => {
    const expected = built.findings[index]
    return finding.sarifResultIndex === expected.sarifResultIndex && finding.findingId === expected.findingId
  })
}

function buildChangeBuckets(epChanges: EpChangesDocument): ChangeBuckets {
  const modified = new Set<string>()
  const added = new Set<string>()
  const deleted = new Set<string>()
  let unknownOrFallback = false
  let fallbackReason: string | undefined
  for (const fallback of epChanges.fallbacks ?? []) {
    if (fallback.level && fallback.level !== 'L0') {
      unknownOrFallback = true
      fallbackReason = fallback.reason ?? fallback.level
    }
  }
  for (const change of epChanges.epChanges ?? []) {
    const key = change.entrypointKey ?? change.epKey
    if (change.status === 'unknown') {
      unknownOrFallback = true
      fallbackReason = change.reasons?.join(',') ?? 'unknown entrypoint change'
      continue
    }
    if (!key) continue
    const canonicalKey = canonicalizeEntrypointKey(key)
    if (change.status === 'modified') modified.add(canonicalKey)
    if (change.status === 'added') added.add(canonicalKey)
    if (change.status === 'deleted') deleted.add(canonicalKey)
  }
  return { modified, added, deleted, unknownOrFallback, fallbackReason }
}

function canonicalizeEntrypointKey(entrypointKey: string): string {
  const parts = entrypointKey.split('|')
  if (parts.length !== 6) return entrypointKey
  const [filePath, functionName, type, , , attribute] = parts
  return [normalizePath(filePath), functionName, type, '', '', attribute].join('|')
}

function buildFullFallbackOutputs(selectedSarif: SarifLog, selectedIndex: FindingsIndex, reason?: string): MergeOutputs {
  const results = selectedSarif.runs?.[0]?.results ?? []
  const findings = selectedIndex.findings.map((finding, index) => ({ ...finding, sarifResultIndex: index, status: 'active' as const }))
  return {
    sarif: cloneSarifWithResults(selectedSarif, results),
    findingsIndex: { ...selectedIndex, findings },
    summary: {
      schemaVersion: 1,
      mode: 'full-fallback',
      reason,
      counts: {
        baseFindings: 0,
        selectedFindings: selectedIndex.findings.length,
        finalFindings: findings.length,
        keptUnaffected: 0,
        removedModified: 0,
        addedOrModifiedNew: findings.length,
        resolvedDeleted: 0,
        staleDeleted: 0,
      },
    },
    auditLog: findings.map(finding => auditEntry(finding, 'full_fallback', 'active', reason ?? 'unknown/full fallback uses full head SARIF')),
  }
}

function buildLineRemapper(epChanges: EpChangesDocument, sourceRootRemap?: SourceRootRemap): LineRemapper {
  const changes = buildLineRemapChanges(epChanges)
  return {
    remapLocation(location: FindingLocation): FindingLocation {
      const mappedStart = remapLine(location.file, location.startLine, changes)
      const mappedEnd = remapLine(location.file, location.endLine, changes)
      return { ...location, startLine: mappedStart, endLine: Math.max(mappedStart, mappedEnd) }
    },
    remapPhysicalLocation(location: SarifPhysicalLocation): SarifPhysicalLocation {
      const uri = location.artifactLocation?.uri
      const region = location.region
      if (!uri) return location
      const file = normalizePath(uri)
      const mappedUri = remapArtifactUri(uri, sourceRootRemap)
      if (!region?.startLine) {
        return mappedUri === uri ? location : { ...location, artifactLocation: { ...location.artifactLocation, uri: mappedUri } }
      }
      const mappedStart = remapLine(file, region.startLine, changes)
      const mappedEnd = region.endLine ? remapLine(file, region.endLine, changes) : undefined
      return {
        ...location,
        artifactLocation: { ...location.artifactLocation, uri: mappedUri },
        region: {
          ...region,
          startLine: mappedStart,
          endLine: mappedEnd === undefined ? undefined : Math.max(mappedStart, mappedEnd),
        },
      }
    },
  }
}

function buildSourceRootRemap(baseSourcePath: string | undefined, headSourcePath: string | undefined): SourceRootRemap | undefined {
  if (!baseSourcePath || !headSourcePath) return undefined
  const baseRoot = trimTrailingSlash(normalizePathPreserveCase(baseSourcePath))
  const headRoot = trimTrailingSlash(normalizePathPreserveCase(headSourcePath))
  if (!baseRoot || !headRoot || normalizePath(baseRoot) === normalizePath(headRoot)) return undefined
  return { baseRoot, headRoot }
}

function remapArtifactUri(uri: string, sourceRootRemap: SourceRootRemap | undefined): string {
  if (!sourceRootRemap) return uri
  const rawPath = stripUriPrefix(uri)
  const normalizedPath = normalizePath(rawPath)
  const normalizedBaseRoot = normalizePath(sourceRootRemap.baseRoot)
  if (normalizedPath !== normalizedBaseRoot && !normalizedPath.startsWith(`${normalizedBaseRoot}/`)) return uri
  const comparableRawPath = rawPath.replace(/^\/+/, '')
  const suffix = normalizedPath === normalizedBaseRoot ? '' : comparableRawPath.slice(sourceRootRemap.baseRoot.length)
  const mapped = `${sourceRootRemap.headRoot}${suffix}`
  if (uri.startsWith('file:///')) return `file:///${mapped}`
  if (uri.startsWith('file://')) return `file://${mapped}`
  if (uri.startsWith('/')) return `/${mapped}`
  return mapped
}

function stripUriPrefix(uri: string): string {
  return uri.replace(/^file:\/\//, '').replace(/\\/g, '/')
}

function normalizePathPreserveCase(filePath: string): string {
  return stripUriPrefix(filePath).replace(/^\/+/, '')
}

function trimTrailingSlash(filePath: string): string {
  return filePath.replace(/\/+$/, '')
}

function buildLineRemapChanges(epChanges: EpChangesDocument): LineRemapChange[] {
  const changesByKey = new Map<string, LineRemapChange>()
  for (const change of epChanges.epChanges ?? []) {
    const file = normalizePath(change.fileOld ?? change.fileNew ?? '')
    if (!file) continue
    if (change.rangeOld && change.rangeNew) {
      addLineRemapChange(changesByKey, { file, oldStart: change.rangeOld[0], oldEnd: change.rangeOld[1], newStart: change.rangeNew[0], newEnd: change.rangeNew[1], kind: 'modified' })
      continue
    }
    if (!change.rangeOld && change.rangeNew) {
      addLineRemapChange(changesByKey, { file, oldStart: change.rangeNew[0], oldEnd: change.rangeNew[0] - 1, newStart: change.rangeNew[0], newEnd: change.rangeNew[1], kind: 'added' })
      continue
    }
    if (change.rangeOld && !change.rangeNew) {
      addLineRemapChange(changesByKey, { file, oldStart: change.rangeOld[0], oldEnd: change.rangeOld[1], newStart: change.rangeOld[0], newEnd: change.rangeOld[0] - 1, kind: 'deleted' })
    }
  }
  return Array.from(changesByKey.values()).sort((left, right) => left.oldStart - right.oldStart)
}

function addLineRemapChange(changesByKey: Map<string, LineRemapChange>, change: LineRemapChange): void {
  changesByKey.set([change.file, change.oldStart, change.oldEnd, change.newStart, change.newEnd, change.kind].join('|'), change)
}

function remapLine(filePath: string, line: number, changes: LineRemapChange[]): number {
  const normalizedFile = normalizePath(filePath)
  let offset = 0
  for (const change of changes) {
    if (!pathsMatch(normalizedFile, change.file)) continue
    const oldLength = change.oldEnd >= change.oldStart ? change.oldEnd - change.oldStart + 1 : 0
    const newLength = change.newEnd >= change.newStart ? change.newEnd - change.newStart + 1 : 0
    if (line < change.oldStart) continue
    if (oldLength > 0 && line <= change.oldEnd) return change.newStart + Math.min(line - change.oldStart, Math.max(newLength - 1, 0))
    offset += newLength - oldLength
  }
  return Math.max(1, line + offset)
}

function remapSarifResult(result: SarifResult, lineRemapper: LineRemapper): SarifResult {
  const cloned = cloneJson<SarifResult>(result)
  remapPhysicalLocationsInValue(cloned, lineRemapper)
  return cloned
}

function remapFindingIndexEntry(finding: FindingIndexEntry, lineRemapper: LineRemapper, sarifResultIndex: number): FindingIndexEntry {
  const sink = lineRemapper.remapLocation(finding.sink)
  const source = finding.source ? lineRemapper.remapLocation(finding.source) : null
  return { ...finding, findingId: buildFindingId(finding.ruleId, sink, source, finding.entrypointKey, finding.traceDigest), sink, source, sarifResultIndex, status: 'active' }
}

function remapPhysicalLocationsInValue(value: unknown, lineRemapper: LineRemapper): void {
  if (Array.isArray(value)) {
    for (const item of value) remapPhysicalLocationsInValue(item, lineRemapper)
    return
  }
  if (!isObjectRecord(value)) return
  const physicalLocation = value.physicalLocation
  if (isSarifPhysicalLocation(physicalLocation)) value.physicalLocation = lineRemapper.remapPhysicalLocation(physicalLocation)
  for (const item of Object.values(value)) remapPhysicalLocationsInValue(item, lineRemapper)
}

function isSarifPhysicalLocation(value: unknown): value is SarifPhysicalLocation {
  if (!isObjectRecord(value)) return false
  const artifactLocation = value.artifactLocation
  const region = value.region
  return isObjectRecord(artifactLocation) || isObjectRecord(region)
}

function pathsMatch(left: string, right: string): boolean {
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function extractSinkLocation(result: SarifResult): FindingLocation {
  return normalizeSarifLocation(result.locations?.[0])
}

function extractSourceLocation(result: SarifResult): FindingLocation | null {
  const locations = result.codeFlows?.[0]?.threadFlows?.[0]?.locations ?? []
  if (locations.length === 0) return null
  return normalizeSarifPhysicalLocation(locations[0].location?.physicalLocation)
}

function digestCodeFlows(codeFlows: SarifCodeFlow[] | undefined): string {
  const normalized = (codeFlows ?? []).map(flow => (flow.threadFlows ?? []).map(threadFlow => (threadFlow.locations ?? []).map(location => ({
    message: location.location?.message?.text ?? '',
    location: normalizeSarifPhysicalLocation(location.location?.physicalLocation),
  }))))
  return sha1(JSON.stringify(normalized))
}

function normalizeSarifLocation(location: SarifLocation | undefined): FindingLocation {
  return normalizeSarifPhysicalLocation(location?.physicalLocation)
}

function normalizeSarifPhysicalLocation(location: SarifPhysicalLocation | undefined): FindingLocation {
  const region = location?.region
  const startLine = region?.startLine ?? 0
  return {
    file: normalizePath(location?.artifactLocation?.uri ?? ''),
    startLine,
    endLine: region?.endLine ?? startLine,
    startColumn: region?.startColumn,
    endColumn: region?.endColumn,
  }
}

function normalizeLocationForId(location: FindingLocation | null): string {
  if (!location) return 'none'
  return [normalizePath(location.file), location.startLine, location.endLine, location.startColumn ?? 0, location.endColumn ?? 0].join(':')
}

function normalizePath(filePath: string): string {
  return filePath.replace(/^file:\/\//, '').replace(/^\/+/, '').replace(/\\/g, '/').toLowerCase()
}

function cloneSarifWithResults(source: SarifLog, results: SarifResult[]): SarifLog {
  const cloned: SarifLog = { ...source, runs: source.runs ? [...source.runs] : [] }
  if (!cloned.runs || cloned.runs.length === 0) cloned.runs = [{}]
  cloned.runs[0] = { ...cloned.runs[0], results }
  return cloned
}

function auditEntry(finding: FindingIndexEntry, action: AuditLogEntry['action'], status: FindingStatus, reason: string): AuditLogEntry {
  return {
    findingId: finding.findingId,
    entrypointKey: finding.entrypointKey,
    action,
    status,
    sarifResultIndex: finding.sarifResultIndex,
    reason,
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
}

function sha1(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex')
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function numberOrEmpty(value: unknown): string {
  return typeof value === 'number' ? String(value) : ''
}
