import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { applyIncrementalEntrypointAllowlist, completeIncrementalRun, parseUnifiedDiff, tryCompleteIncrementalConsumerRun } from '../src/incremental/incremental-manager'
import { mergeSarifFindingFiles } from '../src/util/incremental-findings'
import type { EntryPoint } from '../src/engine/analyzer/common/entrypoint/entrypoint'

function makeTempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
}

function makeEntryPoint(filePath: string, functionName: string, startLine: number, endLine: number): EntryPoint {
  return { filePath, functionName, type: 'http', attribute: 'GET', funcLocStart: startLine, funcLocEnd: endLine }
}

function epKey(filePath: string, functionName: string, startLine: number, endLine: number): string {
  return [filePath, functionName, 'http', String(startLine), String(endLine), 'GET'].join('|')
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeEmptyDataflowDb(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const db = new Database(filePath)
  try {
    db.exec(`
      CREATE TABLE entrypoints (id INTEGER PRIMARY KEY, ep_id TEXT, file TEXT, func_name TEXT, start_line INTEGER, end_line INTEGER, ep_type TEXT, framework TEXT, attribute TEXT);
      CREATE TABLE callgraph (ep_id INTEGER, call_site_file TEXT, call_site_line INTEGER, caller_qid TEXT, callee_qid TEXT, callee_dotted_path TEXT);
      CREATE TABLE nodes (id INTEGER PRIMARY KEY, file TEXT, line INTEGER);
      CREATE TABLE edges (ep_id INTEGER, from_node_id INTEGER, to_node_id INTEGER);
      CREATE TABLE symbols (symbol_id TEXT PRIMARY KEY, qid TEXT, sid TEXT, vtype TEXT, file TEXT, start_line INTEGER, end_line INTEGER, provenance TEXT);
    `)
  } finally {
    db.close()
  }
}

interface SmokeSarifResult {
  ruleId: string
  level?: string
  message?: { text: string }
  entrypoint?: Record<string, unknown>
  locations?: unknown[]
  codeFlows?: unknown[]
}

interface SmokeSarifLog {
  version: string
  runs: Array<{ results: SmokeSarifResult[] }>
}

function findingSarif(ruleId: string, entrypointKey: string, artifactUri = 'src/api.ts'): SmokeSarifLog {
  return {
    version: '2.1.0',
    runs: [{
      results: [{
        ruleId,
        level: 'error',
        message: { text: `${ruleId}:${entrypointKey}` },
        entrypoint: { entrypointKey, filePath: 'src/api.ts', functionName: 'handler' },
        locations: [{ physicalLocation: { artifactLocation: { uri: artifactUri }, region: { startLine: 12, endLine: 12 } } }],
        codeFlows: [{
          threadFlows: [{
            locations: [
              { location: { message: { text: 'source' }, physicalLocation: { artifactLocation: { uri: artifactUri }, region: { startLine: 11, endLine: 11 } } } },
              { location: { message: { text: 'sink' }, physicalLocation: { artifactLocation: { uri: artifactUri }, region: { startLine: 12, endLine: 12 } } } },
            ],
          }],
        }],
      }],
    }],
  }
}

function testImpactFileFullHeadReturnsAllEntrypoints(): void {
  const root = makeTempDir('cia-full-head-impact')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const impactFile = path.join(root, 'impact.json')
  const entryPoints = [makeEntryPoint('a.ts', 'one', 1, 4), makeEntryPoint('b.ts', 'two', 10, 15)]
  writeJson(impactFile, {
    schemaVersion: 1,
    allowlistKeys: [epKey('a.ts', 'one', 1, 4), epKey('b.ts', 'two', 10, 15)],
    reasonsByEpKey: {},
    epChanges: [],
    fallbacks: [],
  })

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, impactEntrypointFile: impactFile, mode: 'auto' }, sourcePath, reportDir)
  const allowlist = readJson<{ fullHead: boolean; allowlist: unknown[] }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))

  assert.strictEqual(filtered.length, entryPoints.length)
  assert.strictEqual(allowlist.fullHead, true)
  assert.strictEqual(allowlist.allowlist.length, entryPoints.length)
}

function testFallbackFullHeadReturnsAllEntrypoints(): void {
  const root = makeTempDir('cia-full-head-fallback')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const diffFile = path.join(root, 'change.diff')
  fs.writeFileSync(diffFile, '')
  const entryPoints = [makeEntryPoint('a.ts', 'one', 1, 4), makeEntryPoint('b.ts', 'two', 10, 15)]

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const allowlist = readJson<{ fullHead: boolean; allowlist: unknown[] }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))

  assert.strictEqual(filtered.length, entryPoints.length)
  assert.strictEqual(allowlist.fullHead, true)
  assert.strictEqual(allowlist.allowlist.length, entryPoints.length)
}

function testPlanInputRunIdStaleness(): void {
  const root = makeTempDir('cia-run-id')
  const cacheDir = path.join(root, 'cache')
  const reportDir = path.join(root, 'report')
  const sourceA = path.join(root, 'src-a')
  const sourceB = path.join(root, 'src-b')
  const diffA = path.join(root, 'a.diff')
  const diffB = path.join(root, 'b.diff')
  fs.writeFileSync(diffA, '')
  fs.writeFileSync(diffB, '')

  applyIncrementalEntrypointAllowlist([], { cacheDir, diffFile: diffA, mode: 'auto' }, sourceA, reportDir)
  const first = readJson<{ runId: string }>(path.join(reportDir, 'incremental', 'incremental-input.json')).runId
  completeIncrementalRun({ cacheDir, diffFile: diffA, mode: 'auto' }, sourceA, reportDir)
  const second = readJson<{ runId: string }>(path.join(reportDir, 'incremental', 'incremental-input.json')).runId
  applyIncrementalEntrypointAllowlist([], { cacheDir, diffFile: diffB, mode: 'auto' }, sourceA, reportDir)
  const diffChanged = readJson<{ runId: string }>(path.join(reportDir, 'incremental', 'incremental-input.json')).runId
  applyIncrementalEntrypointAllowlist([], { cacheDir, diffFile: diffB, mode: 'auto' }, sourceB, reportDir)
  const sourceChanged = readJson<{ runId: string }>(path.join(reportDir, 'incremental', 'incremental-input.json')).runId

  assert.strictEqual(second, first)
  assert.notStrictEqual(diffChanged, first)
  assert.notStrictEqual(sourceChanged, diffChanged)
}

