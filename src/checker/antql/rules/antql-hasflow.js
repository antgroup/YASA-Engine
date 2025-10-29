const _ = require('lodash')
const pathMod = require('path')
const uuid = require('node-uuid')
const Config = require('../../../config')
const fileUtil = require('../../../util/file-util')
const locationUtil = require('../util/location-util')
const astUtil = require('../../../util/ast-util')
const sourceUtil = require('../../taint/common-kit/source-util')
const entrypointUtil = require('../util/entrypoint-util')
const findingUtil = require('../../../util/finding-util')
const sourceLine = require('../../../engine/analyzer/common/source-line')
const Rules = require('../../common/rules-basic-handler')
const Checker = require('../../common/checker')
const TaintChecker = require('../../taint/taint-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
const InteractiveOutputStrategy = require(
  '../../common/output/interactive-output-strategy')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')

const TaintName = 'ANTQL'

/**
 *x
 */
class AntQLHasFlow extends TaintChecker {
  /**
   *
   * @param mng
   */
  constructor(mng) {
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
  getStrategyId() {
    return [InteractiveOutputStrategy.outputStrategyId, TaintOutputStrategy.outputStrategyId]
  }

  /**
   * 处理输入，0 = source，1 = sink
   * @param args
   */
  handleInput(args) {
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
  triggerAtSymbolInterpretOfEntryPointBefore(analyzer, scope, node, state, info) {
    if (this.status) {
      this.refreshCtx()
    }
  }

  /**
   *
   */
  refreshCtx() {
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
  handleOutput(success, message, body) {
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
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
    if (!this.status) {
      return
    }
    analyzer.entryPoints = []
    const fullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
    // fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
    const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getEntryPointsUsingCallGraphByLoc(
      locationUtil.convertQLLocationStringListToUastLocation(this.sourceLocs, Config.prefixPath),
      analyzer.ainfo?.callgraph,
      analyzer.fileManager
    )
    const uniqueEntries = entrypointUtil.mergeEntryPoints(fullCallGraphEntrypoint, analyzer.entryPoints)
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
  triggerAtEndOfNode(analyzer, scope, node, state, info) {
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
  markTaintSource(unit, { node, kind }) {
    sourceUtil.setTaint(unit, kind)
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
        affectedNodeName: astUtil.prettyPrint(node),
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
  checkIsSource(node, res, scope, info) {
    let isSourceFlag = false
    const nodeLoc = locationUtil.findUastLocationInList(node?.loc, this.sourceLocs, Config.prefixPath)
    // if (this.sourceLocs && this.sourceLocs.includes(nodeLoc)){
    //   isSourceFlag = true
    // }
    if (nodeLoc) {
      isSourceFlag = true
    }

    if (isSourceFlag) {
      if (this.sourceSymbol[nodeLoc] === '') {
        const sourceTag = `${TaintName}_${uuid.v4()}`
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
  checkIsSink(node, res, scope, info) {
    let isSinkFlag = false
    const nodeLoc = locationUtil.findUastLocationInList(node?.loc, this.sinkLocs, Config.prefixPath)
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
        const sourceNodes = astUtil.findTag(res, tag, true)
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
  addQLFinding(currentNode, currentNodeLoc, sourceNode, sourceLoc, fclos, tag) {
    const finding = Rules.getFinding(this.getCheckerId(), this.desc, currentNode)
    // const finding = this.mng.newFinding(this.getCheckerId(), currentNode, currentNode.loc, sourceNode, fclos.id)
    if (finding && sourceNode.hasTagRec) {
      const sourceTrace = findingUtil.getTrace(sourceNode, tag)
      if (sourceTrace.length > 0) {
        let flag = false
        let calcTrace = []

        for (const index in sourceTrace) {
          const trace = sourceTrace[index]
          if (trace?.tag !== 'SOURCE: ') {
            continue
          }
          if (locationUtil.findUastLocationInList(trace?.node?.loc, [sourceLoc], Config.prefixPath)) {
            flag = true
            calcTrace = sourceTrace.slice(index, sourceTrace.length)
            break
          }
        }
        if (!flag) {
          return
        }

        const attribute = `${sourceLoc};${currentNodeLoc}`
        const cliFinding = {
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
        const trace = sourceLine.getNodeTrace(fclos, currentNode)
        trace.tag = 'SINK: '
        trace.affectedNodeName = astUtil.prettyPrint(currentNode?.callee)
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
