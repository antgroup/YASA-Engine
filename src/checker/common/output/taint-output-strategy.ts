import type { IResultManager } from '../../../engine/analyzer/common/result-manager'
import type { IConfig } from '../../../config'
import type { TaintFinding } from '../../../engine/analyzer/common/common-types'

const _ = require('lodash')
const path = require('path')
const CallgraphOutputStrategy = require('./callgraph-output-strategy')
const OutputStrategy = require('../../../engine/analyzer/common/output-strategy')
const Config = require('../../../config')
const FileUtil = require('../../../util/file-util')
const TaintFindingUtil = require('../../taint/common-kit/taint-finding-util')
const { getDedupTrace, getSarifTrace, normalizeTerminalStringValueOfTrace } = require('../../taint/common-kit/taint-trace-output')
const SourceLine = require('../../../engine/analyzer/common/source-line')
const FindingUtil = require('../../../util/finding-util')
const logger = require('../../../util/logger')(__filename)
const {
  registerDedupFunction,
} = require('../../../engine/analyzer/common/entrypoint/merge-coordinator') as typeof import('../../../engine/analyzer/common/entrypoint/merge-coordinator')

type SarifLocation = { physicalLocation?: Record<string, unknown>; [key: string]: unknown }

const {
  prepareLocation,
  prepareTrace,
  prepareResult,
  prepareSarifFormat,
  prepareCallstackElements,
} = require('../../../engine/analyzer/common/sarif')
const AstUtil = require('../../../util/ast-util')
const { handleException } = require('../../../engine/analyzer/common/exception-handler')

function isNodeEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.loc?.start?.line === b.loc?.start?.line
    && a.loc?.sourcefile === b.loc?.sourcefile
    && a._meta?.nodehash === b._meta?.nodehash
}

function getArgTrace(finding: any): any {
  // snapshot 后 argNode 已清空，返回 undefined 使 isNewFinding 走 getDedupTrace（完整 finding.trace）分支，
  // 避免使用冻结的 _snapshotArgTrace 误折叠同 source-sink 不同中间节点的变体对。
  if (finding.argNode?.taint?.getFirstTrace) return finding.argNode.taint.getFirstTrace()
  return undefined
}

type TraceLine = number | number[]

interface TraceNodeLocation {
  sourcefile?: string
  start?: { line?: number; column?: number }
  end?: { line?: number; column?: number }
}

interface TraceNodeMeta {
  nodehash?: string | number
}

interface TaintTraceItem {
  file?: string
  line?: TraceLine
  tag?: string
  str?: string
  affectedNodeName?: string
  node?: {
    loc?: TraceNodeLocation
    _meta?: TraceNodeMeta
  }
  _synthetic?: boolean
}

type TracePreserveFinding = TaintFinding & {
  trace?: TaintTraceItem[]
}

function isSameSinkAttribute(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  const sortedA = a.slice().sort()
  const sortedB = b.slice().sort()
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false
  }
  return true
}

function isSameMatchedSanitizers(a: any, b: any): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    const idsA = a.map((s: any) => s.id ?? '').sort()
    const idsB = b.map((s: any) => s.id ?? '').sort()
    for (let i = 0; i < idsA.length; i++) {
      if (idsA[i] !== idsB[i]) return false
    }
    return true
  }
  return a === b
}

/**
 * 过滤仅用于补充输出可读性的合成 trace step。
 *
 * finding 去重依赖原始 trace 形态判断链路等价性；如果合成 step 参与比较，
 * 同一条链路可能因为输出辅助节点不同而无法折叠。
 * `_synthetic` 字段不经 SARIF 序列化路径，不影响最终报告内容。
 * @param trace
 */
function filterOutSyntheticSteps(trace: TaintTraceItem[] | undefined): TaintTraceItem[] | undefined {
  if (!Array.isArray(trace)) return trace
  return trace.filter((item: TaintTraceItem) => item._synthetic !== true)
}

/**
 * 比较单个 trace item 是否相等（file、line、tag、affectedNodeName）
 */
