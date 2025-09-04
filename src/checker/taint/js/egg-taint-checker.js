const _ = require('lodash')
const Rules = require('../../common/rules-basic-handler')
const { initRules } = require('../../common/rules-basic-handler')
const IntroduceTaint = require('../common-kit/source-util')
const IntroduceTaintForJs = require('./source-util-for-egg')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const constValue = require('../../../util/constant')
const commonUtil = require('../../../util/common-util')
const loader = require('../../../util/loader')
const { matchSinkAtFuncCall } = require('../common-kit/sink-util')
const {
  valueUtil: {
    ValueUtil: { Scoped },
  },
} = require('../../../engine/analyzer/common')
const config = require('../../../config')
const eggHttp = require('../../../engine/analyzer/javascript/egg/entrypoint-collector/egg-http')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const { handleException } = require('../../../engine/analyzer/common/exception-handler')
const logger = require('../../../util/logger')(__filename)

const CheckerId = 'taint_flow_egg_input'
const TAINT_TAG_NAME = 'EGG_INPUT'

/**
 *
 */
class EggTaintChecker {
  /**
   *
   * @param mng
   * @param resultManager
   */
  constructor(resultManager) {
    this.entryPoints = []
    this.sourceScope = {
      complete: false,
      value: [],
    }
    this.resultManager = resultManager
    initRules()
    commonUtil.initSourceScope(this.sourceScope)
  }

  /**
   *
   */
  static GetCheckerId() {
    return CheckerId
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
    if (config.analyzer !== 'EggAnalyzer') {
      return
    }
    const { topScope, fileManager } = analyzer
    this.prepareEntryPoints(analyzer, topScope, fileManager)
    analyzer.entryPoints.push(...this.entryPoints)
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
    if (config.analyzer !== 'EggAnalyzer') {
      return
    }
    try {
      IntroduceTaint.introduceTaintAtIdentifier(node, info.res, this.sourceScope.value)
    } catch (e) {
      handleException(
        e,
        `Exception in egg-taint-checker.triggerAtIdentifier`,
        `Exception in egg-taint-checker.triggerAtIdentifier`
      )
    }
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
    if (config.analyzer !== 'EggAnalyzer') {
      return
    }
    IntroduceTaintForJs.introduceTaintAtMemberAccess(info.res, this.sourceScope.value, node)
  }

  /** set entry points for Egg application's taint check
   *
   * @param analyzer
   * @param topScope
   * @param fileManager
   */
  prepareEntryPoints(analyzer, topScope, fileManager) {
    const { RouterPath: routers, TaintSource: SourceRules } = Rules.getRules() || {}
    // 自定义source入口方式，并根据入口自主加载source
    const prepareEntryPointList = []
    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      logger.info('YASA collecting egg source and entrypoint...')
      // eslint-disable-next-line prefer-const
      let { entryPoints, TaintSource } = eggHttp.getEggHttpEntryPointsAndSources(topScope.fileManager)

      if (_.isEmpty(entryPoints) && _.isEmpty(routers)) {
        logger.info('[egg-taint-checker]Egg EntryPoints are not found')
        return
      }
      if (_.isEmpty(TaintSource) && _.isEmpty(SourceRules)) {
        logger.info('[egg-taint-checker]Egg TaintSource are not found')
        return
      }

      if (config.entryPointMode !== 'ONLY_CUSTOM' && !_.isEmpty(TaintSource)) {
        Rules.getRules().TaintSource = Rules.getRules().TaintSource || []
        Rules.getRules().TaintSource.push(...TaintSource)
        commonUtil.initSourceScopeByTaintSourceWithLoc(this.sourceScope)
      }
      if (config.entryPointMode !== 'ONLY_CUSTOM' && !_.isEmpty(entryPoints)) {
        entryPoints.forEach((main) => {
          if (main) {
            const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
            entryPoint.argValues = []
            entryPoint.filePath = main.filePath
            entryPoint.functionName = main.functionName
            entryPoint.attribute = main.attribute
            prepareEntryPointList.push(entryPoint)
          }
        })
      }
    }
    if (!_.isEmpty(routers) && config.entryPointMode !== 'SELF_COLLECT') {
      prepareEntryPointList.push(...routers)
    }
    if (!_.isEmpty(prepareEntryPointList)) {
      for (const entrypoint of prepareEntryPointList) {
        let filepath = entrypoint.filePath || entrypoint.routerFile
        filepath = filepath.startsWith('/') ? filepath.slice(1) : filepath
        const arr = loader.getFilePathProperties(filepath, { caseStyle: 'lower' })
        // const arr = filepath.split("/").filter(str => str !== "").map(str => str.split(".").shift());
        let fieldT = topScope
        arr.forEach((path) => {
          fieldT = fieldT?.field[path]
        })
        if (!fieldT || fieldT.vtype === 'undefine') {
          continue
        }

        const func = entrypoint.functionName || entrypoint.routerFunc
        const valExport = fieldT
        const entryPointSymVal = commonUtil.getFclosFromScope(valExport, func)
        if (entryPointSymVal?.vtype !== 'fclos') {
          continue
        }

        const scopeVal = Scoped({
          vtype: 'scope',
          _sid: 'mock',
          _id: 'mock',
          field: {},
          parent: null,
        })

        // const argValues = []
        const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
        entryPoint.scopeVal = scopeVal
        // entryPoint.argValues = argValues
        entryPoint.functionName = entrypoint.functionName || entrypoint.routerFunc
        entryPoint.filePath = entrypoint.filePath || entrypoint.routerFile
        entryPoint.attribute = entrypoint.attribute || entrypoint.routerAttribute
        entryPoint.entryPointSymVal = entryPointSymVal
        this.entryPoints.push(entryPoint)
      }
    }
  }

  /**
   *
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    if (config.analyzer !== 'EggAnalyzer') {
      return
    }
    const { fclos, argvalues } = info
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(fclos?.object, node, argvalues)
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
    if (config.analyzer !== 'EggAnalyzer') {
      return
    }
    const { fclos, ret } = info
    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret)
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
    if (config.analyzer !== 'EggAnalyzer') {
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
    let rules = Rules.getRules()?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
    rules = _.clone(rules)
    rules = rules.filter((v) => v.kind === TAINT_TAG_NAME)
    if (!rules) return

    const rule = matchSinkAtFuncCall(node, fclos, rules).find((v) => v.kind === TAINT_TAG_NAME)

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
          const finding = Rules.getRule(CheckerId, node)
          this.resultManager.addNewFinding(nd, node, fclos, TAINT_TAG_NAME, finding, ruleName, matchedSanitizerTags)
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
    let rules = Rules.getRules()?.FuncCallTaintSink
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
        // 三方包补偿获取
        if (!CallObj.includes(RuleObj)) {
          return false
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
            const finding = Rules.getRule(CheckerId, node)
            this.resultManager.addNewFinding(nd, node, fclos, TAINT_TAG_NAME, finding, ruleName, matchedSanitizerTags)
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

module.exports = EggTaintChecker
