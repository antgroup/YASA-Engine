import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { before, describe, it } from 'mocha'

const { execute } = require('../../src/interface/starter')
const { ErrorCode } = require('../../src/util/error-code')
const { recordFindingStr } = require('../test-utils')
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')

interface SarifReport {
  runs?: SarifRun[]
}

interface SarifRun {
  results?: SarifResult[]
}

interface SarifResult {
  message?: { text?: string }
  codeFlows?: SarifCodeFlow[]
  callstack?: SarifCallstackElement[]
  [key: string]: unknown
}

interface SarifCallstackElement {
  type?: number
  nodeHash?: string
  [key: string]: unknown
}

interface AstCacheListEntry {
  path: string
  jsonFile: string
  crc: string
  time?: string
}

interface SarifCodeFlow {
  threadFlows?: SarifThreadFlow[]
}

interface SarifThreadFlow {
  locations?: SarifThreadFlowLocation[]
}

interface SarifThreadFlowLocation {
  location?: SarifLocation
}

interface SarifLocation {
  message?: { text?: string }
  physicalLocation?: SarifPhysicalLocation
}

interface SarifPhysicalLocation {
  artifactLocation?: { uri?: string }
  region?: SarifRegion
  nodeHash?: string
}

interface SarifRegion {
  startLine?: number
  startColumn?: number
  endLine?: number
  endColumn?: number
  snippet?: {
    text?: string
    affectedNodeName?: string
  }
}

interface QualityIssue {
  kind:
    | 'sameAstNodeHashForCallArgPass'
    | 'boundaryTypeMismatch'
    | 'missingNodeHash'
    | 'methodNotInCallstack'
    | 'pointEdgeCountMismatch'
  message: string
}

const BENCHMARK_DIR = path.join(__dirname, 'benchmarks', 'sast-java')
const RULE_CONFIG_FILE = path.join(__dirname, 'rule_config_xast_java.json')
const REPORT_DIR = path.join(__dirname, 'report-sarif-codeflow-quality')
const SARIF_PATH = path.join(REPORT_DIR, 'report.sarif')
const INTERMEDIATE_DIR = path.join(__dirname, 'intermediate-sarif-codeflow-quality')
const AST_CACHE_LIST = path.join(INTERMEDIATE_DIR, 'ast-cache-list.json')
const AST_CACHE_SUBDIR = path.join(INTERMEDIATE_DIR, 'astcache')

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function getNodeHash(location: SarifThreadFlowLocation): string | undefined {
  const value = location.location?.physicalLocation?.nodeHash
  return isNonEmptyString(value) ? value : undefined
}

function hasPhysicalRegion(location: SarifThreadFlowLocation): boolean {
  const region = location.location?.physicalLocation?.region
  const startLine = region?.startLine ?? 0
  return startLine > 0
}

function getSnippetText(location: SarifThreadFlowLocation): string {
  return location.location?.physicalLocation?.region?.snippet?.text ?? ''
}

function getTraceKind(location: SarifThreadFlowLocation): string {
  const text = getSnippetText(location)
  if (text.includes('ARG PASS')) return 'ARG PASS'
  if (text.includes('CALL RETURN')) return 'CALL RETURN'
  if (text.includes('Return Value')) return 'Return Value'
  if (text.includes('Var Pass')) return 'Var Pass'
  if (text.includes('CALL')) return 'CALL'
  if (text.includes('SINK')) return 'SINK'
  if (text.includes('SOURCE')) return 'SOURCE'
  return ''
}

function formatLocation(location: SarifThreadFlowLocation, index: number): string {
  const physicalLocation = location.location?.physicalLocation
  const region = physicalLocation?.region
  const uri = physicalLocation?.artifactLocation?.uri ?? '<missing-uri>'
  const line = region?.startLine ?? '<missing-line>'
  const nodeHash = physicalLocation?.nodeHash ?? '<missing-nodeHash>'
  const snippet = region?.snippet?.text ?? '<missing-snippet>'
  return `location=${index}, uri=${uri}, line=${line}, nodeHash=${nodeHash}, snippet=${JSON.stringify(snippet)}`
}

function formatContext(
  resultIndex: number,
  codeFlowIndex: number,
  threadFlowIndex: number,
  result: SarifResult
): string {
  const rule = result.message?.text ?? '<missing-message>'
  return `result=${resultIndex}, codeFlow=${codeFlowIndex}, threadFlow=${threadFlowIndex}, message=${JSON.stringify(rule)}`
}

