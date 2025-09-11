const _ = require('lodash')
const uuid = require('node-uuid')
const Stat = require('./statistics')
const AstUtil = require('./ast-util')
const SourceLine = require('../engine/analyzer/common/source-line')
const config = require('../config')
const CONSTANT = require('./constant')
const { formatSanitizerTags } = require('../checker/sanitizer/sanitizer-checker')

/**
 * convert the finding to the string format
 * @param finding
 */
function formatFinding(finding) {
  const res = {}
  res.type = finding.type
  if (finding.subtype) res.subtype = finding.subtype
  if (finding.best_practice) res.best_practice = finding.best_practice
  res.id = finding.id
  res.desc = finding.desc

  // source file information
  if (finding.sourcefile) {
    const sourcefile = finding.sourcefile.toString()
    Stat.incFileIssues(sourcefile)
    res.sourcefile = shortenSourceFile(sourcefile)
  }
  // the line of the issue
  const { loc } = finding.node
  const line_str = loc.start.line == loc.end.line ? loc.start.line : `[${loc.start.line}, ${loc.end.line}]`
  let code = AstUtil.prettyPrint(finding.node)
  if (code.startsWith('{\n "type'))
    // non-pretty-printed ast
    code = SourceLine.formatTraces([{ file: finding.sourcefile, line: loc.start.line }])
  res.line = `Line ${line_str}: ${code}`

  // the trace of the origin of the issue
  if (finding.trace) {
    for (const item of finding.trace) {
      if (item.file) item.shortfile = shortenSourceFile(item.file)
    }
    const trace = SourceLine.formatTraces(finding.trace)
    res.trace = trace
  }
  // the trace of an example attack
  if (finding.attackTrace) {
    for (const item of finding.attackTrace) {
      if (item.file) item.shortfile = shortenSourceFile(item.file)
    }
    res.attackTrace = SourceLine.formatTraces(finding.attackTrace)
  }
  // the advice
  if (finding.advice) res.advice = finding.advice

  if (finding.matchedSanitizerTags) {
    res.matchedSanitizers = formatSanitizerTags(finding.matchedSanitizerTags)
  }
  return res
}

/**
 * Obtain the source lines for all involved components (breath-first version)
 * @param root
 * @param lines
 * @param tagName
 */
function getBwdTrace(root, lines, tagName) {
  if (!root) return

  const worklist = [root]
  const visited = new Set()
  while (worklist.length > 0) {
    const node = worklist.shift()
    if (!node || visited.has(node)) continue
    visited.add(node)
    const { trace } = node
    if (trace) {
      for (let i = trace.length - 1; i >= 0; i--) {
        const item = trace[i]
        const prev_item = lines[lines.length - 1]
        if (!prev_item || prev_item.file !== item.file || prev_item.line !== item.line || prev_item.tag !== item.tag)
          lines.push(item)
      }
      if (tagName && node?._tags.has(tagName)) {
        return lines
      }
    }

    // now go through the sub nodes
    if (Array.isArray(node)) {
      for (const child of node) {
        worklist.push(child)
      }
      continue
    }

    if (!node.type) continue
    if (!node.hasTagRec) continue

    switch (node.type) {
      case 'MemberAccess': {
        worklist.push(node.object)
        worklist.push(node.property)
        break
      }
      case 'BinaryOperation': {
        worklist.push(node.left)
        worklist.push(node.right)
        break
      }
      case 'UnaryOperation': {
        worklist.push(node.subExpression)
        break
      }
      case 'FunctionCall': {
        worklist.push(node.expression)
        worklist.push(node.arguments)
        break
      }
    } // end switch
  } // end for
}

/**
 * remove the shared prefix of the file paths
 * @param original
 * @returns {*}
 */
function shortenSourceFile(original) {
  const path_prefix = config.maindirPrefix
  if (path_prefix) {
    if (original.startsWith(path_prefix)) {
      return original.substring(path_prefix.length)
    }
  }
  return original
}

/**
 *
 * @param original
 */
function sourceFileURI(original) {
  if (original) {
    const filepath = shortenSourceFile(original)
    if (!filepath.startsWith('/')) return `file:///${filepath}`
    return `file://${filepath}`
  }
  return ''
}

/**
 * convert the ast node to the range in the report
 * @param node
 */
function convertNode2Range(node) {
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
 *
 * @param node
 * @param tagName
 */
function getTrace(node, tagName) {
  const res = []
  getBwdTrace(node, res, tagName)
  return res.reverse()
}

/**
 *
 * @param findings
 * @param finding
 * @param outputStrategyId
 * @param info
 */
function addFinding(findings, finding, outputStrategyId, info) {
  let categoryFindings = findings[outputStrategyId]
  if (!categoryFindings) {
    findings[outputStrategyId] = []
    categoryFindings = findings[outputStrategyId]
  }
  if (info && info.sourcefile) {
    finding.sourcefile = info.sourcefile
  }

  finding.id = uuid.v4()
  categoryFindings.push(finding)
}

module.exports = {
  formatFinding,
  getBwdTrace,
  sourceFileURI,
  convertNode2Range,
  getTrace,
  shortenSourceFile,
  addFinding,
}
