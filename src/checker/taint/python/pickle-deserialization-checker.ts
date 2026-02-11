const IntroduceTaint = require('../common-kit/source-util')
const TaintChecker = require('../taint-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
const CommonUtil = require('../../../util/common-util')

const TAINT_TAG = 'CROSS_BOUNDARY_DATA'
const CHECKER_ID = 'pickle_deserialization_checker'

/**
 *
 */
class PickleDeserializationChecker extends TaintChecker {
  entryPoints: any[]

  /**
   *
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, CHECKER_ID)
    this.entryPoints = []
    this.initRules()
  }

  /**
   *
   */
  initRules(): void {
    this.checkerRuleConfigContent.sources = {}
    this.checkerRuleConfigContent.sinks = {}
  }

  /**
   *
   * @param analyzer
   */
  triggerAtStartOfAnalyze(analyzer: any): void {
    this.prepareEntryPoints(analyzer)
    analyzer.entryPoints.push(...this.entryPoints)
  }

  /**
   *
   * @param analyzer
   */
  prepareEntryPoints(analyzer: any): void {
    const epHelper = require('../../common/full-callgraph-file-entrypoint')
    epHelper.makeFullCallGraph(analyzer)
    this.entryPoints.push(...epHelper.getAllEntryPointsUsingCallGraph(analyzer.ainfo?.callgraph))
    this.entryPoints.push(...epHelper.getAllFileEntryPointsUsingFileManager(analyzer.fileManager))

    CommonUtil.initSourceScopeByTaintSourceWithLoc(this.sourceScope, this.checkerRuleConfigContent.sources?.TaintSource)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos, argvalues } = info
    if (this.isSink(node)) {
      const arg0 = argvalues?.[0]
      if (arg0?._tags?.has(TAINT_TAG)) {
        const finding = this.buildTaintFinding(
          CHECKER_ID,
          this.desc,
          node,
          arg0,
          fclos,
          TAINT_TAG,
          'pickle.loads\nSINK Attribute: UnsafeDeserialization',
          [],
          undefined
        )
        if (TaintOutputStrategy.isNewFinding(this.resultManager, finding)) {
          this.resultManager.newFinding(finding, TaintOutputStrategy.outputStrategyId)
        }
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
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos, ret } = info

    if (this.isSource(node) && ret) {
      IntroduceTaint.setTaint(ret, [TAINT_TAG])
      ret.trace = ret.trace || []
      ret.trace.push({ node, type: 'SOURCE' })
    }
    if (fclos?.object?._tags?.has(TAINT_TAG) && ret) {
      IntroduceTaint.setTaint(ret, [TAINT_TAG])
      if (fclos.object.trace && !ret.trace) {
        ret.trace = fclos.object.trace
      }
    }
  }

  /**
   *
   * @param node
   */
  isSource(node: any): boolean {
    const callee = node?.callee
    // if (!callee || callee.type !== 'MemberAccess') return false

    // // method name must be recv
    // if (callee.property?.name !== 'recv') return false

    // object must be self.remote_socket
    // const obj = callee.object
    // return obj?.type === 'MemberAccess' && obj.object?.name === 'self' && obj.property?.name === 'remote_socket'
    return callee?.type === 'MemberAccess' && callee?.property?.name === 'socket'
  }

  /**
   *
   * @param node
   */
  isSink(node: any): boolean {
    const callee = node?.callee
    return callee?.type === 'MemberAccess' && callee?.object?.name === 'pickle' && callee?.property?.name === 'loads'
  }
}

module.exports = PickleDeserializationChecker
