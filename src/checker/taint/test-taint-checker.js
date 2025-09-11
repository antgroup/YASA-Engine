const Rules = require('../common/rules-basic-handler')
const IntroduceTaint = require('./common-kit/source-util')
const SanitizerChecker = require('../sanitizer/sanitizer-checker')
const { matchSinkAtFuncCall } = require('./common-kit/sink-util')
const config = require('../../config')
const TaintChecker = require('./taint-checker')
const TaintOutputStrategy = require('../common/output/taint-output-strategy')

const TAINT_TAG_NAME = 'TEST'

/**
 *
 */
class TestTaintChecker extends TaintChecker {
  /**
   *
   * @param resultManager
   */
  constructor(resultManager) {
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
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
    this.prepareEntryPoints(analyzer)
    if (this.entryPoints) {
      if (analyzer.entryPoints && Array.isArray(analyzer.entryPoints)) {
        analyzer.entryPoints.push(...this.entryPoints)
      } else {
        analyzer.entryPoints = this.entryPoints
      }
    }
    this.addSourceTagForSourceScope(TAINT_TAG_NAME, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME, this.checkerRuleConfigContent)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
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
  triggerAtEndOfChecker(analyzer, scope, node, state, info) {}

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer, scope, node, state, info) {
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
  triggerAtMemberAccess(analyzer, scope, node, state, info) {}

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtVariableDeclaration(analyzer, scope, node, state, info) {}

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtAssignment(analyzer, scope, node, state, info) {
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
  triggerAtBinaryOperation(analyzer, scope, node, state, info) {}

  /**
   *

   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIfCondition(analyzer, scope, node, state, info) {}

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtNewExpr(analyzer, scope, node, state, info) {}

  /**
   *

   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtNewObject(analyzer, scope, node, state, info) {}

  /**
   *
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtEndOfCompileUnit(analyzer, scope, node, state, info) {}

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtEndOfAnalyze(analyzer, scope, node, state, info) {}

  /**
   *
   * @param analyzer
   */
  prepareEntryPoints(analyzer) {
    const fullCallGraphFileEntryPoint = require('../common/full-callgraph-file-entrypoint')
    if (config.entryPointMode !== 'ONLY_CUSTOM') {
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
  checkSinkAtFunctionCall(node, fclos, argValues) {
    if (!fclos) {
      return
    }
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    let rule = matchSinkAtFuncCall(node, fclos, rules)
    rule = rule.length > 0 ? rule[0] : null

    if (rule) {
      const args = Rules.prepareArgs(argValues, fclos, rule)
      const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
      const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
        node,
        fclos,
        args,
        null,
        TAINT_TAG_NAME,
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
            TAINT_TAG_NAME,
            ruleName,
            matchedSanitizerTags
          )
          if (!this.isNewTaintFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)) continue
          this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
        }
        return true
      }
    }
  }
}

module.exports = TestTaintChecker