function isTraceItemEqual(item1: TaintTraceItem | undefined, item2: TaintTraceItem | undefined): boolean {
  if (item1?.file !== item2?.file) return false
  const line1 = item1?.line
  const line2 = item2?.line
  if (Array.isArray(line1) && Array.isArray(line2)) {
    if (!_.isEqual(line1, line2)) return false
  } else if (line1 !== line2) {
    return false
  }
  if (item1?.tag !== item2?.tag) return false
  if (item1?.affectedNodeName !== item2?.affectedNodeName) return false
  return true
}

/**
 * 比较两个 trace 数组是否相等
 * 如果大小一样，且每一项的 file、line、tag、affectedNodeName 都一样，则返回 true
 * @param trace1
 * @param trace2
 */
function isTraceEqual(trace1: TaintTraceItem[] | undefined, trace2: TaintTraceItem[] | undefined): boolean {
  if (!Array.isArray(trace1) || !Array.isArray(trace2)) {
    return false
  }
  if (trace1.length !== trace2.length) {
    return false
  }
  for (let i = 0; i < trace1.length; i++) {
    if (!isTraceItemEqual(trace1[i], trace2[i])) return false
  }
  return true
}

/**
 * 取 trace item 的位置键（仅 file+line），忽略 affectedNodeName
 * 用于判定子序列退化时中间节点的松散位置匹配
 */
function getTracePositionKey(item: TaintTraceItem): string {
  const file = item?.file ?? ''
  const line = item?.line
  const lineKey = Array.isArray(line) ? line.join(',') : String(line ?? '')
  return `${file}@${lineKey}`
}

function getTraceLineKey(item: TaintTraceItem | undefined): string {
  const line = item?.node?.loc?.start?.line ?? item?.line
  return Array.isArray(line) ? line.join(',') : String(line ?? '')
}

function getTraceFileKey(item: TaintTraceItem | undefined): string {
  return item?.node?.loc?.sourcefile || item?.file || ''
}

/**
 * 判断 candidate trace 是否为 existing trace 的"子序列退化"：
 *  - candidate 首项（SOURCE）与 existing 首项 isTraceItemEqual
 *  - candidate 末项（SINK）与 existing 末项 isTraceItemEqual
 *  - candidate.length 严格小于 existing.length（只去重更短的）
 *  - candidate 每个中间节点的 (file,line) 都能在 existing 的中间节点中找到同位置
 *
 * 根因：union BFS 在多子值上各产 1 条 finding，length 更短且中间节点均落在
 * 某条更完整 chain 的位置范围内的就是退化产物，不是独立真实链路
 */
function isDegenerateSubsequence(candidate: TaintTraceItem[] | undefined, existing: TaintTraceItem[] | undefined): boolean {
  if (!Array.isArray(candidate) || !Array.isArray(existing)) return false
  if (candidate.length < 2 || existing.length < 2) return false
  if (candidate.length >= existing.length) return false
  const cFirst = candidate[0]
  const cLast = candidate[candidate.length - 1]
  const eFirst = existing[0]
  const eLast = existing[existing.length - 1]
  if (cFirst?.tag !== 'SOURCE: ' || cLast?.tag !== 'SINK: ') return false
  if (!isTraceItemEqual(cFirst, eFirst)) return false
  if (!isTraceItemEqual(cLast, eLast)) return false
  // SOURCE/SINK 边界相同且候选链只有边界节点时，按通用退化链规则去重。
  if (candidate.length === 2) {
    return true
  }
  const existingMidPositions = new Set<string>()
  for (let i = 1; i < existing.length - 1; i++) {
    existingMidPositions.add(getTracePositionKey(existing[i]))
  }
  for (let i = 1; i < candidate.length - 1; i++) {
    if (!existingMidPositions.has(getTracePositionKey(candidate[i]))) {
      return false
    }
  }
  return true
}

function hasOnlySimpleMiddlePassSteps(trace: TaintTraceItem[] | undefined): boolean {
  if (!Array.isArray(trace)) return false
  for (let i = 1; i < trace.length - 1; i++) {
    if (trace[i]?.tag !== 'Var Pass: ') return false
  }
  return true
}

