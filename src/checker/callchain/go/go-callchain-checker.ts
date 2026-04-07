import type { CallInfo } from '../../../engine/analyzer/common/call-args'

const _ = require('lodash')
const CallchainChecker = require('../callchain-checker')
const { matchSinkAtFuncCallWithCalleeType } = require('../../taint/common-kit/sink-util')
const GoEntryPoint = require('../../../engine/analyzer/golang/common/entrypoint-collector/go-default-entrypoint')
const FullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
const completeEntryPoint = require('../../taint/common-kit/entry-points-util')
const AstUtil = require('../../../util/ast-util')
const FileUtil = require('../../../util/file-util')

/**
 * Go callchain checker
 * Only detects sink matches and outputs call chains without checking for taint
 */
class GoCallchainChecker extends CallchainChecker {
  entryPoints: any[]

  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'callchain_go')
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
    const Config = require('../../../config')
    const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
    const Constant = require('../../../util/constant')
    const logger = require('../../../util/logger')(__filename)

    try {
      logger.info('[GoCallchainChecker] triggerAtStartOfAnalyze called')

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

      // 完整复制 GoDefaultTaintChecker 的 prepareEntryPoints 逻辑
      // 1. 添加 main 入口点（如果不是 ONLY_CUSTOM 模式）
      if (Config.entryPointMode !== 'ONLY_CUSTOM') {
        // 添加 main 入口
        let mainEntryPoints = GoEntryPoint.getMainEntryPoints(topScope.context.packages)
        if (!_.isEmpty(mainEntryPoints)) {
          if (Array.isArray(mainEntryPoints)) {
            mainEntryPoints = _.uniqBy(mainEntryPoints, (value: any) => value.ast?.fdef)
          } else {
            mainEntryPoints = [mainEntryPoints]
          }
          mainEntryPoints.forEach((main: any) => {
            if (main) {
              const entryPoint = completeEntryPoint(main)
              this.entryPoints.push(entryPoint)
            }
          })
        }

        // 使用 callGraph 边界作为 entrypoint
        if (Config.cgAlgo === 'CHA' && analyzer.typeResolver) {
          FullCallGraphFileEntryPoint.makeFullCallGraphByType(analyzer, analyzer.typeResolver)
        } else {
          FullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
        }
        const fullCallGraphEntrypoint = FullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
          analyzer.ainfo?.callgraph,
          analyzer
        )
        this.entryPoints.push(...fullCallGraphEntrypoint)
      }
    } catch (err: any) {
      logger.error(`[GoCallchainChecker] Error in entrypoint collection: ${err.message}`)
      logger.error(`[GoCallchainChecker] Stack: ${err.stack}`)
    }

    // 2. 使用用户规则中指定的 entrypoint
    const { entrypoints: ruleConfigEntryPoints } = this.checkerRuleConfigContent
    if (!_.isEmpty(ruleConfigEntryPoints) && Config.entryPointMode !== 'SELF_COLLECT') {
      logger.info(`[GoCallchainChecker] Processing ${ruleConfigEntryPoints.length} custom entrypoints`)
      for (const entrypoint of ruleConfigEntryPoints) {
        logger.info(`[GoCallchainChecker] Looking for: ${entrypoint.filePath}#${entrypoint.functionName}`)
        let entryPointSymVal
        if (entrypoint.funcReceiverType) {
          entryPointSymVal = AstUtil.satisfy(
            topScope.context.packages,
            (n: any) =>
              n.vtype === 'fclos' &&
              FileUtil.extractAfterSubstring(n?.ast?.node?.loc?.sourcefile, Config.maindirPrefix) === entrypoint.filePath &&
              n?.parent?.ast?.node?.type === 'ClassDefinition' &&
              n?.parent?.ast?.node?.id?.name === entrypoint.funcReceiverType &&
              n?.ast?.node?.id?.name === entrypoint.functionName,
            (node: any, prop: any) => prop === '_field',
            null,
            false
          )
        } else {
          // 尝试多种路径匹配方式
          entryPointSymVal = AstUtil.satisfy(
            topScope.context.packages,
            (n: any) => {
              const sourcefile = n?.ast?.node?.loc?.sourcefile
              const extracted = FileUtil.extractAfterSubstring(sourcefile, Config.maindirPrefix)
              const matches =
                n.vtype === 'fclos' &&
                (extracted === entrypoint.filePath ||
                  sourcefile?.endsWith(entrypoint.filePath) ||
                  sourcefile?.includes(`/${entrypoint.filePath}`)) &&
                n?.ast?.node?.id?.name === entrypoint.functionName

              if (matches) {
                logger.info(`[GoCallchainChecker] Found match: ${sourcefile} -> ${n?.ast?.node?.id?.name}`)
              }
              return matches
            },
            (node: any, prop: any) => prop === '_field',
            null,
            false
          )
        }

        if (_.isEmpty(entryPointSymVal)) {
          logger.warn(
            `[GoCallchainChecker] match entryPoint fail for ${entrypoint.filePath}#${entrypoint.functionName}`
          )
          continue
        }

        logger.info(
          `[GoCallchainChecker] Found ${Array.isArray(entryPointSymVal) ? entryPointSymVal.length : 1} match(es)`
        )
        const symValArray = Array.isArray(entryPointSymVal)
          ? _.uniqBy(entryPointSymVal, (value: any) => value.ast?.fdef)
          : [entryPointSymVal]
        for (const main of symValArray) {
          if (main) {
            const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
            entryPoint.scopeVal = main.parent
            entryPoint.argValues = []
            entryPoint.entryPointSymVal = main
            entryPoint.filePath = entrypoint.filePath
            entryPoint.functionName = entrypoint.functionName
            entryPoint.attribute = entrypoint.attribute
            entryPoint.funcReceiverType = main.funcReceiverType
            this.entryPoints.push(entryPoint)
          }
        }
      }
    }

    logger.info(`[GoCallchainChecker] Total entryPoints: ${this.entryPoints.length}`)
    analyzer.mainEntryPoints = this.entryPoints
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
    this.checkSinkMatch(node, fclos, callInfo, scope, state)
  }

  /**
   * check if sink matches by name and class
   * @param node
   * @param fclos
   * @param callInfo
   * @param scope
   * @param state
   */
  checkSinkMatch(node: any, fclos: any, callInfo: CallInfo | undefined, scope: any, state: any) {
    if (fclos === undefined) {
      return
    }
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink

    if (!rules || !callInfo) return

    const nodeCallee = node.callee || node

    let rule = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, scope, callInfo)
    rule = rule.length > 0 ? rule[0] : null

    // 如果没有匹配到，尝试基于 AST node 的匹配（用于处理类型信息缺失的情况）
    if (!rule && nodeCallee?.type === 'MemberAccess') {
      const objectName = nodeCallee.object?.name
      const propertyName = nodeCallee.property?.name

      if (objectName && propertyName) {
        for (const tspec of rules) {
          // 尝试匹配：如果 fsig 是方法名，检查是否匹配
          if (tspec.fsig === propertyName || tspec.fsig === `${objectName}.${propertyName}`) {
            // 对于 callchain checker，当类型信息缺失时，忽略 calleeType 检查
            // 因为我们只关心 sink 匹配，不需要严格的类型检查
            rule = tspec
            break
          }
        }
      }
    }

    if (rule) {
      this.findArgsAndAddNewFinding(node, callInfo, fclos, rule, state)
    }
  }
}

module.exports = GoCallchainChecker
