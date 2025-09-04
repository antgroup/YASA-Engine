const Rules = require('../common/rules-basic-handler')
const { initRules } = require('../common/rules-basic-handler')
const IntroduceTaint = require('./common-kit/source-util')
const SanitizerChecker = require('../sanitizer/sanitizer-checker')
const commonUtil = require('../../util/common-util')
const { matchSinkAtFuncCall } = require('./common-kit/sink-util')
const config = require('../../config')

const CheckerId = 'taint_flow_test'

/**
 *
 */
class TestTaintChecker {
  /**
   *
   * @param resultManager
   */
  constructor(resultManager) {
    this.entryPoints = []
    this.sourceScope = {
      complete: false,
      value: [],
    }

    this.tag = ''
    this.resultManager = resultManager
    initRules()
    commonUtil.initSourceScope(this.sourceScope)
  }

  /**
   *
   */
  static GetCheckerId() {
    return CheckerId
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
    const rules = Rules.getRules()?.FuncCallTaintSink
    const matchedRules = matchSinkAtFuncCall(node, fclos, rules)
    if (matchedRules && matchedRules.length > 0) {
      for (let i = 0; i < matchedRules.length; i++) {
        const args = Rules.prepareArgs(argValues, fclos, matchedRules[i])
        const sanitizers = SanitizerChecker.findSanitizerByIds(matchedRules[i].sanitizerIds)
        const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
          node,
          fclos,
          args,
          null,
          matchedRules[i].kind,
          false,
          sanitizers
        )
        if (ndResultWithMatchedSanitizerTagsArray) {
          for (const ndResultWithMatchedSanitizerTags of ndResultWithMatchedSanitizerTagsArray) {
            const { nd } = ndResultWithMatchedSanitizerTags
            const { matchedSanitizerTags } = ndResultWithMatchedSanitizerTags
            let ruleName = matchedRules[i].fsig
            if (typeof matchedRules[i].attribute !== 'undefined') {
              ruleName += `\nSINK Attribute: ${matchedRules[i].attribute}`
            }
            const finding = Rules.getRule(CheckerId, node)
            this.resultManager.addNewFinding(
              nd,
              node,
              fclos,
              matchedRules[i].kind,
              finding,
              ruleName,
              matchedSanitizerTags
            )
          }
          return true
        }
      }
    }
  }
}

module.exports = TestTaintChecker
