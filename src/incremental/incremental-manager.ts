import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type Database from 'better-sqlite3'
import { createSqliteDatabase } from '../util/better-sqlite3-loader'
import { buildFindingsIndexFromSarif, mergeSarifFindingFiles, type SarifLog } from '../util/incremental-findings'
import type { EntryPoint } from '../engine/analyzer/common/entrypoint/entrypoint'
import type { EntryPointMetric } from '../util/entrypoint-metrics'

export type IncrementalMode = 'baseline' | 'auto' | 'full-on-fallback' | 'ep-only'
export type EpChangeStatus = 'added' | 'deleted' | 'modified' | 'unknown' | 'no_ep_impact'
export type FallbackLevel = 'L0' | 'L4'

export interface IncrementalConfig {
  cacheDir?: string
  diffFile?: string
  mode?: IncrementalMode
  impactEntrypointFile?: string
}

interface IndexRunRecord {
  runId: string
  kind: 'base' | 'head' | 'output'
  commit: string
  sourcePath: string
  reportDir: string
  dataflowDb: string
  sarif: string
  findingIndex: string
  entrypoints: string
  scanSummary: string
  entrypointMetrics?: string
  skippedEntrypoints?: number
  createdAt: string
}

interface SkippedEntrypointSummary {
  count: number
  byReason: Record<string, number>
  samples: Array<{ epKey: string; reason: string; file?: string; function?: string }>
}

interface EntrypointMetricFileRecord {
  epKey?: unknown
  file?: unknown
  function?: unknown
  skipped?: unknown
  skipReason?: unknown
}

interface IncrementalIndex {
  schemaVersion: 1
  project: string
  latestBase?: string
  runs: Record<string, IndexRunRecord>
  lastOutput?: IncrementalOutputPaths
  updatedAt: string
}

interface IncrementalOutputPaths {
  epChanges: string
  allowlist: string
  selectedRerunReport: string
  selectedRerunSummary: string
  mergedSarif: string
  findingIndex: string
  summary: string
  auditLog: string
}

interface DiffLineRange {
  file: string
  startLine: number
  endLine: number
  kind: 'added' | 'deleted' | 'modified'
  oldStartLine?: number
  oldEndLine?: number
}

interface EpIdentity {
  epKey: string
  epId?: string
  filePath: string
  functionName: string
  type: string
  attribute: string
  funcLocStart: number
  funcLocEnd: number
}

interface EpChange {
  status: EpChangeStatus
  epKey: string
  epIdOld: string | null
  epIdNew: string | null
  fileOld: string | null
  fileNew: string | null
  functionName: string
  type: string
  attribute: string
  rangeOld: [number, number] | null
  rangeNew: [number, number] | null
  rerun: boolean
  requiresDbRefresh: boolean
  reasons: string[]
  confidence: 'high' | 'low'
  fallbackLevel: FallbackLevel
}

interface EpChangesFile {
  schemaVersion: 1
  project: string
  baseCommit: string
  headCommit: string
  epChanges: EpChange[]
  fallbacks: Array<{ level: FallbackLevel; reason: string }>
  stats: {
    totalBaseEntrypoints: number
    totalHeadEntrypoints: number
    selectedRerunEntrypoints: number
    deletedEntrypoints: number
    addedEntrypoints: number
    unknownEntrypoints: number
    modifiedEntrypoints: number
    fallbackEntrypoints: number
    selectedRatio: number
  }
}

interface AllowlistFile {
  schemaVersion: 1
  mode: IncrementalMode
  allowlist: EpIdentity[]
  reasonsByEpKey: Record<string, string[]>
  failFast: boolean
  fallbackReasons: string[]
  fullHead: boolean
}

interface IncrementalPlan {
  enabled: boolean
  baselineOnly: boolean
  mode: IncrementalMode
  cacheDir: string
  indexPath: string
  project: string
  runId: string
  outputDir: string
  reportDir: string
  sourcePath: string
  baseRun?: IndexRunRecord
  outputPaths: IncrementalOutputPaths
  diffRanges: DiffLineRange[]
  diffPath?: string
  impactEntrypointFile?: string
  impactEntrypointInput?: ImpactEntrypointInput
  epChanges: EpChange[]
  fallbacks: Array<{ level: FallbackLevel; reason: string }>
  allowlistKeys: Set<string>
  reasonsByEpKey: Map<string, string[]>
  fullHead: boolean
  shouldRunFullHead: boolean
}

const DEFAULT_MODE: IncrementalMode = 'auto'
const INCREMENTAL_MODES = new Set<IncrementalMode>(['baseline', 'auto', 'full-on-fallback', 'ep-only'])
const PLAN_INPUT_FILE = 'incremental-input.json'

interface PersistedPlanInput {
  schemaVersion: 1
  runId: string
  project: string
  sourcePath: string
  reportDir: string
  cacheDir: string
  diffPath: string
  mode: IncrementalMode
  impactEntrypointFile: string
  createdAt: string
}

interface ImpactEntrypointInput {
  epChanges: EpChange[]
  allowlistKeys: string[]
  reasonsByEpKey: Record<string, string[]>
  fallbacks: Array<{ level: FallbackLevel; reason: string }>
  schemaVersionMissing: boolean
}

export function validateIncrementalMode(value: string | undefined): IncrementalMode {
  if (!value) return DEFAULT_MODE
  if (INCREMENTAL_MODES.has(value as IncrementalMode)) return value as IncrementalMode
  throw new Error(`--incrementalMode must be baseline|auto|full-on-fallback|ep-only, got ${value}`)
}

export function getIncrementalPlan(config: IncrementalConfig, sourcePath: string, reportDir: string): IncrementalPlan | null {
  if (!config.cacheDir) return null
  const cacheDir = path.resolve(config.cacheDir)
  ensureDir(cacheDir)
  const indexPath = path.join(cacheDir, 'incremental-index.json')
  const project = path.basename(sourcePath.replace(/[\/]+$/, '')) || 'project'
  const outputDir = path.join(reportDir, 'incremental')
  const mode = config.mode ?? DEFAULT_MODE
  const diffPath = config.diffFile ? path.resolve(config.diffFile) : ''
  const impactEntrypointFile = config.impactEntrypointFile ? path.resolve(config.impactEntrypointFile) : ''
  const runId = readOrCreatePlanInput(outputDir, { project, sourcePath, reportDir, cacheDir, diffPath, mode, impactEntrypointFile }).runId
  let index = readIndex(indexPath, project)
  if (!index.latestBase) {
    const autoBase = discoverBaselineRun(cacheDir, project)
    if (autoBase) {
      index.runs[autoBase.runId] = autoBase
      index.latestBase = autoBase.runId
      index.updatedAt = new Date().toISOString()
      writeJson(indexPath, index)
    }
  }
  const baseRun = index.latestBase ? index.runs[index.latestBase] : undefined
  const outputPaths = buildOutputPaths(outputDir)
  const impactEntrypointInput = impactEntrypointFile ? readImpactEntrypointFile(impactEntrypointFile) : undefined
  const baselineOnly = mode === 'baseline' || (!diffPath && !impactEntrypointInput)
  const diffRanges = diffPath && !impactEntrypointInput ? parseUnifiedDiff(diffPath) : []
  return {
    enabled: true,
    baselineOnly,
    mode,
    cacheDir,
    indexPath,
    project,
    runId,
    outputDir,
    reportDir,
    sourcePath,
    baseRun,
    outputPaths,
    diffRanges,
    diffPath,
    impactEntrypointFile,
    impactEntrypointInput,
    epChanges: [],
    fallbacks: [],
    allowlistKeys: new Set<string>(),
    reasonsByEpKey: new Map<string, string[]>(),
    fullHead: false,
    shouldRunFullHead: false,
  }
}