function testMalformedImpactFileFailFast(): void {
  const root = makeTempDir('cia-malformed-impact')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const impactFile = path.join(root, 'impact.json')
  writeJson(impactFile, { schemaVersion: 1, allowlist: [{ epKey: 123 }] })

  assert.throws(
    () => applyIncrementalEntrypointAllowlist([], { cacheDir, impactEntrypointFile: impactFile, mode: 'auto' }, sourcePath, reportDir),
    /allowlist item epKey must be a string/
  )
}

function testMalformedEpChangeFailFast(): void {
  const root = makeTempDir('cia-malformed-ep-change')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const impactFile = path.join(root, 'impact.json')
  writeJson(impactFile, { schemaVersion: 1, epChanges: [{ epKey: 'x', status: 123 }] })

  assert.throws(
    () => applyIncrementalEntrypointAllowlist([], { cacheDir, impactEntrypointFile: impactFile, mode: 'auto' }, sourcePath, reportDir),
    /epChanges\[0\]\.status must be added\|deleted\|modified\|unknown\|no_ep_impact/
  )
}

function testMinimalEpChangePasses(): void {
  const root = makeTempDir('cia-minimal-ep-change')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const impactFile = path.join(root, 'impact.json')
  writeJson(impactFile, {
    schemaVersion: 1,
    epChanges: [{ epKey: 'x', status: 'modified', rerun: true, reasons: ['smoke'], fallbackLevel: 'L0' }],
  })

  applyIncrementalEntrypointAllowlist([], { cacheDir, impactEntrypointFile: impactFile, mode: 'auto' }, sourcePath, reportDir)
  const epChanges = readJson<{ epChanges: Array<{ epKey: string; status: string }> }>(path.join(reportDir, 'incremental', 'ep-changes.json'))

  assert.strictEqual(epChanges.epChanges.length, 1)
  assert.strictEqual(epChanges.epChanges[0].epKey, 'x')
  assert.strictEqual(epChanges.epChanges[0].status, 'modified')
}

function testAbsoluteRootRemapKeepsLeadingSlashAndSuffix(): void {
  const root = makeTempDir('cia-root-remap')
  const baseSourcePath = path.join(root, 'base')
  const headSourcePath = path.join(root, 'head')
  const baseSarifPath = path.join(root, 'base.sarif')
  const selectedSarifPath = path.join(root, 'selected.sarif')
  const epChangesPath = path.join(root, 'ep-changes.json')
  const baseArtifactUri = path.join(baseSourcePath, 'src', 'A.java')
  const headArtifactUri = path.join(headSourcePath, 'src', 'A.java')
  const baseSarif = findingSarif('base-rule', epKey('src/api.ts', 'handler', 10, 20), baseArtifactUri)
  fs.writeFileSync(baseSarifPath, `${JSON.stringify(baseSarif, null, 2)}\n`)
  fs.writeFileSync(selectedSarifPath, `${JSON.stringify({ version: '2.1.0', runs: [{ results: [] }] })}\n`)
  writeJson(epChangesPath, { epChanges: [] })

  const resultPaths = mergeSarifFindingFiles({ baseSarifPath, selectedSarifPath, epChangesPath, outputDir: path.join(root, 'out'), baseSourcePath: `${baseSourcePath}/`, headSourcePath: `${headSourcePath}/` })
  const merged = readJson<SmokeSarifLog>(resultPaths.mergedSarifPath)
  const result = merged.runs[0].results[0]
  const primaryLocation = result.locations?.[0] as { physicalLocation?: { artifactLocation?: { uri?: string } } } | undefined
  const firstCodeFlow = result.codeFlows?.[0] as { threadFlows?: Array<{ locations?: Array<{ location?: { physicalLocation?: { artifactLocation?: { uri?: string } } } }> }> } | undefined

  assert.strictEqual(primaryLocation?.physicalLocation?.artifactLocation?.uri, headArtifactUri)
  assert.strictEqual(firstCodeFlow?.threadFlows?.[0]?.locations?.[0]?.location?.physicalLocation?.artifactLocation?.uri, headArtifactUri)
}

function testMergedSarifOutputUsesCompactJson(): void {
  const root = makeTempDir('cia-merged-sarif-compact')
  const base = findingSarif('base-rule', epKey('src/api.ts', 'handler', 10, 20))
  const selected = findingSarif('selected-rule', epKey('src/api.ts', 'handler', 10, 20))
  const baseSarifPath = path.join(root, 'base.sarif')
  const selectedSarifPath = path.join(root, 'selected.sarif')
  const epChangesPath = path.join(root, 'ep-changes.json')
  fs.writeFileSync(baseSarifPath, `${JSON.stringify(base, null, 2)}\n`)
  fs.writeFileSync(selectedSarifPath, `${JSON.stringify(selected, null, 2)}\n`)
  writeJson(epChangesPath, { epChanges: [{ status: 'modified', epKey: epKey('src/api.ts', 'handler', 10, 20) }] })

  const resultPaths = mergeSarifFindingFiles({ baseSarifPath, selectedSarifPath, epChangesPath, outputDir: path.join(root, 'out') })
  const mergedContent = fs.readFileSync(resultPaths.mergedSarifPath, 'utf8')
  const merged = readJson<SmokeSarifLog>(resultPaths.mergedSarifPath)

  assert.strictEqual(merged.runs[0].results.length, 1)
  assert.strictEqual(merged.runs[0].results[0].ruleId, 'selected-rule')
  assert.strictEqual(mergedContent.includes('\n  \"'), false)
}

