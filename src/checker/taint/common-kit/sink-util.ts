import { Invocation } from '../../../resolver/common/value/invocation'
import TypeRelatedInfoResolver from '../../../resolver/common/type-related-info-resolver'
import type { ClassHierarchy } from '../../../resolver/common/value/class-hierarchy'
import { getExplicitArgCount, type CallInfo } from '../../../engine/analyzer/common/call-args'

const _ = require('lodash')
const { matchField: matchFieldSinkUtil } = require('../../common/rules-basic-handler')
const AstUtilSinkUtil = require('../../../util/ast-util')
const { handleException: handleExceptionSinkUtil } = require('../../../engine/analyzer/common/exception-handler')

// 全局统计：实际匹配的 sink 数量
let matchedSinkCount = 0

function getMatchedSinkCount(): number {
  return matchedSinkCount
}

function resetMatchedSinkCount(): void {
  matchedSinkCount = 0
}

interface SinkRule {
  argNum?: number
  fsig?: string
  fregex?: string
  calleeType?: string
  /** sink 关联的前置条件 id 列表，采用 OR 语义：taint 上命中任一 id 对应的 tag 即生成 finding */
  preconditionIds?: string[]
  [key: string]: any
}

/**
 *
 * @param node
 * @param fclos
 * @param sinks
 * @param callInfo
 * @returns {Array}
 */
function matchSinkAtFuncCall(node: any, fclos: any, sinks: SinkRule[], callInfo: CallInfo): SinkRule[] {
  const argCount = getExplicitArgCount(callInfo)
  const callExpr = node.callee || node
  const res: SinkRule[] = []
  if (sinks && sinks.length > 0) {
    for (const tspec of sinks) {
      if (tspec.argNum !== undefined && tspec.argNum >= 0 && tspec.argNum !== argCount) {
        continue
      }

      if (tspec.fsig) {
        const marray = tspec.fsig.split('.')
        if (matchFieldSinkUtil(callExpr, marray, marray.length - 1)) {
          res.push(tspec)
          matchedSinkCount++ // 统计实际匹配的 sink
        }
      } else if (tspec.fregex) {
        if (callExpr.type === 'MemberAccess' && matchRegex(tspec.fregex, fclos.qid)) {
          res.push(tspec)
          matchedSinkCount++ // 统计实际匹配的 sink
        }
      }
    }
  }
  return res
}

/**
 *
 * @param node
 * @param fclos
 * @param rules
 * @param scope
 * @param argvalues
 */
