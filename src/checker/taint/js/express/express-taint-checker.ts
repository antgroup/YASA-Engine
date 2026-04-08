import type { CallInfo } from '../../../../engine/analyzer/common/call-args'

// checker加载逻辑重构后可打开，让stc不要用
const _ = require('lodash')
const Rules = require('../../../common/rules-basic-handler')
const IntroduceTaint = require('../../common-kit/source-util')
const IntroduceTaintForJs = require('../source-util-for-egg')
const EntryPoint = require('../../../../engine/analyzer/common/entrypoint')
const constValue = require('../../../../util/constant')
const commonUtil = require('../../../../util/common-util')
const loader = require('../../../../util/loader')
const { matchSinkAtFuncCall } = require('../../common-kit/sink-util')
const TaintChecker = require('../../taint-checker')
const config = require('../../../../config')
const SanitizerChecker = require('../../../sanitizer/sanitizer-checker')
const TaintOutputStrategy = require('../../../common/output/taint-output-strategy')
const { handleException } = require('../../../../engine/analyzer/common/exception-handler')
const logger = require('../../../../util/logger')(__filename)
const QidUnifyUtil = require('../../../../util/qid-unify-util')

const TAINT_TAG_NAME = 'EXPRESS_INPUT'

/**
 *
 */
class ExpressTaintChecker extends TaintChecker {
  entryPoints: any[]

  /**
   *
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_express_input')
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
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
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
  triggerAtIdentifier(analyzer: any, scope: any, node: any, state: any, info: any) {
    if (config.analyzer !== 'JavaScriptAnalyzer') {
      return
    }
    IntroduceTaint.introduceTaintAtIdentifier(analyzer, scope, node, info.res, this.sourceScope.value)
  }

  /**
   *
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtMemberAccess(analyzer: any, scope: any, node: any, state: any, info: any) {
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
  prepareEntryPoints(analyzer: any, topScope: any, fileManager: any) {
    const { entrypoints: ruleConfigEntryPoints, sources: ruleConfigSources } = this.checkerRuleConfigContent
    const prepareEntryPointList = []

    logger.info('YASA collecting express source...')

    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      logger.info('YASA calculating program entrypoint...')
      // TODO: 根据 Express 框架，自动添加路由
    }
    if (!_.isEmpty(ruleConfigEntryPoints) && config.entryPointMode !== 'SELF_COLLECT') {
      prepareEntryPointList.push(...ruleConfigEntryPoints)
    }
    if (!_.isEmpty(prepareEntryPointList)) {
      for (const entrypoint of prepareEntryPointList) {
        try {
          let filepath = entrypoint.filePath
          filepath = filepath.startsWith('/') ? filepath.slice(1) : filepath
          const arr = loader.getFilePathProperties(filepath, { caseStyle: 'lower' })
          let fieldT = topScope
          arr.forEach((path: any) => {
            fieldT = fieldT?.members?.get(path)
          })
          if (!fieldT || fieldT.vtype === 'undefine') {
            for (const mod of topScope.context.modules.members.keys()) {
              if (mod.includes(entrypoint.filePath) && topScope.context.modules.members.get(mod)?.ast?.node?.type === 'CompileUnit') {
                fieldT = topScope.context.modules.members.get(mod)
                break
              }
            }
          }
          if (!fieldT || fieldT.vtype === 'undefine') {
            continue
          }
          if (entrypoint.functionName) {
            const func = entrypoint.functionName
            const valExport = fieldT
            const entryPointSymVal = commonUtil.getFclosFromScope(valExport, func)
            if (entryPointSymVal?.vtype !== 'fclos') {
              continue
            }

            const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
            entryPoint.scopeVal = valExport
            entryPoint.functionName = entrypoint.functionName
            entryPoint.filePath = entrypoint.filePath
            entryPoint.attribute = entrypoint.attribute
            entryPoint.entryPointSymVal = entryPointSymVal
            this.entryPoints.push(entryPoint)
          } else {
            if (!fieldT.ast.node || fieldT.ast.node.type !== 'CompileUnit') continue
            const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
            entryPoint.scopeVal = fieldT
            entryPoint.argValues = undefined
            entryPoint.functionName = undefined
            entryPoint.filePath = fieldT?.ast?.node?.loc?.sourcefile
            entryPoint.attribute = entrypoint.attribute
            entryPoint.packageName = undefined
            entryPoint.entryPointSymVal = fieldT
            this.entryPoints.push(entryPoint)
          }
        } catch (e) {
          handleException(
            e,
            '[express-taint-checker]An Error Occurred in custom entrypoint',
            '[express-taint-checker]An Error Occurred in custom entrypoint'
          )
        }
      }
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
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    if (config.analyzer !== 'JavaScriptAnalyzer') {
      return
    }

    const { fclos, callInfo } = info

    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(fclos?.object, node, callInfo, funcCallArgTaintSource)
    this.checkSinkAtFunctionCall(node, fclos, callInfo, state)
    this.checkByFieldMatch(node, fclos, callInfo, scope, state)
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
  triggerAtFunctionDefinition(analyzer: any, scope: any, node: any, state: any, info: any) {
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
   * @param state
   */
  checkSinkAtFunctionCall(node: any, fclos: any, callInfo: CallInfo | undefined, state?: any) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }

    let rule = matchSinkAtFuncCall(node, fclos, rules, callInfo)
    rule = rule.length > 0 ? rule[0] : null

    if (rule) {
      const args = Rules.prepareArgs(callInfo, fclos, rule)
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
            matchedSanitizerTags,
            state?.callstack
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
   * @param state
   */
  checkByFieldMatch(node: any, fclos: any, callInfo: CallInfo | undefined, scope: any, state?: any) {
    let rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
    rules = _.clone(rules)

    let matched = false
    rules.some((rule: any) => {
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
          // 补偿获取一次 callName
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
        const args = Rules.prepareArgs(callInfo, fclos, rule)
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
              matchedSanitizerTags,
              state?.callstack
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
  getObj(fclos: any): any {
    if (typeof fclos?.qid === 'undefined' && typeof fclos?._this === 'undefined') {
      return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(fclos.sid)
    }
    if (typeof fclos?.qid !== 'undefined') {
      let { qid } = fclos
      if (fclos.ast?.node?.loc?.sourcefile && fclos.ast?.node?.loc?.sourcefile.startsWith(config.maindirPrefix)) {
        const prefix = fclos.ast.node.loc.sourcefile.substring(config.maindirPrefix.length)
        const lastDotIndex = prefix.lastIndexOf('.')
        const result = lastDotIndex >= 0 ? prefix.substring(0, lastDotIndex) : prefix
        if (result) {
          qid = qid?.substring(prefix.length + 1)
        }
      }
      return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(qid)
    }
    if (!(fclos === fclos?._this)) {
      return this.getObj(fclos._this)
    }
    return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(fclos.sid)
  }
}

module.exports = ExpressTaintChecker
