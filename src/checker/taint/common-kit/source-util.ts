import { buildNewValueInstance } from '../../../util/clone-util'
import { getLegacyArgValues, type CallInfo } from '../../../engine/analyzer/common/call-args'

const _ = require('lodash')
const AstUtil = require('../../../util/ast-util')
const { prepareArgs, matchField } = require('../../common/rules-basic-handler')
const BasicRuleHandler = require('../../common/rules-basic-handler')
const { Scope } = require('../../../engine/analyzer/common')
const QidUnifyUtil = require('../../../util/qid-unify-util')

import { SymbolValue } from '../../../engine/analyzer/common/value/symbolic'

// 全局统计：实际标记的 source 数量
let markedSourceCount = 0

/**
 *
 */
function getMarkedSourceCount(): number {
  return markedSourceCount
}

/**
 *
 */
function resetMarkedSourceCount(): void {
  markedSourceCount = 0
}

/**
 *
 * @param res
 * @param tagType
 */
function setTaint(res: any, tagType: any): void {
  // taint 在 Unit 构造函数中已创建
  if (Array.isArray(tagType)) {
    for (const item of tagType) {
      res.taint.addTag(item)
    }
  } else if (tagType) {
    res.taint.addTag(tagType)
  }
}

/**
 *
 * @param unit
 * @param root0
 * @param root0.path
 * @param root0.kind
 */
function markTaintSource(unit: any, { path, kind }: { path: any; kind: any }): void {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return
  }
  setTaint(unit, kind)
  markedSourceCount++ // 统计实际标记的 source
  // 如果已有 trace 但首项不是 SOURCE，清空 trace
  const existingTrace = unit.taint.getFirstTrace()
  if (existingTrace && Array.isArray(existingTrace) && existingTrace[0]?.tag !== 'SOURCE: ') {
    unit.taint.clearTrace()
  }
  if (!unit.taint.hasTraces()) {
    const start_line = path?.loc?.start?.line
    const end_line = path?.loc?.end?.line
    const tline = start_line === end_line ? start_line : _.range(start_line, end_line + 1)
    const traceItem = {
      file: path?.loc?.sourcefile,
      line: tline,
      node: path,
      tag: 'SOURCE: ',
      affectedNodeName: AstUtil.prettyPrint(path),
    }
    unit.taint.setAllTraces([traceItem])
  }
}

/**
 *
 * @param scope
 * @param node
 * @param res
 * @param funcCallReturnValueTaintSource
 */
function introduceTaintAtFuncCallReturnValue(
  scope: any,
  node: any,
  res: any,
  funcCallReturnValueTaintSource: any
): void {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return
  }
  const rules = funcCallReturnValueTaintSource
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
    return
  }
  const call = node
  for (const tspec of rules) {
    if (tspec.fsig) {
      const marray = tspec.fsig.split('.')
      if (call.callee?.type === 'MemberAccess') {
        // 要考虑call.callee?.property 也会有memberaccess和identifier的情况
        if (
          (matchField(call.callee?.property, marray, marray.length - 1) ||
            matchField(call.callee, marray, marray.length - 1)) &&
          (AstUtil.prettyPrint(scope?.rtype?.definiteType) === tspec.calleeType || tspec.calleeType === '*')
        ) {
          markTaintSource(res, { path: node, kind: tspec.kind })
          break
        }
      } else if (call.callee?.type === 'Identifier') {
        if (call.callee.name === tspec.fsig) {
          markTaintSource(res, { path: node, kind: tspec.kind })
          break
        }
      }
    }
  }
}

/**
 *
 * @param scope
 * @param node
 * @param callInfo
 * @param funcCallArgTaintSource
 */
function introduceFuncArgTaintByRuleConfig(scope: any, node: any, callInfo: CallInfo | undefined, funcCallArgTaintSource: any): void {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return
  }
  const argvalues = getLegacyArgValues(callInfo)
  const rules = funcCallArgTaintSource
  if (rules && Array.isArray(rules) && rules.length > 0) {
    const call = node
    for (const tspec of rules) {
      if (tspec.fsig) {
        const marray = tspec.fsig.split('.')
        if (call.callee?.type === 'MemberAccess' && _.isArray(argvalues)) {
          if (
            (matchField(call.callee?.property, marray, marray.length - 1) ||
              matchField(call.callee, marray, marray.length - 1)) &&
            (AstUtil.prettyPrint(scope?.rtype) === tspec.calleeType || tspec.calleeType === '*')
          ) {
            const args = prepareArgs(callInfo, undefined, tspec)
            for (let i = 0; i < args.length; i++) {
              markTaintSource(args[i], { path: node, kind: tspec.kind })
            }
          }
        } else if (call.callee?.type === 'Identifier') {
          if (call.callee.name === tspec.fsig) {
            const args = prepareArgs(callInfo, undefined, tspec)
            for (let i = 0; i < args.length; i++) {
              markTaintSource(args[i], { path: node, kind: tspec.kind })
            }
            break
          }
        }
      }
    }
  }
}

