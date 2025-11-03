import type { IResultManager } from '../../../engine/analyzer/common/result-manager'
import type { IConfig } from '../../../config'

const path = require('path')
const fs = require('fs-extra')
const OutputStrategy = require('../../../engine/analyzer/common/output-strategy')
const logger = require('../../../util/logger')(__filename)
const { createWriteStream } = require('fs')

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
   * 流式写入 CG 内容到文件，避免内存溢出
   * @param cgContent 
   * @param filePath 
   */
  private writeCgContentToStream(cgContent: { nodes: Record<string, any>; edges: Record<string, any> }, filePath: string): void {
    const writeStream = createWriteStream(filePath, { encoding: 'utf8' })
    
    // 流式序列化单个值到流中（应用过滤器：排除 parent，将 undefined 转为 ''）
    const writeValue = (value: any): void => {
      if (value === undefined) {
        writeStream.write('""')
        return
      }
      if (value === null) {
        writeStream.write('null')
        return
      }
      if (typeof value === 'string') {
        writeStream.write(JSON.stringify(value))
        return
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        writeStream.write(String(value))
        return
      }
      if (Array.isArray(value)) {
        writeStream.write('[')
        value.forEach((item, index) => {
          if (index > 0) {
            writeStream.write(',')
          }
          writeValue(item)
        })
        writeStream.write(']')
        return
      }
      if (typeof value === 'object') {
        writeStream.write('{')
        let first = true
        for (const [key, val] of Object.entries(value)) {
          // 排除 parent 属性
          if (key === 'parent') {
            continue
          }
          if (!first) {
            writeStream.write(',')
          }
          first = false
          writeStream.write(JSON.stringify(key))
          writeStream.write(':')
          // 将 undefined 转为 ''
          writeValue(val === undefined ? '' : val)
        }
        writeStream.write('}')
        return
      }
      writeStream.write('""')
    }

    // 写入开始
    writeStream.write('{')

    // 写入 nodes
    writeStream.write('"nodes":{')
    const nodeKeys = Object.keys(cgContent.nodes)
    nodeKeys.forEach((key, index) => {
      if (index > 0) {
        writeStream.write(',')
      }
      writeStream.write(JSON.stringify(key))
      writeStream.write(':')
      writeValue(cgContent.nodes[key])
    })
    writeStream.write('}')

    // 写入 edges
    writeStream.write(',"edges":{')
    const edgeKeys = Object.keys(cgContent.edges)
    edgeKeys.forEach((key, index) => {
      if (index > 0) {
        writeStream.write(',')
      }
      writeStream.write(JSON.stringify(key))
      writeStream.write(':')
      writeValue(cgContent.edges[key])
    })
    writeStream.write('}')

    // 写入结束
    writeStream.write('}')
    writeStream.end()
  }

  /**
   * output callgraph findings
   *
   * @param resultManager
   * @param outputFilePath
   * @param config
   * @param printf
   */
  outputFindings(resultManager: IResultManager, outputFilePath: string, config: IConfig, printf: any): void {
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
              const cgFilePath = path.join(config.reportDir, outputFilePath)
              logger.info(`start dump CG to ${cgFilePath}`)
              this.writeCgContentToStream(cgContent, cgFilePath)
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
