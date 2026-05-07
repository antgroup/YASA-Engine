import type { CallInfo } from '../../../engine/analyzer/common/call-args'
import { getLegacyArgValues } from '../../../engine/analyzer/common/call-args'

const _ = require('lodash')
const commonUtil = require('../../../util/common-util')
const config = require('../../../config')
const { handleException } = require('../../../engine/analyzer/common/exception-handler')

const IntroduceTaint = require('../common-kit/source-util')
const BasicRuleHandler = require('../../common/rules-basic-handler')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const { matchSinkAtFuncCall, matchRegex } = require('../common-kit/sink-util')
const TaintChecker = require('../taint-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
const QidUnifyUtil = require('../../../util/qid-unify-util')
const FileUtil = require('../../../util/file-util')

const TAINT_TAG_NAME_PYTHON = 'PYTHON_INPUT'

/**
 *
 */
class PythonTaintAbstractChecker extends TaintChecker {
  /**
   * trigger at identifier
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer: any, scope: any, node: any, state: any, info: any) {
    const result = IntroduceTaint.introduceTaintAtIdentifier(analyzer, scope, node, info.res, this.sourceScope.value)
    if (result !== undefined) {
      info.res = result
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
  triggerAtFunctionDefinition(analyzer: any, scope: any, node: any, state: any, info: any) {
    if (config.analyzer !== 'PythonAnalyzer') {
      return
    }
    commonUtil.fillSourceScope(info.fclos, this.sourceScope)
  }

  /**
   * trigger before function call
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, callInfo } = info
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(fclos?.object, node, callInfo, funcCallArgTaintSource)
    this.checkByNameMatch(node, fclos, callInfo, state)
    this.checkByFieldMatch(node, fclos, callInfo, state)
  }

  /**
   * FunctionCallAfter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, ret, callInfo } = info
    const funcCallReturnValueTaintSource = this.checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource

    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret, funcCallReturnValueTaintSource)
  }

  /**
   * check sink by name
   * @param node
   * @param fclos
   * @param argvalues
   * @param callInfo
   * @param state
   * @returns {boolean}
   */
  checkByNameMatch(node: any, fclos: any, callInfo: CallInfo | undefined, state?: any) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
    let rule = matchSinkAtFuncCall(node, fclos, rules, callInfo)
    rule = rule.length > 0 ? rule[0] : null

    if (rule) {
      this.findArgsAndAddNewFinding(node, callInfo, fclos, rule, state)
    }
  }

  /**
   *
   * @param node
   * @param fclos
   * @param argvalues
   * @param state
   * @param qid
   */

  /**
   *
   * @param node
   * @param fclos
   * @param callInfo
   * @param state
   */
  checkByFieldMatch(node: any, fclos: any, callInfo: CallInfo | undefined, state?: any) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
    rules.some((rule: any): boolean => {
      if (typeof rule.fsig !== 'string') {
        return false
      }
      const callFull = this.getObj(fclos)
      if (typeof callFull === 'undefined') {
        return false
      }
      if (rule.fsig) {
        if (rule.fsig === callFull) {
          this.findArgsAndAddNewFinding(node, callInfo, fclos, rule, state)
          return true
        }
        // 去除参数元数据后匹配：无 '.' 的裸函数名只精确匹配，有 '.' 的允许后缀匹配
        const stripped = QidUnifyUtil.removeParenthesesFromString(callFull)
        if (stripped === rule.fsig || (rule.fsig.includes('.') && stripped.endsWith(`.${rule.fsig}`))) {
          this.findArgsAndAddNewFinding(node, callInfo, fclos, rule, state)
          return true
        }
      } else {
        if (!rule.fregex) {
          return false
        }
        if (callFull.type === 'MemberAccess' && matchRegex(rule.fregex, fclos.qid)) {
          this.findArgsAndAddNewFinding(node, callInfo, fclos, rule, state)
          return true
        }
      }
      return false
    })
  }

  /**
   * get obj
   * @param fclos
   */
  getObj(fclos: any): any {
    if (typeof fclos?.sid !== 'undefined' && typeof fclos?.qid === 'undefined' && typeof fclos?._this === 'undefined') {
      const index = fclos?.sid.indexOf('>.')
      return index !== -1 ? fclos?.sid.substring(index + 2) : fclos?.sid
    }
    if (typeof fclos?.qid !== 'undefined' && typeof fclos.qid === 'string') {
      const index = fclos.qid.indexOf('>.')
      const result = index !== -1 ? fclos?.qid.substring(index + 2) : fclos?.qid
      return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(result)
    }
    if (!(fclos === fclos?._this)) {
      return this.getObj(fclos._this)
    }
    if (typeof fclos?.sid === 'string') {
      const index = fclos?.sid.indexOf('>.')
      const result = index !== -1 ? fclos?.sid.substring(index + 2) : fclos?.sid
      if (result) {
        return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(result)
      }
    }
  }

  /**
   *
   * @param node
   * @param argvalues
   * @param callInfo
   * @param fclos
   * @param rule
   * @param state
   */
  findArgsAndAddNewFinding(node: any, callInfo: CallInfo | undefined, fclos: any, rule: any, state?: any) {
    const args = BasicRuleHandler.prepareArgs(callInfo, fclos, rule)
    const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
    const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
      node,
      fclos,
      args,
      null,
      TAINT_TAG_NAME_PYTHON,
      true,
      sanitizers
    )
    if (ndResultWithMatchedSanitizerTagsArray) {
      for (const ndResultWithMatchedSanitizerTags of ndResultWithMatchedSanitizerTagsArray) {
        const { nd } = ndResultWithMatchedSanitizerTags
        const { matchedSanitizerTags } = ndResultWithMatchedSanitizerTags
        let ruleName = rule.fsig
        if (typeof rule.attribute !== 'undefined') {
          const attrStr = Array.isArray(rule.attribute) ? rule.attribute.join(',') : rule.attribute
          ruleName += `\nSINK Attribute: ${attrStr}`
        }
        const taintFlowFinding = this.buildTaintFinding(
          this.getCheckerId(),
          this.desc,
          node,
          nd,
          fclos,
          TAINT_TAG_NAME_PYTHON,
          ruleName,
          matchedSanitizerTags,
          state?.callstack,
          state?.callsites
        )
        if (!TaintOutputStrategy.isNewFinding(this.resultManager, taintFlowFinding)) continue
        this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
      }
      return true
    }
  }
}

/**
 *
 */
function loadPythonDefaultRule() {
  let pythonDefaultRule
  try {
    const rulePath = FileUtil.getAbsolutePath('./resource/python/python-default-rule.json')
    pythonDefaultRule = FileUtil.loadJSONfile(rulePath)
  } catch (e) {
    handleException(e, 'Error occurred in load python default rule', 'Error occurred in load python default rule')
  }
  return pythonDefaultRule
}

module.exports = { PythonTaintAbstractChecker, loadPythonDefaultRule }