/**
 * 取 trace 中第一个 tag=SOURCE 的 item 的位置键
 */
function getTraceLocationKey(item: TaintTraceItem | undefined): string | null {
  const file = getTraceFileKey(item)
  if (!file) return null
  const loc = item?.node?.loc
  if (loc?.start?.line != null) {
    const endLine = loc.end?.line ?? loc.start.line
    return `${file}:${loc.start.line}-${endLine}`
  }
  const line = item?.line
  if (line == null) return null
  const startLine = Array.isArray(line) ? line[0] : line
  const endLine = Array.isArray(line) ? line[line.length - 1] : line
  return `${file}:${startLine}-${endLine}`
}

function extractSourceKey(finding: TracePreserveFinding): string | null {
  const trace = finding?.trace
  if (!Array.isArray(trace)) return null
  for (const item of trace) {
    if (item?.tag === 'SOURCE: ') return getTraceLocationKey(item)
  }
  return null
}


/**
 * 取 sink 位置键：优先 finding.node 的 loc，否则 trace 末尾 tag=SINK 的 item
 */
function extractSinkKey(finding: TracePreserveFinding): string | null {
  const n = finding?.node
  if (n?.loc) {
    const file = n.loc.sourcefile || finding.sourcefile || ''
    const startLine = n.loc.start?.line
    if (startLine == null) return null
    const endLine = n.loc.end?.line ?? startLine
    return `${file}:${startLine}-${endLine}`
  }
  const trace = finding?.trace
  if (Array.isArray(trace)) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const item = trace[i]
      if (item?.tag === 'SINK: ') return getTraceLocationKey(item)
    }
  }
  return null
}

type JavaTraceGroup = { call: string; argPass: string }
type JavaFindingProjection = { source: string; sink: string; groups: JavaTraceGroup[] }

function traceItemIdentity(item: TaintTraceItem): string | null {
  const file = getTraceFileKey(item)
  if (!file) return null
  return getTraceLocationKey(item)
}

function isJavaFinding(finding: TracePreserveFinding): boolean {
  return finding.type === 'taint_flow_java_input' || finding.type === 'taint_flow_java_input_inner'
}

function getJavaFindingProjection(finding: TracePreserveFinding): JavaFindingProjection | null {
  if (!isJavaFinding(finding) || !Array.isArray(finding.trace) || finding.trace.length < 2) return null
  const source = extractSourceKey(finding)
  const sink = extractSinkKey(finding)
  if (!source || source.includes(':-1:-1') || !sink || sink.includes(':-1:-1')) return null
  const groups: JavaTraceGroup[] = []
  for (let i = 0; i < finding.trace.length; i++) {
    const item = finding.trace[i]
    if (item?.tag !== 'CALL: ') continue
    const arg = finding.trace[i + 1]
    if (arg?.tag !== 'ARG PASS: ') continue
    const call = traceItemIdentity(item)
    const argPass = traceItemIdentity(arg)
    if (call && argPass) groups.push({ call, argPass })
    i++
  }
  return { source, sink, groups }
}

function getJavaProjectionKey(projection: JavaFindingProjection): string {
  const groups = projection.groups.map((group) => `${group.call}${group.argPass}`).join('')
  return `${projection.source}${projection.sink}${groups}`
}

const javaProjectionIndexes = new WeakMap<TaintFinding[], Map<string, TaintFinding>>()

function getJavaProjectionIndex(category: TaintFinding[]): Map<string, TaintFinding> {
  const cached = javaProjectionIndexes.get(category)
  if (cached) return cached
  const index = new Map<string, TaintFinding>()
  for (const issue of category) {
    const projection = getJavaFindingProjection(issue as TracePreserveFinding)
    if (projection) index.set(getJavaProjectionKey(projection), issue)
  }
  javaProjectionIndexes.set(category, index)
  return index
}

