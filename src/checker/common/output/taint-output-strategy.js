const _ = require('lodash')
const pathMod = require('path')
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
  outputFindings(resultManager, outputFilePath, config, printf) {
    let reportFilePath
    if (resultManager) {
      const allFindings = resultManager.getFindings()
      const taintFindings = allFindings[TaintOutputStrategy.outputStrategyId]
      let callgraphFindings
      if (taintFindings) {
        callgraphFindings = allFindings[CallgraphOutputStrategy.outputStrategyId]
        const results = this.getTaintFlowAsSarif(taintFindings, callgraphFindings)
        reportFilePath = pathMod.join(Config.reportDir, outputFilePath)
        FileUtil.writeJSONfile(reportFilePath, results)
      }
      // for taint flow checker, output result to console at the same time
      TaintFindingUtil.outputCheckerResultToConsole(taintFindings, printf)
      logger.info(`report is write to ${reportFilePath}`)
    }
  }

  /**
   * convert taint flow and callgraph info to sarif
   * @param taintFindings
   * @param callgraphFindings
   */
  getTaintFlowAsSarif(taintFindings, callgraphFindings) {
    const results = []
    _.values(taintFindings).forEach((finding) => {
      // prepare trace
      const locations = []
      finding.trace?.forEach((item) => {
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
  buildGraphs(callgraphFindings) {
    const graphs = []
    _.values(callgraphFindings).forEach((callgraph) => {
      if (callgraph) {
        graphs.push({
          description: {
            text: 'call graph',
          },
          nodes: callgraph.getNodesAsArray().map((node) => {
            const res = {}
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
          edges: callgraph.getEdgesAsArray().map((node) => {
            const res = {}
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