function matchSinkAtFuncCallWithCalleeType(
  node: any,
  fclos: any,
  rules: SinkRule[],
  scope: any,
  callInfo: CallInfo
): SinkRule[] {
  const argCount = getExplicitArgCount(callInfo)
  const callExpr = node.callee || node
  const res: SinkRule[] = []
  if (rules && rules.length > 0) {
    if (fclos.vtype === 'union' && !_.isEmpty(fclos.value)) {
      fclos.value.forEach((subFClos: any) => {
        res.push(...matchSinkAtFuncCallWithCalleeType(node, subFClos, rules, scope, callInfo))
      })
      return res
    }
    for (const tspec of rules) {
      if (tspec.argNum !== undefined && tspec.argNum >= 0 && tspec.argNum !== argCount) {
        continue
      }

      // Go 指针类型 sink 规则的 calleeType 带 * 前缀（如 *Collection），引擎解析的类型不带，需 normalize
      const calleeTypeBase = tspec.calleeType?.startsWith('*') ? tspec.calleeType.slice(1) : ''

      if (tspec.fsig) {
        if ((!tspec.calleeType || tspec.calleeType === '') && tspec.fsig === AstUtilSinkUtil.prettyPrint(callExpr)) {
          res.push(tspec)
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            (calleeTypeBase && (AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${calleeTypeBase}`))) ||
            tspec.calleeType === '*') &&
          `${AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.vagueType).replace(/"/g, '')}.${AstUtilSinkUtil.prettyPrint(
            fclos.property
          )}` === tspec.fsig
        ) {
          res.push(tspec)
        } else if (
          (callExpr.type === 'MemberAccess' || callExpr.type === 'Identifier') &&
          (AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            (calleeTypeBase && (AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${calleeTypeBase}`))) ||
            tspec.calleeType === '*') &&
          (AstUtilSinkUtil.prettyPrint(fclos.rtype?.vagueType).replace(/"/g, '') === tspec.fsig ||
            fclos.sid === tspec.fsig)
        ) {
          // import cn.hutool.http.HttpRequest; HttpRequest.post
          res.push(tspec)
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtilSinkUtil.prettyPrint(fclos.object?.rtype) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype).endsWith(`.${tspec.calleeType}`) ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            (calleeTypeBase && (AstUtilSinkUtil.prettyPrint(fclos.object?.rtype) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.object?.rtype).endsWith(`.${calleeTypeBase}`) ||
              AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${calleeTypeBase}`))) ||
            tspec.calleeType === '*') &&
          AstUtilSinkUtil.prettyPrint(fclos.property) === tspec.fsig
        ) {
          res.push(tspec)
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtilSinkUtil.prettyPrint(fclos.rtype) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.rtype).endsWith(`.${tspec.calleeType}`) ||
            AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            (calleeTypeBase && (AstUtilSinkUtil.prettyPrint(fclos.rtype) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.rtype).endsWith(`.${calleeTypeBase}`) ||
              AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${calleeTypeBase}`))) ||
            tspec.calleeType === '*') &&
          AstUtilSinkUtil.prettyPrint(fclos.ast?.node) === tspec.fsig
        ) {
          res.push(tspec)
        }
      } else if (tspec.fregex) {
        if (
          // 用于匹配形如 squirrel.Delete(*).Where形式的sink点，*为通配符
          callExpr.type === 'MemberAccess' &&
          tspec.calleeType === '' &&
          matchRegex(tspec.fregex, fclos.qid)
        ) {
          res.push(tspec)
        }
      }
    }
  }
  return res
}

/**
 *
 * @param pattern
 * @param testStr
 */
function matchRegex(pattern: string, testStr: string): boolean {
  try {
    return new RegExp(pattern, 'g').test(testStr)
  } catch (e) {
    handleExceptionSinkUtil(
      e,
      '[sink-util]An Error Occurred in compile regex',
      '[sink-util]An Error Occurred in compile regex'
    )
    return false
  }
}

/**
 * check if invocation match sink
 * @param invocation
 * @param sink
 * @param typeResolver
 */
function checkInvocationMatchSink(invocation: Invocation, sink: SinkRule, typeResolver: TypeRelatedInfoResolver): boolean {
  if (!invocation || !sink) {
    return false
  }

  if (!sink.fsig || sink.fsig === '') {
    return false
  }
  if (!sink.calleeType || sink.calleeType === '') {
    if (invocation.callSiteLiteral === sink.fsig || invocation.fsig === sink.fsig) {
      return true
    }
  } else {
    if (invocation.fsig === sink.fsig && invocation.calleeType && invocation.calleeType !== '') {
      if (invocation.calleeType === sink.calleeType || invocation.calleeType.endsWith(`.${sink.calleeType}`)) {
        return true
      } else if (typeResolver) {
        const classHierarchy: ClassHierarchy | undefined = typeResolver.classHierarchyMap.get(invocation.calleeType)
        if (classHierarchy) {
          const baseTypes: string[] = typeResolver.findBaseTypes(classHierarchy)
          for (const baseType of baseTypes) {
            if (baseType === sink.calleeType || baseType?.endsWith(`.${sink.calleeType}`)) {
              return true
            }
          }
          const subTypes: string[] = typeResolver.findSubTypes(classHierarchy)
          for (const subType of subTypes) {
            if (subType === sink.calleeType || subType?.endsWith(`.${sink.calleeType}`)) {
              return true
            }
          }
        }
      }
    }
    if (invocation.callSiteLiteral === `${sink.calleeType}.${sink.fsig}` || invocation.callSiteLiteral?.endsWith(`.${sink.calleeType}.${sink.fsig}`)) {
      return true
    }
  }

  return false
}

module.exports = {
  matchSinkAtFuncCall,
  matchSinkAtFuncCallWithCalleeType,
  matchRegex,
  checkInvocationMatchSink,
  getMatchedSinkCount,
  resetMatchedSinkCount,
}