function testDbFactGapEmptySelectionDoesNotFullFallback(): void {
  const root = makeTempDir('cia-db-no-ep')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  const baseEntryPointsPath = path.join(baseReportDir, 'incremental', 'entrypoints.json')
  const entryPoints = [makeEntryPoint('src/api.ts', 'handler', 10, 20)]
  fs.writeFileSync(diffFile, [
    '--- a/src/util.ts',
    '+++ b/src/util.ts',
    '@@ -3,1 +3,1 @@',
    '-oldValue()',
    '+newValue()',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  writeJson(baseEntryPointsPath, { schemaVersion: 1, entryPoints: [] })
  writeJson(path.join(cacheDir, 'incremental-index.json'), {
    schemaVersion: 1,
    project: path.basename(sourcePath),
    latestBase: 'base',
    runs: {
      base: {
        runId: 'base',
        kind: 'base',
        commit: 'base',
        sourcePath,
        reportDir: 'base-report',
        dataflowDb: 'base-report/dataflow.db',
        sarif: 'base-report/report.sarif',
        findingIndex: 'base-report/incremental/findings-index.json',
        entrypoints: 'base-report/incremental/entrypoints.json',
        scanSummary: 'base-report/scan_summary.json',
        createdAt: new Date(0).toISOString(),
      },
    },
    updatedAt: new Date(0).toISOString(),
  })

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const allowlist = readJson<{ fullHead: boolean; allowlist: unknown[]; fallbackReasons: string[] }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))
  const epChanges = readJson<{ epChanges: Array<{ status: string; rerun: boolean; reasons: string[] }>; fallbacks: unknown[]; stats: { selectedRerunEntrypoints: number } }>(path.join(reportDir, 'incremental', 'ep-changes.json'))
  const auditLog = fs.readFileSync(path.join(reportDir, 'incremental', 'audit-log.jsonl'), 'utf8')

  assert.strictEqual(filtered.length, 0)
  assert.strictEqual(allowlist.fullHead, false)
  assert.strictEqual(allowlist.allowlist.length, 0)
  assert.deepStrictEqual(allowlist.fallbackReasons, [])
  assert.strictEqual(epChanges.fallbacks.length, 0)
  assert.strictEqual(epChanges.stats.selectedRerunEntrypoints, 0)
  assert.strictEqual(epChanges.epChanges[0].status, 'no_ep_impact')
  assert.strictEqual(epChanges.epChanges[0].rerun, false)
  assert.strictEqual(epChanges.epChanges[0].reasons.includes('db_fact_gap: src/util.ts:3-3'), true)
  assert.strictEqual(epChanges.epChanges[0].reasons.includes('no_db_ep_impact'), true)
  assert.match(auditLog, /db_fact_gap/)
  assert.match(auditLog, /no_db_ep_impact/)
}