/**
 *
 * @param analyzer
 * @param scope
 * @param node
 * @param res
 * @param sourceScopeVal
 */
function introduceTaintAtIdentifier(analyzer: any, scope: any, node: any, res: any, sourceScopeVal: any): any {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return res
  }
  const nodeStart = node.loc?.start?.line
  const nodeEnd = node.loc?.end?.line

  const alreadyTainted = res.taint?.hasTags()
  let target = res

  if (sourceScopeVal && sourceScopeVal.length > 0) {
    for (const val of sourceScopeVal) {
      const paths = val.path
      if (
        res.sid === paths ||
        res.qid === paths ||
        QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(res.qid) === paths ||
        node.name === paths
      ) {
        const valStart = val.locStart
        const valEnd = val.locEnd
        if (typeof valStart === 'undefined' || typeof valEnd === 'undefined') {
          continue
        }
        let shouldMark = false
        if (valStart === 'all' && valEnd === 'all' && val.scopeFile === 'all' && val.scopeFunc === 'all') {
          shouldMark = true
        } else if (valStart === 'all' && valEnd === 'all' && val.scopeFile !== 'all' && val.scopeFunc === 'all') {
          if (typeof node.loc.sourcefile === 'string' && node.loc.sourcefile.includes(val.scopeFile)) {
            shouldMark = true
          }
        } else if (node.loc.sourcefile.includes(val.scopeFile) && nodeStart >= valStart && nodeEnd <= valEnd) {
          shouldMark = true
        }

        if (shouldMark) {
          // 只有全局标识符 source（如 request）才需要拷贝。
          // 路由函数参数等局部 source（locStart/locEnd 为具体行号）不需要拷贝。
          const isGlobalIdentifierSource = valStart === 'all' && valEnd === 'all'
          // 局部 source：子值已持有该 kind 的 tag 时跳过，避免 φ 合并后重复标记
          const kinds = Array.isArray(val.kind) ? val.kind : [val.kind]
          if (!isGlobalIdentifierSource && kinds.some((k: string) => target.taint?.containsTag(k))) {
            continue
          }
          if (alreadyTainted && target === res && isGlobalIdentifierSource) {
            target = buildNewValueInstance(
              analyzer,
              res,
              node,
              scope,
              () => false,
              () => false,
              1,
              { skipTagTraceMap: true }
            )
          }
          markTaintSource(target, { path: node, kind: val.kind })
        }
      }
    }
  }
  return target
}

/**
 *
 * @param res
 * @param scope
 * @param node
 * @param taintSource
 */
function introduceTaintAtMemberAccess(res: any, node: any, scope: any, taintSource: any): void {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return
  }
  const sources = taintSource
  if (sources === null || sources === undefined || !Array.isArray(sources) || sources.length === 0) {
    return
  }
  for (const tspec of sources) {
    if (tspec.className === AstUtil.prettyPrint(scope.rtype) && tspec.path === node.property.name) {
      markTaintSource(res, { path: node, kind: tspec.kind })
    }
  }
}

/**
 * match value node with "xx.yy.zz...", invoke mark callback function if matched
 * @param paths
 * @param scp
 * @param rule
 * @param mark_cb
 * @param createIfNotExists
 */