function isDuplicateJavaFinding(category: TaintFinding[], finding: TaintFinding): boolean {
  const projection = getJavaFindingProjection(finding as TracePreserveFinding)
  if (!projection) return false
  return getJavaProjectionIndex(category).has(getJavaProjectionKey(projection))
}

function rememberJavaFinding(category: TaintFinding[], finding: TaintFinding): void {
  const projection = getJavaFindingProjection(finding as TracePreserveFinding)
  if (!projection) return
  getJavaProjectionIndex(category).set(getJavaProjectionKey(projection), finding)
}

function invalidateJavaProjectionIndex(category: TaintFinding[]): void {
  javaProjectionIndexes.delete(category)
}

/**
 * 同 source+sink 位置的 finding 只保留 trace 最短的一条
 * 只对 PHP（finding.type === 'taint_flow_php_input'）启用；其它语言原样透传
 */
function dedupBySourceSinkShortestTrace(taintFindings: TaintFinding[]): TaintFinding[] {
  if (!Array.isArray(taintFindings) || taintFindings.length === 0) return taintFindings
  const phpGroups = new Map<string, { finding: TaintFinding; len: number }>()
  const nonPhpAndUngrouped: TaintFinding[] = []
  for (const finding of taintFindings) {
    if (finding?.type !== 'taint_flow_php_input') {
      nonPhpAndUngrouped.push(finding)
      continue
    }
    const srcKey = extractSourceKey(finding as TracePreserveFinding)
    const sinkKey = extractSinkKey(finding as TracePreserveFinding)
    if (!srcKey || !sinkKey) {
      nonPhpAndUngrouped.push(finding)
      continue
    }
    const groupKey = `${srcKey}|${sinkKey}`
    const traceLen = Array.isArray(finding.trace) ? finding.trace.length : Number.POSITIVE_INFINITY
    const prev = phpGroups.get(groupKey)
    if (!prev || traceLen < prev.len) {
      phpGroups.set(groupKey, { finding, len: traceLen })
    }
  }
  const result: TaintFinding[] = [...nonPhpAndUngrouped]
  for (const { finding } of phpGroups.values()) result.push(finding)
  return result
}

/**
 *
 */
class TaintOutputStrategy extends OutputStrategy {
  static outputStrategyId = 'taintflow'

  /**
   *
   */
  constructor() {
    super()
    this.outputFilePath = 'report.sarif'
  }

  /**
   *
   * @param resultManager
   * @param outputFilePath
   * @param config
   * @param printf
   */
  outputFindings(resultManager: IResultManager, outputFilePath: string, config: IConfig, printf: any): void {
    const outputStartedAt = Date.now()
    let reportFilePath
    if (resultManager) {
      const allFindings = resultManager.getFindings()
      let taintFindings = allFindings[TaintOutputStrategy.outputStrategyId]
      const rawFindingCount = Array.isArray(taintFindings) ? taintFindings.length : 0
      let callgraphFindings
      if (taintFindings) {
        const dedupStartedAt = Date.now()
        const deduped = dedupBySourceSinkShortestTrace(taintFindings as TaintFinding[])
        logger.info(`[outputFindings] strategy=taintflow phase=dedup raw=${rawFindingCount} output=${deduped.length} elapsed=${Date.now() - dedupStartedAt}ms`)
        allFindings[TaintOutputStrategy.outputStrategyId] = deduped
        taintFindings = deduped
        if (printf) {
          TaintFindingUtil.outputCheckerResultToConsole(taintFindings, printf)
        }
        callgraphFindings = allFindings[CallgraphOutputStrategy.outputStrategyId]
        const sarifStartedAt = Date.now()
        const results = this.getTaintFlowAsSarif(taintFindings, callgraphFindings)
        const sarifElapsed = Date.now() - sarifStartedAt
        const sarifResults = results?.runs?.reduce((count: number, run: { results?: unknown[] }) => count + (run.results?.length ?? 0), 0) ?? 0
        const sarifLocations = results?.runs?.reduce(
          (count: number, run: { results?: Array<{ codeFlows?: Array<{ threadFlows?: Array<{ locations?: unknown[] }> }> }> }) =>
            count + (run.results ?? []).reduce(
              (resultCount: number, result: { codeFlows?: Array<{ threadFlows?: Array<{ locations?: unknown[] }> }> }) =>
                resultCount + (result.codeFlows ?? []).reduce(
                  (flowCount: number, flow: { threadFlows?: Array<{ locations?: unknown[] }> }) =>
                    flowCount + (flow.threadFlows ?? []).reduce((locationCount: number, threadFlow: { locations?: unknown[] }) => locationCount + (threadFlow.locations?.length ?? 0), 0),
                  0
                ),
              0
            ),
          0
        ) ?? 0
        logger.info(`[outputFindings] strategy=taintflow phase=sarif results=${sarifResults} traceLocations=${sarifLocations} elapsed=${sarifElapsed}ms`)
        reportFilePath = path.join(Config.reportDir, outputFilePath)
        const writeStartedAt = Date.now()
        FileUtil.writeJSONfile(reportFilePath, results, true)
        logger.info(`[outputFindings] strategy=taintflow phase=write elapsed=${Date.now() - writeStartedAt}ms total=${Date.now() - outputStartedAt}ms`)
        // for taint flow checker, output result to console at the same time
        logger.info(`report is write to ${reportFilePath}`)
      }
    }
  }

