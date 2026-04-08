import type { CallInfo } from '../../engine/analyzer/common/call-args'

const _ = require('lodash')
const Checker = require('../common/checker')
const AstUtil = require('../../util/ast-util')
const SourceLine = require('../../engine/analyzer/common/source-line')
const entryPointConfig = require('../../engine/analyzer/common/current-entrypoint')
const RulesBasicHandler = require('../common/rules-basic-handler')
const Config = require('../../config')
const QidUnifyUtil = require('../../util/qid-unify-util')
const CallchainOutputStrategy = require('../common/output/callchain-output-strategy')

/**
 * basic class for callchain checker
 * This checker only detects sink matches and outputs call chains,
 * without checking for taint flow
 */
class CallchainChecker extends Checker {
  /**
   * constructor of CallchainChecker
   * @param resultManager
   * @param checkerId
   */
  constructor(resultManager: any, checkerId: any) {
    super(resultManager, checkerId)
    this.sinkRuleArray = undefined
    this.matchSinkRuleResultMap = new Map()
  }

  /**
   * 从 fclos 中提取文件路径（相对路径）
   * @param fclos
   */
  extractFilePath(fclos: any): string {
    const sourcefile = fclos?.ast?.node?.loc?.sourcefile || fclos?.loc?.sourcefile
    if (!sourcefile) return ''
    return this.toRelativePath(sourcefile)
  }

  /**
   * 从 state.callstack 中构建调用链信息
   * 每个元素包含 CallstackElement 的内容（type, nodeHash, funcDef, fullName）
   * 以及额外的可读信息（function, file, line, column）
   * 最后追加 sink 调用点（CallExpression node）的信息
   * @param callstack
   * @param sinkNode
   * @param sinkFclos
   */
  buildCallstackInfo(callstack: any[], sinkNode: any, sinkFclos: any): any[] {
    const result: any[] = []

    // 1. 记录从 entrypoint 到 sink 的函数调用链（与 sarif CallstackElement 统一）
    if (callstack && callstack.length > 0) {
      for (const fclos of callstack) {
        if (!fclos) continue

        const astNode = fclos.ast?.node
        const loc = astNode?.loc
        const sourcefile = this.extractFilePath(fclos)
        const funcName = astNode?.id?.name || fclos.name || fclos.sid || ''
        const qid = fclos.qid || ''

        const entry: any = {
          // CallstackElement 标准字段
          type: 0,
          nodeHash: astNode?._meta?.nodehash || null,
          fullName: qid ? QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(qid) : null,
          // 额外可读信息
          function: funcName,
          file: sourcefile,
          line: loc?.start?.line,
          column: loc?.start?.column,
        }

        if (loc?.start?.column) {
          entry.column = loc.start.column
        }

        result.push(entry)
      }
    }

    // 2. 记录 sink 调用点（CallExpression node）的信息
    if (sinkNode) {
      let sourcefile = ''
      let srcNode = sinkNode
      while (srcNode && !srcNode?.loc?.sourcefile) {
        srcNode = srcNode.parent
      }
      if (srcNode?.loc?.sourcefile) {
        sourcefile = this.toRelativePath(srcNode.loc.sourcefile)
      } else if (sinkFclos) {
        sourcefile = this.extractFilePath(sinkFclos)
      }
      const funcName = sinkNode?.id?.name || sinkFclos.name || sinkFclos.sid || ''
      result.push({
        // CallstackElement 标准字段
        type: 1,
        nodeHash: sinkNode?._meta?.nodehash || null,
        // sink 调用点信息
        fullName: QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(sinkFclos.qid) || null,
        function: funcName,
        file: sourcefile,
        line: sinkNode.loc?.start?.line,
        column: sinkNode.loc?.start?.column,
      })
    }

    return result
  }

  /**
   * 将绝对路径转换为相对路径
   * @param sourcefile
   */
  toRelativePath(sourcefile: string): string {
    if (!sourcefile) return ''
    if (Config.maindirPrefix && sourcefile.startsWith(Config.maindirPrefix)) {
      return sourcefile.substring(Config.maindirPrefix.length)
    }
    if (Config.maindir && sourcefile.startsWith(Config.maindir)) {
      return sourcefile.substring(Config.maindir.length)
    }
    return sourcefile
  }

  /**
   * 从 sink 调用节点 (CallExpression node) 中提取调用点信息
   * @param node
   * @param fclos
   */
  buildSinkCallSiteInfo(node: any, fclos: any): any {
    if (!node) return {}

    const { loc } = node
    // 获取 sourcefile，优先从 node 自身获取，再从 fclos 获取
    let sourcefile = ''
    let srcNode = node
    while (srcNode && !srcNode?.loc?.sourcefile) {
      srcNode = srcNode.parent
    }
    if (srcNode?.loc?.sourcefile) {
      sourcefile = this.toRelativePath(srcNode.loc.sourcefile)
    } else {
      sourcefile = this.extractFilePath(fclos)
    }

    const callExpr = AstUtil.getRawCode(node.callee || node).slice(0, 100)

    return {
      code: callExpr,
      file: sourcefile,
      line: loc?.start?.line,
      column: loc?.start?.column,
    }
  }