function matchAndMark(paths: any, scp: any, rule: any, mark_cb: any, createIfNotExists: any): void {
  if (paths?.length === 0) {
    mark_cb(scp, rule)
    return
  }

  const path = paths.shift()
  if (path === '*') {
    if (scp.members) {
      for (const i of scp.members.keys()) {
        const u = scp.members.get(i)
        matchAndMark(paths, u, rule, mark_cb, createIfNotExists)
      }
    }
  } else if (path === '**') {
    mark_cb(scp, rule)
    if (scp.members) {
      for (const i of scp.members.keys()) {
        const u = scp.members.get(i)
        matchAndMark(['**'], u, rule, mark_cb, createIfNotExists)
      }
    }
  } else if (path === 'this') {
    const val = scp.getThisObj()
    if (!val) return
    matchAndMark(paths, val, rule, mark_cb, createIfNotExists)
  } else {
    const scpBackup = scp
    scp = Scope.getDefScope(scp, new SymbolValue(scp.qid || '', { sid: path, type: 'Identifier', name: path }))
    if (!scp) {
      scp = scpBackup
    }
    let val = scp?.getFieldValue(path, createIfNotExists)
    if (!val) {
      if (scp.sid !== '<global>') {
        while (scp.hasOwnProperty('parent') && scp.parent) {
          scp = scp.parent
        }
        if (scp?.sid === '<global>') {
          scp = scp.context.modules
        }
        // 确保scp的值不是undefined
        if (scp && typeof scp.getFieldValue === 'function') {
          val = scp.getFieldValue(path, createIfNotExists)
        }
        if (!val) {
          return
        }
      } else {
        return
      }
    }
    matchAndMark(paths, val, rule, mark_cb, createIfNotExists)
  }
}

/**
 * introduce identifier taint globally, no limitation for file and function, usually for benchmark testing
 * @param analyzer
 * @param scope
 * @param node
 * @param res
 * @param sourceScopeVal
 */
function introduceTaintAtIdentifierDirect(analyzer: any, scope: any, node: any, res: any, sourceScopeVal: any): any {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return res
  }
  if (sourceScopeVal) {
    for (const rule of sourceScopeVal) {
      const paths = rule.path
      if (res.sid === paths) {
        markTaintSource(res, { path: node, kind: rule.kind })
      }
    }
  }
}

/**
 * 根据传入的rule，从数组中取出对应位置的元素
 * @param array
 * @param rule
 */
function getArrayElementsByRule(array: any[], rule: any): any[] {
  if (!Array.isArray(array)) return []
  // 辅助函数
  const parseIndex = (indexStr: string): number | null => {
    const index = parseInt(indexStr, 10)
    return Number.isInteger(index) && index >= 0 && index < array.length ? index : null
  }
  const parseRange = (rangeStr: string): any[] => {
    const [startStr, endStr] = rangeStr.split(':')
    const start = parseIndex(startStr) ?? 0
    const end = parseIndex(endStr) ?? array.length
    return start <= end ? array.slice(start, end) : []
  }
  // 根据规则取出对应位置的元素
  // 默认返回整个array
  if (!rule) return array
  if (rule === '*') return array
  // "x:y,z"
  if (rule.includes(',')) {
    const parts = rule.split(',')
    // 如果是组合规则，单独解析每个子规则
    const result = parts.flatMap((part: any) => {
      if (part.includes(':')) {
        return parseRange(part)
      }
      const index = parseIndex(part)
      return index !== null ? [array[index]] : []
    })

    // 过滤掉任何 undefined 或不合法的值后返回结果
    return result.filter((value: any) => value !== undefined)
  }
  // "x:y"
  if (rule.includes(':')) {
    return parseRange(rule)
  }
  // "x"
  const index = parseIndex(rule)
  return index !== null ? [array[index]] : []
}

/**
 * 给定一个entryPoint，为其特定位置的参数打上污点
 * @param entryPoint
 * @param state
 * @param analyzer
 * @param rule
 * e.g., "1:"，":1", "1,2,3", undefined
 * @param sourceKind
 */
function introduceFuncArgTaintBySelfCollection(
  entryPoint: any,
  state: any,
  analyzer: any,
  rule: any,
  sourceKind: any
): void {
  const parameters = entryPoint.ast.fdef?.parameters
  const interestedParas = getArrayElementsByRule(parameters, rule)
  interestedParas.forEach((para) => {
    const argv = analyzer.processInstruction(entryPoint, para, state)
    markTaintSource(argv, { path: para, kind: sourceKind })
  })
}

module.exports = {
  introduceTaintAtIdentifier,
  introduceTaintAtMemberAccess,
  markTaintSource,
  matchAndMark,
  introduceTaintAtFuncCallReturnValue,
  introduceTaintAtIdentifierDirect,
  introduceFuncArgTaintBySelfCollection,
  introduceFuncArgTaintByRuleConfig,
  setTaint,
  getMarkedSourceCount,
  resetMarkedSourceCount,
}
