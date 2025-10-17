const Checker = require('../common/checker')
const InteractiveOutputStrategy = require('../common/output/interactive-output-strategy')
const logger = require('../../util/logger')(__filename)

/**
 * 获取文件的AST
 */
class GetFileAstChecker extends Checker {
  /**
   *
   * @param mng
   */
  constructor(mng) {
    super(mng, 'get_file_ast')
  }

  /**
   * 配置输出策略
   */
  getStrategyId() {
    return [InteractiveOutputStrategy.outputStrategyId]
  }

  /**
   * 处理输入
   * @param args
   */
  handleInput(args) {
    if (args.length !== 1) {
      logger.error('args 不合法')
      return
    }
    this.input = args[0]
    this.output = []
    this.status = true
  }

  /**
   *
   * @param output
   * @param success
   * @param message
   * @param body
   */
  handleOutput(success, message, body) {
    const finding = {
      output: '',
    }
    if (this.fileManager[this.input]) {
      finding.output = JSON.stringify(this.fileManager[this.input].ast, (key, value) => {
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
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
    this.fileManager = analyzer.fileManager
  }
}
module.exports = GetFileAstChecker
