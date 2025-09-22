// checker加载逻辑重构后可打开，让stc不要用
const _ = require('lodash')
const Rules = require('../../common/rules-basic-handler')
const IntroduceTaint = require('../common-kit/source-util')
const IntroduceTaintForJs = require('./source-util-for-egg')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const constValue = require('../../../util/constant')
const commonUtil = require('../../../util/common-util')
const loader = require('../../../util/loader')
const { matchSinkAtFuncCall } = require('../common-kit/sink-util')
const TaintChecker = require('../taint-checker')
const {
  valueUtil: {
    ValueUtil: { Scoped },
  },
} = require('../../../engine/analyzer/common')
const config = require('../../../config')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
const { handleException } = require('../../../engine/analyzer/common/exception-handler')

const TAINT_TAG_NAME = 'JS_INPUT'

/**
 *
 */
class JsTaintChecker extends TaintChecker {
  /**
   *
   * @param resultManager
   */
  constructor(resultManager) {
    super(resultManager, 'taint_flow_js_input')
    this.entryPoints = []
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
    if (config.analyzer !== 'JavaScriptAnalyzer') {
      return
    }
    const { topScope, fileManager } = analyzer
    this.prepareEntryPoints(analyzer, topScope, fileManager)
    analyzer.entryPoints.push(...this.entryPoints)
    this.addSourceTagForSourceScope(TAINT_TAG_NAME, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME, this.checkerRuleConfigContent)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer, scope, node, state, info) {
    if (config.analyzer !== 'JavaScriptAnalyzer') {
      return
    }
    IntroduceTaint.introduceTaintAtIdentifier(node, info.res, this.sourceScope.value)
  }

