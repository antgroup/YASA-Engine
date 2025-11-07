const _ = require('lodash')
const BasicRuleHandler = require('../../common/rules-basic-handler')
const FileUtil = require('../../../util/file-util')
const CommonUtil = require('../../../util/common-util')
const { matchSinkAtFuncCallWithCalleeType } = require('../common-kit/sink-util')
const IntroduceTaint = require('../common-kit/source-util')
const GinEntryPoint = require('../../../engine/analyzer/golang/gin/entrypoint-collector/gin-default-entrypoint')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const Constant = require('../../../util/constant')
const completeEntryPoint = require('../common-kit/entry-points-util')
const AstUtil = require('../../../util/ast-util')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const Config = require('../../../config')
const TaintChecker = require('../taint-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
const logger = require('../../../util/logger')(__filename)

const TAINT_TAG_NAME_GIN = 'GO_INPUT'

/**
 * Gin taint_flow checker
 */
class GinTaintChecker extends TaintChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_gin_input_inner')
  }

  /**
   * starter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { topScope } = analyzer
    this.prepareEntryPoints(analyzer, topScope)
    this.addSourceTagForSourceScope(TAINT_TAG_NAME_GIN, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME_GIN, this.checkerRuleConfigContent)
  }

  /**
   * MemberAccess trigger
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtMemberAccess(analyzer: any, scope: any, node: any, state: any, info: any) {
    const taintSource = this.checkerRuleConfigContent.sources?.TaintSource

    IntroduceTaint.introduceTaintAtMemberAccess(info.res, node, scope, taintSource)
  }

  /**
   * set entry-points and taint-source from rule-config.json
   * for Gin application's taint check
   * @param analyzer
   * @param topScope
   */
  prepareEntryPoints(analyzer: any, topScope: any) {
    const { entrypoints: ruleConfigEntryPoints, sources: ruleConfigSources } = this.checkerRuleConfigContent

    const {
      TaintSource: TaintSourceRules,
      FuncCallArgTaintSource: FuncCallArgTaintSourceRules,
      FuncCallReturnValueTaintSource: FuncCallReturnValueTaintSourceRules,
    } = ruleConfigSources

    // 添加rule_config中的route入口
    if (!_.isEmpty(ruleConfigEntryPoints) && Config.entryPointMode !== 'SELF_COLLECT') {
      for (const entrypoint of ruleConfigEntryPoints) {
        let entryPointSymVal
        if (entrypoint.funcReceiverType) {
          entryPointSymVal = AstUtil.satisfy(
            topScope.packageManager,
            (n: any) =>
              n.vtype === 'fclos' &&
              FileUtil.extractAfterSubstring(n?.ast?.loc?.sourcefile, Config.maindirPrefix) === entrypoint.filePath &&
              n?.parent?.ast?.type === 'ClassDefinition' &&
              n?.parent?.ast?.id?.name === entrypoint.funcReceiverType &&
              n?.ast?.id.name === entrypoint.functionName,
            (node: any, prop: any) => prop === 'field',
            null,
            false
          )
        } else {
          entryPointSymVal = AstUtil.satisfy(
            topScope.packageManager,
            (n: any) =>
              n.vtype === 'fclos' &&
              FileUtil.extractAfterSubstring(n?.ast?.loc?.sourcefile, Config.maindirPrefix) === entrypoint.filePath &&
              n?.ast?.id.name === entrypoint.functionName,
            (node: any, prop: any) => prop === 'field',
            null,
            false
          )
        }
        if (_.isEmpty(entryPointSymVal)) {
          continue
        }
        if (Array.isArray(entryPointSymVal)) {
          entryPointSymVal = _.uniqBy(entryPointSymVal, (value: any) => value.fdef)
        } else {
          entryPointSymVal = [entryPointSymVal]
        }

        const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
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

    // 添加source
    if (Config.entryPointMode !== 'ONLY_CUSTOM') {
      const { TaintSource, FuncCallArgTaintSource, FuncCallReturnValueTaintSource } =
        GinEntryPoint.getGinEntryPointAndSource(topScope.packageManager)

      if (
        _.isEmpty(TaintSource) &&
        _.isEmpty(FuncCallArgTaintSource) &&
        _.isEmpty(FuncCallReturnValueTaintSource) &&
        _.isEmpty(TaintSourceRules) &&
        _.isEmpty(FuncCallArgTaintSourceRules) &&
        _.isEmpty(FuncCallReturnValueTaintSourceRules)
      ) {
        logger.info('[gin-taint-checker]TaintSource are not found')
        return
      }

      if (!_.isEmpty(TaintSource)) {
        this.checkerRuleConfigContent.sources = this.checkerRuleConfigContent.sources || {}
        this.checkerRuleConfigContent.sources.TaintSource = this.checkerRuleConfigContent.sources.TaintSource || []
        this.checkerRuleConfigContent.sources.TaintSource = Array.isArray(
          this.checkerRuleConfigContent.sources.TaintSource
        )
          ? this.checkerRuleConfigContent.sources.TaintSource
          : [this.checkerRuleConfigContent.sources.TaintSource]
        this.checkerRuleConfigContent.sources.TaintSource.push(...TaintSource)
      }

      if (!_.isEmpty(FuncCallArgTaintSource)) {
        this.checkerRuleConfigContent.sources = this.checkerRuleConfigContent.sources || {}
        this.checkerRuleConfigContent.sources.TaintSource = this.checkerRuleConfigContent.sources.TaintSource || []
        this.checkerRuleConfigContent.sources.TaintSource = Array.isArray(
          this.checkerRuleConfigContent.sources.TaintSource
        )
          ? this.checkerRuleConfigContent.sources.TaintSource
          : [this.checkerRuleConfigContent.sources.TaintSource]
        this.checkerRuleConfigContent.sources.TaintSource.push(...FuncCallArgTaintSource)
      }

      if (!_.isEmpty(FuncCallReturnValueTaintSource)) {
        this.checkerRuleConfigContent.sources = this.checkerRuleConfigContent.sources || {}
        this.checkerRuleConfigContent.sources.TaintSource = this.checkerRuleConfigContent.sources.TaintSource || []
        this.checkerRuleConfigContent.sources.TaintSource = Array.isArray(
          this.checkerRuleConfigContent.sources.TaintSource
        )
          ? this.checkerRuleConfigContent.sources.TaintSource
          : [this.checkerRuleConfigContent.sources.TaintSource]
        this.checkerRuleConfigContent.sources.TaintSource.push(...FuncCallReturnValueTaintSource)
      }
    }
  }

  /**
   * FunctionDefinition trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionDefinition(analyzer: any, scope: any, node: any, state: any, info: any) {
    CommonUtil.fillSourceScope(info.fclos, this.sourceScope)
  }

  /**
   * FunctionCall trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, argvalues } = info
    const calleeObject = fclos.object
    this.checkByNameAndClassMatch(node, fclos, argvalues, scope)
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(calleeObject, node, argvalues, funcCallArgTaintSource)

    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    this.collectRouteRegistry(node, calleeObject, argvalues, scope, analyzer)
  }

  /**
   * 路由entryPoint自采集
   * @param callExpNode
   * @param calleeObject
   * @param argValues
   * @param scope
   * @param analyzer
   */
  collectRouteRegistry(callExpNode: any, calleeObject: any, argValues: any, scope: any, analyzer: any) {
    if (
      !callExpNode ||
      !callExpNode.callee ||
      callExpNode.callee.type !== 'MemberAccess' ||
      !callExpNode.loc ||
      !calleeObject ||
      !argValues ||
      argValues.length <= 0
    )
      return null
    const routeFCloses = GinEntryPoint.collectRouteRegistry(callExpNode, calleeObject, argValues, scope)
    if (routeFCloses) {
      for (const routeFClos of routeFCloses) {
        const entryPoint = completeEntryPoint(routeFClos)
        analyzer.entryPoints.push(entryPoint)
      }
    }
  }

  /**
   * FunctionCallAfter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, ret } = info
    const funcCallReturnValueTaintSource = this.checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource

    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret, funcCallReturnValueTaintSource)
  }

  /**
   * 每次运行完main后清空hash
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
    if (info?.entryPoint.functionName === 'main') GinEntryPoint.clearProcessedRouteRegistry()
  }

  /**
   * check if sink or not by name and class
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   */
  checkByNameAndClassMatch(node: any, fclos: any, argvalues: any, scope: any) {
    if (fclos === undefined) {
      return
    }
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink

    if (!rules || !argvalues) return
    let rule = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, scope)
    rule = rule.length > 0 ? rule[0] : null

    if (rule) {
      const args = BasicRuleHandler.prepareArgs(argvalues, fclos, rule)
      const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
      const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
        node,
        fclos,
        args,
        scope,
        TAINT_TAG_NAME_GIN,
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
            TAINT_TAG_NAME_GIN,
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

module.exports = GinTaintChecker
