import type { BaseAnalyzer } from '../../../engine/analyzer/common/base-analyzer'
import type { Scope, State, Value } from '../../../types/analyzer'
import type { Identifier } from '../../../types/uast'
const _ = require('lodash')
const Config = require('../../../config')
const CommonUtil = require('../../../util/common-util')
const IntroduceTaint = require('../common-kit/source-util')
const GoHttpEntryPoint = require('../../../engine/analyzer/golang/common/entrypoint-collector/go-http-default-entrypoint')
const AstUtil = require('../../../util/ast-util')
const logger = require('../../../util/logger')(__filename)
const TaintChecker = require('../taint-checker')

const TAINT_TAG_NAME_GO_HTTP = 'GO_INPUT'

/**
 * net/http taint_flow checker
 * 仅做 source 注入（*http.Request / *url.URL / url.Values）
 * 不做 entrypoint 自采集（net/http 路由形态多样，由现有 main / callgraph 兜底）
 */
class GoHttpTaintChecker extends TaintChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_go_http_input')
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
    this.addSourceTagForSourceScope(TAINT_TAG_NAME_GO_HTTP, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME_GO_HTTP, this.checkerRuleConfigContent)
  }

  /**
   * MemberAccess trigger（识别 r.URL 等字段 source）
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
   * Identifier trigger（识别自定义配置中的形参 / 局部变量 source）
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(
    analyzer: BaseAnalyzer,
    scope: Scope,
    node: Identifier,
    state: State,
    info: { res: Value }
  ): void {
    IntroduceTaint.introduceTaintAtIdentifier(analyzer, scope, node, info.res, this.sourceScope.value)
  }

  /**
   * FunctionCallAfter trigger（识别 .Query() / .Get() / .FormValue() 返回值 source）
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
    // 链式调用补偿：fclos.rtype.definiteType 为根 receiver 而非中间返回类型，
    // 导致标准 calleeType 匹配失败。后续应在 source-util 层为链式调用的
    // 中间返回类型建模（如 .Query() → url.Values），替代此 checker 层补偿。
    if (
      ret &&
      !ret.taint?.hasTraces() &&
      node?.callee?.type === 'MemberAccess' &&
      node?.callee?.object?.type === 'CallExpression' &&
      AstUtil.prettyPrint(fclos?.rtype?.definiteType) === '*http.Request'
    ) {
      const propName = node.callee.property?.name
      if (propName === 'Get' || propName === 'FormValue' || propName === 'PostFormValue') {
        IntroduceTaint.markTaintSource(ret, { path: node, kind: TAINT_TAG_NAME_GO_HTTP })
      }
    }
  }

  /**
   * FunctionDefinition trigger（填充 sourceScope，跨函数 source 复用）
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
   * 把 net/http default source 并入 checkerRuleConfigContent.sources
   * 与 user rule-config 中的 source 共存（不去重，gin 路径同款行为）
   * @param analyzer
   * @param topScope
   */
  prepareEntryPoints(analyzer: any, topScope: any) {
    const { sources: ruleConfigSources } = this.checkerRuleConfigContent || {}

    const {
      TaintSource: TaintSourceRules,
      FuncCallArgTaintSource: FuncCallArgTaintSourceRules,
      FuncCallReturnValueTaintSource: FuncCallReturnValueTaintSourceRules,
    } = ruleConfigSources || {}

    if (Config.entryPointMode === 'ONLY_CUSTOM') return

    const { TaintSource, FuncCallArgTaintSource, FuncCallReturnValueTaintSource } =
      GoHttpEntryPoint.getGoHttpEntryPointAndSource()

    if (
      _.isEmpty(TaintSource) &&
      _.isEmpty(FuncCallArgTaintSource) &&
      _.isEmpty(FuncCallReturnValueTaintSource) &&
      _.isEmpty(TaintSourceRules) &&
      _.isEmpty(FuncCallArgTaintSourceRules) &&
      _.isEmpty(FuncCallReturnValueTaintSourceRules)
    ) {
      logger.info('[go-http-taint-checker]TaintSource are not found')
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

    if (!_.isEmpty(FuncCallReturnValueTaintSource)) {
      this.checkerRuleConfigContent.sources = this.checkerRuleConfigContent.sources || {}
      this.checkerRuleConfigContent.sources.FuncCallReturnValueTaintSource =
        this.checkerRuleConfigContent.sources.FuncCallReturnValueTaintSource || []
      this.checkerRuleConfigContent.sources.FuncCallReturnValueTaintSource = Array.isArray(
        this.checkerRuleConfigContent.sources.FuncCallReturnValueTaintSource
      )
        ? this.checkerRuleConfigContent.sources.FuncCallReturnValueTaintSource
        : [this.checkerRuleConfigContent.sources.FuncCallReturnValueTaintSource]
      this.checkerRuleConfigContent.sources.FuncCallReturnValueTaintSource.push(...FuncCallReturnValueTaintSource)
    }
  }
}

module.exports = GoHttpTaintChecker
