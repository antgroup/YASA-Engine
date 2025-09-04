const uuid = require('node-uuid')
const _ = require('lodash')
const SourceLine = require('./source-line')
const AstUtil = require('../../../util/ast-util')
const findingUtil = require('../../../util/finding-util')
const config = require('../../../config')
const { prepareResult, prepareLocation, prepareTrace, prepareSarifFormat } = require('./sarif')
const entryPointConfig = require('./current-entrypoint')
const { Errors } = require('../../../util/error-code')
const { handleException } = require('./exception-handler')
const logger = require('../../../util/logger')(__filename)

const pat = /\#\#(\s|[A-Za-z0-9_\.])+/g

/**
 *
 */
class ResultManager {
  static CONSOLE = 'console'

  static FILE = 'file'

  /**
   *
   */
  constructor() {
    this.outputMode = ResultManager.CONSOLE
    this.findings = {}
    this.printings = {}
  }

  /**
   *
   * @param self
   * @param result
   */
  addResult(self, result) {}

  /**
   *
   * @param self
   * @param outPutType
   * @param outputType
   */
  outputResult(self, outputType) {
    if (ResultManager.CONSOLE === outputType) {
    } else if (ResultManager.FILE === outputType) {
    }
  }

  /**
   *
   */
  getPrintings() {
    return this.printings
  }

  /**
   *
   */
  outputToConsole() {}

  /**
   *
   */
  outputToFile() {}

  /**
   *
   * @param argNode
   * @param callNode
   * @param fclos
   * @param ruleName
   * @param finding
   * @param tagName
   * @param sinkRule
   * @param matchedSanitizerTags
   */
  addNewFinding(argNode, callNode, fclos, tagName, finding, sinkRule, matchedSanitizerTags) {
    if (finding && argNode && argNode.hasTagRec) {
      let traceStack = findingUtil.getTrace(argNode, tagName)
      const trace = SourceLine.getNodeTrace(fclos, callNode)
      // 暂时统一去掉Field，不然展示出来的链路会重复
      traceStack = traceStack.filter((item) => item.tag !== 'Field: ')
      for (const i in traceStack) {
        if (traceStack[i].tag === 'Return value: ') {
          traceStack[i].tag = 'Return Value: '
        }
      }
      finding.trace = traceStack
      trace.tag = 'SINK: '
      trace.affectedNodeName = AstUtil.prettyPrint(callNode?.callee)
      const arr = sinkRule.split('\nSINK Attribute: ')
      if (arr.length === 1) {
        finding.sinkRule = arr[0]
      } else if (arr.length === 2) {
        finding.sinkRule = arr[0]
        finding.sinkAttribute = arr[1]
      }
      finding.sinkInfo = {
        sinkRule: finding.sinkRule,
        sinkAttribute: finding.sinkAttribute,
      }
      finding.entrypoint = _.pickBy(_.clone(entryPointConfig.getCurrentEntryPoint()), (value) => !_.isObject(value))
      finding.trace.push(trace)
      finding.matchedSanitizerTags = matchedSanitizerTags
    }
    if (!this.isNewFinding(finding)) return
    this.addFinding(finding, callNode.loc)
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
    // this.findings.push(finding)
  }

  /**
   *
   * @param printf
   */
  printFindings(printf) {
    const categories = this.findings
    findingUtil.outputFindings(printf, categories)
  }

  /**
   *
   * @param format
   */
  getResult(format) {
    format = format || this.options?.format
    if (format === 'json') {
      return this.getJsonFormat()
    }
    if (format === 'sarif') {
      return this.getSarifFormat()
    }
    if (format === 'plaintext') {
      return this.getPlainTextFormat()
    }
    handleException(
      new Error(`format:${format} is not supported`),
      `format:${format} is not supported`,
      `format:${format} is not supported`
    )
    process.exit(1)
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
  getPlainTextFormat() {}

  /**
   *
   */
  getJsonFormat() {}

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
    const printings = this.getPrintings()
    const { callgraph } = printings
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

  /**
   * For cross-checking the finding annotations in the source
   * @param src
   * @param sourcefile
   * @sourcefile
   */
  checkFindings(src, sourcefile) {
    const allLines = src.split(/\n/)
    const issueSpec = new Map()
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i]
      const issueTx = line.match(pat)
      if (!issueTx) continue
      issueSpec[i + 2] = issueTx.map((tx) => tx.trim())
    }

    const findings = []
    const categories = this.findings
    for (const ct in categories) {
      for (const finding of categories[ct]) findings.push(finding)
    }
    for (const finding of findings) {
      if (
        finding.sourcefile !== sourcefile &&
        !(finding.sourcefile && finding.sourcefile.startsWith('_f_') && !sourcefile)
      )
        continue
      const { line } = finding
      const issue = issueSpec[line]
      let found = false
      if (issue) {
        for (const x in issue) {
          const tp = issue[x]
          if (tp.endsWith(finding.type)) {
            found = true
            delete issue[x]
            break
          }
        }
        if (!found) {
          const msg = `Checker: (Absent) Issue not specified at line ${line}:${finding.type}`
          Errors.CheckerError(msg)
        }
      } else {
        const msg = `Checker: (Absent) Issue not specified at line ${line}:${finding.type}`
        Errors.CheckerError(msg)
      }
    }

    for (const line in issueSpec) {
      for (const issue of issueSpec[line]) {
        if (issue) {
          const msg = `Checker: (FN) Finding missing at line ${line}:${issue}`
          Errors.CheckerError(msg)
        }
      }
    }
  }
}

module.exports = ResultManager
