const Checker = require('../common/checker')
const InteractiveOutputStrategy = require('../common/output/interactive-output-strategy')
const sourceLine = require('../../engine/analyzer/common/source-line')
const logger = require('../../util/logger')(__filename)
const AstUtil = require('../../util/ast-util')

/**
 * 获取文件的AST
 */
class GetAstSourceCodeChecker extends Checker {
  /**
   *
   * @param mng
   */
  constructor(mng) {
    super(mng, 'get_ast_source_code')
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
    const ast = JSON.parse(this.input)
    let content = ''
    if (ast.loc) {
      content = sourceLine.getCodeByLocation(ast.loc)
      if (content === '') {
        content = AstUtil.prettyPrint(ast)
      }
    } else {
      content = 'error: ast has no loc, please check it'
    }
    finding.output = content
    this.resultManager.newFinding(finding, InteractiveOutputStrategy.outputStrategyId)
    this.status = false
  }
}

module.exports = GetAstSourceCodeChecker
