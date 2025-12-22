const _ = require('lodash')
const AstUtil = require('../../../util/ast-util')
const { prepareArgs, matchField } = require('../../common/rules-basic-handler')
const BasicRuleHandler = require('../../common/rules-basic-handler')
const { Scope } = require('../../../engine/analyzer/common')
const ValueUtil = require('../../../engine/analyzer/common/value/valueUtil')
const varUtil = require('../../../util/variable-util')

/**
 *
 * @param res
 * @param tagType
 */
function setTaint(res: any, tagType: any): void {
  res._tags = res._tags || new Set()
  if (Array.isArray(tagType)) {
    for (const item of tagType) {
      res._tags.add(item)
    }
  } else if (tagType) {
    res._tags.add(tagType)
  }
  res.hasTagRec = true
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
  if (unit.trace && Array.isArray(unit.trace) && unit.trace[0]?.tag !== 'SOURCE: ') {
    unit.trace = undefined
  }
  if (!unit.trace) {
    const start_line = path?.loc?.start?.line
    const end_line = path?.loc?.end?.line
    const tline = start_line === end_line ? start_line : _.range(start_line, end_line + 1)
    unit.trace = [
      {
        file: path?.loc?.sourcefile,
        line: tline,
        node: path,
        tag: 'SOURCE: ',
        affectedNodeName: AstUtil.prettyPrint(path),
      },
    ]
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
 * @param res
 * @param funcCallArgTaintSource
 */
function introduceFuncArgTaintByRuleConfig(scope: any, node: any, res: any, funcCallArgTaintSource: any): void {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return
  }
  const rules = funcCallArgTaintSource
  if (rules && Array.isArray(rules) && rules.length > 0) {
    const call = node
    for (const tspec of rules) {
      if (tspec.fsig) {
        const marray = tspec.fsig.split('.')
        if (call.callee?.type === 'MemberAccess' && _.isArray(res)) {
          if (
            (matchField(call.callee?.property, marray, marray.length - 1) ||
              matchField(call.callee, marray, marray.length - 1)) &&
            (AstUtil.prettyPrint(scope?.rtype) === tspec.calleeType || tspec.calleeType === '*')
          ) {
            const args = prepareArgs(res, undefined, tspec)
            for (let i = 0; i < args.length; i++) {
              markTaintSource(args[i], { path: node, kind: tspec.kind })
            }
          }
        } else if (call.callee?.type === 'Identifier') {
          if (call.callee.name === tspec.fsig) {
            const args = prepareArgs(res, undefined, tspec)
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
 * @param node
 * @param res
 * @param sourceScopeVal
 */
function introduceTaintAtIdentifier(node: any, res: any, sourceScopeVal: any): any {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return
  }
  if (varUtil.isEmpty(res._tags)) {
    // source定义方式，增加文件域和函数域的匹配，主要用于形参场景。identifier的source添加基本都用于插件-->形参场景
    const nodeStart = node.loc?.start?.line
    const nodeEnd = node.loc?.end?.line
    if (sourceScopeVal && sourceScopeVal.length > 0) {
      for (const val of sourceScopeVal) {
        const paths = val.path
        if (res._sid === paths || res._qid === paths || node.name === paths) {
          const valStart = val.locStart
          const valEnd = val.locEnd
          if (typeof valStart === 'undefined' || typeof valEnd === 'undefined') {
            continue
          }
          if (valStart === 'all' && valEnd === 'all' && val.scopeFile === 'all' && val.scopeFunc === 'all') {
            markTaintSource(res, { path: node, kind: val.kind })
          } else if (valStart === 'all' && valEnd === 'all' && val.scopeFile !== 'all' && val.scopeFunc === 'all') {
            if (typeof node.loc.sourcefile === 'string') {
              if (node.loc.sourcefile.includes(val.scopeFile)) {
                markTaintSource(res, { path: node, kind: val.kind })
              }
            }
          } else if (node.loc.sourcefile.includes(val.scopeFile) && nodeStart >= valStart && nodeEnd <= valEnd) {
            markTaintSource(res, { path: node, kind: val.kind })
          }
        }
      }
    }
  }
  return res
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
    for (const i in scp.field) {
      const u = scp.field[i]
      matchAndMark(paths, u, rule, mark_cb, createIfNotExists)
    }
  } else if (path === '**') {
    mark_cb(scp, rule)
    for (const i in scp.field) {
      const u = scp.field[i]
      matchAndMark(['**'], u, rule, mark_cb, createIfNotExists)
    }
  } else if (path === 'this') {
    const val = scp.getThis()
    if (!val) return
    matchAndMark(paths, val, rule, mark_cb, createIfNotExists)
  } else {
    const scpBackup = scp
    scp = Scope.getDefScope(scp, ValueUtil.SymbolValue({ type: 'Identifier', name: path }))
    if (!scp) {
      scp = scpBackup
    }
    let val = scp?.getFieldValue(path, createIfNotExists)
    if (!val) {
      if (scp._sid !== '<global>') {
        while (scp.hasOwnProperty('parent') && scp.parent) {
          scp = scp.parent
        }
        if (scp?._sid === '<global>') {
          scp = scp.moduleManager
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
 * @param node
 * @param res
 * @param sourceScopeVal
 */
function introduceTaintAtIdentifierDirect(node: any, res: any, sourceScopeVal: any): void {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return
  }
  if (sourceScopeVal) {
    for (const rule of sourceScopeVal) {
      const paths = rule.path
      if (res._sid === paths) {
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
  const parameters = entryPoint.fdef?.parameters
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
}
