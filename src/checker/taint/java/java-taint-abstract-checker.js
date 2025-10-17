const TaintChecker = require('../taint-checker')
const IntroduceTaint = require('../common-kit/source-util')
const commonUtil = require('../../../util/common-util')
const { matchSinkAtFuncCallWithCalleeType } = require('../common-kit/sink-util')
const Rules = require('../../common/rules-basic-handler')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')

const TAINT_TAG_NAME = 'JAVA_INPUT'

/**
 * java taint base checker
 */
class JavaTaintAbstractChecker extends TaintChecker {
  /**
   * starter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
    const { topScope } = analyzer
    this.prepareEntryPoints(analyzer, topScope)
    analyzer.entryPoints.push(...this.entryPoints)
    this.addSourceTagForSourceScope(TAINT_TAG_NAME, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME, this.checkerRuleConfigContent)
  }

  /**
   * Identifier trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer, scope, node, state, info) {
    IntroduceTaint.introduceTaintAtIdentifier(node, info.res, this.sourceScope.value)
  }

  /**
   * FunctionDefinition trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionDefinition(analyzer, scope, node, state, info) {
    commonUtil.fillSourceScope(info.fclos, this.sourceScope)
  }

  /**
   * FunctionCall trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    const { fclos, argvalues } = info
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(fclos?.object, node, argvalues, funcCallArgTaintSource)
    this.checkByNameAndClassMatch(node, fclos, argvalues, scope)
    this.checkByFieldMatch(node, fclos, argvalues, scope)
  }

  /**
   * FunctionCallAfter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer, scope, node, state, info) {
    const { fclos, ret } = info
    const funcCallReturnValueTaintSource = this.checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource

    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret, funcCallReturnValueTaintSource)
  }

  /**
   * check if sink or not by name and class
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   */
  checkByNameAndClassMatch(node, fclos, argvalues, scope) {
    const sinkRules = this.assembleFunctionCallSinkRule()

    const rules = matchSinkAtFuncCallWithCalleeType(node, fclos, sinkRules, scope)
    for (const rule of rules) {
      let args
      if (rule._sinkType === 'FuncCallTaintSink') {
        args = Rules.prepareArgs(argvalues, fclos, rule)
      } else if (rule._sinkType === 'ObjectTaintFuncCallSink') {
        args = fclos.getThis()
      }
      if (!args) {
        continue
      }

      const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
      const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
        node,
        fclos,
        args,
        scope,
        TAINT_TAG_NAME,
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
            TAINT_TAG_NAME,
            ruleName,
            matchedSanitizerTags
          )
          if (!TaintOutputStrategy.isNewFinding(this.resultManager, taintFlowFinding)) continue
          this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
        }
      }
    }

    return true
  }

  /**
   * check if sink or not by obj value
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   */
  checkByFieldMatch(node, fclos, argvalues, scope) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (!rules) return

    let matched = false
    rules.some((rule) => {
      if (typeof rule.fsig !== 'string') {
        return false
      }
      if (!rule.fsig.includes('.') && rule.calleeType === undefined) {
        return false // 不包含.的使用checkByNameMatch
      }
      const paths = rule.fsig.split('.')
      const lastIndex = rule.fsig.lastIndexOf('.')
      let RuleObj
      if (rule.calleeType) {
        RuleObj = rule.calleeType
      } else {
        RuleObj = rule.fsig.substring(0, lastIndex)
      }

      if (RuleObj === undefined && lastIndex === -1) {
        RuleObj = rule.fsig
      }
      const ruleCallName = paths[paths.length - 1]
      let callName
      const { callee } = node
      if (!callee) return false
      if (callee.type === 'MemberAccess') {
        callName = callee.property.name
      } else {
        // Identifier
        callName = callee.name
      }
      const CallFull = this.getObj(fclos)
      if (typeof CallFull === 'undefined') {
        return false
      }
      const lastIndexofCall = CallFull.lastIndexOf('.')
      if (ruleCallName !== '*' && ruleCallName !== callName) {
        if (lastIndexofCall >= 0) {
          // 补偿获取一次callName
          callName = CallFull.substring(lastIndexofCall + 1)
          if (ruleCallName !== callName && rule.fsig.includes('.')) {
            return false
          }
        }
      }

      let CallObj = CallFull
      if (lastIndexofCall >= 0) {
        CallObj = CallFull.substring(0, lastIndexofCall)
      }
      if (CallObj !== RuleObj && RuleObj !== '*') {
        return false
      }

      const create = false

      IntroduceTaint.matchAndMark(
        paths,
        scope,
        rule,
        () => {
          matched = true
        },
        create
      )
      if (matched) {
        const args = Rules.prepareArgs(argvalues, fclos, rule)
        const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
        const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
          node,
          fclos,
          args,
          scope,
          TAINT_TAG_NAME,
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
              TAINT_TAG_NAME,
              ruleName,
              matchedSanitizerTags
            )

            if (!TaintOutputStrategy.isNewFinding(this.resultManager, taintFlowFinding)) continue
            this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
          }
          return true
        }
      }
      matched = false
    })
  }

  /**
   * get obj
   * @param fclos
   */
  getObj(fclos) {
    if (
      typeof fclos?._sid !== 'undefined' &&
      typeof fclos?._qid === 'undefined' &&
      typeof fclos?._this === 'undefined'
    ) {
      const index = fclos?._sid.indexOf('>.')
      const result = index !== -1 ? fclos?._sid.substring(index + 2) : fclos?._sid
      return result.replace('<instance>', '')
    }
    if (typeof fclos?._qid !== 'undefined') {
      const index = fclos._qid.indexOf('>.')
      const result = index !== -1 ? fclos?._qid.substring(index + 2) : fclos?._qid
      return result.replace('<instance>', '')
    }
    if (!(fclos === fclos?._this)) {
      return this.getObj(fclos._this)
    }
    const index = fclos?._sid.indexOf('>.')
    const result = index !== -1 ? fclos?._sid.substring(index + 2) : fclos?._sid
    if (result) {
      return result.replace('<instance>', '')
    }
  }

  /**
   * assemble function call sink rule
   */
  assembleFunctionCallSinkRule() {
    const sinkRules = []
    const funcCallTaintSinkRules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (Array.isArray(funcCallTaintSinkRules)) {
      for (const funcCallTaintSinkRule of funcCallTaintSinkRules) {
        funcCallTaintSinkRule._sinkType = 'FuncCallTaintSink'
      }
      sinkRules.push(...funcCallTaintSinkRules)
    }
    const objectTaintFuncCallSinkRules = this.checkerRuleConfigContent.sinks?.ObjectTaintFuncCallSink
    if (Array.isArray(objectTaintFuncCallSinkRules)) {
      for (const objectTaintFuncCallSinkRule of objectTaintFuncCallSinkRules) {
        objectTaintFuncCallSinkRule._sinkType = 'ObjectTaintFuncCallSink'
      }
      sinkRules.push(...objectTaintFuncCallSinkRules)
    }

    return sinkRules
  }
}

module.exports = JavaTaintAbstractChecker
