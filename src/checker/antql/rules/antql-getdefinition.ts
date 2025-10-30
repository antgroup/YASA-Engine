import type { Finding } from '../../../engine/analyzer/common/common-types'

const LocationUtil = require('../util/location-util')
const EntrypointUtil = require('../util/entrypoint-util')
const Config = require('../../../config')
const QidUnifyUtil = require('../util/qid-unify-util')
const logger = require('../../../util/logger')(__filename)
const Checker = require('../../common/checker')
const InteractiveOutputStrategy = require('../../common/output/interactive-output-strategy')

/**
 *
 */
class AntQLGetDefinition extends Checker {
  mng: any

  kit: any

  status: boolean

  symbolMap: Map<string, string>

  alreadyExecutedEntries: Map<string, any>

  input!: string

  /**
   *
   * @param mng
   */
  constructor(mng: any) {
    super(mng, 'antql_getdefinition')
    this.mng = mng
    this.kit = mng.kit
    this.status = false
    this.symbolMap = new Map()
    this.alreadyExecutedEntries = new Map()
  }

  /**
   * 配置输出策略
   */
  getStrategyId(): string[] {
    return [InteractiveOutputStrategy.outputStrategyId]
  }

  /**
   * 处理输入，0 = functioncall
   * @param args
   */
  handleInput(args: string[]): void {
    if (args.length !== 1) {
      logger.error('args 不合法')
      return
    }
    this.input = args[0]
    this.status = true
  }

  /**
   * 处理输出
   * @param success
   * @param message
   * @param body
   */
  handleOutput(): void {
    this.status = false
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (!this.status) {
      return
    }
    analyzer.entryPoints = []
    const fullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
    // fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
    const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getEntryPointsUsingCallGraphByLoc(
      LocationUtil.convertQLLocationStringListToUastLocation([this.input], Config.prefixPath),
      analyzer.ainfo?.callgraph,
      analyzer.fileManager
    )
    const uniqueEntries = EntrypointUtil.mergeEntryPoints(fullCallGraphEntrypoint, analyzer.entryPoints)
    analyzer.entryPoints = Array.from(uniqueEntries.values())
  }

  /**
   *
   * @param analyzer
   * @param node
   * @param res
   * @param scope
   * @param state
   * @param info
   */
  triggerAtEndOfNode(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (!this?.input || !this.status) {
      return
    }
    const qlLocationString = LocationUtil.findUastLocationInList(node?.loc, [this.input], Config.prefixPath)
    if (qlLocationString) {
      const finding: Finding = {
        output: QidUnifyUtil.unify(info.val),
      }
      this.resultManager.newFinding(finding, InteractiveOutputStrategy.outputStrategyId)
    }
  }
}

module.exports = AntQLGetDefinition