function walkAstForEnclosingFn(
  node: unknown,
  currentFnHash: string | undefined,
  enclosingFnMap: Map<string, string>,
  visited: WeakSet<object>
): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walkAstForEnclosingFn(item, currentFnHash, enclosingFnMap, visited)
    return
  }
  if (visited.has(node as object)) return
  visited.add(node as object)

  const record = node as Record<string, unknown>
  const meta = record._meta as { nodehash?: string } | undefined
  const nodehash = meta?.nodehash
  const nodeType = record.type
  let fnHashForChildren = currentFnHash
  if (nodeType === 'FunctionDefinition' && typeof nodehash === 'string' && nodehash.length > 0) {
    fnHashForChildren = nodehash
  }
  if (typeof nodehash === 'string' && nodehash.length > 0 && currentFnHash && !enclosingFnMap.has(nodehash)) {
    enclosingFnMap.set(nodehash, currentFnHash)
  }
  for (const key of Object.keys(record)) {
    if (key === 'parent' || key === '_meta') continue
    walkAstForEnclosingFn(record[key], fnHashForChildren, enclosingFnMap, visited)
  }
}

function buildEnclosingFnMap(cacheListPath: string, cacheSubDir: string): Map<string, string> {
  const enclosingFnMap = new Map<string, string>()
  if (!fs.existsSync(cacheListPath)) return enclosingFnMap
  const listContent = fs.readFileSync(cacheListPath, 'utf-8')
  const entries = JSON.parse(listContent) as AstCacheListEntry[]
  const visited = new WeakSet<object>()
  for (const entry of entries) {
    const jsonPath = path.isAbsolute(entry.jsonFile)
      ? entry.jsonFile
      : path.join(path.dirname(cacheSubDir), entry.jsonFile)
    if (!fs.existsSync(jsonPath)) continue
    try {
      const ast = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
      walkAstForEnclosingFn(ast, undefined, enclosingFnMap, visited)
    } catch {
      // 单个缓存文件解析失败不阻断其他文件
    }
  }
  return enclosingFnMap
}

function collectQualityIssues(report: SarifReport, enclosingFnMap: Map<string, string>): QualityIssue[] {
  const issues: QualityIssue[] = []
  const runs = report.runs ?? []

  runs.forEach((run, runIndex) => {
    ;(run.results ?? []).forEach((result, resultIndex) => {
      ;(result.codeFlows ?? []).forEach((codeFlow, codeFlowIndex) => {
        ;(codeFlow.threadFlows ?? []).forEach((threadFlow, threadFlowIndex) => {
          const locations = threadFlow.locations ?? []
          if (locations.length === 0) return

          const context = `run=${runIndex}, ${formatContext(resultIndex, codeFlowIndex, threadFlowIndex, result)}`
          const callstackMethodHashes = new Set<string>()
          for (const element of result.callstack ?? []) {
            if (element.type === 0 && isNonEmptyString(element.nodeHash)) callstackMethodHashes.add(element.nodeHash)
          }
          if (callstackMethodHashes.size === 0) {
            issues.push({
              kind: 'methodNotInCallstack',
              message: `${context}, kind=methodNotInCallstack, reason=callstack 缺少 type=0 方法节点`,
            })
          }
          const firstType = getTraceKind(locations[0])
          const lastType = getTraceKind(locations[locations.length - 1])
          if (firstType !== 'SOURCE') {
            issues.push({
              kind: 'boundaryTypeMismatch',
              message: `${context}, kind=boundaryTypeMismatch, boundary=first, actual=${firstType || '<unknown>'}, offending={${formatLocation(locations[0], 0)}}`,
            })
          }
          if (lastType !== 'SINK') {
            issues.push({
              kind: 'boundaryTypeMismatch',
              message: `${context}, kind=boundaryTypeMismatch, boundary=last, actual=${lastType || '<unknown>'}, offending={${formatLocation(locations[locations.length - 1], locations.length - 1)}}`,
            })
          }
          locations.forEach((location, index) => {
            if (!hasPhysicalRegion(location)) return
            if (getNodeHash(location)) return
            issues.push({
              kind: 'missingNodeHash',
              message: `${context}, kind=missingNodeHash, offending={${formatLocation(location, index)}}`,
            })
          })

          let callArgPassPairs = 0
          for (let i = 0; i < locations.length - 1; i++) {
            const current = locations[i]
            const next = locations[i + 1]
            if (getTraceKind(current) !== 'CALL' || getTraceKind(next) !== 'ARG PASS') continue

            const currentNodeHash = getNodeHash(current)
            const nextNodeHash = getNodeHash(next)
            if (!currentNodeHash || !nextNodeHash) continue
            callArgPassPairs++
            if (currentNodeHash === nextNodeHash) {
              issues.push({
                kind: 'sameAstNodeHashForCallArgPass',
                message:
                  `${context}, kind=sameAstNodeHashForCallArgPass, ` +
                  `current={${formatLocation(current, i)}}, next={${formatLocation(next, i + 1)}}`,
              })
            }
          }

          if (callstackMethodHashes.size > 0) {
            const lastIndex = locations.length - 1
            for (let i = 0; i < lastIndex; i++) {
              const location = locations[i]
              const nodeHash = getNodeHash(location)
              if (!nodeHash) continue
              const enclosingFn = enclosingFnMap.get(nodeHash)
              if (!enclosingFn) continue
              if (!callstackMethodHashes.has(enclosingFn)) {
                issues.push({
                  kind: 'methodNotInCallstack',
                  message:
                    `${context}, kind=methodNotInCallstack, ` +
                    `enclosingFn=${enclosingFn}, offending={${formatLocation(location, i)}}`,
                })
              }
            }
          }

          if (callstackMethodHashes.size > 0 && callstackMethodHashes.size !== callArgPassPairs + 1) {
            issues.push({
              kind: 'pointEdgeCountMismatch',
              message:
                `${context}, kind=pointEdgeCountMismatch, ` +
                `callstackMethods=${callstackMethodHashes.size}, callArgPassPairs=${callArgPassPairs}, ` +
                `expected callstackMethods == callArgPassPairs + 1`,
            })
          }

        })
      })
    })
  })

  return issues
}

