const _ = require('lodash')
const { matchField } = require('../../common/rules-basic-handler')
const AstUtil = require('../../../util/ast-util')
const { handleException } = require('../../../engine/analyzer/common/exception-handler')

/**
 *
 * @param node
 * @param fclos
 * @param sinks
 * @param argvalues
 * @returns {Array}
 */
function matchSinkAtFuncCall(node, fclos, sinks, argvalues) {
  const callExpr = node.callee || node
  const res = []
  if (sinks && sinks.length > 0) {
    for (const tspec of sinks) {
      if (tspec.argNum >= 0 && argvalues && tspec.argNum !== argvalues.length) {
        continue
      }

      if (tspec.fsig) {
        const marray = tspec.fsig.split('.')
        if (matchField(callExpr, marray, marray.length - 1)) {
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
function matchSinkAtFuncCallWithCalleeType(node, fclos, rules, scope, argvalues) {
  const callExpr = node.callee || node
  const res = []
  if (rules && rules.length > 0) {
    if (fclos.vtype === 'union' && !_.isEmpty(fclos.field)) {
      fclos.field.forEach((subFClos) => {
        res.push(...matchSinkAtFuncCallWithCalleeType(node, subFClos, rules, scope))
      })
      return res
    }
    for (const tspec of rules) {
      if (tspec.argNum >= 0 && argvalues && tspec.argNum !== argvalues.length) {
        continue
      }

      if (tspec.fsig) {
        if ((!tspec.calleeType || tspec.calleeType === '') && tspec.fsig === AstUtil.prettyPrint(callExpr)) {
          res.push(tspec)
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtil.prettyPrint(fclos.object?.rtype?.definiteType) === tspec.calleeType ||
            AstUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            tspec.calleeType === '*') &&
          `${AstUtil.prettyPrint(fclos.object?.rtype?.vagueType).replace(/"/g, '')}.${AstUtil.prettyPrint(
            fclos.property
          )}` === tspec.fsig
        ) {
          res.push(tspec)
        } else if (
          (callExpr.type === 'MemberAccess' || callExpr.type === 'Identifier') &&
          (AstUtil.prettyPrint(fclos.rtype?.definiteType) === tspec.calleeType ||
            AstUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            tspec.calleeType === '*') &&
          (AstUtil.prettyPrint(fclos.rtype?.vagueType).replace(/"/g, '') === tspec.fsig || fclos._sid === tspec.fsig)
        ) {
          // import cn.hutool.http.HttpRequest; HttpRequest.post
          res.push(tspec)
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtil.prettyPrint(fclos.object?.rtype) === tspec.calleeType ||
            AstUtil.prettyPrint(fclos.object?.rtype).endsWith(`.${tspec.calleeType}`) ||
            AstUtil.prettyPrint(fclos.object?.rtype?.definiteType) === tspec.calleeType ||
            AstUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            fclos.object?.rtype?.val?._qid === tspec.calleeType ||
            tspec.calleeType === '*') &&
          AstUtil.prettyPrint(fclos.property) === tspec.fsig
        ) {
          res.push(tspec)
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtil.prettyPrint(fclos.rtype) === tspec.calleeType ||
            AstUtil.prettyPrint(fclos.rtype).endsWith(`.${tspec.calleeType}`) ||
            AstUtil.prettyPrint(fclos.rtype?.definiteType) === tspec.calleeType ||
            AstUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            fclos.rtype?.val?._qid === tspec.calleeType ||
            tspec.calleeType === '*') &&
          AstUtil.prettyPrint(fclos.ast) === tspec.fsig
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
function matchRegex(pattern, testStr) {
  try {
    return new RegExp(pattern, 'g').test(testStr)
  } catch (e) {
    handleException(e, '[sink-util]An Error Occurred in compile regex', '[sink-util]An Error Occurred in compile regex')
    return false
  }
}

module.exports = {
  matchSinkAtFuncCall,
  matchSinkAtFuncCallWithCalleeType,
}
