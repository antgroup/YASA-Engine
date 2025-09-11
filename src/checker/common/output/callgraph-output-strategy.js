const pathMod = require('path')
const fs = require('fs-extra')
const OutputStrategy = require('../../../engine/analyzer/common/output-strategy')
const logger = require('../../../util/logger')(__filename)

/**
 *
 */
class CallgraphOutputStrategy extends OutputStrategy {
  static outputStrategyId = 'callgraph'

  /**
   *
   */
  constructor() {
    super()
    this.outputFilePath = 'callgraph.json'
  }

  /**
   * output callgraph findings
   *
   * @param resultManager
   * @param outputFilePath
   * @param config
   * @param printf
   */
  outputFindings(resultManager, outputFilePath, config, printf) {
    const allFindings = resultManager.getFindings()
    if (allFindings) {
      const findings = allFindings[CallgraphOutputStrategy.outputStrategyId]
      if (config.reportDir) {
        // dump Call Graph to file
        if (config.dumpCG || config.dumpAllCG) {
          const callgraph = findings
          if (Array.isArray(callgraph) && callgraph.length > 0) {
            const cgContent = callgraph[0].dumpGraph()

            if (cgContent) {
              const cgFilePath = pathMod.join(config.reportDir, outputFilePath)
              logger.info(`start dump CG to ${cgFilePath}`)
              const filteredRecords = JSON.stringify(cgContent, (key, value) => {
                // 如果属性名是 'parent'，则返回 undefined 表示排除
                if (key === 'parent') {
                  return undefined
                }
                if (value === undefined) {
                  return ''
                }
                return value
              })
              fs.writeFileSync(cgFilePath, filteredRecords)
              logger.info(`CG info is write to ${cgFilePath}`)
            }
          } else {
            logger.warn('dumpCG is not available for callgraph is not found in checker printings')
          }
        }
      } else {
        logger.warn('There is no report directory specified for reporting results')
      }
    }
  }
}

module.exports = CallgraphOutputStrategy
