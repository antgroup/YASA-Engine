const _ = require('lodash')
const Rules = require('../../common/rules-basic-handler')
const fileUtil = require('../../../util/file-util')
const commonUtil = require('../../../util/common-util')
const { matchSinkAtFuncCallWithCalleeType } = require('../common-kit/sink-util')
const IntroduceTaint = require('../common-kit/source-util')
const ginEntryPoint = require('../../../engine/analyzer/golang/gin/entrypoint-collector/gin-default-entrypoint')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const constValue = require('../../../util/constant')
const { completeEntryPoint } = require('./entry-points-util')
const AstUtil = require('../../../util/ast-util')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const config = require('../../../config')
const { initRules } = require('../../common/rules-basic-handler')
const logger = require('../../../util/logger')(__filename)

const CheckerId = 'taint_flow_go_input_for_gin'

const TARGET_RULES_KIND = 'GO_INPUT'
const TAINT_TAG_NAME = 'GO_INPUT'

/**
 * Gin taint_flow checker
 */
class GinTaintChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    this.entryPoints = []
    this.sourceScope = {
      complete: false,
      value: [],
    }
    this.resultManager = resultManager
    initRules()
    commonUtil.initSourceScope(this.sourceScope)
  }

  /**
   *
   * @returns {string}
   * @constructor
   */
  static GetCheckerId() {
    return CheckerId
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
    this.prepareEntryPoints(analyzer, topScope)
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
  triggerAtMemberAccess(analyzer, scope, node, state, info) {
    IntroduceTaint.introduceTaintAtMemberAccess(info.res, node, scope)
  }

  /**
   * set entry-points and taint-source from rule-config.json
   * for Gin application's taint check
   * @param analyzer
   * @param topScope
   */
  prepareEntryPoints(analyzer, topScope) {
    const {
      RouterPath: routers,
      TaintSource: TaintSourceRules,
      FuncCallArgTaintSource: FuncCallArgTaintSourceRules,
      FuncCallReturnValueTaintSource: FuncCallReturnValueTaintSourceRules,
    } = Rules.getRules() || {}

    // 添加rule_config中的route入口
    if (!_.isEmpty(routers) && config.entryPointMode !== 'SELF_COLLECT') {
      for (const router of routers) {
        let entryPointSymVal
        if (router.routerFuncReceiverType) {
          entryPointSymVal = AstUtil.satisfy(
            topScope.packageManager,
            (n) =>
              n.vtype === 'fclos' &&
              fileUtil.extractAfterSubstring(n?.ast?.loc?.sourcefile, config.maindirPrefix) === router.routerFile &&
              n?.parent?.ast?.type === 'ClassDefinition' &&
              n?.parent?.ast?.id?.name === router.routerFuncReceiverType &&
              n?.ast?.id.name === router.routerFunc,
            (node, prop) => prop === 'field',
            null,
            false
          )
        } else {
          entryPointSymVal = AstUtil.satisfy(
            topScope.packageManager,
            (n) =>
              n.vtype === 'fclos' &&
              fileUtil.extractAfterSubstring(n?.ast?.loc?.sourcefile, config.maindirPrefix) === router.routerFile &&
              n?.ast?.id.name === router.routerFunc,
            (node, prop) => prop === 'field',
            null,
            false
          )
        }
        if (_.isEmpty(entryPointSymVal)) {
          logger.info('[gin-default-taint-checker]gin route entryPoint is not found')
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
        entryPoint.functionName = router.routerFunc
        entryPoint.filePath = router.routerFile
        entryPoint.attribute = router.routerAttribute
        entryPoint.packageName = router.packageName
        entryPoint.entryPointSymVal = entryPointSymVal[0]
        analyzer.ruleEntrypoints.push(entryPoint)
      }
    }

    // 添加source
    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      const { TaintSource, FuncCallArgTaintSource, FuncCallReturnValueTaintSource } =
        ginEntryPoint.getGinEntryPointAndSource(topScope.packageManager)

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

      if (Rules.getRules()?.TaintSource && Array.isArray(Rules.getRules()?.TaintSource)) {
        Rules.getRules()?.TaintSource.push(...TaintSourceRules)
      } else {
        Rules.getRules().TaintSource = TaintSourceRules
      }
      if (Rules.getRules()?.FuncCallArgTaintSource && Array.isArray(Rules.getRules()?.FuncCallArgTaintSource)) {
        Rules.getRules().FuncCallArgTaintSource.push(...FuncCallArgTaintSourceRules)
      } else {
        Rules.getRules().FuncCallArgTaintSource = FuncCallArgTaintSourceRules
      }
      if (
        Rules.getRules()?.FuncCallReturnValueTaintSource &&
        Array.isArray(Rules.getRules()?.FuncCallReturnValueTaintSource)
      ) {
        Rules.getRules().FuncCallReturnValueTaintSource.push(...FuncCallReturnValueTaintSourceRules)
      } else {
        Rules.getRules().FuncCallReturnValueTaintSource = FuncCallReturnValueTaintSourceRules
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
  triggerAtFunctionDefinition(analyzer, scope, node, state, info) {
    commonUtil.fillSourceScope(info.fclos, this.sourceScope)
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
    const calleeObject = fclos.object
    this.checkByNameAndClassMatch(node, fclos, argvalues, scope)
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(calleeObject, node, argvalues)

    if (config.entryPointMode === 'ONLY_CUSTOM') return
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
  collectRouteRegistry(callExpNode, calleeObject, argValues, scope, analyzer) {
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
    const routeFCloses = ginEntryPoint.collectRouteRegistry(callExpNode, calleeObject, argValues, scope)
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
  triggerAtFunctionCallAfter(analyzer, scope, node, state, info) {
    const { fclos, ret } = info
    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret)
  }

  /**
   * 每次运行完main后清空hash
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer, scope, node, state, info) {
    if (info?.entryPoint.functionName === 'main') ginEntryPoint.clearProcessedRouteRegistry()
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
    const rules = Rules.getRules()?.FuncCallTaintSink

    if (!rules || !argvalues) return
    const rule = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, scope).find((v) => v.kind === TARGET_RULES_KIND)

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
          const finding = Rules.getRule(CheckerId, node)
          this.resultManager.addNewFinding(nd, node, fclos, TAINT_TAG_NAME, finding, ruleName, matchedSanitizerTags)
        }
        return true
      }
    }
  }
}

module.exports = GinTaintChecker