export function prepareIncrementalPlan(plan: IncrementalPlan): void {
  ensureDir(plan.cacheDir)
  ensureDir(plan.outputDir)
  writeAudit(plan, { event: 'plan_start', mode: plan.mode, baselineOnly: plan.baselineOnly })
  if (plan.baselineOnly) return
  if (plan.impactEntrypointInput) {
    applyImpactEntrypointInput(plan)
    return
  }
  if (!plan.baseRun) {
    addFallback(plan, 'L4', 'incremental-index.json has no latestBase run')
    return
  }
  const dbPath = resolveFromCache(plan.cacheDir, plan.baseRun.dataflowDb)
  if (!fs.existsSync(dbPath)) {
    addFallback(plan, 'L4', `base dataflow.db not found: ${dbPath}`)
    return
  }
  const oldEntrypoints = readDbEntrypoints(dbPath)
  for (const range of plan.diffRanges) {
    if (range.kind === 'deleted') {
      addDeletedChanges(plan, dbPath, oldEntrypoints, range)
      continue
    }
    if (range.kind === 'modified') {
      addModifiedChanges(plan, dbPath, range)
      continue
    }
    addNoEpImpact(plan, range)
    continue
  }
  if (plan.diffRanges.length === 0) {
    addFallback(plan, 'L4', 'incremental diff has no parseable file hunks')
  }
}

export function applyIncrementalEntrypointAllowlist(
  entryPoints: EntryPoint[],
  config: IncrementalConfig,
  sourcePath: string,
  reportDir: string
): EntryPoint[] {
  const plan = getIncrementalPlan(config, sourcePath, reportDir)
  if (!plan) return entryPoints
  const headEntrypoints = entryPoints.map((ep) => toEpIdentity(ep, sourcePath))
  writeEntrypointsFile(path.join(plan.outputDir, 'entrypoints.json'), headEntrypoints)
  if (plan.baselineOnly) {
    writeBaselineOutputs(plan, headEntrypoints)
    return entryPoints
  }

  prepareIncrementalPlan(plan)
  if (!plan.impactEntrypointInput) compareHeadEntrypoints(plan, headEntrypoints)
  finalizeMode(plan, headEntrypoints)
  writeIncrementalOutputs(plan, headEntrypoints)
  if (plan.shouldRunFullHead) {
    writeAudit(plan, { event: 'allowlist_applied', before: entryPoints.length, after: entryPoints.length, fullHead: true })
    return entryPoints
  }
  const selected = entryPoints.filter((ep) => plan.allowlistKeys.has(toEpIdentity(ep, sourcePath).epKey))
  writeAudit(plan, { event: 'allowlist_applied', before: entryPoints.length, after: selected.length, fullHead: false })
  return selected
}

export function completeIncrementalRun(config: IncrementalConfig, sourcePath: string, reportDir: string, entrypointMetrics?: readonly EntryPointMetric[]): void {
  const plan = getIncrementalPlan(config, sourcePath, reportDir)
  if (!plan) return
  if (!plan.baselineOnly) publishHeadReportAsSelectedRerun(plan)
  completeIncrementalPlan(plan, sourcePath, reportDir, plan.baselineOnly ? 'base' : 'head', entrypointMetrics)
}

export interface IncrementalConsumerResult {
  completed: boolean
  finalFindings: number
}

export function tryCompleteIncrementalConsumerRun(config: IncrementalConfig, sourcePath: string, reportDir: string): IncrementalConsumerResult {
  const plan = getIncrementalPlan(config, sourcePath, reportDir)
  if (!plan || plan.baselineOnly) return { completed: false, finalFindings: 0 }
  prepareIncrementalPlan(plan)
  if (!canCompleteWithoutHeadAnalysis(plan)) return { completed: false, finalFindings: 0 }
  const headEntrypoints = readConsumerHeadEntrypoints(plan)
  writeIncrementalOutputs(plan, headEntrypoints)
  writePartialMergedOutputs(plan)
  publishMergedSarifAsPublicReport(plan)
  completeIncrementalPlan(plan, sourcePath, reportDir, 'output')
  return { completed: true, finalFindings: readFinalFindingsCount(plan) }
}

function completeIncrementalPlan(plan: IncrementalPlan, sourcePath: string, reportDir: string, kind: 'base' | 'head' | 'output', entrypointMetrics?: readonly EntryPointMetric[]): void {
  const index = readIndex(plan.indexPath, plan.project)
  const skippedSummary = summarizeSkippedEntrypoints(entrypointMetrics ?? readEntrypointMetrics(path.join(reportDir, 'entrypoint-metrics.json')))
  const run: IndexRunRecord = {
    runId: plan.runId,
    kind,
    commit: plan.runId,
    sourcePath,
    reportDir: relativeToCache(plan.cacheDir, reportDir),
    dataflowDb: kind === 'output' && plan.baseRun ? plan.baseRun.dataflowDb : relativeToCache(plan.cacheDir, path.join(reportDir, 'dataflow.db')),
    sarif: relativeToCache(plan.cacheDir, path.join(reportDir, 'report.sarif')),
    findingIndex: relativeToCache(plan.cacheDir, path.join(plan.outputDir, 'findings-index.json')),
    entrypoints: relativeToCache(plan.cacheDir, path.join(plan.outputDir, 'entrypoints.json')),
    scanSummary: relativeToCache(plan.cacheDir, path.join(reportDir, 'scan_summary.json')),
    entrypointMetrics: relativeToCache(plan.cacheDir, path.join(reportDir, 'entrypoint-metrics.json')),
    skippedEntrypoints: skippedSummary.count,
    createdAt: new Date().toISOString(),
  }
  index.runs[run.runId] = run
  if (plan.baselineOnly) {
    writeBaselineFindingsIndex(plan)
    index.latestBase = run.runId
  } else {
    index.lastOutput = toRelativeOutputPaths(plan.cacheDir, plan.outputPaths)
    if (kind !== 'output') {
      if (isFullHeadOutput(plan)) writeFullHeadMergedOutputs(plan)
      else writePartialMergedOutputs(plan)
      publishMergedSarifAsPublicReport(plan)
    }
  }
  mergeSkippedEntrypointSummary(plan.outputPaths.summary, skippedSummary)
  index.updatedAt = new Date().toISOString()
  writeJson(plan.indexPath, index)
}

function readFinalFindingsCount(plan: IncrementalPlan): number {
  if (!fs.existsSync(plan.outputPaths.summary)) return 0
  try {
    const summary = JSON.parse(fs.readFileSync(plan.outputPaths.summary, 'utf8')) as { counts?: { finalFindings?: unknown } }
    return typeof summary.counts?.finalFindings === 'number' ? summary.counts.finalFindings : 0
  } catch (_err) {
    return 0
  }
}


function summarizeSkippedEntrypoints(metrics: readonly EntrypointMetricFileRecord[]): SkippedEntrypointSummary {
  const skipped = metrics.filter((metric) => metric.skipped === true)
  const byReason: Record<string, number> = {}
  const samples: SkippedEntrypointSummary['samples'] = []
  for (const metric of skipped) {
    const reason = typeof metric.skipReason === 'string' && metric.skipReason.length > 0 ? metric.skipReason : 'unknown'
    byReason[reason] = (byReason[reason] ?? 0) + 1
    if (samples.length < 20) {
      samples.push({
        epKey: typeof metric.epKey === 'string' ? metric.epKey : '<unknown>',
        reason,
        file: typeof metric.file === 'string' ? metric.file : undefined,
        function: typeof metric.function === 'string' ? metric.function : undefined,
      })
    }
  }
  return { count: skipped.length, byReason, samples }
}

function readEntrypointMetrics(metricsPath: string): EntrypointMetricFileRecord[] {
  if (!fs.existsSync(metricsPath)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(metricsPath, 'utf8')) as unknown
    return Array.isArray(raw) ? raw.filter(isPlainObject) : []
  } catch (_err) {
    return []
  }
}

function mergeSkippedEntrypointSummary(summaryPath: string, skippedSummary: SkippedEntrypointSummary): void {
  if (!fs.existsSync(summaryPath)) return
  try {
    const raw = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as unknown
    if (!isPlainObject(raw)) return
    writeJson(summaryPath, { ...raw, skippedEntrypoints: skippedSummary })
  } catch (_err) {
    return
  }
}

