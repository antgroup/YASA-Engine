const BasicRuleHandler = require('../common/rules-basic-handler')
const IntroduceTaint = require('./common-kit/source-util')
const SanitizerChecker = require('../sanitizer/sanitizer-checker')
const { matchSinkAtFuncCall } = require('./common-kit/sink-util')
const Config = require('../../config')
const TaintChecker = require('./taint-checker')
const TaintOutputStrategy = require('../common/output/taint-output-strategy')

const TAINT_TAG_NAME_TEST_TAINT = 'TEST'

/**
 *
 */
class TestTaintChecker extends TaintChecker {
  entryPoints: any[]

  /**
   *
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_test')
    this.entryPoints = []
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
    this.prepareEntryPoints(analyzer)
    if (this.entryPoints) {
      if (analyzer.entryPoints && Array.isArray(analyzer.entryPoints)) {
        analyzer.entryPoints.push(...this.entryPoints)
      } else {
        analyzer.entryPoints = this.entryPoints
      }
    }
    this.addSourceTagForSourceScope(TAINT_TAG_NAME_TEST_TAINT, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME_TEST_TAINT, this.checkerRuleConfigContent)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, argvalues } = info
    this.checkSinkAtFunctionCall(node, fclos, argvalues)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtEndOfChecker(analyzer: any, scope: any, node: any, state: any, info: any) {}

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer: any, scope: any, node: any, state: any, info: any) {
    IntroduceTaint.introduceTaintAtIdentifierDirect(node, info.res, this.sourceScope.value)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtMemberAccess(analyzer: any, scope: any, node: any, state: any, info: any) {}

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtVariableDeclaration(analyzer: any, scope: any, node: any, state: any, info: any) {}

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtAssignment(analyzer: any, scope: any, node: any, state: any, info: any) {
    // check propagator
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtBinaryOperation(analyzer: any, scope: any, node: any, state: any, info: any) {}

  /**
   *
   
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIfCondition(analyzer: any, scope: any, node: any, state: any, info: any) {}

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtNewExpr(analyzer: any, scope: any, node: any, state: any, info: any) {}

  /**
   *
   
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtNewObject(analyzer: any, scope: any, node: any, state: any, info: any) {}

  /**
   *
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtEndOfCompileUnit(analyzer: any, scope: any, node: any, state: any, info: any) {}

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtEndOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {}

  /**
   *
   * @param analyzer
   */
  prepareEntryPoints(analyzer: any) {
    const fullCallGraphFileEntryPoint = require('../common/full-callgraph-file-entrypoint')
    if (Config.entryPointMode !== 'ONLY_CUSTOM') {
      // 使用callgraph边界作为entrypoint
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
      const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
        analyzer.ainfo?.callgraph
      )
      // 使用file作为entrypoint
      const fullFileEntrypoint = fullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(analyzer.fileManager)
      this.entryPoints.push(...fullFileEntrypoint)
      this.entryPoints.push(...fullCallGraphEntrypoint)
    }
  }

  /**
   *
   * @param node
   * @param fclos
   * @param argValues
   */
  checkSinkAtFunctionCall(node: any, fclos: any, argValues: any) {
    if (!fclos) {
      return
    }
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    let rule = matchSinkAtFuncCall(node, fclos, rules)
    rule = rule.length > 0 ? rule[0] : null

    if (rule) {
      const args = BasicRuleHandler.prepareArgs(argValues, fclos, rule)
      const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
      const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
        node,
        fclos,
        args,
        null,
        TAINT_TAG_NAME_TEST_TAINT,
        false,
        sanitizers
      )
      if (ndResultWithMatchedSanitizerTagsArray) {
        for (const ndResultWithMatchedSanitizerTags of ndResultWithMatchedSanitizerTagsArray) {
          const { nd } = ndResultWithMatchedSanitizerTags
          const { matchedSanitizerTags } = ndResultWithMatchedSanitizerTags
          let ruleName = rule.fsig
          if (typeof rule.attribute !== 'undefined') {
            ruleName += `\nSINK Attribute: ${rule.attribute}`
          }
          const taintFlowFinding = this.buildTaintFinding(
            this.getCheckerId(),
            this.desc,
            node,
            nd,
            fclos,
            TAINT_TAG_NAME_TEST_TAINT,
            ruleName,
            matchedSanitizerTags
          )
          if (!TaintOutputStrategy.isNewFinding(this.resultManager, taintFlowFinding)) continue
          this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
        }
        return true
      }
    }
  }
}

module.exports = TestTaintChecker