  /**
   * check whether taint flow finding is new or not
   * @param resultManager
   * @param finding
   */
  static isNewFinding(resultManager: IResultManager, finding: TaintFinding): boolean {
    // finding 为 null 表示上游（如 verifyCallstackEdgeInvariant 校验未通过）已判定丢弃，返回 false 让 caller 的 `if (!isNewFinding) continue` 跳过
    if (!finding) return false
    let category: TaintFinding[] | undefined
    try {
      category = resultManager?.findings[TaintOutputStrategy.outputStrategyId] as TaintFinding[] | undefined
      if (!category) return true
      if (isDuplicateJavaFinding(category as TaintFinding[], finding)) return false
      // 依赖 trace 形态的折叠判据只比较原始链路节点，避免输出辅助节点改变去重结果。
      // 非 callstack-only 输出下 trace 通常不含 `_synthetic` 标记，过滤后与原数组等价。
      const findingTraceNoSynthetic = filterOutSyntheticSteps(getDedupTrace(finding))
      for (let i = 0; i < category.length; i++) {
        const issue = category[i]
        if (
          issue.line === finding.line &&
          isNodeEqual(issue.node, finding.node) &&
          issue.issuecause === finding.issuecause &&
          issue.entry_fclos?.qid === finding.entry_fclos?.qid &&
          issue.entrypoint.attribute === finding.entrypoint.attribute &&
          isSameSinkAttribute(issue.sinkAttribute, finding.sinkAttribute) &&
          isSameMatchedSanitizers(issue.matchedSanitizerTags, finding.matchedSanitizerTags)
        ) {
          const issueArgTrace = getArgTrace(issue)
          const findingArgTrace = getArgTrace(finding)
          if (issueArgTrace && findingArgTrace) {
            if (isTraceEqual(issueArgTrace, findingArgTrace)) {
              return false
            }
          } else if (isTraceEqual(getDedupTrace(issue), getDedupTrace(finding))) {
            return false
          } else if (
            isTraceEqual(
              filterOutSyntheticSteps(getDedupTrace(issue)),
              filterOutSyntheticSteps(getDedupTrace(finding))
            )
          ) {
            // callstack-only output may collapse distinct internal traces into the same
            // user-visible chain; suppress duplicate visible findings in that mode.
            // 比较前过滤合成 step，保持 callstack-only 输出下的原始链路折叠语义。
            return false
          } else if (
            findingTraceNoSynthetic && findingTraceNoSynthetic.length === 2 &&
            findingTraceNoSynthetic[0]?.tag === 'SOURCE: ' && findingTraceNoSynthetic[1]?.tag === 'SINK: ' &&
            getDedupTrace(issue) && getDedupTrace(issue).length > 2 &&
            getDedupTrace(issue)[0]?.tag === 'SOURCE: ' &&
            isTraceItemEqual(findingTraceNoSynthetic[0], getDedupTrace(issue)[0]) &&
            isTraceItemEqual(findingTraceNoSynthetic[1], getDedupTrace(issue)[getDedupTrace(issue).length - 1])
          ) {
            // TaintRecord._clone 拷贝 trace 数组导致部分 finding 的 trace 退化为仅 SOURCE+SINK（len=2），
            // 当已有同 SOURCE 且同 SINK 的更长 trace finding 时，跳过退化 finding。
            return false
          } else if (isDegenerateSubsequence(getDedupTrace(finding), getDedupTrace(issue))) {
            // union BFS 在多子值上各产 1 条 finding：同 SOURCE 同 SINK 但 length 更短、
            // 中间节点位置落在更完整 chain 范围内的是退化产物（如解构+三元引入的 __tmpN__ chain），去重
            return false
          } else if (
            isDegenerateSubsequence(getDedupTrace(issue), getDedupTrace(finding)) &&
            hasOnlySimpleMiddlePassSteps((issue as TracePreserveFinding).trace) &&
            hasOnlySimpleMiddlePassSteps((finding as TracePreserveFinding).trace)
          ) {
            // 简单 Var Pass 链路中，若退化短链先入库，后到完整链应替换短链，避免同 source/sink 输出两条 finding。
            // "简单链"判定必须看未过滤的原始 trace：合成 CALL/ARG PASS 桥接步同样表达跨帧结构，
            // 含结构步的链路不做替换，否则异步边界场景里两条真实可见链会被折叠成一条。
            category.splice(i, 1)
            invalidateJavaProjectionIndex(category as TaintFinding[])
            i--
          }
        }
      }
    } catch (e) {
      handleException(
        e,
        'Error : an error occurred in TaintOutputStrategy.isNewFinding',
        'Error : an error occurred in TaintOutputStrategy.isNewFinding'
      )
    }
    if (category) rememberJavaFinding(category as TaintFinding[], finding)
    return true
  }

