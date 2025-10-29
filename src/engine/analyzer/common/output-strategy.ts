import type { IResultManager } from './result-manager'
import type { IConfig } from '../../../config'

/**
 * OutputStrategy接口 - 定义输出策略的结构
 */
export interface IOutputStrategy {
  outputFilePath?: string
  getOutputFilePath?: () => string
  outputFindings?: (resultManager: IResultManager, outputFilePath: string, config: IConfig, printf: any) => any
  [key: string]: any
}

/**
 * OutputStrategy类 - 输出策略的基类
 */
class OutputStrategy implements IOutputStrategy {
  outputFilePath!: string

  /**
   *
   */
  getOutputFilePath(): string {
    return this.outputFilePath
  }

  /**
   * interface to output the finding
   *
   * @param resultManager
   * @param outputFilePath
   * @param config
   * @param printf
   */
  outputFindings(resultManager: IResultManager, outputFilePath: string, config: IConfig, printf: any): void {}
}

module.exports = OutputStrategy
