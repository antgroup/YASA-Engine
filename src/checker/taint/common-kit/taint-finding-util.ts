import type { PrintFunction, TaintFinding } from '../../../engine/analyzer/common/common-types'

const _ = require('lodash')
const Constant = require('../../../util/constant')
const { formatSanitizerTags } = require('../../sanitizer/sanitizer-checker')
const SourceLine = require('../../../engine/analyzer/common/source-line')
const AstUtil = require('../../../util/ast-util')
const Statistics = require('../../../util/statistics').default
const { shortenSourceFile } = require('../../../util/finding-util')
const Config = require('../../../config')
const logger = require('../../../util/logger')(__filename)

/**
 * output taint flow result to console
 * @param findings
 * @param printf
 */
function outputCheckerResultToConsole(findings: TaintFinding[], printf: PrintFunction): void {
  printf('\n======================== Findings ======================== ')
  if (_.isEmpty(findings)) {
    printf('No findings!')
  } else {
    let i = 1
    for (const finding of findings) {
      if (!finding.format) finding.format = formatTaintFinding(finding)
      const { format } = finding
      const { entrypoint } = finding
      const type_str = finding.issue
        ? finding.issue
        : !finding.subtype
          ? finding.type
          : `${finding.type} (${finding.subtype})`
      printf('\n------------- ', i++, ': ', type_str, '------------- ')
      // description
      printf('Description:', finding.desc)
      // source file information
      const { sourcefile } = format
      if (sourcefile && !sourcefile.startsWith('_f_')) printf('File:', sourcefile)
      // the line of the issue
      printf(format.line)
      if (typeof finding.sinkRule !== 'undefined' && finding.sinkRule !== 'Default') {
        printf('SINK RULE:', finding.sinkRule)
      }
      if (finding.sinkAttribute) {
        printf('SINK Attribute:', finding.sinkAttribute)
      }
      // the entrypoint of this source
      if (entrypoint && entrypoint.filepath !== Constant.YASA_DEFAULT) {
        printf('entrypoint: ')
        printf({
          filePath: entrypoint.filePath.startsWith(Config.maindirPrefix)
            ? entrypoint.filePath.substring(Config.maindirPrefix.length)
            : entrypoint.filePath,
          functionName: entrypoint.functionName,
          attribute: entrypoint.attribute,
          type: entrypoint.type,
          packageName: entrypoint.packageName,
          funcReceiverType: entrypoint.funcReceiverType,
        })
      }

      // the trace of the origin of the issue
      if (format.trace) {
        printf('Trace: ')
        printf(format.trace)
      }
      // matched sanitizer of issue
      if (format.matchedSanitizers) {
        printf('Matched Sanitizers: ')
        printf(format.matchedSanitizers)
      }
      // the trace of an example attack
      if (format.attackTrace) {
        printf('Attack example:')
        printf(format.attackTrace)
      }
      // the advice
      if (format.advice) {
        printf('Advice: ')
        printf('\t', format.advice)
      }
    }

    // print statistics
    printf('==========================================================')
    if (findings.length !== 0) {
      printf('  #', 'Total-findings', ':', findings.length)
    }
  }
  printf('========================================================== \n')
}

/**
 * convert the finding to the string format
 * @param finding
 */
function formatTaintFinding(finding: TaintFinding): Record<string, any> {
  const res: Record<string, any> = {}
  res.type = finding.type
  if (finding.subtype) res.subtype = finding.subtype
  if (finding.best_practice) res.best_practice = finding.best_practice
  res.id = finding.id
  res.desc = finding.desc

  // source file information
  if (finding.sourcefile) {
    const sourcefile = finding.sourcefile.toString()
    Statistics.incFileIssues(sourcefile)
    res.sourcefile = shortenSourceFile(sourcefile)
  }
  // the line of the issue
  if (finding.node) {
    const { loc } = finding.node
    const line_str = loc.start.line == loc.end.line ? loc.start.line : `[${loc.start.line}, ${loc.end.line}]`
    let code = AstUtil.prettyPrint(finding.node)
    if (code.startsWith('{\n "type'))
      // non-pretty-printed ast
      code = SourceLine.formatTraces([{ file: finding.sourcefile, line: loc.start.line }])
    res.line = `Line ${line_str}: ${code}`
  } else {
    logger.warn('finding.node is null')
  }
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

module.exports = {
  outputCheckerResultToConsole,
}
