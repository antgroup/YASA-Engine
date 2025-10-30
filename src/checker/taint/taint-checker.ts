const _ = require('lodash')
const Checker = require('../common/checker')
const TaintCheckerAstUtil = require('../../util/ast-util')
const TaintCheckerFindingUtil = require('../../util/finding-util')
const TaintCheckerSourceLine = require('../../engine/analyzer/common/source-line')
const entryPointConfig = require('../../engine/analyzer/common/current-entrypoint')
const TaintCheckerRules = require('../common/rules-basic-handler')
const taintCheckerCommonUtil = require('../../util/common-util')

/**
 * basic class for taint-flow checker
 */
class TaintChecker extends Checker {
  sourceScope: any

  /**
   * constructor of TaintChecker
   * @param resultManager
   * @param checkerId
   */
  constructor(resultManager: any, checkerId: any) {
    super(resultManager, checkerId)
    this.sourceScope = {
      complete: false,
      value: [],
    }
    taintCheckerCommonUtil.initSourceScope(this.sourceScope, this.checkerRuleConfigContent.sources?.TaintSource)
  }

  /**
   * construct Taint flow finding detail info
   * @param finding
   */
  buildTaintFindingDetail(finding: any): any {
    const argNode = finding.nd
    const tagName = finding.kind
    const callNode = finding.node
    const sinkRule = finding.ruleName
    const { fclos, matchedSanitizerTags } = finding
    if (finding && argNode && argNode.hasTagRec) {
      let traceStack = TaintCheckerFindingUtil.getTrace(argNode, tagName)
      const trace = TaintCheckerSourceLine.getNodeTrace(fclos, callNode)
      // 暂时统一去掉Field，不然展示出来的链路会重复
      traceStack = traceStack.filter((item: any) => item.tag !== 'Field: ')
      for (const i in traceStack) {
        if (traceStack[i].tag === 'Return value: ') {
          traceStack[i].tag = 'Return Value: '
        }
      }
      finding.trace = traceStack
      trace.tag = 'SINK: '
      trace.affectedNodeName = TaintCheckerAstUtil.prettyPrint(callNode?.callee)
      const arr = sinkRule.split('\nSINK Attribute: ')
      if (arr.length === 1) {
        finding.sinkRule = arr[0]
      } else if (arr.length === 2) {
        finding.sinkRule = arr[0]
        finding.sinkAttribute = arr[1]
      }
      finding.sinkInfo = {
        sinkRule: finding.sinkRule,
        sinkAttribute: finding.sinkAttribute,
      }
      finding.entrypoint = _.pickBy(
        _.clone(entryPointConfig.getCurrentEntryPoint()),
        (value: any) => !_.isObject(value)
      )
      finding.trace.push(trace)
      finding.matchedSanitizerTags = matchedSanitizerTags
    }
    this.filterDuplicateSource(finding)
    return finding
  }

  /**
   * 去掉链路中重复的source，以免链路可读性降低
   * @param finding
   */
  filterDuplicateSource(finding: any): void {
    if (!finding || !finding.trace || !Array.isArray(finding.trace)) return
    const newTrace = []
    for (const key in finding.trace) {
      if (
        Number(key) > 1 &&
        (finding.trace[key].tag === 'SOURCE: ' ||
          (typeof finding.trace[key].str === 'string' && finding.trace[key].str.includes('SOURCE: ')))
      ) {
        continue
      }
      newTrace.push(finding.trace[key])
    }
    finding.trace = newTrace
  }

  /**
   * construct taint flow finding object with detail info
   * @param checkerId
   * @param checkerDesc
   * @param node
   * @param nd
   * @param fclos
   * @param kind
   * @param ruleName
   * @param matchedSanitizerTags
   */
  buildTaintFinding(
    checkerId: any,
    checkerDesc: any,
    node: any,
    nd: any,
    fclos: any,
    kind: any,
    ruleName: any,
    matchedSanitizerTags: any
  ): any {
    const taintFlowFinding = this.buildTaintFindingObject(
      checkerId,
      checkerDesc,
      node,
      nd,
      fclos,
      kind,
      ruleName,
      matchedSanitizerTags
    )
    return this.buildTaintFindingDetail(taintFlowFinding)
  }

  /**
   * construct taint flow finding object
   * @param checkerId
   * @param checkerDesc
   * @param node
   * @param nd
   * @param fclos
   * @param kind
   * @param ruleName
   * @param matchedSanitizerTags
   */
  buildTaintFindingObject(
    checkerId: any,
    checkerDesc: any,
    node: any,
    nd: any,
    fclos: any,
    kind: any,
    ruleName: any,
    matchedSanitizerTags: any
  ): any {
    const taintFlowFinding = TaintCheckerRules.getFinding(checkerId, checkerDesc, node)
    taintFlowFinding.nd = nd
    taintFlowFinding.node = node
    taintFlowFinding.fclos = fclos
    taintFlowFinding.kind = kind
    taintFlowFinding.ruleName = ruleName
    taintFlowFinding.matchedSanitizerTags = matchedSanitizerTags
    return taintFlowFinding
  }

  /**
   *
   * @param tagName
   * @param sources
   */
  addSourceTagForSourceScope(tagName: string, sources: any): void {
    if (!sources || !tagName) return
    if (Array.isArray(sources) && sources.length > 0) {
      for (const source of sources) {
        source.kind = source.kind || []
        source.kind = Array.isArray(source.kind) ? source.kind : [source.kind]
        if (!source.kind.includes(tagName)) {
          source.kind.push(tagName)
        }
      }
    }
  }

  /**
   *
   * @param tagName
   * @param checkerRuleConfigContent
   */
  addSourceTagForcheckerRuleConfigContent(tagName: string, checkerRuleConfigContent: any): void {
    if (!tagName) return
    if (
      Array.isArray(checkerRuleConfigContent.sources?.TaintSource) &&
      checkerRuleConfigContent.sources?.TaintSource.length > 0
    ) {
      for (const source of checkerRuleConfigContent.sources?.TaintSource) {
        source.kind = source.kind || []
        source.kind = Array.isArray(source.kind) ? source.kind : [source.kind]
        if (!source.kind.includes(tagName)) {
          source.kind.push(tagName)
        }
      }
    }
    if (
      Array.isArray(checkerRuleConfigContent.sources?.FuncCallArgTaintSource) &&
      checkerRuleConfigContent.sources?.FuncCallArgTaintSource.length > 0
    ) {
      for (const source of checkerRuleConfigContent.sources?.FuncCallArgTaintSource) {
        source.kind = source.kind || []
        source.kind = Array.isArray(source.kind) ? source.kind : [source.kind]
        if (!source.kind.includes(tagName)) {
          source.kind.push(tagName)
        }
      }
    }
    if (
      Array.isArray(checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource) &&
      checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource.length > 0
    ) {
      for (const source of checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource) {
        source.kind = source.kind || []
        source.kind = Array.isArray(source.kind) ? source.kind : [source.kind]
        if (!source.kind.includes(tagName)) {
          source.kind.push(tagName)
        }
      }
    }
  }
}

module.exports = TaintChecker
