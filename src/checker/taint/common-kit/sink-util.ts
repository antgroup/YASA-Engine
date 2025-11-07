const _ = require('lodash')
const { matchField: matchFieldSinkUtil } = require('../../common/rules-basic-handler')
const AstUtilSinkUtil = require('../../../util/ast-util')
const { handleException: handleExceptionSinkUtil } = require('../../../engine/analyzer/common/exception-handler')

interface SinkRule {
  argNum?: number
  fsig?: string
  fregex?: string
  calleeType?: string
  [key: string]: any
}

/**
 *
 * @param node
 * @param fclos
 * @param sinks
 * @param argvalues
 * @returns {Array}
 */
function matchSinkAtFuncCall(node: any, fclos: any, sinks: SinkRule[], argvalues: any[]): SinkRule[] {
  const callExpr = node.callee || node
  const res: SinkRule[] = []
  if (sinks && sinks.length > 0) {
    for (const tspec of sinks) {
      if (tspec.argNum !== undefined && tspec.argNum >= 0 && argvalues && tspec.argNum !== argvalues.length) {
        continue
      }

      if (tspec.fsig) {
        const marray = tspec.fsig.split('.')
        if (matchFieldSinkUtil(callExpr, marray, marray.length - 1)) {
          res.push(tspec)
        }
      } else if (tspec.fregex) {
        if (callExpr.type === 'MemberAccess' && matchRegex(tspec.fregex, fclos._qid)) {
          res.push(tspec)
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
  argvalues: any[]
): SinkRule[] {
  const callExpr = node.callee || node
  const res: SinkRule[] = []
  if (rules && rules.length > 0) {
    if (fclos.vtype === 'union' && !_.isEmpty(fclos.field)) {
      fclos.field.forEach((subFClos: any) => {
        res.push(...matchSinkAtFuncCallWithCalleeType(node, subFClos, rules, scope, argvalues))
      })
      return res
    }
    for (const tspec of rules) {
      if (tspec.argNum !== undefined && tspec.argNum >= 0 && argvalues && tspec.argNum !== argvalues.length) {
        continue
      }

      if (tspec.fsig) {
        if ((!tspec.calleeType || tspec.calleeType === '') && tspec.fsig === AstUtilSinkUtil.prettyPrint(callExpr)) {
          res.push(tspec)
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
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
            tspec.calleeType === '*') &&
          (AstUtilSinkUtil.prettyPrint(fclos.rtype?.vagueType).replace(/"/g, '') === tspec.fsig ||
            fclos._sid === tspec.fsig)
        ) {
          // import cn.hutool.http.HttpRequest; HttpRequest.post
          res.push(tspec)
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtilSinkUtil.prettyPrint(fclos.object?.rtype) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype).endsWith(`.${tspec.calleeType}`) ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
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
            tspec.calleeType === '*') &&
          AstUtilSinkUtil.prettyPrint(fclos.ast) === tspec.fsig
        ) {
          res.push(tspec)
        }
      } else if (tspec.fregex) {
        if (
          // 用于匹配形如 squirrel.Delete(*).Where形式的sink点，*为通配符
          callExpr.type === 'MemberAccess' &&
          tspec.calleeType === '' &&
          matchRegex(tspec.fregex, fclos._qid)
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

module.exports = {
  matchSinkAtFuncCall,
  matchSinkAtFuncCallWithCalleeType,
  matchRegex,
}
