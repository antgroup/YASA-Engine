const _ = require('lodash')
const commonUtil = require('../../../util/common-util')
const goEntryPoint = require('../../../engine/analyzer/golang/common/entrypoint-collector/go-default-entrypoint')
const { completeEntryPoint } = require('./entry-points-util')
const config = require('../../../config')
const Rules = require('../../common/rules-basic-handler')
const AstUtil = require('../../../util/ast-util')
const fileUtil = require('../../../util/file-util')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const constValue = require('../../../util/constant')
const IntroduceTaint = require('../common-kit/source-util')
const { matchSinkAtFuncCallWithCalleeType } = require('../common-kit/sink-util')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const fullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
const logger = require('../../../util/logger')(__filename)
const TaintChecker = require('../taint-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')

const TAINT_TAG_NAME = 'GO_INPUT'
/**
 * Go framework checker
 */
class GoDefaultTaintChecker extends TaintChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    super(resultManager, 'taint_flow_go_input')
    this.entryPoints = []
  }

  /**
   * starter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
    const { topScope } = analyzer
    this.prepareEntryPoints(topScope, analyzer)
    analyzer.mainEntryPoints = this.entryPoints
    this.addSourceTagForSourceScope(TAINT_TAG_NAME, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME, this.checkerRuleConfigContent)
  }

  /**
   * 添加main entryPoints
   * @param topScope
   * @param analyzer
   */
  prepareEntryPoints(topScope, analyzer) {
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    // 添加main入口
    let mainEntryPoints = goEntryPoint.getMainEntryPoints(topScope.packageManager)
    if (_.isEmpty(mainEntryPoints)) {
      logger.info('[go-default-taint-checker]EntryPoints are not found')
      return
    }
    if (Array.isArray(mainEntryPoints)) {
      mainEntryPoints = _.uniqBy(mainEntryPoints, (value) => value.fdef)
    } else {
      mainEntryPoints = [mainEntryPoints]
    }
    mainEntryPoints.forEach((main) => {
      if (main) {
        const entryPoint = completeEntryPoint(main)
        this.entryPoints.push(entryPoint)
      }
    })

    // 使用callGraph边界作为entrypoint
    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
      const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
        analyzer.ainfo?.callgraph
      )
      this.entryPoints.push(...fullCallGraphEntrypoint)
    }

    // 使用用户规则中指定的entrypoint
    const { entrypoints: ruleConfigEntryPoints } = this.checkerRuleConfigContent
    // 添加rule_config中的route入口
    if (!_.isEmpty(ruleConfigEntryPoints) && config.entryPointMode !== 'SELF_COLLECT') {
      for (const entrypoint of ruleConfigEntryPoints) {
        let entryPointSymVal
        if (entrypoint.funcReceiverType) {
          entryPointSymVal = AstUtil.satisfy(
            topScope.packageManager,
            (n) =>
              n.vtype === 'fclos' &&
              fileUtil.extractAfterSubstring(n?.ast?.loc?.sourcefile, config.maindirPrefix) === entrypoint.filePath &&
              n?.parent?.ast?.type === 'ClassDefinition' &&
              n?.parent?.ast?.id?.name === entrypoint.funcReceiverType &&
              n?.ast?.id.name === entrypoint.functionName,
            (node, prop) => prop === 'field',
            null,
            false
          )
        } else {
          entryPointSymVal = AstUtil.satisfy(
            topScope.packageManager,
            (n) =>
              n.vtype === 'fclos' &&
              fileUtil.extractAfterSubstring(n?.ast?.loc?.sourcefile, config.maindirPrefix) === entrypoint.filePath &&
              n?.ast?.id.name === entrypoint.functionName,
            (node, prop) => prop === 'field',
            null,
            false
          )
        }
        if (_.isEmpty(entryPointSymVal)) {
          continue
        }
        if (Array.isArray(entryPointSymVal)) {
          entryPointSymVal = _.uniqBy(entryPointSymVal, (value) => value.fdef)
        } else {
          entryPointSymVal = [entryPointSymVal]
        }

        const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
        entryPoint.scopeVal = entryPointSymVal[0].parent
        entryPoint.argValues = []
        entryPoint.functionName = entrypoint.functionName
        entryPoint.filePath = entrypoint.filePath
        entryPoint.attribute = entrypoint.attribute
        entryPoint.packageName = entrypoint.packageName
        entryPoint.entryPointSymVal = entryPointSymVal[0]
        analyzer.ruleEntrypoints.push(entryPoint)
      }
    }
  }

  /**
   * MemberAccess trigger
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtMemberAccess(analyzer, scope, node, state, info) {
    const taintSource = this.checkerRuleConfigContent.sources?.TaintSource
    IntroduceTaint.introduceTaintAtMemberAccess(info.res, node, scope, taintSource)
  }

  /**
   * FunctionCall trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    const { fclos, argvalues } = info
    const calleeObject = fclos?.object
    this.checkByNameAndClassMatch(node, fclos, argvalues, scope)
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(calleeObject, node, argvalues, funcCallArgTaintSource)
  }

  /**
   * FunctionCallAfter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer, scope, node, state, info) {
    const { fclos, ret } = info
    const funcCallReturnValueTaintSource = this.checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource

    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret, funcCallReturnValueTaintSource)
  }

  /**
   * check if sink or not by name and class
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   */
  checkByNameAndClassMatch(node, fclos, argvalues, scope) {
    if (fclos === undefined) {
      return
    }
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink

    if (!rules || !argvalues) return
    let rule = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, scope)
    rule = rule.length > 0 ? rule[0] : null

    if (rule) {
      const args = Rules.prepareArgs(argvalues, fclos, rule)
      const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
      const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
        node,
        fclos,
        args,
        scope,
        TAINT_TAG_NAME,
        true,
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

          if (!TaintOutputStrategy.isNewFinding(this.resultManager, taintFlowFinding)) continue
          this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
        }
        return true
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
  triggerAtIdentifier(analyzer, scope, node, state, info) {
    IntroduceTaint.introduceTaintAtIdentifierDirect(node, info.res, this.sourceScope.value)
  }
}

module.exports = GoDefaultTaintChecker