  /**
   * 将 state.callsites 转换为可读的调用点信息（路径转为相对路径）
   * callsites 中每个元素结构为 { code, nodehash, loc }
   * @param callsites
   * @param sinkNode
   */
  buildCallsitesInfo(callsites: any[], sinkNode: any): any[] {
    if (!callsites || callsites.length === 0) {
      return []
    }
    const result = callsites.map((site: any) => {
      let sourcefile = ''
      if (site?.loc?.sourcefile) {
        sourcefile = this.toRelativePath(site.loc.sourcefile)
      } else {
        sourcefile = this.extractFilePath(site)
      }

      return {
        code: site.code,
        nodeHash: site.nodeHash,
        file: sourcefile,
        line: site.loc.start.line,
        column: site.loc.start.column,
      }
    })
    // 2. 记录 sink 调用点（CallExpression node）的信息
    if (sinkNode) {
      let sourcefile = ''
      if (sinkNode?.loc?.sourcefile) {
        sourcefile = this.toRelativePath(sinkNode.loc.sourcefile)
      } else {
        sourcefile = this.extractFilePath(sinkNode)
      }
      result.push({
        code: AstUtil.getRawCode(sinkNode).slice(0, 100),
        nodeHash: sinkNode._meta?.nodehash,
        file: sourcefile,
        line: sinkNode.loc.start.line,
        column: sinkNode.loc.start.column,
      })
    }
    return result
  }

  /**
   * construct callchain finding detail info
   * @param finding
   */
  buildCallchainFindingDetail(finding: any): any {
    const callNode = finding.node
    const sinkRule = finding.ruleName
    const { fclos, callstack, callsites } = finding
    if (finding && callNode) {
      const trace = SourceLine.getNodeTrace(fclos, callNode)
      trace.tag = 'SINK: '
      trace.affectedNodeName = AstUtil.getRawCode(callNode?.callee || callNode).slice(0, 100)

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
        callSite: this.buildSinkCallSiteInfo(callNode, fclos),
      }

      finding.entrypoint = _.pickBy(
        _.clone(entryPointConfig.getCurrentEntryPoint()),
        (value: any) => !_.isObject(value)
      )

      finding.trace = [trace]
      finding.callstackInfo = this.buildCallstackInfo(callstack, callNode, fclos)
      finding.callsitesInfo = this.buildCallsitesInfo(callsites, callNode)
      finding.callstack = callstack
      finding.callsites = callsites
    }
    if (
      finding.callsites &&
      finding.callstack &&
      finding.callsites.length > 0 &&
      finding.callstack.length > 0 &&
      finding.callstack.length === finding.callsites.length
    ) {
      return finding
    }

    return null
  }

  /**
   * construct callchain finding object with detail info
   * @param checkerId
   * @param checkerDesc
   * @param node
   * @param fclos
   * @param ruleName
   * @param callstack
   * @param callsites
   */
  buildCallchainFinding(
    checkerId: any,
    checkerDesc: any,
    node: any,
    fclos: any,
    ruleName: any,
    callstack: any,
    callsites: any
  ): any {
    const callchainFinding = this.buildCallchainFindingObject(
      checkerId,
      checkerDesc,
      node,
      fclos,
      ruleName,
      callstack,
      callsites
    )
    return this.buildCallchainFindingDetail(callchainFinding)
  }

  /**
   * construct callchain finding object
   * @param checkerId
   * @param checkerDesc
   * @param node
   * @param fclos
   * @param ruleName
   * @param callstack
   * @param callsites
   */
  buildCallchainFindingObject(
    checkerId: any,
    checkerDesc: any,
    node: any,
    fclos: any,
    ruleName: any,
    callstack: any,
    callsites: any
  ): any {
    const callchainFinding = RulesBasicHandler.getFinding(checkerId, checkerDesc, node)
    callchainFinding.node = node
    callchainFinding.fclos = fclos
    callchainFinding.ruleName = ruleName
    callchainFinding.callstack = callstack
    callchainFinding.callsites = callsites
    return callchainFinding
  }

  /**
   *
   * @param node
   * @param callInfo
   * @param fclos
   * @param rule
   * @param state
   */
  findArgsAndAddNewFinding(node: any, callInfo: CallInfo | undefined, fclos: any, rule: any, state: any) {
    let ruleName = (rule as any).fsig
    if (typeof (rule as any).attribute !== 'undefined') {
      ruleName += `\nSINK Attribute: ${(rule as any).attribute}`
    }
    const callchainFinding = this.buildCallchainFinding(
      this.getCheckerId(),
      this.desc,
      node,
      fclos,
      ruleName,
      state?.callstack,
      state?.callsites
    )

    if (!CallchainOutputStrategy.isNewFinding(this.resultManager, callchainFinding)) return
    this.resultManager.newFinding(callchainFinding, CallchainOutputStrategy.outputStrategyId)
    return true
  }
}

module.exports = CallchainChecker