function canCompleteWithoutHeadAnalysis(plan: IncrementalPlan): boolean {
  return plan.fallbacks.length === 0
    && plan.allowlistKeys.size === 0
    && plan.epChanges.every((change) => change.rerun === false && change.status !== 'unknown' && change.status !== 'added')
}

function readConsumerHeadEntrypoints(plan: IncrementalPlan): EpIdentity[] {
  if (!plan.baseRun) return []
  const entrypointPath = resolveFromCache(plan.cacheDir, plan.baseRun.entrypoints)
  if (fs.existsSync(entrypointPath)) return readEntrypointsFile(entrypointPath)
  const dbPath = resolveFromCache(plan.cacheDir, plan.baseRun.dataflowDb)
  if (fs.existsSync(dbPath)) return readDbEntrypoints(dbPath)
  return []
}

function writeBaselineOutputs(plan: IncrementalPlan, headEntrypoints: EpIdentity[]): void {
  writeEntrypointsFile(path.join(plan.outputDir, 'entrypoints.json'), headEntrypoints)
  writeJson(plan.outputPaths.summary, {
    schemaVersion: 1,
    mode: plan.mode,
    baselineInitialized: true,
    totalEntrypoints: headEntrypoints.length,
    promoteBaseline: false,
  })
  writeJson(plan.outputPaths.allowlist, { schemaVersion: 1, mode: plan.mode, allowlist: [], reasonsByEpKey: {}, failFast: false, fallbackReasons: [], fullHead: false })
  writeJson(plan.outputPaths.epChanges, emptyEpChanges(plan, headEntrypoints.length))
  ensureFile(plan.outputPaths.selectedRerunReport, JSON.stringify({ version: '2.1.0', runs: [] }, null, 2))
  ensureFile(plan.outputPaths.selectedRerunSummary, JSON.stringify({ reservedFor: 'incremental-merge' }, null, 2))
  ensureFile(plan.outputPaths.findingIndex, JSON.stringify({ schemaVersion: 1, findings: [] }, null, 2))
  ensureFile(plan.outputPaths.mergedSarif, JSON.stringify({ reservedFor: 'incremental-merge' }, null, 2))
}

function writeBaselineFindingsIndex(plan: IncrementalPlan): void {
  const sarifPath = path.join(plan.reportDir, 'report.sarif')
  if (!fs.existsSync(sarifPath)) return
  const sarif = JSON.parse(fs.readFileSync(sarifPath, 'utf8')) as SarifLog
  writeJson(plan.outputPaths.findingIndex, buildFindingsIndexFromSarif(sarif, plan.project, plan.runId))
}

function compareHeadEntrypoints(plan: IncrementalPlan, headEntrypoints: EpIdentity[]): void {
  if (!plan.baseRun) return
  const baseEntrypointPath = resolveFromCache(plan.cacheDir, plan.baseRun.entrypoints)
  const baseEntrypoints = readEntrypointsFile(baseEntrypointPath)
  const baseKeys = new Set(baseEntrypoints.map((ep) => ep.epKey))
  const headKeys = new Set(headEntrypoints.map((ep) => ep.epKey))
  const nonDeletedRanges = plan.diffRanges.filter((range) => range.kind !== 'deleted')
  const pairedDriftBaseKeys = new Set<string>()
  for (const ep of headEntrypoints) {
    if (baseKeys.has(ep.epKey)) continue
    const driftedBaseIdentity = baseEntrypoints.find((baseEp) => hasSameEntrypointIdentity(baseEp, ep))
    if (driftedBaseIdentity) {
      pairedDriftBaseKeys.add(driftedBaseIdentity.epKey)
      const change = makeEpChange('modified', ep, null, ['head_entrypoint_identity_changed'], true)
      plan.epChanges.push(change)
      addAllowlist(plan, ep.epKey, change.reasons)
    } else if (touchesAnyRange(ep, nonDeletedRanges)) {
      const change = makeEpChange('added', ep, null, ['head_entrypoint_compare'], true)
      plan.epChanges.push(change)
      addAllowlist(plan, ep.epKey, change.reasons)
    }
  }
  for (const ep of baseEntrypoints) {
    if (!headKeys.has(ep.epKey) && !pairedDriftBaseKeys.has(ep.epKey)) {
      plan.epChanges.push(makeEpChange('deleted', ep, null, ['head_entrypoint_compare'], false))
    }
  }
  for (const range of plan.diffRanges.filter((item) => item.kind === 'added')) {
    if (!headEntrypoints.some((ep) => touchesRange(ep, range))) addNoEpImpact(plan, range)
  }
}

function finalizeMode(plan: IncrementalPlan, headEntrypoints: EpIdentity[]): void {
  const riskyReasons = plan.fallbacks.map((fallback) => fallback.reason)
  if (plan.mode === 'full-on-fallback' && riskyReasons.length > 0) {
    addFullHeadAllowlist(plan, headEntrypoints, riskyReasons)
    return
  }
  if (plan.mode === 'auto' && riskyReasons.length > 0) {
    addFullHeadAllowlist(plan, headEntrypoints, riskyReasons)
    return
  }
  if (plan.mode === 'ep-only') {
    const hasBadChange = plan.epChanges.some((change) => change.status === 'added' || change.status === 'unknown')
    const hasOnlyNoEpImpact = plan.epChanges.length > 0 && plan.epChanges.every((change) => change.status === 'no_ep_impact')
    if (riskyReasons.length > 0 || hasBadChange || (plan.allowlistKeys.size === 0 && !hasOnlyNoEpImpact)) {
      const reason = riskyReasons[0] ?? 'ep-only allowlist is empty or unsafe'
      throw new Error(`Incremental ep-only fail fast: ${reason}`)
    }
  }
}


function addFullHeadAllowlist(plan: IncrementalPlan, headEntrypoints: EpIdentity[], reasons: string[]): void {
  plan.fullHead = true
  plan.shouldRunFullHead = true
  writeAudit(plan, { event: 'full_fallback_selected', totalHeadEntrypoints: headEntrypoints.length, reasons })
  for (const ep of headEntrypoints) addAllowlist(plan, ep.epKey, ['full_head_fallback', ...reasons])
}

function setFullHeadIfAllHeadSelected(plan: IncrementalPlan, headEntrypoints: EpIdentity[]): void {
  const allHeadSelected = headEntrypoints.length > 0 && headEntrypoints.every((ep) => plan.allowlistKeys.has(ep.epKey))
  if (!allHeadSelected) return
  plan.fullHead = true
  plan.shouldRunFullHead = true
}

function writeIncrementalOutputs(plan: IncrementalPlan, headEntrypoints: EpIdentity[]): void {
  const fallbackReasons = plan.fallbacks.map((fallback) => fallback.reason)
  setFullHeadIfAllHeadSelected(plan, headEntrypoints)
  const allowlist = plan.shouldRunFullHead ? headEntrypoints : headEntrypoints.filter((ep) => plan.allowlistKeys.has(ep.epKey))
  const allowlistFile: AllowlistFile = {
    schemaVersion: 1,
    mode: plan.mode,
    allowlist,
    reasonsByEpKey: Object.fromEntries(plan.reasonsByEpKey.entries()),
    failFast: false,
    fallbackReasons,
    fullHead: plan.fullHead,
  }
  const epChanges = buildEpChangesFile(plan, headEntrypoints.length)
  epChanges.stats.selectedRerunEntrypoints = allowlist.length
  epChanges.stats.selectedRatio = headEntrypoints.length > 0 ? allowlist.length / headEntrypoints.length : 0
  writeJson(plan.outputPaths.epChanges, epChanges)
  writeJson(plan.outputPaths.allowlist, allowlistFile)
  writeJson(plan.outputPaths.summary, {
    schemaVersion: 1,
    mode: plan.mode,
    baselineInitialized: false,
    totalBaseEntrypoints: readBaseEntrypointCount(plan),
    totalHeadEntrypoints: headEntrypoints.length,
    selectedRerunEntrypoints: allowlist.length,
    selectedAll: plan.fullHead,
    fallbackReasons,
    stats: epChanges.stats,
    fallbacks: plan.fallbacks,
    selectedRerunReport: plan.outputPaths.selectedRerunReport,
    promoteBaseline: false,
  })
  ensureFile(plan.outputPaths.selectedRerunSummary, JSON.stringify({ reservedFor: 'incremental-merge' }, null, 2))
  ensureFile(plan.outputPaths.selectedRerunReport, JSON.stringify({ reservedFor: 'incremental-merge' }, null, 2))
  ensureFile(plan.outputPaths.findingIndex, JSON.stringify({ schemaVersion: 1, findings: [] }, null, 2))
  ensureFile(plan.outputPaths.mergedSarif, JSON.stringify({ reservedFor: 'incremental-merge' }, null, 2))
}

