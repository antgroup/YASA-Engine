const _ = require('lodash')
const commonUtil = require('../../../util/common-util')
const goEntryPoint = require('../../../engine/analyzer/golang/common/entrypoint-collector/go-default-entrypoint')
const { completeEntryPoint } = require('./entry-points-util')
const { initRules } = require('../../common/rules-basic-handler')
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

const CheckerId = 'taint_flow_go_input'
const TAINT_TAG_NAME = 'GO_INPUT'
const TARGET_RULES_KIND = 'GO_INPUT'
/**
 * Go framework checker
 */
class GoDefaultTaintChecker {
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
    this.prepareEntryPoints(topScope, analyzer)
    analyzer.mainEntryPoints = this.entryPoints
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

    // 使用callgraph边界+file作为entrypoint
    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
      const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
        analyzer.ainfo?.callgraph
      )
      this.entryPoints.push(...fullCallGraphEntrypoint)
    }

    // 使用用户规则中指定的entrypoint
    const { RouterPath: routers } = Rules.getRules() || {}
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
          logger.info('[go-default-taint-checker]entryPoint is not found')

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
    IntroduceTaint.introduceTaintAtMemberAccess(info.res, node, scope)
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
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(calleeObject, node, argvalues)
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
