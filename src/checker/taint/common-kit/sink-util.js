const _ = require('lodash')
const { matchField } = require('../../common/rules-basic-handler')
const AstUtil = require('../../../util/ast-util')

/**
 *
 * @param node
 * @param fclos
 * @param sinks
 * @returns {Array}
 */
function matchSinkAtFuncCall(node, fclos, sinks) {
  const callExpr = node.callee || node
  const res = []
  if (sinks && sinks.length > 0) {
    for (const tspec of sinks) {
      if (tspec.fsig) {
        const marray = tspec.fsig.split('.')
        if (!matchField(callExpr, marray, marray.length - 1)) {
          if (
            !(
              callExpr.type === 'MemberAccess' &&
              new RegExp(convertRuleToRegexString(tspec.fsig)).test(fclos._qid) &&
              typeof AstUtil.prettyPrint(callExpr) === 'string' &&
              AstUtil.prettyPrint(callExpr).includes(marray[marray.length - 1])
            )
          ) {
            continue
          }
        }
        res.push(tspec)
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
 */
function matchSinkAtFuncCallWithCalleeType(node, fclos, rules, scope) {
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
        } else if (
          // 用于匹配形如 squirrel.Delete(*).Where形式的sink点，*为通配符
          callExpr.type === 'MemberAccess' &&
          tspec.calleeType === '' &&
          new RegExp(convertRuleToRegexString(tspec.fsig)).test(fclos._qid) &&
          typeof AstUtil.prettyPrint(callExpr) === 'string' &&
          AstUtil.prettyPrint(callExpr).includes(tspec.fsig.split('.')[tspec.fsig.split('.').length - 1])
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
 * @param rule
 */
function convertRuleToRegexString(rule) {
  // 转义正则中的特殊字符（除了 *）
  let regexStr = rule.replace(/([.+?^${}()|[\]\\])/g, '\\$1')
  // 将 * 替换为非贪婪匹配任意字符的正则表达式
  regexStr = regexStr.replace(/\*/g, '.*?')
  // 在开头和结尾添加单词边界，确保匹配完整标识符
  return `\\b${regexStr}\\b`
}

module.exports = {
  matchSinkAtFuncCall,
  matchSinkAtFuncCallWithCalleeType,
}