function addModifiedChanges(plan: IncrementalPlan, dbPath: string, range: DiffLineRange): void {
  const rows = readDbImpactedEntrypoints(dbPath, range)
  if (rows.length === 0) {
    addNoEpImpact(plan, range)
    return
  }
  for (const row of rows) {
    const ep = dbRowToIdentity(row)
    const reason = `${row.reason}: ${formatImpactLocation(range)}`
    plan.epChanges.push(makeEpChange('modified', ep, row.ep_id, [reason], true))
    addAllowlist(plan, ep.epKey, [reason])
  }
}

function readDbImpactedEntrypoints(dbPath: string, range: DiffLineRange): DbEntrypointRow[] {
  const db = createSqliteDatabase(dbPath, { readonly: true })
  try {
    const directRows = db.prepare(`
      SELECT DISTINCT id, ep_id, file, func_name, start_line, end_line, ep_type, framework, attribute, reason FROM (
        SELECT ep.id, ep.ep_id, ep.file, ep.func_name, ep.start_line, ep.end_line, ep.ep_type, ep.framework, ep.attribute, 'entrypoint_body' AS reason
        FROM entrypoints ep
        WHERE ltrim(ep.file, '/') LIKE '%' || @file AND ep.start_line <= @endLine AND ep.end_line >= @startLine
        UNION
        SELECT ep.id, ep.ep_id, ep.file, ep.func_name, ep.start_line, ep.end_line, ep.ep_type, ep.framework, ep.attribute, 'call_site' AS reason
        FROM callgraph cg JOIN entrypoints ep ON ep.id = cg.ep_id
        WHERE ltrim(cg.call_site_file, '/') LIKE '%' || @file AND cg.call_site_line BETWEEN @startLine AND @endLine
        UNION
        SELECT ep.id, ep.ep_id, ep.file, ep.func_name, ep.start_line, ep.end_line, ep.ep_type, ep.framework, ep.attribute, 'edges_one_hop' AS reason
        FROM edges ed JOIN entrypoints ep ON ep.id = ed.ep_id JOIN nodes n ON n.id = ed.from_node_id OR n.id = ed.to_node_id
        WHERE ltrim(n.file, '/') LIKE '%' || @file AND n.line BETWEEN @startLine AND @endLine
      )
    `).all({ file: normalizePath(range.file), startLine: impactStartLine(range), endLine: impactEndLine(range) }) as DbEntrypointRow[]
    return mergeEntrypointRows(directRows, readPythonClassBridgeEntrypoints(db, range))
  } finally {
    db.close()
  }
}


function readPythonClassBridgeEntrypoints(db: Database.Database, range: DiffLineRange): DbEntrypointRow[] {
  const bridgeRows = db.prepare(`
    SELECT DISTINCT ep.id, ep.ep_id, ep.file, ep.func_name, ep.start_line, ep.end_line, ep.ep_type, ep.framework, ep.attribute, s.sid AS class_name,
      'python_class_callgraph_bridge' AS reason
    FROM symbols s
    JOIN callgraph cg ON (
      instr(coalesce(cg.callee_qid, ''), s.sid) > 0
      OR instr(coalesce(cg.caller_qid, ''), s.sid) > 0
      OR instr(coalesce(cg.callee_dotted_path, ''), s.sid) > 0
    )
    JOIN entrypoints ep ON ep.id = cg.ep_id
    WHERE s.vtype = 'class'
      AND coalesce(s.sid, '') != ''
      AND coalesce(cg.ep_id, '') != ''
      AND ltrim(s.file, '/') LIKE '%' || @file
      AND s.start_line <= @endLine
      AND s.end_line >= @startLine
  `).all({ file: normalizePath(range.file), startLine: impactStartLine(range), endLine: impactEndLine(range) }) as DbClassBridgeRow[]
  return bridgeRows
    .filter((row) => !isWeakClassBridgeName(row.class_name))
    .map((row) => ({ ...row, reason: `${row.reason}:${row.class_name}` }))
}

function mergeEntrypointRows(directRows: DbEntrypointRow[], bridgeRows: DbEntrypointRow[]): DbEntrypointRow[] {
  const rowsByKey = new Map<string, DbEntrypointRow>()
  for (const row of [...directRows, ...bridgeRows]) {
    const ep = dbRowToIdentity(row)
    const existing = rowsByKey.get(ep.epKey)
    if (!existing) {
      rowsByKey.set(ep.epKey, row)
      continue
    }
    rowsByKey.set(ep.epKey, { ...existing, reason: mergeReasonLabels(existing.reason, row.reason) })
  }
  return Array.from(rowsByKey.values())
}

function mergeReasonLabels(left: string | undefined, right: string | undefined): string {
  return Array.from(new Set([left, right].filter((reason): reason is string => Boolean(reason)))).join('+')
}

function isWeakClassBridgeName(name: string): boolean {
  const normalized = name.trim()
  if (normalized.length < 3) return true
  if (normalized === '...') return true
  if (normalized.startsWith('_') || normalized.endsWith('_')) return true
  return new Set(['get', 'set', 'init', 'config', 'handler', 'main']).has(normalized.toLowerCase())
}

function addDeletedChanges(plan: IncrementalPlan, dbPath: string, oldEntrypoints: EpIdentity[], range: DiffLineRange): void {
  const touched = oldEntrypoints.filter((ep) => touchesRange(ep, range))
  const touchedKeys = new Set(touched.map((ep) => ep.epKey))
  for (const ep of touched) {
    plan.epChanges.push(makeEpChange('deleted', ep, ep.epId ?? null, [`deleted_base_coordinate: ${range.file}:${range.startLine}-${range.endLine}`], false))
  }

  const rows = readDbImpactedEntrypoints(dbPath, range)
  let impacted = 0
  for (const row of rows) {
    const ep = dbRowToIdentity(row)
    if (touchedKeys.has(ep.epKey)) continue
    const reason = `${row.reason}: ${range.file}:${range.startLine}-${range.endLine}`
    plan.epChanges.push(makeEpChange('modified', ep, row.ep_id, [reason], true))
    addAllowlist(plan, ep.epKey, [reason])
    impacted += 1
  }
  if (touched.length === 0 && impacted === 0) addNoEpImpact(plan, range)
}

function addNoEpImpact(plan: IncrementalPlan, range: DiffLineRange): void {
  const location = formatImpactLocation(range)
  const reason = `db_no_ep_fact: ${location}`
  const factGapReason = `db_fact_gap: ${location}`
  const reasons = [reason, factGapReason, 'no_db_ep_impact']
  plan.epChanges.push({
    status: 'no_ep_impact',
    epKey: `no_ep_impact|${location}`,
    epIdOld: null,
    epIdNew: null,
    fileOld: range.kind === 'added' ? null : range.file,
    fileNew: range.kind === 'deleted' ? null : range.file,
    functionName: '',
    type: '',
    attribute: '',
    rangeOld: range.kind === 'added' ? null : [impactStartLine(range), impactEndLine(range)],
    rangeNew: range.kind === 'deleted' ? null : [range.startLine, range.endLine],
    rerun: false,
    requiresDbRefresh: false,
    reasons,
    confidence: 'high',
    fallbackLevel: 'L0',
  })
  writeAudit(plan, { event: 'no_ep_impact', range, reason: 'no_db_ep_impact', reasons })
}

