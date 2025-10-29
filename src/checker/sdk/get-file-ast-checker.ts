import type { Finding } from '../../engine/analyzer/common/common-types'

const Checker = require('../common/checker')
const InteractiveOutputStrategy = require('../common/output/interactive-output-strategy')
const logger = require('../../util/logger')(__filename)

/**
 * 获取文件的AST
 */
class GetFileAstChecker extends Checker {
  input: string

  output: any[]

  status: boolean

  fileManager: Record<string, any>

  /**
   *
   * @param mng
   */
  constructor(mng: any) {
    super(mng, 'get_file_ast')
    this.input = ''
    this.output = []
    this.status = false
    this.fileManager = {}
  }

  /**
   * 配置输出策略
   */
  getStrategyId(): string[] {
    return [InteractiveOutputStrategy.outputStrategyId]
  }

  /**
   * 处理输入
   * @param args
   */
  handleInput(args: string[]): void {
    if (args.length !== 1) {
      logger.error('args 不合法')
      return
    }
    this.input = args[0]
    this.output = []
    this.status = true
  }

  /**
   * 处理输出
   */
  handleOutput(): void {
    const finding: Finding = {
      output: '',
    }
    if (this.fileManager[this.input]) {
      finding.output = JSON.stringify(this.fileManager[this.input].ast, (key: string, value: any) => {
        // 如果属性名是 'parent'，则返回 undefined 表示排除
        if (key === 'parent') {
          return undefined
        }
        if (value === undefined) {
          return ''
        }
        return value
      })
      this.resultManager.newFinding(finding, InteractiveOutputStrategy.outputStrategyId)
    }
    this.status = false
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    this.fileManager = analyzer.fileManager
  }
}
module.exports = GetFileAstChecker