async function generateJavaBenchmarkSarif(): Promise<SarifReport> {
  fs.rmSync(REPORT_DIR, { recursive: true, force: true })
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  fs.rmSync(INTERMEDIATE_DIR, { recursive: true, force: true })
  fs.mkdirSync(INTERMEDIATE_DIR, { recursive: true })

  const recorder = recordFindingStr()
  recorder.clearResult()
  const args = [
    BENCHMARK_DIR,
    '--ruleConfigFile',
    RULE_CONFIG_FILE,
    '--analyzer',
    'SpringAnalyzer',
    '--checkerPackIds',
    'taint-flow-java-inner',
    '--report',
    REPORT_DIR,
    '--incremental',
    'force',
    '--intermediate-dir',
    INTERMEDIATE_DIR,
  ]

  try {
    await execute(null, args, recorder.printAndAppend)
  } catch (e) {
    handleException(
      e,
      `[test-sarif-codeflow-quality] Java benchmark SARIF quality test failed.ERROR: ${e}`,
      `[test-sarif-codeflow-quality] Java benchmark SARIF quality test failed.ERROR: ${e}`
    )
    recorder.clearResult()
    process.exitCode = ErrorCode.unknown_error
  }

  assert.ok(fs.existsSync(SARIF_PATH), `Java benchmark SARIF was not generated: ${SARIF_PATH}`)
  return JSON.parse(fs.readFileSync(SARIF_PATH, 'utf-8')) as SarifReport
}

describe('SARIF codeFlow quality', function () {
  this.timeout(0)

  let sarifReport: SarifReport | null = null
  let benchmarkMissingReason = ''

  before(async function () {
    if (!fs.existsSync(BENCHMARK_DIR)) {
      benchmarkMissingReason = `Java benchmark fixture missing: ${BENCHMARK_DIR}. Prepare with: npx tsx test/java/prepare-java-benchmark.ts. CI must run it before npm run test-sarif-codeflow-quality so SARIF codeFlow coverage is not zero.`
      return
    }
    sarifReport = await generateJavaBenchmarkSarif()
  })

  it('java benchmark fixture is available for SARIF quality test', function () {
    assert.strictEqual(benchmarkMissingReason, '', benchmarkMissingReason)
  })

  it('has java benchmark SARIF results generated with Java callstack-only trace strategy', function () {
    if (benchmarkMissingReason) this.skip()
    const resultCount = sarifReport?.runs?.reduce((sum, run) => sum + (run.results?.length ?? 0), 0) ?? 0
    assert.ok(resultCount > 0, `Java benchmark SARIF has no results: ${SARIF_PATH}`)
  })

  it('keeps codeFlow point/edge structure and method mapping consistent', function () {
    if (benchmarkMissingReason) this.skip()
    assert.ok(sarifReport, 'SARIF report was not loaded')
    const enclosingFnMap = buildEnclosingFnMap(AST_CACHE_LIST, AST_CACHE_SUBDIR)
    assert.ok(
      enclosingFnMap.size > 0,
      `AST cache is empty, methodNotInCallstack check has no source of truth: ${AST_CACHE_LIST}`
    )
    const issues = collectQualityIssues(sarifReport!, enclosingFnMap)
    assert.strictEqual(
      issues.length,
      0,
      issues.map((issue, index) => `${index + 1}. ${issue.message}`).join('\n')
    )
  })
})
