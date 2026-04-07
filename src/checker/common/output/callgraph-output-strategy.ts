import type { IResultManager } from '../../../engine/analyzer/common/result-manager'
import type { IConfig } from '../../../config'

const path = require('path')
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
   * 使用原生 JSON.stringify 配合 replacer 提升性能，同时保持流式写入
   * @param cgContent - 调用图内容，包含 nodes 和 edges
   * @param filePath - 输出文件路径
   */
  private writeCgContentToStream(
    cgContent: { nodes: Record<string, any>; edges: Record<string, any> },
    filePath: string
  ): void {
    const writeStream = createWriteStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 })
    const bufferSize = 1024 * 1024 // 1MB 缓冲区
    const chunks: string[] = []
    let currentSize = 0

    // 批量写入缓冲区，减少系统调用
    const flush = (): void => {
      if (chunks.length > 0) {
        writeStream.write(chunks.join(''))
        chunks.length = 0
        currentSize = 0
      }
    }

    const append = (str: string): void => {
      chunks.push(str)
      currentSize += str.length
      if (currentSize >= bufferSize) {
        flush()
      }
    }

    // JSON.stringify 的 replacer：排除 parent 属性，将 undefined 转为空字符串
    const replacer = (key: string, value: any): any => {
      // 排除 parent 属性
      if (key === 'parent') {
        return undefined
      }
      // 将 undefined 转为空字符串
      if (value === undefined) {
        return ''
      }
      return value
    }

    // 写入开始
    append('{')

    // 写入 nodes：使用原生 JSON.stringify 序列化每个节点，利用 V8 优化
    append('"nodes":{')
    const nodeKeys = Object.keys(cgContent.nodes)
    if (nodeKeys.length > 0) {
      for (let i = 0; i < nodeKeys.length; i++) {
        if (i > 0) {
          append(',')
        }
        const key = nodeKeys[i]
        const nodeValue = cgContent.nodes[key]
        // 使用原生 JSON.stringify，利用 V8 的原生优化
        const serializedNode = JSON.stringify(nodeValue, replacer)
        append(`${JSON.stringify(key)}:${serializedNode}`)
      }
    }
    append('}')

    // 写入 edges：使用原生 JSON.stringify 序列化每条边
    append(',"edges":{')
    const edgeKeys = Object.keys(cgContent.edges)
    if (edgeKeys.length > 0) {
      for (let i = 0; i < edgeKeys.length; i++) {
        if (i > 0) {
          append(',')
        }
        const key = edgeKeys[i]
        const edgeValue = cgContent.edges[key]
        // 使用原生 JSON.stringify，利用 V8 的原生优化
        const serializedEdge = JSON.stringify(edgeValue, replacer)
        append(`${JSON.stringify(key)}:${serializedEdge}`)
      }
    }
    append('}')

    // 写入结束
    append('}')

    // 刷新剩余缓冲区并关闭流
    flush()
    writeStream.end()
  }

  /**
   * output callgraph findings
   *
   * @param resultManager - 结果管理器
   * @param outputFilePath - 输出文件路径
   * @param config - 配置对象
   * @param printf - 打印函数（未使用）
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
            // 从 finding 中获取 astManager 和 symbolTable（在 triggerAtEndOfAnalyze 中已设置）
            const astManager = (callgraph[0] as any).astManager
            const symbolTable = (callgraph[0] as any).symbolTable
            const cgContent = callgraph[0].dumpGraph(astManager, symbolTable)

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
