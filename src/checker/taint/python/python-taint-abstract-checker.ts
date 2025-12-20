const _ = require('lodash')
const IntroduceTaint = require('../common-kit/source-util')
const BasicRuleHandler = require('../../common/rules-basic-handler')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const { matchSinkAtFuncCall, matchRegex } = require('../common-kit/sink-util')
const TaintChecker = require('../taint-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')

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
    // Try normal matching first
    IntroduceTaint.introduceTaintAtIdentifier(node, info.res, this.sourceScope.value)

    // If preprocess is not ready, still mark parameters that are in sourceScope
    const BasicRuleHandler = require('../../common/rules-basic-handler')
    if (!BasicRuleHandler.getPreprocessReady() && this.sourceScope.value && this.sourceScope.value.length > 0) {
      for (const source of this.sourceScope.value) {
        // Check if kind matches (could be string or array)
        const kindMatches =
          source.kind === 'PYTHON_INPUT' || (Array.isArray(source.kind) && source.kind.includes('PYTHON_INPUT'))

        if (source.path === node.name && kindMatches) {
          // For path parameters, we use 'all' for all scope conditions, so always match
          const shouldMatch =
            (source.scopeFile === 'all' || !source.scopeFile) &&
            (source.scopeFunc === 'all' || !source.scopeFunc) &&
            (source.locStart === 'all' || !source.locStart) &&
            (source.locEnd === 'all' || !source.locEnd)

          if (shouldMatch && (!info.res._tags || info.res._tags.size === 0)) {
            if (!info.res._tags) {
              info.res._tags = new Set()
            }
            info.res._tags.add('PYTHON_INPUT')
            info.res.hasTagRec = true
            break
          }
        }
      }
    }
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
    const { fclos, argvalues } = info
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(fclos?.object, node, argvalues, funcCallArgTaintSource)
    this.checkByNameMatch(node, fclos, argvalues)
    this.checkByFieldMatch(node, fclos, argvalues)
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
    const { fclos, ret } = info
    const funcCallReturnValueTaintSource = this.checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource

    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret, funcCallReturnValueTaintSource)
  }

  /**
   * check sink by name
   * @param node
   * @param fclos
   * @param argvalues
   * @returns {boolean}
   */
  checkByNameMatch(node: any, fclos: any, argvalues: any) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
    let rule = matchSinkAtFuncCall(node, fclos, rules)
    rule = rule.length > 0 ? rule[0] : null

    if (rule) {
      this.findArgsAndAddNewFinding(node, argvalues, fclos, rule)
    }
  }

  /**
   *
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   */
  checkByFieldMatch(node: any, fclos: any, argvalues: any) {
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
          this.findArgsAndAddNewFinding(node, argvalues, fclos, rule)
          return true
        }
      } else {
        if (!rule.fregex) {
          return false
        }
        if (callFull.type === 'MemberAccess' && matchRegex(rule.fregex, fclos._qid)) {
          this.findArgsAndAddNewFinding(node, argvalues, fclos, rule)
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
    if (
      typeof fclos?._sid !== 'undefined' &&
      typeof fclos?._qid === 'undefined' &&
      typeof fclos?._this === 'undefined'
    ) {
      const index = fclos?._sid.indexOf('>.')
      const result = index !== -1 ? fclos?._sid.substring(index + 2) : fclos?._sid
      return result.replace('<instance>', '').replace('()', '')
    }
    if (typeof fclos?._qid !== 'undefined') {
      const index = fclos._qid.indexOf('>.')
      const result = index !== -1 ? fclos?._qid.substring(index + 2) : fclos?._qid
      return result.replace('<instance>', '').replace('()', '')
    }
    if (!(fclos === fclos?._this)) {
      return this.getObj(fclos._this)
    }
    const index = fclos?._sid.indexOf('>.')
    const result = index !== -1 ? fclos?._sid.substring(index + 2) : fclos?._sid
    if (result) {
      return result.replace('<instance>', '').replace('()', '')
    }
  }

  /**
   *
   * @param node
   * @param argvalues
   * @param fclos
   * @param rule
   */
  findArgsAndAddNewFinding(node: any, argvalues: any, fclos: any, rule: any) {
    const args = BasicRuleHandler.prepareArgs(argvalues, fclos, rule)
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
          ruleName += `\nSINK Attribute: ${rule.attribute}`
        }
        const taintFlowFinding = this.buildTaintFinding(
          this.getCheckerId(),
          this.desc,
          node,
          nd,
          fclos,
          TAINT_TAG_NAME_PYTHON,
          ruleName,
          matchedSanitizerTags
        )
        if (!TaintOutputStrategy.isNewFinding(this.resultManager, taintFlowFinding)) continue
        this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
      }
      return true
    }
  }
}

module.exports = PythonTaintAbstractChecker
