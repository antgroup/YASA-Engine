import type { Finding } from '../../engine/analyzer/common/common-types'

const Checker = require('../common/checker')
const InteractiveOutputStrategy = require('../common/output/interactive-output-strategy')
const SourceLine = require('../../engine/analyzer/common/source-line')
const logger = require('../../util/logger')(__filename)
const AstUtil = require('../../util/ast-util')

/**
 * 获取文件的AST
 */
class GetAstSourceCodeChecker extends Checker {
  input!: string

  output!: any[]

  status!: boolean

  /**
   *
   * @param mng
   */
  constructor(mng: any) {
    super(mng, 'get_ast_source_code')
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
   *
   * @param success
   * @param message
   * @param body
   */
  handleOutput(success: boolean, message: string, body: any): void {
    const finding: Finding = {
      output: '',
    }
    const ast = JSON.parse(this.input)
    let content = ''
    if (ast.loc) {
      content = SourceLine.getCodeByLocation(ast.loc)
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
