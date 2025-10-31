const _ = require('lodash')
const Uuid = require('node-uuid')
const Config = require('../../../config')
const LocationUtil = require('../util/location-util')
const AstUtil = require('../../../util/ast-util')
const SourceUtil = require('../../taint/common-kit/source-util')
const EntrypointUtil = require('../util/entrypoint-util')
const FindingUtil = require('../../../util/finding-util')
const SourceLine = require('../../../engine/analyzer/common/source-line')
const BasicRuleHandler = require('../../common/rules-basic-handler')
const TaintChecker = require('../../taint/taint-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
const InteractiveOutputStrategy = require('../../common/output/interactive-output-strategy')

const TaintName = 'ANTQL'

/**
 *x
 */
class AntQLHasFlow extends TaintChecker {
  mng: any

  kit: any

  status: boolean

  output: any

  alreadyExecutedEntries: Map<string, any>

  sourceLocs!: string[]

  sinkLocs!: string[]

  sourceSymbol!: Record<string, any>

  sourceTag!: Record<string, string>

  sinkSymbol!: Record<string, any>

  /**
   *
   * @param mng
   */
  constructor(mng: any) {
    super(mng, 'antql_hasflow')
    this.mng = mng
    this.kit = mng.kit
    this.status = false
    this.output = {}
    this.alreadyExecutedEntries = new Map()
  }

  /**
   * 配置输出策略
   */
  getStrategyId(): string[] {
    return [InteractiveOutputStrategy.outputStrategyId, TaintOutputStrategy.outputStrategyId]
  }

  /**
   * 处理输入，0 = source，1 = sink
   * @param args
   */
  handleInput(args: any[]): void {
    if (!Array.isArray(args) || args.length !== 2) {
      return
    }
    this.sourceLocs = args[0].split(',')
    this.sinkLocs = args[1].split(',')

    // 初始化，记录所有的source符号值
    this.sourceSymbol = {}
    for (const sourceLoc of this.sourceLocs) {
      this.sourceSymbol[sourceLoc] = ''
    }

    // 初始化，记录最新的污点值
    this.sourceTag = {}
    for (const sourceLoc of this.sourceLocs) {
      this.sourceTag[sourceLoc] = ''
    }

    // 初始化，记录sink的符号值
    this.sinkSymbol = {}
    for (const sinkLoc of this.sinkLocs) {
      this.sinkSymbol[sinkLoc] = ''
    }
    this.output = {}
    this.status = true
  }

  /**
   * 清除每个entrypoint的缓存信息
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (this.status) {
      this.refreshCtx()
    }
  }

  /**
   *
   */
  refreshCtx(): void {
    for (const sourceLoc in this.sourceSymbol) {
      const symbol = this.sourceSymbol[sourceLoc]
      if (symbol !== '') {
        symbol._has_tags = undefined
        symbol.hasTagRec = undefined
        symbol._tags = undefined
        symbol.trace = undefined
        symbol.value = {}
        // symbol.misc_ = {}
      }
      this.sourceSymbol[sourceLoc] = ''
      this.sourceTag[sourceLoc] = ''
    }
  }

  /**
   * 处理输出
   * @param success
   * @param message
   * @param body
   */
  handleOutput(success: any, message: any, body: any): void {
    this.status = false
    this.refreshCtx()
  }

  /**
   * 通过callgraph获取entrypoint
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (!this.status) {
      return
    }
    analyzer.entryPoints = []
    const fullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
    // fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
    const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getEntryPointsUsingCallGraphByLoc(
      LocationUtil.convertQLLocationStringListToUastLocation(this.sourceLocs, Config.prefixPath),
      analyzer.ainfo?.callgraph,
      analyzer.fileManager
    )
    const uniqueEntries = EntrypointUtil.mergeEntryPoints(fullCallGraphEntrypoint, analyzer.entryPoints)
    analyzer.entryPoints = Array.from(uniqueEntries.values())
    this.refreshCtx()
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtEndOfNode(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (!this.status) {
      return
    }
    this.checkIsSource(node, info.val, scope, state)
    this.checkIsSink(node, info.val, scope, state)
  }

  /**
   *
   * @param unit
   * @param root0
   * @param root0.node
   * @param root0.kind
   */
  markTaintSource(unit: any, { node, kind }: { node: any; kind: string }): void {
    SourceUtil.setTaint(unit, kind)
    if (
      unit.trace &&
      Array.isArray(unit.trace) &&
      (unit.trace[0]?.tag !== 'SOURCE: ' ||
        (typeof unit.trace[0]?.str === 'string' && !unit.trace[0].str.includes('SOURCE: ')))
    ) {
      unit.trace = undefined
    } else {
      const startLine = node?.loc?.start?.line
      const endLine = node?.loc?.end?.line
      const tline = startLine === endLine ? startLine : _.range(startLine, endLine + 1)
      const trace = {
        file: node?.loc?.sourcefile,
        line: tline,
        node,
        tag: 'SOURCE: ',
        affectedNodeName: AstUtil.prettyPrint(node),
      }

      if (!unit.trace) {
        unit.trace = []
      }
      unit.trace.push(trace)
    }
  }

  /**
   * 判断source
   * @param node
   * @param res
   * @param scope
   * @param info
   */
  checkIsSource(node: any, res: any, scope: any, info: any): void {
    let isSourceFlag = false
    const nodeLoc = LocationUtil.findUastLocationInList(node?.loc, this.sourceLocs, Config.prefixPath)
    // if (this.sourceLocs && this.sourceLocs.includes(nodeLoc)){
    //   isSourceFlag = true
    // }
    if (nodeLoc) {
      isSourceFlag = true
    }

    if (isSourceFlag) {
      if (this.sourceSymbol[nodeLoc] === '') {
        const sourceTag = `${TaintName}_${Uuid.v4()}`
        this.markTaintSource(res, { node, kind: sourceTag })

        this.sourceSymbol[nodeLoc] = res
        this.sourceTag[nodeLoc] = sourceTag
      }
    }
  }

  /**
   * 判断taint
   * @param node
   * @param res
   * @param scope
   * @param info
   */
  checkIsSink(node: any, res: any, scope: any, info: any): void {
    let isSinkFlag = false
    const nodeLoc = LocationUtil.findUastLocationInList(node?.loc, this.sinkLocs, Config.prefixPath)
    if (nodeLoc) {
      isSinkFlag = true
    }

    if (isSinkFlag) {
      const fclos = info?.callstack[info.callstack.length - 1 > 0 ? info.callstack.length - 1 : 0]
      for (const sourceLoc in this.sourceTag) {
        const tag = this.sourceTag[sourceLoc]
        if (tag === '') {
          continue
        }
        const sourceNodes = AstUtil.findTag(res, tag, true)
        if (!sourceNodes) {
          continue
        }
        for (const sourceNode of sourceNodes) {
          this.addQLFinding(node, nodeLoc, sourceNode, sourceLoc, fclos, tag)
        }
      }
    }
  }

  /**
   *
   * @param currentNode
   * @param currentNodeLoc
   * @param sourceNode
   * @param sourceLoc
   * @param fclos
   * @param tag
   */
  addQLFinding(
    currentNode: any,
    currentNodeLoc: string,
    sourceNode: any,
    sourceLoc: string,
    fclos: any,
    tag: string
  ): any {
    const finding = BasicRuleHandler.getFinding(this.getCheckerId(), this.desc, currentNode)
    // const finding = this.mng.newFinding(this.getCheckerId(), currentNode, currentNode.loc, sourceNode, fclos.id)
    if (finding && sourceNode.hasTagRec) {
      const sourceTrace = FindingUtil.getTrace(sourceNode, tag)
      if (sourceTrace.length > 0) {
        let flag = false
        let calcTrace: any[] = []

        for (const index in sourceTrace) {
          const trace = sourceTrace[index]
          if (trace?.tag !== 'SOURCE: ') {
            continue
          }
          if (LocationUtil.findUastLocationInList(trace?.node?.loc, [sourceLoc], Config.prefixPath)) {
            flag = true
            calcTrace = sourceTrace.slice(index, sourceTrace.length)
            break
          }
        }
        if (!flag) {
          return
        }

        const attribute = `${sourceLoc};${currentNodeLoc}`
        const cliFinding: any = {
          output: attribute,
        }
        this.resultManager.newFinding(cliFinding, InteractiveOutputStrategy.outputStrategyId)
        // sarif结果中记录sourceLoc 和 sinkLoc，用于合并sarif结果
        finding.desc = sourceLoc
        finding.sinkInfo = {
          sinkRes: attribute,
        }
        finding.issuecause = attribute
        finding.trace = calcTrace
        // finding.sinkInfo.sinkRes = attribute
        const trace = SourceLine.getNodeTrace(fclos, currentNode)
        trace.tag = 'SINK: '
        trace.affectedNodeName = AstUtil.prettyPrint(currentNode?.callee)
        finding.trace.push(trace)
        // finding.entrypoint = _.pickBy(_.clone(entryPointConfig.getCurrentEntryPoint()), (value) => !_.isObject(value))
      }
      if (!TaintOutputStrategy.isNewFinding(this.resultManager, finding)) return
      this.resultManager.newFinding(finding, TaintOutputStrategy.outputStrategyId)
      return finding
    }
  }
}

module.exports = AntQLHasFlow
