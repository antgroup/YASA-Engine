import type { IResultManager } from '../../../engine/analyzer/common/result-manager'
import type { ResponseObject } from '../../../engine/analyzer/common/common-types'

const OutputStrategy = require('../../../engine/analyzer/common/output-strategy')

/**
 *
 */
class InteractiveOutputStrategy extends OutputStrategy {
  static outputStrategyId = 'interactive'

  /**
   *
   */
  constructor() {
    super()
    this.outputFilePath = ''
  }

  /**
   * output callgraph findings
   *
   * @param resultManager
   * @param outputFilePath
   * @param config
   * @param printf
   */
  outputFindings(resultManager: IResultManager, outputFilePath: string, config: any, printf: any): ResponseObject {
    const response = {
      body: '',
    }
    const allFindings = resultManager.getFindings()
    if (allFindings) {
      const findings = allFindings[InteractiveOutputStrategy.outputStrategyId]
      if (findings) {
        const result = new Set()
        for (const finding of findings) {
          if (finding?.output && typeof finding.output === 'string' && finding?.output !== '') {
            result.add(finding?.output)
          }
        }
        response.body = [...result].join(',')
      }
      // for (let i = findings.length - 1; i >= 0; i--) {
      //   const finding = findings[i]
      //   if (finding?.output && typeof finding.output === 'string' && finding?.output !== '') {
      //     result.add(finding?.output)
      //     findings.splice(i, 1)
      //   }
      // }
    }
    console.log(JSON.stringify(response))
    return response
  }
}

module.exports = InteractiveOutputStrategy