function testUnownedImpactFactProducesNoEpImpact(): void {
  const root = makeTempDir('cia-unbound-impact')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  const entryPoints = [makeEntryPoint('src/api.ts', 'handler', 10, 20)]
  fs.writeFileSync(diffFile, [
    '--- a/src/lib/shared.ts',
    '+++ b/src/lib/shared.ts',
    '@@ -50,1 +70,1 @@',
    '-oldValue()',
    '+newValue()',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  const db = new Database(dbPath)
  try {
    db.prepare('INSERT INTO callgraph (ep_id, call_site_file, call_site_line, caller_qid, callee_qid, callee_dotted_path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(null, 'src/lib/shared.ts', 50, '', '', '')
  } finally {
    db.close()
  }
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const allowlist = readJson<{ fullHead: boolean; allowlist: unknown[]; fallbackReasons: string[] }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))
  const epChanges = readJson<{ epChanges: Array<{ status: string; rerun: boolean; rangeOld: [number, number] | null; rangeNew: [number, number] | null; reasons: string[] }>; fallbacks: Array<{ reason: string }> }>(path.join(reportDir, 'incremental', 'ep-changes.json'))

  assert.strictEqual(filtered.length, 0)
  assert.strictEqual(allowlist.fullHead, false)
  assert.strictEqual(allowlist.allowlist.length, 0)
  assert.deepStrictEqual(allowlist.fallbackReasons, [])
  assert.strictEqual(epChanges.fallbacks.length, 0)
  assert.strictEqual(epChanges.epChanges.length, 1)
  assert.strictEqual(epChanges.epChanges[0].status, 'no_ep_impact')
  assert.strictEqual(epChanges.epChanges[0].rerun, false)
  assert.deepStrictEqual(epChanges.epChanges[0].rangeOld, [50, 50])
  assert.deepStrictEqual(epChanges.epChanges[0].rangeNew, [70, 70])
  assert.strictEqual(epChanges.epChanges[0].reasons.includes('db_fact_gap: src/lib/shared.ts:50-50 (new src/lib/shared.ts:70-70)'), true)
  assert.strictEqual(epChanges.epChanges[0].reasons.includes('no_db_ep_impact'), true)
}

function testUnownedNodeImpactFactProducesNoEpImpact(): void {
  const root = makeTempDir('cia-unowned-node-impact')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  const entryPoints = [makeEntryPoint('src/api.ts', 'handler', 10, 20)]
  fs.writeFileSync(diffFile, [
    '--- a/src/lib/shared.ts',
    '+++ b/src/lib/shared.ts',
    '@@ -50,1 +70,1 @@',
    '-oldValue()',
    '+newValue()',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  const db = new Database(dbPath)
  try {
    db.prepare('INSERT INTO nodes (id, file, line) VALUES (?, ?, ?)').run(10, 'src/lib/shared.ts', 50)
    db.prepare('INSERT INTO edges (ep_id, from_node_id, to_node_id) VALUES (?, ?, ?)').run(null, 10, 10)
  } finally {
    db.close()
  }
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const allowlist = readJson<{ fullHead: boolean; allowlist: unknown[]; fallbackReasons: string[] }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))
  const epChanges = readJson<{ epChanges: Array<{ status: string; rangeOld: [number, number] | null; rangeNew: [number, number] | null }>; fallbacks: Array<{ reason: string }> }>(path.join(reportDir, 'incremental', 'ep-changes.json'))

  assert.strictEqual(filtered.length, 0)
  assert.strictEqual(allowlist.fullHead, false)
  assert.strictEqual(allowlist.allowlist.length, 0)
  assert.deepStrictEqual(allowlist.fallbackReasons, [])
  assert.strictEqual(epChanges.fallbacks.length, 0)
  assert.strictEqual(epChanges.epChanges.length, 1)
  assert.strictEqual(epChanges.epChanges[0].status, 'no_ep_impact')
  assert.deepStrictEqual(epChanges.epChanges[0].rangeOld, [50, 50])
  assert.deepStrictEqual(epChanges.epChanges[0].rangeNew, [70, 70])
}

function testEpOnlyUnownedImpactFactProducesNoEpImpact(): void {
  const root = makeTempDir('cia-unowned-ep-only')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  fs.writeFileSync(diffFile, [
    '--- a/src/lib/shared.ts',
    '+++ b/src/lib/shared.ts',
    '@@ -50,1 +70,1 @@',
    '-oldValue()',
    '+newValue()',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  const db = new Database(dbPath)
  try {
    db.prepare('INSERT INTO callgraph (ep_id, call_site_file, call_site_line, caller_qid, callee_qid, callee_dotted_path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(null, 'src/lib/shared.ts', 50, '', '', '')
  } finally {
    db.close()
  }
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)

  const filtered = applyIncrementalEntrypointAllowlist([makeEntryPoint('src/api.ts', 'handler', 10, 20)], { cacheDir, diffFile, mode: 'ep-only' }, sourcePath, reportDir)
  const allowlist = readJson<{ fallbackReasons: string[] }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))
  const epChanges = readJson<{ epChanges: Array<{ status: string; rangeOld: [number, number] | null; rangeNew: [number, number] | null }>; fallbacks: Array<{ reason: string }> }>(path.join(reportDir, 'incremental', 'ep-changes.json'))

  assert.strictEqual(filtered.length, 0)
  assert.deepStrictEqual(allowlist.fallbackReasons, [])
  assert.strictEqual(epChanges.fallbacks.length, 0)
  assert.strictEqual(epChanges.epChanges[0].status, 'no_ep_impact')
  assert.deepStrictEqual(epChanges.epChanges[0].rangeOld, [50, 50])
  assert.deepStrictEqual(epChanges.epChanges[0].rangeNew, [70, 70])
}
function testDeletedRangeSelectsImpactedCallers(): void {
  const root = makeTempDir('cia-deleted-impact')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  const entryPoints = [
    makeEntryPoint('src/routes/a.ts', 'handlerA', 10, 20),
    makeEntryPoint('src/routes/b.ts', 'handlerB', 30, 40),
  ]
  fs.writeFileSync(diffFile, [
    '--- a/src/lib/shared.ts',
    '+++ b/src/lib/shared.ts',
    '@@ -50,1 +50,0 @@',
    '-oldSharedValue()',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  const db = new Database(dbPath)
  try {
    const insertEp = db.prepare('INSERT INTO entrypoints (id, ep_id, file, func_name, start_line, end_line, ep_type, framework, attribute) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insertEp.run(1, 'ep-a', 'src/routes/a.ts', 'handlerA', 10, 20, 'http', 'express', 'GET')
    insertEp.run(2, 'ep-b', 'src/routes/b.ts', 'handlerB', 30, 40, 'http', 'express', 'GET')
    db.prepare('INSERT INTO callgraph (ep_id, call_site_file, call_site_line, caller_qid, callee_qid, callee_dotted_path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(1, 'src/lib/shared.ts', 50, 'routes.a', 'lib.shared', 'shared')
    db.prepare('INSERT INTO nodes (id, file, line) VALUES (?, ?, ?)').run(10, 'src/lib/shared.ts', 50)
    db.prepare('INSERT INTO nodes (id, file, line) VALUES (?, ?, ?)').run(11, 'src/routes/b.ts', 35)
    db.prepare('INSERT INTO edges (ep_id, from_node_id, to_node_id) VALUES (?, ?, ?)').run(2, 10, 11)
  } finally {
    db.close()
  }
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, diffFile, mode: 'ep-only' }, sourcePath, reportDir)
  const allowlist = readJson<{ fullHead: boolean; allowlist: Array<{ functionName: string }>; reasonsByEpKey: Record<string, string[]> }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))
  const epChanges = readJson<{ epChanges: Array<{ status: string; rerun: boolean; reasons: string[] }> }>(path.join(reportDir, 'incremental', 'ep-changes.json'))

  assert.deepStrictEqual(filtered.map((ep) => ep.functionName).sort(), ['handlerA', 'handlerB'])
  assert.strictEqual(allowlist.fullHead, true)
  assert.deepStrictEqual(allowlist.allowlist.map((ep) => ep.functionName).sort(), ['handlerA', 'handlerB'])
  assert.strictEqual(epChanges.epChanges.every((change) => change.status === 'modified' && change.rerun === true), true)
  assert.strictEqual(Object.values(allowlist.reasonsByEpKey).some((reasons) => reasons.some((reason) => reason.includes('call_site: src/lib/shared.ts:50-50'))), true)
  assert.strictEqual(Object.values(allowlist.reasonsByEpKey).some((reasons) => reasons.some((reason) => reason.includes('edges_one_hop: src/lib/shared.ts:50-50'))), true)
}

function testReplacementRangeUsesOldCoordinatesForDbImpact(): void {
  const root = makeTempDir('cia-replacement-old-impact')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  const entryPoints = [
    makeEntryPoint('src/routes/a.ts', 'handlerA', 10, 20),
    makeEntryPoint('src/routes/b.ts', 'handlerB', 30, 40),
  ]
  fs.writeFileSync(diffFile, [
    '--- a/src/lib/shared.ts',
    '+++ b/src/lib/shared.ts',
    '@@ -50,2 +70,2 @@',
    '-oldSharedValue()',
    '-oldFlowValue()',
    '+newSharedValue()',
    '+newFlowValue()',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  const db = new Database(dbPath)
  try {
    const insertEp = db.prepare('INSERT INTO entrypoints (id, ep_id, file, func_name, start_line, end_line, ep_type, framework, attribute) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insertEp.run(1, 'ep-a', 'src/routes/a.ts', 'handlerA', 10, 20, 'http', 'express', 'GET')
    insertEp.run(2, 'ep-b', 'src/routes/b.ts', 'handlerB', 30, 40, 'http', 'express', 'GET')
    db.prepare('INSERT INTO callgraph (ep_id, call_site_file, call_site_line, caller_qid, callee_qid, callee_dotted_path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(1, 'src/lib/shared.ts', 50, 'routes.a', 'lib.shared', 'shared')
    db.prepare('INSERT INTO nodes (id, file, line) VALUES (?, ?, ?)').run(20, 'src/lib/shared.ts', 51)
    db.prepare('INSERT INTO nodes (id, file, line) VALUES (?, ?, ?)').run(21, 'src/routes/b.ts', 35)
    db.prepare('INSERT INTO edges (ep_id, from_node_id, to_node_id) VALUES (?, ?, ?)').run(2, 20, 21)
  } finally {
    db.close()
  }
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, diffFile, mode: 'ep-only' }, sourcePath, reportDir)
  const allowlist = readJson<{ allowlist: Array<{ functionName: string }>; reasonsByEpKey: Record<string, string[]> }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))
  const epChanges = readJson<{ epChanges: Array<{ status: string; rangeOld: [number, number] | null; rangeNew: [number, number] | null; reasons: string[] }> }>(path.join(reportDir, 'incremental', 'ep-changes.json'))
  const reasons = Object.values(allowlist.reasonsByEpKey).flat()

  assert.deepStrictEqual(filtered.map((ep) => ep.functionName).sort(), ['handlerA', 'handlerB'])
  assert.deepStrictEqual(allowlist.allowlist.map((ep) => ep.functionName).sort(), ['handlerA', 'handlerB'])
  assert.strictEqual(reasons.some((reason) => reason.includes('call_site: src/lib/shared.ts:50-51 (new src/lib/shared.ts:70-71)')), true)
  assert.strictEqual(reasons.some((reason) => reason.includes('edges_one_hop: src/lib/shared.ts:50-51 (new src/lib/shared.ts:70-71)')), true)
  assert.strictEqual(epChanges.epChanges.every((change) => change.status === 'modified'), true)
}

function testCoordinateDriftEntrypointStaysModifiedOnly(): void {
  const root = makeTempDir('cia-coordinate-drift')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const entryPoints = [makeEntryPoint('src/api.ts', 'handler', 12, 24)]
  fs.writeFileSync(diffFile, [
    '--- a/src/api.ts',
    '+++ b/src/api.ts',
    '@@ -10,1 +12,1 @@',
    '-export function handler() {',
    '+export function handler() {',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(path.join(baseReportDir, 'dataflow.db'))
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)
  writeJson(path.join(baseReportDir, 'incremental', 'entrypoints.json'), { schemaVersion: 1, entryPoints: [{ epKey: epKey('src/api.ts', 'handler', 10, 20), epId: 'ep-api', filePath: 'src/api.ts', functionName: 'handler', type: 'http', attribute: 'GET', funcLocStart: 10, funcLocEnd: 20 }] })

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const epChanges = readJson<{ epChanges: Array<{ status: string; rerun: boolean; reasons: string[] }> }>(path.join(reportDir, 'incremental', 'ep-changes.json'))

  assert.strictEqual(filtered.length, 1)
  const identityChanges = epChanges.epChanges.filter((change) => change.reasons.includes('head_entrypoint_identity_changed'))
  assert.strictEqual(identityChanges.length, 1)
  assert.strictEqual(identityChanges[0].status, 'modified')
  assert.strictEqual(identityChanges[0].rerun, true)
  assert.strictEqual(epChanges.epChanges.some((change) => change.status === 'deleted'), false)
  assert.strictEqual(epChanges.epChanges.some((change) => change.status === 'added'), false)
}

function testNewEntrypointTouchingAddedRangeStaysAdded(): void {
  const root = makeTempDir('cia-new-ep-added')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const entryPoints = [makeEntryPoint('src/new_api.ts', 'createdHandler', 1, 3)]
  fs.writeFileSync(diffFile, [
    '--- /dev/null',
    '+++ b/src/new_api.ts',
    '@@ -0,0 +1,3 @@',
    '+export function createdHandler() {',
    '+  return true',
    '+}',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(path.join(baseReportDir, 'dataflow.db'))
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const epChanges = readJson<{ epChanges: Array<{ status: string; rerun: boolean; reasons: string[] }> }>(path.join(reportDir, 'incremental', 'ep-changes.json'))
  const addedChange = epChanges.epChanges.find((change) => change.status === 'added')

  assert.strictEqual(filtered.length, 1)
  assert.notStrictEqual(addedChange, undefined)
  assert.strictEqual(addedChange?.rerun, true)
  assert.strictEqual(addedChange?.reasons.includes('head_entrypoint_compare'), true)
}

function testDeletedEntrypointBodyStaysNonRerunDeleted(): void {
  const root = makeTempDir('cia-deleted-ep-body')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  fs.writeFileSync(diffFile, [
    '--- a/src/api.ts',
    '+++ b/src/api.ts',
    '@@ -12,1 +12,0 @@',
    '-oldHandlerLine()',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  const db = new Database(dbPath)
  try {
    db.prepare('INSERT INTO entrypoints (id, ep_id, file, func_name, start_line, end_line, ep_type, framework, attribute) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(1, 'ep-api', 'src/api.ts', 'handler', 10, 20, 'http', 'express', 'GET')
  } finally {
    db.close()
  }
  writeJson(path.join(baseReportDir, 'incremental', 'entrypoints.json'), { schemaVersion: 1, entryPoints: [{ epKey: epKey('src/api.ts', 'handler', 10, 20), epId: 'ep-api', filePath: 'src/api.ts', functionName: 'handler', type: 'http', attribute: 'GET', funcLocStart: 10, funcLocEnd: 20 }] })
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)

  const filtered = applyIncrementalEntrypointAllowlist([], { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const allowlist = readJson<{ allowlist: unknown[] }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))
  const epChanges = readJson<{ epChanges: Array<{ status: string; rerun: boolean; reasons: string[] }> }>(path.join(reportDir, 'incremental', 'ep-changes.json'))

  assert.strictEqual(filtered.length, 0)
  assert.strictEqual(allowlist.allowlist.length, 0)
  assert.strictEqual(epChanges.epChanges.some((change) => change.status === 'deleted' && change.rerun === false && change.reasons.includes('deleted_base_coordinate: src/api.ts:12-12')), true)
}

function testPythonClassBridgeSelectsImpactedEntrypoints(): void {
  const root = makeTempDir('cia-python-class-bridge')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  const entryPoints = [
    makeEntryPoint('web/main.py', 'chat', 10, 20),
    makeEntryPoint('web/main.py', 'chat_with_image', 30, 40),
    makeEntryPoint('web/main.py', 'websocket_endpoint', 50, 60),
    makeEntryPoint('web/main.py', 'get_config', 70, 80),
  ]
  fs.writeFileSync(diffFile, [
    '--- a/agent/graph.py',
    '+++ b/agent/graph.py',
    '@@ -58,1 +58,1 @@',
    '-oldValue()',
    '+newValue()',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  const db = new Database(dbPath)
  try {
    db.prepare('INSERT INTO symbols (symbol_id, qid, sid, vtype, file, start_line, end_line, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sym1', '<global>./agent/graph.ClinicAgent', 'ClinicAgent', 'class', 'agent/graph.py', 57, 1110, 'fixture')
    const insertEp = db.prepare('INSERT INTO entrypoints (id, ep_id, file, func_name, start_line, end_line, ep_type, framework, attribute) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insertEp.run(1, 'ep-chat', 'web/main.py', 'chat', 10, 20, 'http', 'fastapi', 'GET')
    insertEp.run(2, 'ep-image', 'web/main.py', 'chat_with_image', 30, 40, 'http', 'fastapi', 'GET')
    insertEp.run(3, 'ep-ws', 'web/main.py', 'websocket_endpoint', 50, 60, 'http', 'fastapi', 'GET')
    insertEp.run(4, 'ep-config', 'web/main.py', 'get_config', 70, 80, 'http', 'fastapi', 'GET')
    const insertCg = db.prepare('INSERT INTO callgraph (ep_id, call_site_file, call_site_line, caller_qid, callee_qid, callee_dotted_path) VALUES (?, ?, ?, ?, ?, ?)')
    insertCg.run(1, 'web/main.py', 12, '<global>./web.main.chat', '<global>./agent/graph.ClinicAgent.chat', 'agent.ClinicAgent.chat')
    insertCg.run(2, 'web/main.py', 32, '<global>./web.main.chat_with_image', '<global>./agent/graph.ClinicAgent.chat_with_image', 'agent.ClinicAgent.chat_with_image')
    insertCg.run(3, 'web/main.py', 52, '<global>./agent/graph.ClinicAgent.stream', '<global>./web.main.websocket_endpoint', 'stream')
    insertCg.run(4, 'web/main.py', 72, '<global>./web.main.get_config', '<global>./config.get_config', 'get_config')
  } finally {
    db.close()
  }
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const allowlist = readJson<{ fullHead: boolean; allowlist: Array<{ functionName: string }>; reasonsByEpKey: Record<string, string[]> }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))

  assert.deepStrictEqual(filtered.map((ep) => ep.functionName).sort(), ['chat', 'chat_with_image', 'websocket_endpoint'])
  assert.strictEqual(allowlist.fullHead, false)
  assert.deepStrictEqual(allowlist.allowlist.map((ep) => ep.functionName).sort(), ['chat', 'chat_with_image', 'websocket_endpoint'])
  assert.strictEqual(allowlist.allowlist.some((ep) => ep.functionName === 'get_config'), false)
  assert.strictEqual(Object.values(allowlist.reasonsByEpKey).some((reasons) => reasons.some((reason) => reason.includes('python_class_callgraph_bridge:ClinicAgent'))), true)
}

function testPythonClassBridgeSkipsWeakNames(): void {
  const root = makeTempDir('cia-python-class-weak')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  const entryPoints = [makeEntryPoint('web/main.py', 'one', 1, 4), makeEntryPoint('web/main.py', 'two', 5, 8)]
  fs.writeFileSync(diffFile, [
    '--- a/model.py',
    '+++ b/model.py',
    '@@ -10,1 +10,1 @@',
    '-oldValue()',
    '+newValue()',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  const db = new Database(dbPath)
  try {
    db.prepare('INSERT INTO symbols (symbol_id, qid, sid, vtype, file, start_line, end_line, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sym1', '<global>./model.get', 'get', 'class', 'model.py', 10, 20, 'fixture')
    db.prepare('INSERT INTO entrypoints (id, ep_id, file, func_name, start_line, end_line, ep_type, framework, attribute) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(1, 'ep-one', 'web/main.py', 'one', 1, 4, 'http', 'fastapi', 'GET')
    db.prepare('INSERT INTO entrypoints (id, ep_id, file, func_name, start_line, end_line, ep_type, framework, attribute) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(2, 'ep-two', 'web/main.py', 'two', 5, 8, 'http', 'fastapi', 'GET')
    db.prepare('INSERT INTO callgraph (ep_id, call_site_file, call_site_line, caller_qid, callee_qid, callee_dotted_path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(1, 'web/main.py', 2, '<global>./web.one', '<global>./model.get', 'get')
    db.prepare('INSERT INTO callgraph (ep_id, call_site_file, call_site_line, caller_qid, callee_qid, callee_dotted_path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(2, 'web/main.py', 6, '<global>./web.two', '<global>./model.get', 'get')
  } finally {
    db.close()
  }
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)

  const filtered = applyIncrementalEntrypointAllowlist(entryPoints, { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const allowlist = readJson<{ fullHead: boolean; allowlist: unknown[] }>(path.join(reportDir, 'incremental', 'entrypoint-allowlist.json'))

  assert.strictEqual(filtered.length, 0)
  assert.strictEqual(allowlist.fullHead, false)
  assert.strictEqual(allowlist.allowlist.length, 0)
}

function testKeptBaseSarifLocationsRemapToHeadCoordinates(): void {
  const root = makeTempDir('cia-location-remap')
  const sourcePath = root
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  const baseEpKey = epKey('src/api.ts', 'handler', 10, 20)
  const baseSourcePath = path.join(baseReportDir, '..', 'base')
  const baseArtifactUri = path.join(baseSourcePath, 'src', 'api.ts')
  const headArtifactUri = path.join(reportDir, '..', 'src', 'api.ts')
  const baseSarif = findingSarif('base-rule', baseEpKey, baseArtifactUri)
  fs.writeFileSync(diffFile, [
    '--- a/src/api.ts',
    '+++ b/src/api.ts',
    '@@ -5,0 +5,2 @@',
    '+const insertedOne = 1',
    '+const insertedTwo = 2',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  writeJson(path.join(baseReportDir, 'report.sarif'), baseSarif)
  writeJson(path.join(baseReportDir, 'incremental', 'entrypoints.json'), { schemaVersion: 1, entryPoints: [] })
  writeJson(path.join(baseReportDir, 'incremental', 'findings-index.json'), { schemaVersion: 1, findings: [{ ruleId: 'stale-rule' }] })
  writeJson(path.join(cacheDir, 'incremental-index.json'), {
    schemaVersion: 1,
    project: path.basename(sourcePath),
    latestBase: 'base',
    runs: {
      base: {
        runId: 'base',
        kind: 'base',
        commit: 'base',
        sourcePath: baseSourcePath,
        reportDir: 'base-report',
        dataflowDb: 'base-report/dataflow.db',
        sarif: 'base-report/report.sarif',
        findingIndex: 'base-report/incremental/findings-index.json',
        entrypoints: 'base-report/incremental/entrypoints.json',
        scanSummary: 'base-report/scan_summary.json',
        createdAt: new Date(0).toISOString(),
      },
    },
    updatedAt: new Date(0).toISOString(),
  })

  applyIncrementalEntrypointAllowlist([makeEntryPoint('src/api.ts', 'handler', 10, 20)], { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  completeIncrementalRun({ cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const publicReport = readJson<SmokeSarifLog>(path.join(reportDir, 'report.sarif'))
  const result = publicReport.runs[0].results[0]
  const primaryLocation = result.locations?.[0] as { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number; endLine?: number } } } | undefined
  const firstCodeFlow = result.codeFlows?.[0] as { threadFlows?: Array<{ locations?: Array<{ location?: { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number; endLine?: number } } } }> }> } | undefined
  const sourcePhysicalLocation = firstCodeFlow?.threadFlows?.[0]?.locations?.[0]?.location?.physicalLocation

  assert.strictEqual(primaryLocation?.physicalLocation?.artifactLocation?.uri, headArtifactUri)
  assert.strictEqual(sourcePhysicalLocation?.artifactLocation?.uri, headArtifactUri)
  assert.strictEqual(primaryLocation?.physicalLocation?.region?.startLine, 14)
  assert.strictEqual(primaryLocation?.physicalLocation?.region?.endLine, 14)
  assert.strictEqual(sourcePhysicalLocation?.region?.startLine, 13)
  assert.strictEqual(sourcePhysicalLocation?.region?.endLine, 13)
}

function testDbFactGapDoesNotPublishBaseOnlyMerge(): void {
  const root = makeTempDir('cia-no-impact-merge')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  const dbPath = path.join(baseReportDir, 'dataflow.db')
  const baseEpKey = epKey('src/api.ts', 'handler', 10, 20)
  const baseSarif = findingSarif('base-rule', baseEpKey)
  fs.writeFileSync(diffFile, [
    '--- a/src/util.ts',
    '+++ b/src/util.ts',
    '@@ -3,1 +3,1 @@',
    '-oldValue()',
    '+newValue()',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(dbPath)
  writeJson(path.join(baseReportDir, 'report.sarif'), baseSarif)
  writeJson(path.join(baseReportDir, 'incremental', 'entrypoints.json'), { schemaVersion: 1, entryPoints: [] })
  writeJson(path.join(baseReportDir, 'incremental', 'findings-index.json'), { schemaVersion: 1, findings: [{ ruleId: 'stale-rule' }] })
  writeJson(path.join(cacheDir, 'incremental-index.json'), {
    schemaVersion: 1,
    project: path.basename(sourcePath),
    latestBase: 'base',
    runs: {
      base: {
        runId: 'base',
        kind: 'base',
        commit: 'base',
        sourcePath,
        reportDir: 'base-report',
        dataflowDb: 'base-report/dataflow.db',
        sarif: 'base-report/report.sarif',
        findingIndex: 'base-report/incremental/findings-index.json',
        entrypoints: 'base-report/incremental/entrypoints.json',
        scanSummary: 'base-report/scan_summary.json',
        createdAt: new Date(0).toISOString(),
      },
    },
    updatedAt: new Date(0).toISOString(),
  })

  applyIncrementalEntrypointAllowlist([makeEntryPoint('src/api.ts', 'handler', 10, 20)], { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  completeIncrementalRun({ cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const publicReport = readJson<typeof baseSarif>(path.join(reportDir, 'report.sarif'))
  const merged = readJson<typeof baseSarif>(path.join(reportDir, 'incremental', 'merged-report.sarif'))
  assert.deepStrictEqual(publicReport, merged)
  assert.strictEqual(merged.runs[0].results.length, 1)
  assert.strictEqual(merged.runs[0].results[0].ruleId, 'base-rule')
}

function writeBaseIncrementalIndex(cacheDir: string, sourcePath: string, baseReportDir: string): void {
  writeJson(path.join(baseReportDir, 'report.sarif'), findingSarif('base-rule', epKey('src/api.ts', 'handler', 10, 20)))
  writeJson(path.join(baseReportDir, 'incremental', 'entrypoints.json'), { schemaVersion: 1, entryPoints: [] })
  writeJson(path.join(cacheDir, 'incremental-index.json'), {
    schemaVersion: 1,
    project: path.basename(sourcePath),
    latestBase: 'base',
    runs: {
      base: {
        runId: 'base',
        kind: 'base',
        commit: 'base',
        sourcePath,
        reportDir: 'base-report',
        dataflowDb: 'base-report/dataflow.db',
        sarif: 'base-report/report.sarif',
        findingIndex: 'base-report/incremental/findings-index.json',
        entrypoints: 'base-report/incremental/entrypoints.json',
        scanSummary: 'base-report/scan_summary.json',
        createdAt: new Date(0).toISOString(),
      },
    },
    updatedAt: new Date(0).toISOString(),
  })
}

function testConsumerFastPathSkipsDbFactGapEmptySelection(): void {
  const root = makeTempDir('cia-consumer-added')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const diffFile = path.join(root, 'change.diff')
  fs.writeFileSync(diffFile, [
    '--- /dev/null',
    '+++ b/src/new_api.ts',
    '@@ -0,0 +1,3 @@',
    '+export function handler() {',
    '+  return true',
    '+}',
    '',
  ].join('\n'))
  writeEmptyDataflowDb(path.join(baseReportDir, 'dataflow.db'))
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)

  const result = tryCompleteIncrementalConsumerRun({ cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const publicReport = readJson<SmokeSarifLog>(path.join(reportDir, 'report.sarif'))
  const epChanges = readJson<{ epChanges: Array<{ status: string; reasons: string[] }> }>(path.join(reportDir, 'incremental', 'ep-changes.json'))

  assert.strictEqual(result.completed, true)
  assert.strictEqual(result.finalFindings, 1)
  assert.strictEqual(publicReport.runs[0].results.length, 1)
  assert.strictEqual(epChanges.epChanges[0].status, 'no_ep_impact')
  assert.strictEqual(epChanges.epChanges[0].reasons.includes('no_db_ep_impact'), true)
}

function testConsumerFastPathSkipsImpactAddedChange(): void {
  const root = makeTempDir('cia-consumer-impact-added')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const baseReportDir = path.join(cacheDir, 'base-report')
  const impactFile = path.join(root, 'impact.json')
  writeEmptyDataflowDb(path.join(baseReportDir, 'dataflow.db'))
  writeBaseIncrementalIndex(cacheDir, sourcePath, baseReportDir)
  writeJson(impactFile, {
    schemaVersion: 1,
    epChanges: [{
      status: 'added',
      epKey: 'src/new.ts|handler|http|1|4|GET',
      rerun: false,
      reasons: ['fixture_added'],
      fallbackLevel: 'L0',
    }],
  })

  const result = tryCompleteIncrementalConsumerRun({ cacheDir, impactEntrypointFile: impactFile, mode: 'auto' }, sourcePath, reportDir)

  assert.strictEqual(result.completed, false)
  assert.strictEqual(fs.existsSync(path.join(reportDir, 'report.sarif')), false)
}

function testFullFallbackMergedSarifUsesHeadReport(): void {
  const root = makeTempDir('cia-full-fallback-merge')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const diffFile = path.join(root, 'change.diff')
  const headSarif = { version: '2.1.0', runs: [{ results: [{ ruleId: 'head-rule' }] }] }
  fs.writeFileSync(diffFile, '')
  writeJson(path.join(reportDir, 'report.sarif'), headSarif)

  applyIncrementalEntrypointAllowlist([makeEntryPoint('a.ts', 'one', 1, 4)], { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  completeIncrementalRun({ cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const publicReport = readJson<typeof headSarif>(path.join(reportDir, 'report.sarif'))
  const merged = readJson<typeof headSarif>(path.join(reportDir, 'incremental', 'merged-report.sarif'))

  assert.deepStrictEqual(merged, headSarif)
  assert.deepStrictEqual(publicReport, headSarif)
}

function testCallchainJsonPlaceholderIsNotPublishedAsSarif(): void {
  const root = makeTempDir('cia-callchain-placeholder')
  const sourcePath = path.join(root, 'src')
  const reportDir = path.join(root, 'report')
  const cacheDir = path.join(root, 'cache')
  const diffFile = path.join(root, 'change.diff')
  const placeholder = { reservedFor: 'incremental-merge' }
  fs.writeFileSync(diffFile, '')
  writeJson(path.join(reportDir, 'callchain-report.json'), { findings: [{ id: 'head-finding' }] })

  applyIncrementalEntrypointAllowlist([makeEntryPoint('a.ts', 'one', 1, 4)], { cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  completeIncrementalRun({ cacheDir, diffFile, mode: 'auto' }, sourcePath, reportDir)
  const publicReport = fs.existsSync(path.join(reportDir, 'report.sarif')) ? readJson<unknown>(path.join(reportDir, 'report.sarif')) : null
  const merged = readJson<typeof placeholder>(path.join(reportDir, 'incremental', 'merged-report.sarif'))
  const auditLog = fs.readFileSync(path.join(reportDir, 'incremental', 'audit-log.jsonl'), 'utf8')

  assert.deepStrictEqual(merged, placeholder)
  assert.strictEqual(publicReport, null)
  assert.match(auditLog, /full_head_merged_sarif_missing_or_invalid/)
  assert.match(auditLog, /public_report_sarif_missing_or_invalid/)
}

function testMultilineReplacementDiff(): void {
  const root = makeTempDir('cia-diff')
  const diffFile = path.join(root, 'change.diff')
  fs.writeFileSync(diffFile, [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,3 +10,3 @@',
    '-oldOne()',
    '-oldTwo()',
    '+newOne()',
    '+newTwo()',
    ' context()',
    '',
  ].join('\n'))

  const ranges = parseUnifiedDiff(diffFile)
  assert.deepStrictEqual(ranges, [{ file: 'src/a.ts', startLine: 10, endLine: 11, kind: 'modified', oldStartLine: 10, oldEndLine: 11 }])
}

function main(): void {
  testImpactFileFullHeadReturnsAllEntrypoints()
  testFallbackFullHeadReturnsAllEntrypoints()
  testPlanInputRunIdStaleness()
  testMalformedImpactFileFailFast()
  testMalformedEpChangeFailFast()
  testMinimalEpChangePasses()
  testAbsoluteRootRemapKeepsLeadingSlashAndSuffix()
  testMergedSarifOutputUsesCompactJson()
  testDbFactGapEmptySelectionDoesNotFullFallback()
  testUnownedImpactFactProducesNoEpImpact()
  testUnownedNodeImpactFactProducesNoEpImpact()
  testEpOnlyUnownedImpactFactProducesNoEpImpact()
  testDeletedRangeSelectsImpactedCallers()
  testReplacementRangeUsesOldCoordinatesForDbImpact()
  testCoordinateDriftEntrypointStaysModifiedOnly()
  testNewEntrypointTouchingAddedRangeStaysAdded()
  testDeletedEntrypointBodyStaysNonRerunDeleted()
  testPythonClassBridgeSelectsImpactedEntrypoints()
  testPythonClassBridgeSkipsWeakNames()
  testKeptBaseSarifLocationsRemapToHeadCoordinates()
  testDbFactGapDoesNotPublishBaseOnlyMerge()
  testConsumerFastPathSkipsDbFactGapEmptySelection()
  testConsumerFastPathSkipsImpactAddedChange()
  testFullFallbackMergedSarifUsesHeadReport()
  testCallchainJsonPlaceholderIsNotPublishedAsSarif()
  testMultilineReplacementDiff()
  console.log('incremental-manager smoke passed')
}

main()