function makeEpChange(status: EpChangeStatus, ep: EpIdentity, epIdOld: string | null, reasons: string[], rerun: boolean): EpChange {
  return {
    status,
    epKey: ep.epKey,
    epIdOld: status === 'added' ? null : epIdOld ?? ep.epId ?? null,
    epIdNew: status === 'deleted' ? null : ep.epId ?? null,
    fileOld: status === 'added' ? null : ep.filePath,
    fileNew: status === 'deleted' ? null : ep.filePath,
    functionName: ep.functionName,
    type: ep.type,
    attribute: ep.attribute,
    rangeOld: status === 'added' ? null : [ep.funcLocStart, ep.funcLocEnd],
    rangeNew: status === 'deleted' ? null : [ep.funcLocStart, ep.funcLocEnd],
    rerun,
    requiresDbRefresh: status === 'unknown',
    reasons,
    confidence: status === 'unknown' ? 'low' : 'high',
    fallbackLevel: status === 'unknown' ? 'L4' : 'L0',
  }
}

function addAllowlist(plan: IncrementalPlan, epKey: string, reasons: string[]): void {
  plan.allowlistKeys.add(epKey)
  const existing = plan.reasonsByEpKey.get(epKey) ?? []
  plan.reasonsByEpKey.set(epKey, Array.from(new Set([...existing, ...reasons])))
}

function addFallback(plan: IncrementalPlan, level: FallbackLevel, reason: string): void {
  plan.fallbacks.push({ level, reason })
  plan.epChanges.push({
    status: 'unknown',
    epKey: `unknown|${reason}`,
    epIdOld: null,
    epIdNew: null,
    fileOld: null,
    fileNew: null,
    functionName: '',
    type: '',
    attribute: '',
    rangeOld: null,
    rangeNew: null,
    rerun: true,
    requiresDbRefresh: true,
    reasons: [reason],
    confidence: 'low',
    fallbackLevel: level,
  })
}

interface DbEntrypointRow {
  ep_id: string
  file: string
  func_name: string
  start_line: number
  end_line: number
  ep_type: string
  framework?: string
  attribute: string
  reason?: string
}

interface DbClassBridgeRow extends DbEntrypointRow {
  class_name: string
}

function readDbEntrypoints(dbPath: string): EpIdentity[] {
  const db = createSqliteDatabase(dbPath, { readonly: true })
  try {
    const rows = db.prepare('SELECT ep_id, file, func_name, start_line, end_line, ep_type, framework, attribute FROM entrypoints').all() as DbEntrypointRow[]
    return rows.map(dbRowToIdentity)
  } finally {
    db.close()
  }
}

function dbRowToIdentity(row: DbEntrypointRow): EpIdentity {
  const filePath = normalizePath(row.file ?? '')
  const functionName = String(row.func_name ?? '')
  const type = String(row.ep_type ?? '')
  const attribute = String(row.attribute ?? '')
  const funcLocStart = Number(row.start_line ?? 0)
  const funcLocEnd = Number(row.end_line ?? 0)
  return { epKey: buildEpKey(filePath, functionName, type, funcLocStart, funcLocEnd, attribute), epId: row.ep_id, filePath, functionName, type, attribute, funcLocStart, funcLocEnd }
}

function toEpIdentity(ep: EntryPoint, sourcePath: string): EpIdentity {
  const loc = ep.entryPointSymVal?.ast?.node?.loc
  const rawFile = ep.filePath || loc?.sourcefile || ''
  const filePath = normalizePath(stripSourceRoot(rawFile, sourcePath))
  const functionName = String(ep.functionName ?? '')
  const type = String(ep.type ?? '')
  const attribute = String(ep.attribute ?? '')
  const funcLocStart = Number(ep.funcLocStart ?? loc?.start?.line ?? 0)
  const funcLocEnd = Number(ep.funcLocEnd ?? loc?.end?.line ?? 0)
  return { epKey: buildEpKey(filePath, functionName, type, funcLocStart, funcLocEnd, attribute), filePath, functionName, type, attribute, funcLocStart, funcLocEnd }
}

function buildEpKey(filePath: string, functionName: string, type: string, start: number, end: number, attribute: string): string {
  return [normalizePath(filePath), functionName, type, String(start), String(end), attribute].join('|')
}

function hasSameEntrypointIdentity(left: EpIdentity, right: EpIdentity): boolean {
  return normalizePath(left.filePath) === normalizePath(right.filePath)
    && left.functionName === right.functionName
    && left.type === right.type
    && left.attribute === right.attribute
}

export function parseUnifiedDiff(diffFile: string): DiffLineRange[] {
  const content = fs.readFileSync(diffFile, 'utf8')
  const ranges: DiffLineRange[] = []
  let oldFile = ''
  let newFile = ''
  let oldLine = 0
  let newLine = 0
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('--- ')) {
      oldFile = cleanDiffPath(line.slice(4).trim())
      continue
    }
    if (line.startsWith('+++ ')) {
      newFile = cleanDiffPath(line.slice(4).trim())
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      continue
    }
    if (oldLine === 0 && newLine === 0) continue
    if (line.startsWith('+') && !line.startsWith('+++')) {
      ranges.push({ file: newFile || oldFile, startLine: newLine, endLine: newLine, kind: 'added' })
      newLine += 1
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      ranges.push({ file: oldFile || newFile, startLine: oldLine, endLine: oldLine, kind: 'deleted' })
      oldLine += 1
      continue
    }
    if (line.startsWith(' ')) {
      oldLine += 1
      newLine += 1
    }
  }
  return coalesceDiffRanges(markModifiedPairs(ranges))
}

function markModifiedPairs(ranges: DiffLineRange[]): DiffLineRange[] {
  const result: DiffLineRange[] = []
  let index = 0
  while (index < ranges.length) {
    const current = ranges[index]
    if (current.kind !== 'deleted') {
      result.push(current)
      index += 1
      continue
    }

    const deleteBlock: DiffLineRange[] = []
    while (ranges[index]?.file === current.file && ranges[index]?.kind === 'deleted') {
      deleteBlock.push(ranges[index])
      index += 1
    }
    const addBlock: DiffLineRange[] = []
    while (ranges[index]?.file === current.file && ranges[index]?.kind === 'added') {
      addBlock.push(ranges[index])
      index += 1
    }
    if (addBlock.length === 0) {
      result.push(...deleteBlock)
      continue
    }
    result.push({
      file: current.file,
      startLine: minStartLine(addBlock),
      endLine: maxEndLine(addBlock),
      kind: 'modified',
      oldStartLine: minStartLine(deleteBlock),
      oldEndLine: maxEndLine(deleteBlock),
    })
  }
  return result
}

function minStartLine(ranges: DiffLineRange[]): number {
  return ranges.reduce((min, range) => Math.min(min, range.startLine), Number.MAX_SAFE_INTEGER)
}

function maxEndLine(ranges: DiffLineRange[]): number {
  return ranges.reduce((max, range) => Math.max(max, range.endLine), 0)
}

function coalesceDiffRanges(ranges: DiffLineRange[]): DiffLineRange[] {
  const merged: DiffLineRange[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && previous.file === range.file && previous.kind === range.kind && previous.endLine + 1 >= range.startLine && canCoalesceImpactRange(previous, range)) {
      previous.endLine = Math.max(previous.endLine, range.endLine)
      previous.oldStartLine = Math.min(previous.oldStartLine ?? previous.startLine, range.oldStartLine ?? range.startLine)
      previous.oldEndLine = Math.max(previous.oldEndLine ?? previous.endLine, range.oldEndLine ?? range.endLine)
      continue
    }
    merged.push({ ...range })
  }
  return merged
}