  /**
   *
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtMemberAccess(analyzer, scope, node, state, info) {
    if (config.analyzer !== 'JavaScriptAnalyzer') {
      return
    }
    IntroduceTaintForJs.introduceTaintAtMemberAccess(info.res, this.sourceScope.value, node)
  }

  /** set entry points for javascript application's taint check
   *
   * @param analyzer
   * @param topScope
   * @param fileManager
   */
  prepareEntryPoints(analyzer, topScope, fileManager) {
    const { entrypoints: ruleConfigEntryPoints } = this.checkerRuleConfigContent
    if (config.entryPointMode !== 'SELF_COLLECT') {
      // 自定义source入口方式，并根据入口自主加载source
      const prepareEntryPointList = []
      if (!_.isEmpty(ruleConfigEntryPoints)) {
        prepareEntryPointList.push(...ruleConfigEntryPoints)
      }
      if (!_.isEmpty(prepareEntryPointList)) {
        for (const entrypoint of prepareEntryPointList) {
          try {
            let filepath = entrypoint.filePath
            filepath = filepath.startsWith('/') ? filepath.slice(1) : filepath
            const arr = loader.getFilePathProperties(filepath, { caseStyle: 'lower' })
            // const arr = filepath.split("/").filter(str => str !== "").map(str => str.split(".").shift());
            let fieldT = topScope
            arr.forEach((path) => {
              fieldT = fieldT?.field[path]
            })
            if (!fieldT || fieldT.vtype === 'undefine') {
              for (const mod in topScope.moduleManager.field) {
                if (
                  mod.includes(entrypoint.filePath) &&
                  topScope.moduleManager.field[mod].ast?.type === 'CompileUnit'
                ) {
                  fieldT = topScope.moduleManager.field[mod]
                  break
                }
              }
            }

            if (entrypoint.functionName) {
              const func = entrypoint.functionName
              const valExport = fieldT
              const entryPointSymVal = commonUtil.getFclosFromScope(valExport, func)
              if (entryPointSymVal?.vtype !== 'fclos') {
                continue
              }

              // const argValues = []
              const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
              entryPoint.scopeVal = entryPointSymVal.parent
              // entryPoint.argValues = argValues
              entryPoint.functionName = entrypoint.functionName
              entryPoint.filePath = entrypoint.filePath
              entryPoint.attribute = entrypoint.attribute
              entryPoint.entryPointSymVal = entryPointSymVal
              this.entryPoints.push(entryPoint)
            } else {
              if (!fieldT.ast || fieldT.ast.type !== 'CompileUnit') continue
              const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
              entryPoint.scopeVal = fieldT
              entryPoint.argValues = undefined
              entryPoint.functionName = undefined
              entryPoint.filePath = fieldT?.ast?.sourcefile || fieldT?.ast?.loc?.sourcefile
              entryPoint.attribute = entrypoint.attribute
              entryPoint.packageName = undefined
              entryPoint.entryPointSymVal = fieldT
              this.entryPoints.push(entryPoint)
            }
          } catch (e) {
            handleException(
              e,
              '[js-taint-checker]An Error Occurred in custom entrypoint',
              '[js-taint-checker]An Error Occurred in calcel custom entrypoint'
            )
          }
        }
      }
    }

    // 使用callgraph边界+file作为entrypoint
    const fullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
      const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
        analyzer.ainfo?.callgraph
      )
      const fullFileEntrypoint = fullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(analyzer.fileManager)
      this.entryPoints.push(...fullCallGraphEntrypoint)
      this.entryPoints.push(...fullFileEntrypoint)
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
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    if (config.analyzer !== 'JavaScriptAnalyzer') {
      return
    }
    const { fclos, argvalues } = info
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(fclos?.object, node, argvalues, funcCallArgTaintSource)
    this.checkSinkAtFunctionCall(node, fclos, argvalues)
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
    if (config.analyzer !== 'JavaScriptAnalyzer') {
      return
    }
    const { fclos, ret } = info
    const funcCallReturnValueTaintSource = this.checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource

    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret, funcCallReturnValueTaintSource)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionDefinition(analyzer, scope, node, state, info) {
    if (config.analyzer !== 'JavaScriptAnalyzer') {
      return
    }
    commonUtil.fillSourceScope(info.fclos, this.sourceScope)
  }

  /**
   *
   * @param node
   * @param fclos
   * @param argvalues
   */
  checkSinkAtFunctionCall(node, fclos, argvalues) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }

    let rule = matchSinkAtFuncCall(node, fclos, rules)
    rule = rule.length > 0 ? rule[0] : null

    if (rule) {
      const args = Rules.prepareArgs(argvalues, fclos, rule)
      const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
      const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
        node,
        fclos,
        args,
        null,
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
  }

  /**
   *
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   */
  checkByFieldMatch(node, fclos, argvalues, scope) {
    let rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
    rules = _.clone(rules)
    rules = rules.filter((v) => v.kind === TAINT_TAG_NAME)
    if (!rules) return

    let matched = false
    rules.some((rule) => {
      if (typeof rule.fsig !== 'string') {
        return false
      }
      const paths = rule.fsig.split('.')
      const lastIndex = rule.fsig.lastIndexOf('.')
      let RuleObj = rule.fsig.substring(0, lastIndex)
      if (lastIndex === -1) {
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
      if (CallObj !== RuleObj) {
        const idx = CallObj.lastIndexOf('(')
        const result = idx !== -1 ? CallObj.slice(0, idx) : CallObj
        if (result !== RuleObj) {
          if (!result.endsWith(`.${RuleObj}`) && !result.startsWith(`${RuleObj}.`)) {
            return false
          }
        }
      }

      const create = true

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
              ruleName += `\n` + `SINK Attribute: ${rule.attribute}`
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
      matched = false
    })
  }

  /**
   *
   * @param fclos
   */
  getObj(fclos) {
    if (typeof fclos?._qid === 'undefined' && typeof fclos?._this === 'undefined') {
      return fclos._sid?.replace('<instance>', '')
    }
    if (typeof fclos?._qid !== 'undefined') {
      let qid = fclos._qid?.replace('Egg.Context', 'this.ctx')
      qid = qid?.replace('Egg.Application', 'this.app')
      qid = qid?.replace('this.app.service', 'this.ctx.service')
      qid = qid?.replace('Egg.Request', 'this.ctx.request')
      if (fclos.ast?.loc?.sourcefile && fclos.ast?.loc?.sourcefile.startsWith(config.maindirPrefix)) {
        const prefix = fclos.ast.loc.sourcefile.substring(config.maindirPrefix.length).split('.')[0]
        if (prefix) {
          qid = qid?.substring(prefix.length + 1)
        }
      }
      return qid?.replace('<instance>', '')
    }
    if (!(fclos === fclos?._this)) {
      return this.getObj(fclos._this)
    }
    return fclos._sid?.replace('<instance>', '')
  }
}

module.exports = JsTaintChecker
