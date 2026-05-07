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
const { getOutputTrace } = require('../../taint/common-kit/taint-trace-output')
const SourceLine = require('../../../engine/analyzer/common/source-line')
const FindingUtil = require('../../../util/finding-util')
const logger = require('../../../util/logger')(__filename)

const {
  prepareLocation,
  prepareTrace,
  prepareResult,
  prepareSarifFormat,
  prepareCallstackElements,
} = require('../../../engine/analyzer/common/sarif')
const AstUtil = require('../../../util/ast-util')
const { handleException } = require('../../../engine/analyzer/common/exception-handler')

/**
 * 过滤掉合成的 synthetic step（Plan A）。
 *
 * 背景：R21 判据 A 在 CO 模式下自动在 finding.trace 中注入一对 `CALL: ` + `ARG PASS: ` synthetic
 * step（带 `_synthetic: true` 内部标记）以补齐 callstack 桥接 fclos 的 trace 可见性；但 `isNewFinding`
 * 的 CO 折叠判据依赖"raw trace 形态"判定两条 finding 是否可合并。合成 step 不该参与可合并性判定，
 * 否则原本 degenerate 的 SOURCE+SINK finding 在注入合成 step 后会被误判为不同 finding → R19 CO
 * 折叠语义破损。
 *
 * 该 filter 常驻生效：非 CO 模式下 finding.trace 本就不含带 `_synthetic` 标记的 step，返回值与原数组
 * 等价（no-op）；CO 模式下过滤合成 step 后恢复 R19 折叠语义。
 * `_synthetic` 字段不经 SARIF 序列化路径（prepareLocation 只读 file/line/tag/node/affectedNodeName），
 * 不影响输出。
 * @param trace
 */
function filterOutSyntheticSteps(trace: any): any[] | undefined {
  if (!Array.isArray(trace)) return trace
  return trace.filter((item: any) => item?._synthetic !== true)
}

/**
 * 比较单个 trace item 是否相等（file、line、tag、affectedNodeName）
 */
function isTraceItemEqual(item1: any, item2: any): boolean {
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
function isTraceEqual(trace1: any[] | undefined, trace2: any[] | undefined): boolean {
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
 * 取 trace 中第一个 tag=SOURCE 的 item 的位置键
 */
function extractSourceKey(finding: any): string | null {
  const trace = finding?.trace
  if (!Array.isArray(trace)) return null
  for (const item of trace) {
    if (item?.tag === 'SOURCE: ') {
      const file = item.node?.loc?.sourcefile || item.file || ''
      const line = item.node?.loc?.start?.line ?? (Array.isArray(item.line) ? item.line[0] : item.line) ?? -1
      const col = item.node?.loc?.start?.column ?? -1
      return `${file}:${line}:${col}`
    }
  }
  return null
}

/**
 * 取 sink 位置键：优先 finding.node 的 loc，否则 trace 末尾 tag=SINK 的 item
 */
function extractSinkKey(finding: any): string | null {
  const n = finding?.node
  if (n?.loc) {
    const file = n.loc.sourcefile || finding.sourcefile || ''
    const line = n.loc.start?.line ?? -1
    const col = n.loc.start?.column ?? -1
    return `${file}:${line}:${col}`
  }
  const trace = finding?.trace
  if (Array.isArray(trace)) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const item = trace[i]
      if (item?.tag === 'SINK: ') {
        const file = item.node?.loc?.sourcefile || item.file || ''
        const line = item.node?.loc?.start?.line ?? (Array.isArray(item.line) ? item.line[0] : item.line) ?? -1
        const col = item.node?.loc?.start?.column ?? -1
        return `${file}:${line}:${col}`
      }
    }
  }
  return null
}

/**
 * 同 source+sink 位置的 finding 只保留 trace 最短的一条
 * 只对 PHP（finding.type === 'taint_flow_php_input'）启用；其它语言原样透传
 */
