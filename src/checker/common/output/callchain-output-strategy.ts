import type { IResultManager } from '../../../engine/analyzer/common/result-manager'
import type { IConfig } from '../../../config'

const _ = require('lodash')
const path = require('path')
const OutputStrategy = require('../../../engine/analyzer/common/output-strategy')
const Config = require('../../../config')
const FileUtil = require('../../../util/file-util')
const logger = require('../../../util/logger')(__filename)
const { handleException } = require('../../../engine/analyzer/common/exception-handler')

/**
 * Output strategy for callchain checker
 * Outputs findings as JSON with entrypoint, sinkInfo, and callstack
 */
class CallchainOutputStrategy extends OutputStrategy {
  static outputStrategyId = 'callchain'

  /**
   * constructor
   */
  constructor() {
    super()
    this.outputFilePath = 'callchain-report.json'
  }

  /**
   * output findings
   * @param resultManager
   * @param outputFilePath
   * @param config
   * @param printf
   */
  outputFindings(resultManager: IResultManager, outputFilePath: string, config: IConfig, printf: any): void {
    let reportFilePath
    if (resultManager) {
      const allFindings = resultManager.getFindings()
      const callchainFindings = allFindings[CallchainOutputStrategy.outputStrategyId]
      if (callchainFindings) {
        // if (printf) {
        //   this.outputCallchainResultToConsole(callchainFindings, printf)
        // }
        const results = this.buildCallchainJSON(callchainFindings)
        reportFilePath = path.join(Config.reportDir, outputFilePath)
        FileUtil.writeJSONfile(reportFilePath, results)
        logger.info(`callchain report is written to ${reportFilePath}`)
      }
    }
  }

  /**
   * output callchain result to console
   * @param callchainFindings
   * @param printf
   */
  outputCallchainResultToConsole(callchainFindings: any[], printf: any): void {
    if (!callchainFindings || callchainFindings.length === 0) {
      printf('No callchain findings detected.')
      return
    }
    printf(`\nTotal callchain findings: ${callchainFindings.length}\n`)
    callchainFindings.forEach((finding: any, index: number) => {
      printf(`\n[${index + 1}] Sink matched: ${finding.sinkRule}`)
      if (finding.sinkAttribute) {
        printf(`  Attribute: ${finding.sinkAttribute}`)
      }
      printf(`  Entry point: ${finding.entrypoint?.functionName || 'N/A'}`)
      printf(`  Location: ${finding.sourcefile}:${finding.line}`)
      if (finding.callstackInfo && finding.callstackInfo.length > 0) {
        printf(`  Call stack depth: ${finding.callstackInfo.length}`)
        finding.callstackInfo.forEach((frame: any, i: number) => {
          printf(`    [${i}] ${frame.function || 'anonymous'} at ${frame.file || '?'}:${frame.line || '?'}`)
        })
      }
    })
  }

  /**
   * check whether callchain finding is new or not
   * @param resultManager
   * @param finding
   */
  static isNewFinding(resultManager: IResultManager, finding: any): boolean {
    try {
      if (!finding) {
        return false
      }
      const category = resultManager?.findings[CallchainOutputStrategy.outputStrategyId]
      if (!category) return true
      for (const issue of category) {
        if (
          issue.line === finding.line &&
          issue.node === finding.node &&
          issue.issuecause === finding.issuecause &&
          issue.entry_fclos === finding.entry_fclos &&
          issue.entrypoint?.attribute === finding.entrypoint?.attribute &&
          issue.entrypoint?.filePath === finding.entrypoint?.filePath &&
          issue.entrypoint?.functionName === finding.entrypoint?.functionName &&
          issue.sinkRule === finding.sinkRule
        ) {
          return false
        }
      }
    } catch (e) {
      handleException(
        e,
        'Error: an error occurred in CallchainOutputStrategy.isNewFinding',
        'Error: an error occurred in CallchainOutputStrategy.isNewFinding'
      )
    }
    return true
  }

  /**
   * Build JSON output with entrypoint, sinkInfo, callstack, and callsites
   * @param callchainFindings
   */
  buildCallchainJSON(callchainFindings: any[]): any {
    const findings: any[] = []

    _.values(callchainFindings).forEach((finding: any) => {
      const entry: any = {
        entrypoint: finding.entrypoint || {},
        sinkInfo: finding.sinkInfo || {},
        callstack: finding.callstackInfo || [],
        callsites: finding.callsitesInfo || [],
      }

      findings.push(entry)
    })

    return {
      version: '1.0',
      totalFindings: findings.length,
      findings,
    }
  }
}

module.exports = CallchainOutputStrategy