  /**
   * convert taint flow and callgraph info to sarif
   * @param taintFindings
   * @param callgraphFindings
   */
  getTaintFlowAsSarif(taintFindings: TaintFinding[], callgraphFindings: any): any {
    const results: any[] = []
    _.values(taintFindings).forEach((finding: TaintFinding) => {
      const outputTrace = normalizeTerminalStringValueOfTrace(getSarifTrace(finding))
      // prepare trace
      const locations: SarifLocation[] = []
      // 相邻 dedup 兜底：finding.trace 已在 buildTaintFindingDetail 末尾按 nodehash 折叠，此处再做一次相邻
      // (nodeHash 或 uri+line+col+affected) 比较仅作 idempotent 防御，覆盖 SARIF 坐标侧偶发碰撞场景
      let prevKey: string | null = null
      const pushIfNotAdjacentDup = (location: SarifLocation, key: string): void => {
        if (prevKey !== null && prevKey === key) return
        locations.push(location)
        prevKey = key
      }
      outputTrace?.forEach((item: TaintTraceItem) => {
        const affectedNodeName = item?.affectedNodeName
        if (item.node) {
          const snippetText = SourceLine.formatSingleTrace(item)
          const uri = FindingUtil.sourceFileURI(item.file || finding.sourcefile)
          const [{ line: startLine, character: startColumn }, { line: endLine, character: endColumn }] =
            FindingUtil.convertNode2Range(item.node)
          const nodeHash = item.node._meta?.nodehash
          const traceTag = typeof item?.tag === 'string' ? item.tag : ''
          // 相邻 step key：优先 nodeHash；缺失时退到 uri+起止行列+affected 五元组；tag 不同表示语义不同
          const key =
            nodeHash != null
              ? `h:${traceTag}|${String(nodeHash)}|${affectedNodeName ?? ''}`
              : `p:${traceTag}|${uri}|${startLine}|${startColumn}|${endLine}|${endColumn}|${affectedNodeName ?? ''}`
          pushIfNotAdjacentDup(
            prepareLocation(
              startLine,
              startColumn,
              endLine,
              endColumn,
              uri,
              snippetText,
              nodeHash,
              affectedNodeName,
            ),
            key
          )
        } else if (item.str) {
          const nodeHash = undefined
          const traceTag = typeof item?.tag === 'string' ? item.tag : ''
          const key = `s:${traceTag}|${item.str}|${affectedNodeName ?? ''}`
          pushIfNotAdjacentDup(
            prepareLocation(
              0,
              0,
              0,
              0,
              'egg controller',
              item.str,
              nodeHash,
              affectedNodeName,
            ),
            key
          )
        }
      })
      const trace = prepareTrace(locations)

      const [{ line: startLine, character: startColumn }, { line: endLine, character: endColumn }] =
        FindingUtil.convertNode2Range(finding.node)
      const location = prepareLocation(
        startLine,
        startColumn,
        endLine,
        endColumn,
        finding.sourcefile,
        finding.node?._prettyPrint ?? AstUtil.prettyPrint(finding.node),
        finding.node?._meta?.nodehash
      )

      const callstackElements = prepareCallstackElements(finding.callstack, finding.node)

      results.push(
        prepareResult(
          finding.desc,
          'error',
          finding.severity,
          finding.entrypoint,
          finding.sinkInfo,
          trace,
          location,
          finding.matchedSanitizerTags,
          callstackElements,
        )
      )
    })

    // callstack-only 模式下 codeFlows 已按 callstack 顺序展开，SARIF 顶层 graphs 仅徒增体积且无下游消费，置空数组
    const strategy = Config.taintTraceOutputStrategy
    const isCallstackOnly = strategy === 'callstack-only' || strategy === 'folded' || !strategy
    const graphs = isCallstackOnly ? [] : this.buildGraphs(callgraphFindings)
    return prepareSarifFormat(results, graphs)
  }