function dedupBySourceSinkShortestTrace(taintFindings: any[]): any[] {
  if (!Array.isArray(taintFindings) || taintFindings.length === 0) return taintFindings
  const phpGroups = new Map<string, { finding: any; len: number }>()
  const nonPhpAndUngrouped: any[] = []
  for (const finding of taintFindings) {
    if (finding?.type !== 'taint_flow_php_input') {
      nonPhpAndUngrouped.push(finding)
      continue
    }
    const srcKey = extractSourceKey(finding)
    const sinkKey = extractSinkKey(finding)
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
  const result: any[] = [...nonPhpAndUngrouped]
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
    let reportFilePath
    if (resultManager) {
      const allFindings = resultManager.getFindings()
      let taintFindings = allFindings[TaintOutputStrategy.outputStrategyId]
      let callgraphFindings
      if (taintFindings) {
        // 后处理：同 source+sink 位置只保留 trace 最短的 finding（仅 PHP 启用）
        const deduped = dedupBySourceSinkShortestTrace(taintFindings as any[])
        allFindings[TaintOutputStrategy.outputStrategyId] = deduped
        taintFindings = deduped
        if (printf) {
          TaintFindingUtil.outputCheckerResultToConsole(taintFindings, printf)
        }
        callgraphFindings = allFindings[CallgraphOutputStrategy.outputStrategyId]
        const results = this.getTaintFlowAsSarif(taintFindings, callgraphFindings)
        reportFilePath = path.join(Config.reportDir, outputFilePath)
        FileUtil.writeJSONfile(reportFilePath, results)
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
    try {
      const category = resultManager?.findings[TaintOutputStrategy.outputStrategyId]
      if (!category) return true
      // Plan A：在所有依赖 trace 形态的折叠判据前，先过滤 synthetic step（R21 判据 A 注入的合成步）；
      // 非 CO 模式下 finding.trace / issue.trace 不含带 _synthetic 标记的 step，filter 返回等价数组（no-op）。
      const findingTraceNoSynthetic = filterOutSyntheticSteps(finding.trace)
      for (const issue of category) {
        if (
          issue.line === finding.line &&
          issue.node === finding.node &&
          issue.issuecause === finding.issuecause &&
          issue.entry_fclos === finding.entry_fclos &&
          issue.entrypoint.attribute === finding.entrypoint.attribute
        ) {
          if (issue.argNode && finding.argNode) {
            if (isTraceEqual(issue.argNode.taint.getFirstTrace(), finding.argNode.taint.getFirstTrace())) {
              return false
            }
          } else if (isTraceEqual(issue.trace, finding.trace)) {
            return false
          } else if (
            isTraceEqual(
              filterOutSyntheticSteps(getOutputTrace(issue)),
              filterOutSyntheticSteps(getOutputTrace(finding))
            )
          ) {
            // callstack-only output may collapse distinct internal traces into the same
            // user-visible chain; suppress duplicate visible findings in that mode.
            // Plan A：比较前过滤合成 step，确保 R21 判据 A 在 CO 下原折叠语义不破。
            return false
          } else {
            // TaintRecord._clone 拷贝 trace 数组导致部分 finding 的 trace 退化为仅 SOURCE+SINK（len=2），
            // 当已有同 SOURCE 且同 SINK 的更长 trace finding 时，跳过退化 finding。
            // Plan A：判定基于"去合成 step 后的 trace"，避免 R21 注入的 CALL/ARG PASS 把原 len=2 退化体变成 len>2 逃过折叠。
            const issueTraceNoSynthetic = filterOutSyntheticSteps(issue.trace)
            if (
              Array.isArray(findingTraceNoSynthetic) && findingTraceNoSynthetic.length === 2 &&
              findingTraceNoSynthetic[0]?.tag === 'SOURCE: ' && findingTraceNoSynthetic[1]?.tag === 'SINK: ' &&
              Array.isArray(issueTraceNoSynthetic) && issueTraceNoSynthetic.length > 2 &&
              issueTraceNoSynthetic[0]?.tag === 'SOURCE: ' &&
              isTraceItemEqual(findingTraceNoSynthetic[0], issueTraceNoSynthetic[0]) &&
              isTraceItemEqual(findingTraceNoSynthetic[1], issueTraceNoSynthetic[issueTraceNoSynthetic.length - 1])
            ) {
              return false
            }
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
      const outputTrace = getOutputTrace(finding)
      // prepare trace
      const locations: any[] = []
      outputTrace?.forEach((item: any) => {
        const affectedNodeName = item?.affectedNodeName
        if (item.node) {
          const snippetText = SourceLine.formatSingleTrace(item)
          const uri = FindingUtil.sourceFileURI(item.file || finding.sourcefile)
          const [{ line: startLine, character: startColumn }, { line: endLine, character: endColumn }] =
            FindingUtil.convertNode2Range(item.node)
          locations.push(
            prepareLocation(
              startLine,
              startColumn,
              endLine,
              endColumn,
              uri,
              snippetText,
              item.node?._meta?.nodehash,
              affectedNodeName
            )
          )
        } else if (item.str) {
          locations.push(
            prepareLocation(0, 0, 0, 0, 'egg controller', item.str, item.node?._meta?.nodehash, affectedNodeName)
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
        AstUtil.prettyPrint(finding.node),
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
          callstackElements
        )
      )
    })

    // prepare call graph
    const graphs = this.buildGraphs(callgraphFindings)
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

module.exports = TaintOutputStrategy
module.exports.dedupBySourceSinkShortestTrace = dedupBySourceSinkShortestTrace
