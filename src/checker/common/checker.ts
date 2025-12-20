const BasicRuleHandler = require('./rules-basic-handler')
const { mergeAToB } = require('../../util/common-util')
const { handleException } = require('../../engine/analyzer/common/exception-handler')
const { initRules } = require('./rules-basic-handler')

/**
 * The base class of all checkers
 */
class CheckerBase {
  checkerId: any

  resultManager: any

  // The external variables that each checker can access. Such as source/sink/sanitizer/entrypoint
  checkerRuleConfigContent: any

  /**
   * constructor of checker class
   * @param resultManager
   * @param checkerId
   */
  constructor(resultManager: any, checkerId: any) {
    this.checkerId = checkerId
    this.resultManager = resultManager
    this.checkerRuleConfigContent = {}
    initRules()
    this.loadRuleConfig(this)
  }

  /**
   * get checkerId
   */
  getCheckerId(): any {
    return this.checkerId
  }

  /**
   * load checker ruleConfigContent
   * @param checker
   */
  loadRuleConfig(checker: any): void {
    const checkerId = checker.getCheckerId()
    // 路径从 checker/common 回到项目根的 config
    const Config = require('../../config')
    // 传入 Config.ruleConfigFile，如果为空则让 getRules 从 Config 读取
    const ruleConfigContent = BasicRuleHandler.getRules(Config.ruleConfigFile)
    if (Array.isArray(ruleConfigContent) && ruleConfigContent.length > 0) {
      for (const ruleConfig of ruleConfigContent) {
        if (
          ruleConfig.checkerIds &&
          ((Array.isArray(ruleConfig.checkerIds) &&
            ruleConfig.checkerIds.length > 0 &&
            ruleConfig.checkerIds.includes(checkerId)) ||
            ruleConfig.checkerIds === checkerId)
        ) {
          mergeAToB(ruleConfig, checker.checkerRuleConfigContent)
        }
      }
    } else if (!Array.isArray(ruleConfigContent)) {
      handleException('', 'Error: ruleConfig must be an array!!', 'Error: ruleConfig must be an array!!')
      process.exit(1)
    }
  }
}

module.exports = CheckerBase
