import type { CallInfo } from '../../../engine/analyzer/common/call-args'

const _ = require('lodash')
const CallchainChecker = require('../callchain-checker')
const { matchSinkAtFuncCall, matchRegex } = require('../../taint/common-kit/sink-util')
const FullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const Constant = require('../../../util/constant')
const Config = require('../../../config')
const AstUtil = require('../../../util/ast-util')
const FileUtil = require('../../../util/file-util')
const logger = require('../../../util/logger')(__filename)

/**
 * PHP callchain checker
 * 仅检测 sink 匹配并输出调用链，不检查污点流
 * PHP 函数是全局的（无包前缀），fsig 匹配直接用函数名
 */
class PhpCallchainChecker extends CallchainChecker {
  entryPoints: any[]

  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'callchain_php')
    this.entryPoints = []
  }

  /**
   * 启动触发：收集 PHP 入口点
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { topScope } = analyzer

    try {
      logger.info('[PhpCallchainChecker] triggerAtStartOfAnalyze called')

      // 从 analyzer.checkerManager.Rules 获取规则配置
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

      // 使用 FullCallGraphFileEntryPoint 收集调用图边界入口
      if (Config.entryPointMode !== 'ONLY_CUSTOM') {
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

        // PHP 是脚本语言，也加入文件级别入口点
        const fileEntryPoints = FullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(analyzer)
        this.entryPoints.push(...fileEntryPoints)
      }
    } catch (err: any) {
      logger.error(`[PhpCallchainChecker] Error in entrypoint collection: ${err.message}`)
      logger.error(`[PhpCallchainChecker] Stack: ${err.stack}`)
    }

    // 使用用户规则中指定的 entrypoint
    const { entrypoints: ruleConfigEntryPoints } = this.checkerRuleConfigContent
    if (!_.isEmpty(ruleConfigEntryPoints) && Config.entryPointMode !== 'SELF_COLLECT') {
      logger.info(`[PhpCallchainChecker] Processing ${ruleConfigEntryPoints.length} custom entrypoints`)
      for (const entrypoint of ruleConfigEntryPoints) {
        logger.info(`[PhpCallchainChecker] Looking for: ${entrypoint.filePath}#${entrypoint.functionName}`)

        if (entrypoint.functionName) {
          // PHP 全局函数匹配：直接按文件路径 + 函数名查找
          let entryPointSymVal = AstUtil.satisfy(
            topScope.context.packages,
            (n: any) => {
              const sourcefile = n?.ast?.node?.loc?.sourcefile
              const extracted = FileUtil.extractAfterSubstring(sourcefile, Config.maindirPrefix)
              return (
                n.vtype === 'fclos' &&
                (extracted === entrypoint.filePath ||
                  sourcefile?.endsWith(entrypoint.filePath) ||
                  sourcefile?.includes(`/${entrypoint.filePath}`)) &&
                n?.ast?.node?.id?.name === entrypoint.functionName
              )
            },
            (n: any, prop: any) => prop === '_field',
            null,
            false
          )

          if (_.isEmpty(entryPointSymVal)) {
            logger.warn(
              `[PhpCallchainChecker] match entryPoint fail for ${entrypoint.filePath}#${entrypoint.functionName}`
            )
            continue
          }

          const symValArray = Array.isArray(entryPointSymVal)
            ? _.uniqBy(entryPointSymVal, (value: any) => value.ast?.fdef)
            : [entryPointSymVal]

          for (const main of symValArray) {
            if (main) {
              const ep = new EntryPoint(Constant.ENGIN_START_FUNCALL)
              ep.scopeVal = main.parent
              ep.argValues = []
              ep.entryPointSymVal = main
              ep.filePath = entrypoint.filePath
              ep.functionName = entrypoint.functionName
              ep.attribute = entrypoint.attribute
              this.entryPoints.push(ep)
            }
          }
        } else {
          // 文件级入口
          const ep = new EntryPoint(Constant.ENGIN_START_FILE_BEGIN)
          ep.filePath = entrypoint.filePath
          ep.attribute = entrypoint.attribute
          this.entryPoints.push(ep)
        }
      }
    }

    logger.info(`[PhpCallchainChecker] Total entryPoints: ${this.entryPoints.length}`)
    analyzer.mainEntryPoints = this.entryPoints
  }

  /**
   * 函数调用触发：检测 sink 匹配
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, callInfo } = info
    this.checkSinkMatch(node, fclos, callInfo, state)
  }

  /**
   * 检查 sink 匹配
   * PHP 函数是全局的，使用 matchSinkAtFuncCall 按函数名直接匹配
   * @param node
   * @param fclos
   * @param callInfo
   * @param state
   */
  checkSinkMatch(node: any, fclos: any, callInfo: CallInfo | undefined, state: any) {
    if (fclos === undefined) {
      return
    }
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink

    if (!rules || !callInfo) return

    // PHP 函数是全局的，优先用 matchSinkAtFuncCall 按函数名匹配
    let rule = matchSinkAtFuncCall(node, fclos, rules, callInfo)
    rule = rule.length > 0 ? rule[0] : null

    // 若未匹配到，尝试用 fclos 的 sid/qid 做回退匹配
    if (!rule) {
      const callName = this.resolvePhpCallName(fclos)
      if (callName) {
        for (const tspec of rules) {
          if (tspec.fsig && tspec.fsig === callName) {
            rule = tspec
            break
          }
          if (tspec.fregex && matchRegex(tspec.fregex, callName)) {
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

  /**
   * 从 fclos 解析 PHP 调用名称
   * PHP 全局函数无包前缀，直接取函数名
   * @param fclos
   */
  resolvePhpCallName(fclos: any): string | undefined {
    // 优先取 sid（函数标识符名称）
    if (typeof fclos?.sid === 'string' && fclos.sid !== '') {
      return fclos.sid
    }
    // 回退到 qid
    if (typeof fclos?.qid === 'string' && fclos.qid !== '') {
      return fclos.qid
    }
    // 回退到 AST 节点名
    if (fclos?.ast?.node?.id?.name) {
      return fclos.ast.node.id.name
    }
    return undefined
  }
}

module.exports = PhpCallchainChecker