type PlanInputIdentity = Omit<PersistedPlanInput, 'schemaVersion' | 'runId' | 'createdAt'>

function readOrCreatePlanInput(outputDir: string, identity: PlanInputIdentity): PersistedPlanInput {
  const inputPath = path.join(outputDir, PLAN_INPUT_FILE)
  if (fs.existsSync(inputPath)) {
    const existing = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as Partial<PersistedPlanInput>
    if (isSamePlanInput(existing, identity)) return existing as PersistedPlanInput
  }
  const input: PersistedPlanInput = {
    schemaVersion: 1,
    runId: buildRunId(identity),
    ...identity,
    createdAt: new Date().toISOString(),
  }
  writeJson(inputPath, input)
  return input
}

function isSamePlanInput(existing: Partial<PersistedPlanInput>, identity: PlanInputIdentity): boolean {
  return existing.schemaVersion === 1
    && existing.project === identity.project
    && existing.sourcePath === identity.sourcePath
    && existing.reportDir === identity.reportDir
    && existing.cacheDir === identity.cacheDir
    && (existing.diffPath ?? '') === identity.diffPath
    && existing.mode === identity.mode
    && (existing.impactEntrypointFile ?? '') === identity.impactEntrypointFile
}

interface RawImpactEntrypointFile {
  schemaVersion?: unknown
  epChanges?: unknown
  allowlist?: unknown
  allowlistKeys?: unknown
  reasonsByEpKey?: unknown
  fallbacks?: unknown
}

function readImpactEntrypointFile(filePath: string): ImpactEntrypointInput {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  if (!isPlainObject(raw)) throw new Error(`impactEntrypointFile must be a JSON object: ${filePath}`)
  const input = raw as RawImpactEntrypointFile
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error(`impactEntrypointFile schemaVersion must be 1 when present: ${filePath}`)
  const epChanges = validateEpChanges(input.epChanges, filePath)
  const allowlistKeys = validateAllowlistKeys(input.allowlistKeys, input.allowlist, filePath)
  const reasonsByEpKey = validateReasonsByEpKey(input.reasonsByEpKey, filePath)
  const fallbacks = validateFallbacks(input.fallbacks, filePath)
  return { epChanges, allowlistKeys, reasonsByEpKey, fallbacks, schemaVersionMissing: input.schemaVersion === undefined }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const EP_CHANGE_STATUSES: readonly EpChangeStatus[] = ['added', 'deleted', 'modified', 'unknown', 'no_ep_impact']
const EP_CHANGE_CONFIDENCES = ['high', 'low'] as const

function validateEpChanges(value: unknown, filePath: string): EpChange[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`impactEntrypointFile epChanges must be an array: ${filePath}`)
  return value.map((change, index) => validateEpChange(change, index, filePath))
}

function validateEpChange(value: unknown, index: number, filePath: string): EpChange {
  const prefix = `impactEntrypointFile epChanges[${index}]`
  if (!isPlainObject(value)) throw new Error(`${prefix} must be an object: ${filePath}`)
  validateOptionalStringOrNull(value, 'epId', `${prefix}.epId`, filePath)
  validateOptionalStringOrNull(value, 'file', `${prefix}.file`, filePath)
  validateOptionalStringOrNull(value, 'function', `${prefix}.function`, filePath)
  return {
    status: readEpChangeStatus(value.status, `${prefix}.status`, filePath),
    epKey: readString(value.epKey, `${prefix}.epKey`, filePath),
    epIdOld: readOptionalStringOrNull(value, 'epIdOld', `${prefix}.epIdOld`, filePath, null),
    epIdNew: readOptionalStringOrNull(value, 'epIdNew', `${prefix}.epIdNew`, filePath, null),
    fileOld: readOptionalStringOrNull(value, 'fileOld', `${prefix}.fileOld`, filePath, null),
    fileNew: readOptionalStringOrNull(value, 'fileNew', `${prefix}.fileNew`, filePath, null),
    functionName: readOptionalStringOrNull(value, 'functionName', `${prefix}.functionName`, filePath, '') ?? '',
    type: readOptionalStringOrNull(value, 'type', `${prefix}.type`, filePath, '') ?? '',
    attribute: readOptionalStringOrNull(value, 'attribute', `${prefix}.attribute`, filePath, '') ?? '',
    rangeOld: readOptionalRange(value, 'rangeOld', `${prefix}.rangeOld`, filePath),
    rangeNew: readOptionalRange(value, 'rangeNew', `${prefix}.rangeNew`, filePath),
    rerun: readBoolean(value.rerun, `${prefix}.rerun`, filePath),
    requiresDbRefresh: readOptionalBoolean(value, 'requiresDbRefresh', `${prefix}.requiresDbRefresh`, filePath, false),
    reasons: readStringArray(value.reasons, `${prefix}.reasons`, filePath),
    confidence: readOptionalConfidence(value, 'confidence', `${prefix}.confidence`, filePath),
    fallbackLevel: readFallbackLevel(value.fallbackLevel, `${prefix}.fallbackLevel`, filePath),
  }
}

function readString(value: unknown, fieldPath: string, filePath: string): string {
  if (typeof value !== 'string') throw new Error(`${fieldPath} must be a string: ${filePath}`)
  return value
}

function readBoolean(value: unknown, fieldPath: string, filePath: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${fieldPath} must be a boolean: ${filePath}`)
  return value
}

function readOptionalBoolean(source: Record<string, unknown>, key: string, fieldPath: string, filePath: string, defaultValue: boolean): boolean {
  const value = source[key]
  if (value === undefined) return defaultValue
  if (typeof value !== 'boolean') throw new Error(`${fieldPath} must be a boolean: ${filePath}`)
  return value
}

function readStringArray(value: unknown, fieldPath: string, filePath: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${fieldPath} must be a string array: ${filePath}`)
  return value
}

function readEpChangeStatus(value: unknown, fieldPath: string, filePath: string): EpChangeStatus {
  if (typeof value !== 'string' || !EP_CHANGE_STATUSES.includes(value as EpChangeStatus)) throw new Error(`${fieldPath} must be added|deleted|modified|unknown|no_ep_impact: ${filePath}`)
  return value as EpChangeStatus
}

function readFallbackLevel(value: unknown, fieldPath: string, filePath: string): FallbackLevel {
  if (value !== 'L0' && value !== 'L4') throw new Error(`${fieldPath} must be L0|L4: ${filePath}`)
  return value
}

function readOptionalConfidence(source: Record<string, unknown>, key: string, fieldPath: string, filePath: string): 'high' | 'low' {
  const value = source[key]
  if (value === undefined) return 'high'
  if (typeof value !== 'string' || !EP_CHANGE_CONFIDENCES.includes(value as 'high' | 'low')) throw new Error(`${fieldPath} must be high|low: ${filePath}`)
  return value as 'high' | 'low'
}

function readOptionalStringOrNull(source: Record<string, unknown>, key: string, fieldPath: string, filePath: string, defaultValue: string | null): string | null {
  const value = source[key]
  if (value === undefined) return defaultValue
  if (typeof value !== 'string' && value !== null) throw new Error(`${fieldPath} must be a string or null: ${filePath}`)
  return value
}

function validateOptionalStringOrNull(source: Record<string, unknown>, key: string, fieldPath: string, filePath: string): void {
  if (source[key] === undefined) return
  readOptionalStringOrNull(source, key, fieldPath, filePath, null)
}

function readOptionalRange(source: Record<string, unknown>, key: string, fieldPath: string, filePath: string): [number, number] | null {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => typeof item === 'number')) throw new Error(`${fieldPath} must be [number, number] or null: ${filePath}`)
  return [value[0], value[1]]
}

