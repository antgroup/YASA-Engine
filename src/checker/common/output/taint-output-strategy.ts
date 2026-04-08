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
      const taintFindings = allFindings[TaintOutputStrategy.outputStrategyId]
      let callgraphFindings
      if (taintFindings) {
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
    try {
      const category = resultManager?.findings[TaintOutputStrategy.outputStrategyId]
      if (!category) return true
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
          } else if (isTraceEqual(getOutputTrace(issue), getOutputTrace(finding))) {
            // callstack-only output may collapse distinct internal traces into the same
            // user-visible chain; suppress duplicate visible findings in that mode.
            return false
          } else if (
            finding.trace && finding.trace.length === 2 &&
            finding.trace[0]?.tag === 'SOURCE: ' && finding.trace[1]?.tag === 'SINK: ' &&
            issue.trace && issue.trace.length > 2 &&
            issue.trace[0]?.tag === 'SOURCE: ' &&
            isTraceItemEqual(finding.trace[0], issue.trace[0]) &&
            isTraceItemEqual(finding.trace[1], issue.trace[issue.trace.length - 1])
          ) {
            // TaintRecord._clone 拷贝 trace 数组导致部分 finding 的 trace 退化为仅 SOURCE+SINK（len=2），
            // 当已有同 SOURCE 且同 SINK 的更长 trace finding 时，跳过退化 finding。
            return false
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
