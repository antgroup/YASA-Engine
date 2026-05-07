import type { CallInfo } from '../../../engine/analyzer/common/call-args'

const _ = require('lodash')
const CallchainChecker = require('../callchain-checker')
const { matchSinkAtFuncCall } = require('../../taint/common-kit/sink-util')
const config = require('../../../config')
const QidUnifyUtil = require('../../../util/qid-unify-util')
const Config = require('../../../config')

/**
 * JavaScript callchain checker
 * Only detects sink matches and outputs call chains without checking for taint
 */
class JsCallchainChecker extends CallchainChecker {
  entryPoints: any[]

  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'callchain_js')
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
    const { topScope, fileManager } = analyzer
    const loader = require('../../../util/loader')
    const commonUtil = require('../../../util/common-util')
    const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
    const constValue = require('../../../util/constant')
    const { handleException } = require('../../../engine/analyzer/common/exception-handler')

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

    // 完整复制 JsTaintChecker 的 prepareEntryPoints 逻辑
    const { entrypoints: ruleConfigEntryPoints } = this.checkerRuleConfigContent
    if (config.entryPointMode !== 'SELF_COLLECT') {
      // 自定义 source 入口方式，并根据入口自主加载 source
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
            let fieldT = topScope
            arr.forEach((path: any) => {
              fieldT = fieldT?.members?.get(path)
            })
            if (!fieldT || fieldT.vtype === 'undefine') {
              for (const [mod, modVal] of topScope.context.modules.members.entries()) {
                if (
                  mod.includes(entrypoint.filePath) &&
                  modVal.ast?.node?.type === 'CompileUnit'
                ) {
                  fieldT = modVal
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

              const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
              entryPoint.scopeVal = entryPointSymVal.parent
              entryPoint.functionName = entrypoint.functionName
              entryPoint.filePath = entrypoint.filePath
              entryPoint.attribute = entrypoint.attribute
              entryPoint.entryPointSymVal = entryPointSymVal
              this.entryPoints.push(entryPoint)
            } else {
              if (!fieldT.ast?.node || fieldT.ast.node.type !== 'CompileUnit') continue
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
          } catch (e: any) {
            handleException(
              e,
              '[js-callchain-checker]An Error Occurred in custom entrypoint',
              '[js-callchain-checker]An Error Occurred in custom entrypoint'
            )
          }
        }
      }
    }

    // 使用 callgraph 边界 + file 作为 entrypoint
    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      const fullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
      const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
        analyzer.ainfo?.callgraph,
        analyzer
      )
      const fullFileEntrypoint = fullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(analyzer)
      this.entryPoints.push(...fullCallGraphEntrypoint)
      this.entryPoints.push(...fullFileEntrypoint)
    }

    analyzer.entryPoints.push(...this.entryPoints)

    // 回填 processModule 阶段产生的 finding 的 entrypoint
    // processModule 阶段 getCurrentEntryPoint() 返回 YASADefault，需要从 callstack 匹配正确的 entrypoint
    this.backfillEntrypoints(constValue)
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
    this.checkSinkMatch(node, fclos, callInfo, state)
    this.checkByFieldMatch(node, fclos, callInfo, state)
  }

  /**
   * check if sink matches by name
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
    const nodeCallee = node.callee || node

    let rule = matchSinkAtFuncCall(node, fclos, rules, callInfo)
    rule = rule.length > 0 ? rule[0] : null

    // 如果没有匹配到，尝试基于函数名的匹配（用于处理解构导入等情况）
    if (!rule) {
      const functionName = fclos?.name || fclos?.ast?.node?.id?.name || nodeCallee?.name

      if (functionName) {
        for (const tspec of rules) {
          // 尝试匹配：如果 fsig 包含函数名（例如 child_process.exec 匹配 exec）
          if (tspec.fsig && (tspec.fsig === functionName || tspec.fsig.endsWith(`.${functionName}`))) {
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
   *
   * @param node
   * @param fclos
   * @param callInfo
   * @param state
   */
  checkByFieldMatch(node: any, fclos: any, callInfo: CallInfo | undefined, state: any) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }

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
        const result = QidUnifyUtil.removeParenthesesFromString(CallObj)
        if (result !== RuleObj) {
          if (!result.endsWith(`.${RuleObj}`) && !result.startsWith(`${RuleObj}.`)) {
            return false
          }
        }
      }
      this.findArgsAndAddNewFinding(node, callInfo, fclos, rule, state)
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
      let qid = fclos?.qid?.replace('Egg.Context', 'this.ctx')
      qid = qid?.replace('Egg.Application', 'this.app')
      qid = qid?.replace('this.app.service', 'this.ctx.service')
      qid = qid?.replace('Egg.Request', 'this.ctx.request')
      if (fclos.ast?.node?.loc?.sourcefile && fclos.ast?.node?.loc?.sourcefile.startsWith(Config.maindirPrefix)) {
        const prefix = fclos.ast.node.loc.sourcefile.substring(Config.maindirPrefix.length)
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

  /**
   * 回填 processModule 阶段产生的 finding 中为 YASADefault 的 entrypoint
   * 遍历已有 findings，从 callstackInfo 匹配 entryPoints 列表，找到正确的 entrypoint
   * @param constValue
   */
  backfillEntrypoints(constValue: any): void {
    const CallchainOutputStrategy = require('../../common/output/callchain-output-strategy')
    const category = this.resultManager?.findings?.[CallchainOutputStrategy.outputStrategyId]
    if (!category || this.entryPoints.length === 0) return

    for (const finding of category) {
      if (finding.entrypoint?.filePath !== constValue.YASA_DEFAULT) continue

      // 从 callstackInfo（已处理的调用链）中匹配 entryPoints
      const callstackInfo = finding.callstackInfo
      if (!callstackInfo || callstackInfo.length === 0) continue

      let matched = false
      for (const frame of callstackInfo) {
        if (frame.type === 1) continue // 跳过 sink 节点
        for (const ep of this.entryPoints) {
          if (ep.filePath === frame.file && ep.functionName === frame.function) {
            finding.entrypoint = {
              filePath: ep.filePath,
              functionName: ep.functionName,
              attribute: ep.attribute,
              funcReceiverType: ep.funcReceiverType || '',
            }
            matched = true
            break
          }
        }
        if (matched) break
      }
    }
  }
}

module.exports = JsCallchainChecker
