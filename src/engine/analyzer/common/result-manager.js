const uuid = require('node-uuid')
const _ = require('lodash')
const SourceLine = require('./source-line')
const AstUtil = require('../../../util/ast-util')
const findingUtil = require('../../../util/finding-util')
const config = require('../../../config')
const { prepareResult, prepareLocation, prepareTrace, prepareSarifFormat } = require('./sarif')
const { handleException } = require('./exception-handler')
const FindingUtil = require('../../../util/finding-util')

/**
 *
 */
class ResultManager {
  /**
   *
   */
  constructor() {
    this.findings = {}
  }

  /**
   *
   */
  getFindings() {
    return this.findings
  }

  /**
   *
   * @param finding
   * @param outputStrategyId
   */
  newFinding(finding, outputStrategyId) {
    if (finding.node) {
      FindingUtil.addFinding(this.findings, finding, outputStrategyId, finding.node.loc)
    } else {
      FindingUtil.addFinding(this.findings, finding, outputStrategyId)
    }
  }

  /**
   *
   * get findings by strategyId
   * @param strategyId
   */
  getFindingsByStrategyId(strategyId) {
    if (this.findings) {
      return this.findings[strategyId]
    }
    return null
  }

  /**
   *
   * @param finding
   */
  isNewFinding(finding) {
    const category = this.findings[finding.type]
    if (!category) return true
    for (const issue of category) {
      try {
        if (
          issue.line === finding.line &&
          issue.node === finding.node &&
          issue.issuecause === finding.issuecause &&
          issue.entry_fclos === finding.entry_fclos
        ) {
          if (issue.argNode && finding.argNode) {
            if (_.isEqual(issue.argNode.trace, finding.argNode.trace)) {
              return false
            }
          } else if (_.isEqual(issue.trace, finding.trace)) {
            return false
          }
        }
      } catch (e) {
        handleException(
          e,
          'Error occurred in ResultManager.isNewFinding',
          'Error occurred in ResultManager.isNewFinding'
        )
      }
    }
    return true
  }

  /**
   *
   * @param finding
   * @param info
   */
  addFinding(finding, info) {
    if (!finding.type) return

    // filter duplicate source
    this.filterDuplicateSource(finding)
    let category = this.findings[finding.type]
    if (!category) {
      this.findings[finding.type] = []
      category = this.findings[finding.type]
    }

    const fdef = info
    if (fdef.sourcefile) finding.sourcefile = fdef.sourcefile
    finding.id = uuid.v4()
    category.push(finding)
  }

  /**
   * 去掉链路中重复的source，以免链路可读性降低
   * @param finding
   */
  filterDuplicateSource(finding) {
    if (!finding || !finding.trace || !Array.isArray(finding.trace)) return
    const newTrace = []
    for (const key in finding.trace) {
      if (
        key > 1 &&
        (finding.trace[key].tag === 'SOURCE: ' ||
          (typeof finding.trace[key].str === 'string' && finding.trace[key].str.includes('SOURCE: ')))
      ) {
        continue
      }
      newTrace.push(finding.trace[key])
    }
    finding.trace = newTrace
  }

  /**
   *
   */
  getSarifFormat() {
    const { findings } = this
    // prepare issues

    const results = []
    _.values(findings).forEach((category_findings) => {
      category_findings.forEach((finding) => {
        // prepare trace
        const locations = []
        finding.trace?.forEach((item) => {
          const affectedNodeName = item?.affectedNodeName
          if (item.node) {
            const snippetText = SourceLine.formatSingleTrace(item)
            const uri = this.sourceFileURI(item.file || finding.sourcefile)
            const [{ line: startLine, character: startColumn }, { line: endLine, character: endColumn }] =
              this.convertNode2Range(item.node)
            locations.push(
              prepareLocation(startLine, startColumn, endLine, endColumn, uri, snippetText, affectedNodeName)
            )
          } else if (item.str) {
            locations.push(prepareLocation(0, 0, 0, 0, 'egg controller', item.str, affectedNodeName))
          }
        })
        const trace = prepareTrace(locations)

        const [{ line: startLine, character: startColumn }, { line: endLine, character: endColumn }] =
          this.convertNode2Range(finding.node)
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
    })

    // prepare call graph
    const { callgraph } = findings
    const graphs = []
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
    return prepareSarifFormat(results, graphs)
  }

  /**
   *
   * @param original
   */
  sourceFileURI(original) {
    if (original) {
      const filepath = this.shortenSourceFile(original)
      if (!filepath.startsWith('/')) return `file:///${filepath}`
      return `file://${filepath}`
    }
    return ''
  }

  /**
   * remove the shared prefix of the file paths
   * @param original
   * @returns {*}
   */
  shortenSourceFile(original) {
    const path_prefix = config.maindirPrefix
    if (path_prefix) {
      if (original.startsWith(path_prefix)) {
        return original.substring(path_prefix.length)
      }
    }
    return original
  }

  /**
   * convert the ast node to the range in the report
   * @param node
   */
  convertNode2Range(node) {
    let startCharacter = 0
    let endCharacter = -1
    let startLine = 0
    let endLine = 0
    if (typeof node.loc.start.column !== 'undefined') startCharacter = node.loc.start.column
    if (typeof node.loc.end.column !== 'undefined') endCharacter = node.loc.end.column
    if (typeof node.loc.start.line !== 'undefined' && node.loc.start.line > 0) startLine = node.loc.start.line
    if (typeof node.loc.end.line !== 'undefined' && node.loc.end.line > 0) endLine = node.loc.end.line
    return [
      {
        character: startCharacter,
        line: startLine,
      },
      {
        character: endCharacter,
        line: endLine,
      },
    ]
  }
}

module.exports = ResultManager