  /**
   * construct callgraph info
   * @param callgraphFindings
   */
  buildGraphs(callgraphFindings: any): any[] {
    const graphs: any[] = []
    _.values(callgraphFindings).forEach((callgraph: any) => {
      if (callgraph) {
        graphs.push({
          description: {
            text: 'call graph',
          },
          nodes: callgraph.getNodesAsArray().map((node: any) => {
            const res: any = {}
            const { id, opts } = node
            res.id = id
            // 从 nodehash 还原 funcDef
            let funcDef = opts?.funcDef
            if (opts?.funcDefNodehash && (callgraph as any).astManager) {
              funcDef = (callgraph as any).astManager.get(opts.funcDefNodehash)
            }
            if (funcDef) {
              res.location = prepareLocation(
                funcDef.loc.start?.line,
                funcDef.loc.start?.column,
                funcDef.loc.end?.line,
                funcDef.loc.end?.column,
                funcDef.loc.sourcefile
              )
            }
            return res
          }),
          edges: callgraph.getEdgesAsArray().map((node: any) => {
            const res: any = {}
            const { id, sourceNodeId, targetNodeId, opts } = node
            // 从 callSiteNodehash 还原 callSite
            let callSite = opts?.callSite
            if (opts?.callSiteNodehash && (callgraph as any).astManager) {
              callSite = (callgraph as any).astManager.get(opts.callSiteNodehash)
            }
            if (callSite?.loc) {
              res.location = prepareLocation(
                callSite.loc.start?.line,
                callSite.loc.start?.column,
                callSite.loc.end?.line,
                callSite.loc.end?.column,
                callSite.loc.sourcefile
              )
            }
            res.id = id
            res.sourceNodeId = sourceNodeId
            res.targetNodeId = targetNodeId
            return res
          }),
        })
      }
    })
    return graphs
  }
}

registerDedupFunction(TaintOutputStrategy.outputStrategyId, TaintOutputStrategy.isNewFinding)

module.exports = TaintOutputStrategy
module.exports.dedupBySourceSinkShortestTrace = dedupBySourceSinkShortestTrace
module.exports.isDegenerateSubsequence = isDegenerateSubsequence