function validateAllowlistKeys(keysValue: unknown, allowlistValue: unknown, filePath: string): string[] {
  if (keysValue !== undefined) {
    if (!Array.isArray(keysValue)) throw new Error(`impactEntrypointFile allowlistKeys must be an array: ${filePath}`)
    return keysValue.map((key) => {
      if (typeof key !== 'string') throw new Error(`impactEntrypointFile allowlistKeys item must be a string: ${filePath}`)
      return key
    })
  }
  if (allowlistValue === undefined) return []
  if (!Array.isArray(allowlistValue)) throw new Error(`impactEntrypointFile allowlist must be an array: ${filePath}`)
  return allowlistValue.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.epKey !== 'string') throw new Error(`impactEntrypointFile allowlist item epKey must be a string: ${filePath}`)
    return entry.epKey
  })
}

function validateReasonsByEpKey(value: unknown, filePath: string): Record<string, string[]> {
  if (value === undefined) return {}
  if (!isPlainObject(value)) throw new Error(`impactEntrypointFile reasonsByEpKey must be an object: ${filePath}`)
  const reasonsByEpKey: Record<string, string[]> = {}
  for (const [epKey, reasons] of Object.entries(value)) {
    if (!Array.isArray(reasons) || !reasons.every((reason) => typeof reason === 'string')) throw new Error(`impactEntrypointFile reasonsByEpKey values must be string arrays: ${filePath}`)
    reasonsByEpKey[epKey] = reasons
  }
  return reasonsByEpKey
}

function validateFallbacks(value: unknown, filePath: string): Array<{ level: FallbackLevel; reason: string }> {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`impactEntrypointFile fallbacks must be an array: ${filePath}`)
  return value.map((fallback) => {
    if (!isPlainObject(fallback)) throw new Error(`impactEntrypointFile fallback item must be an object: ${filePath}`)
    if (fallback.level !== 'L0' && fallback.level !== 'L4') throw new Error(`impactEntrypointFile fallback level must be L0|L4: ${filePath}`)
    if (typeof fallback.reason !== 'string') throw new Error(`impactEntrypointFile fallback reason must be a string: ${filePath}`)
    return { level: fallback.level, reason: fallback.reason }
  })
}

function isFullHeadOutput(plan: IncrementalPlan): boolean {
  if (plan.fullHead || plan.shouldRunFullHead) return true
  if (!fs.existsSync(plan.outputPaths.allowlist)) return false
  const raw = JSON.parse(fs.readFileSync(plan.outputPaths.allowlist, 'utf8')) as Partial<AllowlistFile>
  return raw.fullHead === true
}

function writeFullHeadMergedOutputs(plan: IncrementalPlan): void {
  const headSarifPath = path.join(plan.reportDir, 'report.sarif')
  const headSarif = readValidSarifOrNull(headSarifPath)
  if (!headSarif) {
    writeAudit(plan, { event: 'full_head_merged_sarif_missing_or_invalid', source: headSarifPath })
    return
  }
  ensureDir(path.dirname(plan.outputPaths.mergedSarif))
  fs.copyFileSync(headSarifPath, plan.outputPaths.mergedSarif)
  writeJson(plan.outputPaths.findingIndex, buildFindingsIndexFromSarif(headSarif, plan.project, plan.runId))
  writeAudit(plan, { event: 'full_head_merged_sarif_written', source: headSarifPath, target: plan.outputPaths.mergedSarif })
}

function publishHeadReportAsSelectedRerun(plan: IncrementalPlan): void {
  const headSarifPath = path.join(plan.reportDir, 'report.sarif')
  const selectedSarif = readValidSarifOrNull(headSarifPath)
  if (!selectedSarif) {
    writeAudit(plan, { event: 'selected_rerun_sarif_missing_or_invalid', source: headSarifPath })
    return
  }
  ensureDir(path.dirname(plan.outputPaths.selectedRerunReport))
  fs.copyFileSync(headSarifPath, plan.outputPaths.selectedRerunReport)
  writeJson(plan.outputPaths.findingIndex, buildFindingsIndexFromSarif(selectedSarif, plan.project, plan.runId))
  writeAudit(plan, { event: 'selected_rerun_sarif_written', source: headSarifPath, target: plan.outputPaths.selectedRerunReport })
}

function writePartialMergedOutputs(plan: IncrementalPlan): void {
  if (!plan.baseRun) return
  const baseSarifPath = resolveFromCache(plan.cacheDir, plan.baseRun.sarif)
  if (!fs.existsSync(baseSarifPath) || !fs.existsSync(plan.outputPaths.epChanges)) return
  const selectedSarifPath = ensureSelectedRerunSarif(plan)
  const baseFindingsIndexPath = resolveFromCache(plan.cacheDir, plan.baseRun.findingIndex)
  mergeSarifFindingFiles({
    baseSarifPath,
    selectedSarifPath,
    baseFindingsIndexPath: fs.existsSync(baseFindingsIndexPath) ? baseFindingsIndexPath : undefined,
    selectedFindingsIndexPath: fs.existsSync(plan.outputPaths.findingIndex) ? plan.outputPaths.findingIndex : undefined,
    epChangesPath: plan.outputPaths.epChanges,
    outputDir: plan.outputDir,
    project: plan.project,
    commit: plan.runId,
    baseSourcePath: plan.baseRun.sourcePath,
    headSourcePath: plan.sourcePath,
  })
  writeAudit(plan, { event: 'partial_merged_sarif_written', base: baseSarifPath, selected: selectedSarifPath, target: plan.outputPaths.mergedSarif })
}

function publishMergedSarifAsPublicReport(plan: IncrementalPlan): void {
  if (!readValidSarifOrNull(plan.outputPaths.mergedSarif)) {
    writeAudit(plan, { event: 'public_report_sarif_missing_or_invalid', source: plan.outputPaths.mergedSarif })
    return
  }
  const publicReportPath = path.join(plan.reportDir, 'report.sarif')
  fs.copyFileSync(plan.outputPaths.mergedSarif, publicReportPath)
  writeAudit(plan, { event: 'public_report_sarif_written', source: plan.outputPaths.mergedSarif, target: publicReportPath })
}

function readValidSarifOrNull(filePath: string): SarifLog | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const sarif = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SarifLog>
    if (sarif.version !== '2.1.0' || !Array.isArray(sarif.runs)) return null
    return sarif as SarifLog
  } catch (_err) {
    return null
  }
}

function ensureSelectedRerunSarif(plan: IncrementalPlan): string {
  if (!fs.existsSync(plan.outputPaths.selectedRerunReport)) {
    writeJson(plan.outputPaths.selectedRerunReport, { version: '2.1.0', runs: [{ results: [] }] })
  }
  return plan.outputPaths.selectedRerunReport
}

function applyImpactEntrypointInput(plan: IncrementalPlan): void {
  const input = plan.impactEntrypointInput
  if (!input) return
  plan.epChanges.push(...input.epChanges)
  for (const fallback of input.fallbacks) plan.fallbacks.push(fallback)
  for (const key of input.allowlistKeys) addAllowlist(plan, key, input.reasonsByEpKey[key] ?? ['impact_entrypoint_file'])
  for (const [key, reasons] of Object.entries(input.reasonsByEpKey)) {
    if (!plan.allowlistKeys.has(key)) plan.reasonsByEpKey.set(key, reasons)
  }
  writeAudit(plan, { event: 'impact_entrypoint_file_loaded', selected: input.allowlistKeys.length, changes: input.epChanges.length, schemaVersionMissing: input.schemaVersionMissing })
}

function readBaseEntrypointCount(plan: IncrementalPlan): number {
  if (!plan.baseRun) return 0
  const entrypointPath = resolveFromCache(plan.cacheDir, plan.baseRun.entrypoints)
  if (fs.existsSync(entrypointPath)) return readEntrypointsFile(entrypointPath).length
  const dbPath = resolveFromCache(plan.cacheDir, plan.baseRun.dataflowDb)
  if (fs.existsSync(dbPath)) return readDbEntrypoints(dbPath).length
  return 0
}

