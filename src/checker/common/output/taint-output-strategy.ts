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
const SourceLine = require('../../../engine/analyzer/common/source-line')
const FindingUtil = require('../../../util/finding-util')
const logger = require('../../../util/logger')(__filename)

const {
  prepareLocation,
  prepareTrace,
  prepareResult,
  prepareSarifFormat,
} = require('../../../engine/analyzer/common/sarif')
const AstUtil = require('../../../util/ast-util')
const { handleException } = require('../../../engine/analyzer/common/exception-handler')

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
        TaintFindingUtil.outputCheckerResultToConsole(taintFindings, printf)
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
            if (_.isEqual(issue.argNode.trace, finding.argNode.trace)) {
              return false
            }
          } else if (_.isEqual(issue.trace, finding.trace)) {
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
      // prepare trace
      const locations: any[] = []
      finding.trace?.forEach((item: any) => {
        const affectedNodeName = item?.affectedNodeName
        if (item.node) {
          const snippetText = SourceLine.formatSingleTrace(item)
          const uri = FindingUtil.sourceFileURI(item.file || finding.sourcefile)
          const [{ line: startLine, character: startColumn }, { line: endLine, character: endColumn }] =
            FindingUtil.convertNode2Range(item.node)
          locations.push(
            prepareLocation(startLine, startColumn, endLine, endColumn, uri, snippetText, affectedNodeName)
          )
        } else if (item.str) {
          locations.push(prepareLocation(0, 0, 0, 0, 'egg controller', item.str, affectedNodeName))
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
        AstUtil.prettyPrint(finding.node)
      )

      results.push(
        prepareResult(
          finding.desc,
          'error',
          finding.severity,
          finding.entrypoint,
          finding.sinkInfo,
          trace,
          location,
          finding.matchedSanitizerTags
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
            const funcDef = opts?.funcDef
            if (funcDef) {
              res.location = prepareLocation(
                funcDef.loc.start.line,
                funcDef.loc.start.column,
                funcDef.loc.end.line,
                funcDef.loc.end.column,
                funcDef.loc.sourcefile
              )
            }
            return res
          }),
          edges: callgraph.getEdgesAsArray().map((node: any) => {
            const res: any = {}
            const { id, sourceNodeId, targetNodeId, opts } = node
            const callSite = opts?.callSite
            if (callSite?.loc) {
              res.location = prepareLocation(
                callSite.loc.start.line,
                callSite.loc.start.column,
                callSite.loc.end.line,
                callSite.loc.end.column,
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
