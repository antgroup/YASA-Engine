import type { Finding } from '../../../engine/analyzer/common/common-types'
import type { EntryPoint } from '../../../engine/analyzer/common/entrypoint'

const LocationUtil = require('../util/location-util')
const EntrypointUtil = require('../util/entrypoint-util')
const Config = require('../../../config')
const SymbolUtil = require('../util/symbol-util')
const QidUnifyUtil = require('../util/qid-unify-util')
const Checker = require('../../common/checker')
const InteractiveOutputStrategy = require('../../common/output/interactive-output-strategy')

/**
 *
 */
class AntQLHasFunctionCall extends Checker {
  mng: any

  kit: any

  status: boolean

  output: string[]

  symbolMap: Map<string, string[]>

  input!: string

  alreadyExecutedEntries!: Map<string, boolean>

  /**
   *
   * @param mng
   */
  constructor(mng: any) {
    super(mng, 'antql_hasfunctioncall')
    this.mng = mng
    this.kit = mng.kit
    this.status = false
    this.output = []
    this.symbolMap = new Map()
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
    // {
    //    command:"hasfunctioncall"
    //    arguments:["mysql.createConnection.query"]
    // }
    if (args.length !== 1) {
      return
    }
    this.input = args[0]
    this.status = false
    this.output = []
    this.status = true
    this.alreadyExecutedEntries = new Map()
  }

  /**
   * 处理输出
   */
  handleOutput(): void {
    this.status = false

    const finding: Finding = {
      output: '',
    }

    if (this.input.includes('*') || this.input.includes('**')) {
      const qidList = Array.from(this.symbolMap.keys())
      const output: string[] = []
      for (const qid of qidList) {
        if (SymbolUtil.matchPattern(qid, this.input)) {
          const locations = this.symbolMap.get(qid)
          if (locations) {
            output.push(...locations)
          }
        }
      }
      finding.output = output.join(',')
    } else if (this.symbolMap.has(this.input)) {
      const locations = this.symbolMap.get(this.input)
      finding.output = locations ? locations.join(',') : ''
    }
    this.resultManager.newFinding(finding, InteractiveOutputStrategy.outputStrategyId)
  }

  /**
   * 通过callgraph及source点获取entrypoint
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

    const keywordArr = this.input.split('.')
    if (keywordArr.length >= 1) {
      const keyword = keywordArr[keywordArr.length - 1]
      const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getEntryPointsUsingCallGraphByKeyWords(
        [keyword],
        analyzer.ainfo?.callgraph,
        analyzer.fileManager
      )
      const uniqueEntries = EntrypointUtil.mergeEntryPoints(fullCallGraphEntrypoint, analyzer.entryPoints)
      const prepareEntryPoints: EntryPoint[] = []
      for (const key of uniqueEntries.keys()) {
        if (!this.alreadyExecutedEntries.has(key)) {
          this.alreadyExecutedEntries.set(key, true)
          const entryPoint = uniqueEntries.get(key)
          if (entryPoint) {
            prepareEntryPoints.push(entryPoint)
          }
        }
      }
      analyzer.entryPoints = prepareEntryPoints
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
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos } = info
    const checkQid = QidUnifyUtil.unify(fclos)

    if (checkQid) {
      const nodeLoc = LocationUtil.convertUastLocationToString(node.loc, Config.prefixPath)
      if (!this.symbolMap.has(checkQid)) {
        this.symbolMap.set(checkQid, [])
      }
      const locations = this.symbolMap.get(checkQid)
      if (locations && !locations.includes(nodeLoc)) {
        locations.push(nodeLoc)
      }
    }
  }
}

module.exports = AntQLHasFunctionCall