function cleanDiffPath(value: string): string {
  const first = value.split(/\s+/)[0]
  if (first === '/dev/null') return ''
  return normalizePath(first.replace(/^a\//, '').replace(/^b\//, ''))
}

function buildRunId(identity: PlanInputIdentity): string {
  const digest = crypto.createHash('sha1').update(`${identity.project}|${identity.sourcePath}|${identity.reportDir}|${identity.cacheDir}|${identity.diffPath}|${identity.mode}|${identity.impactEntrypointFile}|${Date.now()}`).digest('hex').slice(0, 12)
  return `run-${digest}`
}

function readIndex(indexPath: string, project: string): IncrementalIndex {
  if (!fs.existsSync(indexPath)) return { schemaVersion: 1, project, runs: {}, updatedAt: new Date().toISOString() }
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as IncrementalIndex
  return { schemaVersion: 1, project: raw.project || project, latestBase: raw.latestBase, runs: raw.runs || {}, lastOutput: raw.lastOutput, updatedAt: raw.updatedAt || new Date().toISOString() }
}

function discoverBaselineRun(cacheDir: string, project: string): IndexRunRecord | null {
  const projectDir = path.join(cacheDir, 'artifacts', project)
  if (!fs.existsSync(projectDir)) return null
  const dbPath = path.join(projectDir, 'dataflow.db')
  const entrypoints = path.join(projectDir, 'incremental', 'entrypoints.json')
  if (!fs.existsSync(dbPath) || !fs.existsSync(entrypoints)) return null
  const runId = `base-${crypto.createHash('sha1').update(projectDir).digest('hex').slice(0, 12)}`
  return {
    runId,
    kind: 'base',
    commit: runId,
    sourcePath: projectDir,
    reportDir: relativeToCache(cacheDir, projectDir),
    dataflowDb: relativeToCache(cacheDir, dbPath),
    sarif: relativeToCache(cacheDir, path.join(projectDir, 'report.sarif')),
    findingIndex: relativeToCache(cacheDir, path.join(projectDir, 'incremental', 'findings-index.json')),
    entrypoints: relativeToCache(cacheDir, entrypoints),
    scanSummary: relativeToCache(cacheDir, path.join(projectDir, 'scan_summary.json')),
    createdAt: new Date().toISOString(),
  }
}

function buildOutputPaths(outputDir: string): IncrementalOutputPaths {
  return {
    epChanges: path.join(outputDir, 'ep-changes.json'),
    allowlist: path.join(outputDir, 'entrypoint-allowlist.json'),
    selectedRerunReport: path.join(outputDir, 'selected-rerun-report.sarif'),
    selectedRerunSummary: path.join(outputDir, 'selected-rerun-summary.json'),
    mergedSarif: path.join(outputDir, 'merged-report.sarif'),
    findingIndex: path.join(outputDir, 'findings-index.json'),
    summary: path.join(outputDir, 'incremental-summary.json'),
    auditLog: path.join(outputDir, 'audit-log.jsonl'),
  }
}

function buildEpChangesFile(plan: IncrementalPlan, totalHeadEntrypoints: number): EpChangesFile {
  const selected = plan.allowlistKeys.size
  const deleted = plan.epChanges.filter((change) => change.status === 'deleted').length
  const added = plan.epChanges.filter((change) => change.status === 'added').length
  const modified = plan.epChanges.filter((change) => change.status === 'modified').length
  const unknown = plan.epChanges.filter((change) => change.status === 'unknown').length
  return {
    schemaVersion: 1,
    project: plan.project,
    baseCommit: plan.baseRun?.commit ?? '',
    headCommit: plan.runId,
    epChanges: plan.epChanges,
    fallbacks: plan.fallbacks,
    stats: {
      totalBaseEntrypoints: readBaseEntrypointCount(plan),
      totalHeadEntrypoints,
      selectedRerunEntrypoints: Math.min(selected, totalHeadEntrypoints),
      deletedEntrypoints: deleted,
      addedEntrypoints: added,
      modifiedEntrypoints: modified,
      unknownEntrypoints: unknown,
      fallbackEntrypoints: plan.fallbacks.length,
      selectedRatio: totalHeadEntrypoints > 0 ? Math.min(selected, totalHeadEntrypoints) / totalHeadEntrypoints : 0,
    },
  }
}

function emptyEpChanges(plan: IncrementalPlan, totalHeadEntrypoints: number): EpChangesFile {
  return { schemaVersion: 1, project: plan.project, baseCommit: plan.runId, headCommit: plan.runId, epChanges: [], fallbacks: [], stats: { totalBaseEntrypoints: totalHeadEntrypoints, totalHeadEntrypoints, selectedRerunEntrypoints: 0, deletedEntrypoints: 0, addedEntrypoints: 0, modifiedEntrypoints: 0, unknownEntrypoints: 0, fallbackEntrypoints: 0, selectedRatio: 0 } }
}

function readEntrypointsFile(filePath: string): EpIdentity[] {
  if (!fs.existsSync(filePath)) return []
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { entryPoints?: EpIdentity[]; entrypoints?: EpIdentity[] }
  const values = raw.entryPoints ?? raw.entrypoints ?? []
  return values.map((ep) => ({ ...ep, epKey: ep.epKey || buildEpKey(ep.filePath, ep.functionName, ep.type, ep.funcLocStart, ep.funcLocEnd, ep.attribute) }))
}

function writeEntrypointsFile(filePath: string, entrypoints: EpIdentity[]): void {
  writeJson(filePath, { schemaVersion: 1, entryPoints: entrypoints })
}

function touchesAnyRange(ep: EpIdentity, ranges: DiffLineRange[]): boolean {
  return ranges.some((range) => touchesRange(ep, range))
}

function touchesRange(ep: EpIdentity, range: DiffLineRange): boolean {
  const epFile = normalizePath(ep.filePath)
  const rangeFile = normalizePath(range.file)
  if (!(epFile.endsWith(rangeFile) || rangeFile.endsWith(epFile))) return false
  const newTouches = ep.funcLocStart <= range.endLine && ep.funcLocEnd >= range.startLine
  if (range.kind !== 'modified') return newTouches
  return newTouches || (ep.funcLocStart <= impactEndLine(range) && ep.funcLocEnd >= impactStartLine(range))
}

function canCoalesceImpactRange(left: DiffLineRange, right: DiffLineRange): boolean {
  if (left.kind !== 'modified') return true
  return impactEndLine(left) + 1 >= impactStartLine(right)
}

function impactStartLine(range: DiffLineRange): number {
  return range.oldStartLine ?? range.startLine
}

function impactEndLine(range: DiffLineRange): number {
  return range.oldEndLine ?? range.endLine
}

function formatImpactLocation(range: DiffLineRange): string {
  const baseLocation = `${range.file}:${impactStartLine(range)}-${impactEndLine(range)}`
  if (range.kind !== 'modified' || range.oldStartLine === undefined || range.oldEndLine === undefined) return baseLocation
  if (range.oldStartLine === range.startLine && range.oldEndLine === range.endLine) return baseLocation
  return `${baseLocation} (new ${range.file}:${range.startLine}-${range.endLine})`
}

function stripSourceRoot(filePath: string, sourcePath: string): string {
  const root = sourcePath.replace(/[\/]+$/, '')
  return filePath.startsWith(root) ? filePath.slice(root.length).replace(/^[\/]+/, '') : filePath
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

function resolveFromCache(cacheDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(cacheDir, value)
}

function relativeToCache(cacheDir: string, value: string): string {
  return path.isAbsolute(value) ? path.relative(cacheDir, value) || '.' : value
}

function toRelativeOutputPaths(cacheDir: string, paths: IncrementalOutputPaths): IncrementalOutputPaths {
  return Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, relativeToCache(cacheDir, value)])) as unknown as IncrementalOutputPaths
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function ensureFile(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content)
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeAudit(plan: IncrementalPlan, value: Record<string, unknown>): void {
  ensureDir(path.dirname(plan.outputPaths.auditLog))
  fs.appendFileSync(plan.outputPaths.auditLog, `${JSON.stringify({ time: new Date().toISOString(), ...value })}\n`)
}
