import type { CallInfo } from '../../../engine/analyzer/common/call-args'
import type { Invocation } from '../../../resolver/common/value/invocation'

const _ = require('lodash')
const CallchainChecker = require('../callchain-checker')
const RulesBasicHandler = require('../../common/rules-basic-handler')
const CallchainOutputStrategy = require('../../common/output/callchain-output-strategy')
const { matchSinkAtFuncCallWithCalleeType, checkInvocationMatchSink } = require('../../taint/common-kit/sink-util')
const SpringEntryPoint = require('../../../engine/analyzer/java/spring/entrypoint-collector/spring-default-entrypoint')
const Loader = require('../../../util/loader')
const CommonUtil = require('../../../util/common-util')
const Constant = require('../../../util/constant')
const {
  valueUtil: {
    ValueUtil: { Scoped },
  },
} = require('../../../engine/analyzer/common')

/**
 * Java callchain checker
 * Only detects sink matches and outputs call chains without checking for taint
 */
class JavaCallchainChecker extends CallchainChecker {
  entryPoints: any[]

  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'callchain_java')
    this.entryPoints = []
  }

  /**
   * starter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { topScope } = analyzer
    const AstUtil = require('../../../util/ast-util')
    const Config = require('../../../config')
    const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
    const logger = require('../../../util/logger')(__filename)

    // 直接从 analyzer.checkerManager.Rules 获取规则配置
    const BasicRuleHandler = analyzer.getCheckerManager().Rules
    if (BasicRuleHandler && BasicRuleHandler.getRules) {
      const allRules = BasicRuleHandler.getRules()
      if (Array.isArray(allRules) && allRules.length > 0) {
        for (const rule of allRules) {
          if (rule.checkerIds && rule.checkerIds.includes(this.getCheckerId())) {
            _.merge(this.checkerRuleConfigContent, rule)
            break
          }
        }
      }
    }

    // 准备 entrypoints - 完整复制 JavaTaintChecker 的逻辑
    const { entrypoints: ruleConfigEntryPoints } = this.checkerRuleConfigContent

    // 1. 自动采集 Spring entrypoints（如果不是 ONLY_CUSTOM 模式）
    if (Config.entryPointMode !== 'ONLY_CUSTOM') {
      logger.info('YASA will collect Entrypoint and Source for callchain')
      const { selfCollectSpringEntryPoints } = SpringEntryPoint.getSpringEntryPointAndSource(topScope.context.packages)

      if (!_.isEmpty(selfCollectSpringEntryPoints)) {
        selfCollectSpringEntryPoints.forEach((main: any) => {
          if (main) {
            const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
            entryPoint.scopeVal = main.parent
            entryPoint.argValues = []
            entryPoint.entryPointSymVal = main
            entryPoint.filePath = main.filePath
            entryPoint.functionName = main.functionName
            entryPoint.attribute = main.attribute
            entryPoint.funcReceiverType = main.funcReceiverType
            this.entryPoints.push(entryPoint)
          }
        })
      }
    }

    // 2. 处理 rule config 中的自定义 entrypoints（如果不是 SELF_COLLECT 模式）
    if (!_.isEmpty(ruleConfigEntryPoints) && Config.entryPointMode !== 'SELF_COLLECT') {
      for (const entrypoint of ruleConfigEntryPoints) {
        // 先尝试使用 packageName 查找（原始逻辑）
        if (entrypoint.packageName) {
          let targetPackage = entrypoint.packageName
          targetPackage = targetPackage.startsWith('.') ? targetPackage.slice(1) : targetPackage
          const arr = Loader.getPackageNameProperties(targetPackage)
          let packageManagerT = topScope.context.packages
          arr.forEach((path: any) => {
            packageManagerT = packageManagerT?.members?.get(path)
          })

          if (packageManagerT && packageManagerT.vtype !== 'undefine') {
            const func = entrypoint.functionName
            const entryPointSymVal = CommonUtil.getFclosFromScope(packageManagerT, func)
            if (entryPointSymVal?.vtype === 'fclos') {
              const scopeVal = Scoped('', {
                vtype: 'scope',
                sid: 'mock',
                qid: 'mock',
                field: {},
                parent: null,
              })

              const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
              entryPoint.scopeVal = scopeVal
              entryPoint.argValues = []
              entryPoint.functionName = entrypoint.functionName
              entryPoint.filePath = entrypoint.filePath
              entryPoint.attribute = entrypoint.attribute
              entryPoint.packageName = entrypoint.packageName
              entryPoint.entryPointSymVal = entryPointSymVal
              this.entryPoints.push(entryPoint)
              continue
            }
          }
        }

        // 如果 packageName 查找失败，使用 filePath 查找（备选方案）
        const entryPointSymVal = AstUtil.satisfy(
          topScope.context.packages,
          (n: any) =>
            n.vtype === 'fclos' &&
            (n?.ast?.node?.loc?.sourcefile?.endsWith(entrypoint.filePath) ||
              n?.ast?.node?.loc?.sourcefile?.includes(entrypoint.filePath)) &&
            n?.ast?.node?.id?.name === entrypoint.functionName,
          (node: any, prop: any) => prop === '_field',
          null,
          false
        )

        if (!_.isEmpty(entryPointSymVal)) {
          const symVal = Array.isArray(entryPointSymVal) ? entryPointSymVal[0] : entryPointSymVal
          const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
          entryPoint.scopeVal = symVal.parent
          entryPoint.argValues = []
          entryPoint.functionName = entrypoint.functionName
          entryPoint.filePath = entrypoint.filePath
          entryPoint.attribute = entrypoint.attribute || 'HTTP'
          entryPoint.packageName = entrypoint.packageName
          entryPoint.entryPointSymVal = symVal
          this.entryPoints.push(entryPoint)
        }
      }
    }

    analyzer.entryPoints = this.entryPoints
  }

  /**
   * FunctionCall trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, callInfo } = info
    this.checkSinkMatch(node, fclos, callInfo, scope, state, info, analyzer)
  }

  /**
   * check if sink matches by name and class
   * @param node
   * @param fclos
   * @param callInfo
   * @param scope
   * @param state
   * @param info
   * @param analyzer
   */
  checkSinkMatch(node: any, fclos: any, callInfo: CallInfo | undefined, scope: any, state: any, info: any, analyzer: any) {
    let sinkRules
    if (RulesBasicHandler.getPreprocessReady()) {
      if (!this.sinkRuleArray) {
        this.sinkRuleArray = this.assembleFunctionCallSinkRule()
        this.sinkArray = analyzer?.loadAllSink()
      }
      sinkRules = this.sinkRuleArray
    } else {
      sinkRules = this.assembleFunctionCallSinkRule()
    }

    let rules
    if (RulesBasicHandler.getPreprocessReady()) {
      if (node?._meta?.nodehash) {
        if (this.matchSinkRuleResultMap.has(node._meta.nodehash)) {
          rules = this.matchSinkRuleResultMap.get(node._meta.nodehash)
        } else {
          rules = matchSinkAtFuncCallWithCalleeType(node, fclos, sinkRules, scope, callInfo)
          this.appendCgRules(rules, node, scope, sinkRules, analyzer)
          this.matchSinkRuleResultMap.set(node._meta.nodehash, rules)
        }
      } else {
        rules = matchSinkAtFuncCallWithCalleeType(node, fclos, sinkRules, scope, callInfo)
        this.appendCgRules(rules, node, scope, sinkRules, analyzer)
      }
    } else {
      rules = matchSinkAtFuncCallWithCalleeType(node, fclos, sinkRules, scope, callInfo)
      this.appendCgRules(rules, node, scope, sinkRules, analyzer)
    }

    for (const rule of rules) {
      let ruleName = rule.fsig
      if (typeof rule.attribute !== 'undefined') {
        ruleName += `\nSINK Attribute: ${rule.attribute}`
      }
      const callchainFinding = this.buildCallchainFinding(
        this.getCheckerId(),
        this.desc,
        node,
        fclos,
        ruleName,
        state.callstack,
        state.callsites
      )
      if (!CallchainOutputStrategy.isNewFinding(this.resultManager, callchainFinding)) continue
      this.resultManager.newFinding(callchainFinding, CallchainOutputStrategy.outputStrategyId)
    }

    return true
  }

  /**
   * append matched rules find by callgraph
   * @param rules
   * @param node
   * @param scope
   * @param sinkRules
   * @param analyzer
   */
  appendCgRules(rules: any[], node: any, scope: any, sinkRules: any[], analyzer: any) {
    if (rules.length > 0) {
      return
    }
    const cgRules = this.findMatchedRuleByCallGraph(node, scope, sinkRules, analyzer)
    for (const cgRule of cgRules) {
      rules.push(cgRule)
    }
  }

  /**
   * find matched rule by CallGraph
   * @param node
   * @param scope
   * @param analyzer
   * @param sinkRules
   */
  findMatchedRuleByCallGraph(node: any, scope: any, sinkRules: any[], analyzer: any) {
    const resultArray: any[] = []

    if (!node || !scope || !sinkRules || !analyzer || !analyzer.findNodeInvocations) {
      return resultArray
    }

    const invocations: Invocation[] = analyzer.findNodeInvocations(scope, node)
    if (!invocations) {
      return resultArray
    }

    for (const invocation of invocations) {
      for (const sink of sinkRules) {
        const matchSink: boolean = checkInvocationMatchSink(invocation, sink, analyzer.typeResolver)
        if (matchSink) {
          resultArray.push(sink)
        }
      }
    }

    return resultArray
  }

  /**
   * assemble function call sink rule
   */
  assembleFunctionCallSinkRule() {
    const sinkRules: any[] = []
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

module.exports = JavaCallchainChecker
