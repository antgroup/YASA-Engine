import type { Finding } from '../../../engine/analyzer/common/common-types'
import type { EntryPoint } from '../../../engine/analyzer/common/entrypoint'

const LocationUtil = require('../util/location-util')
const EntrypointUtil = require('../util/entrypoint-util')
const QidUnifyUtil = require('../util/qid-unify-util')
const Config = require('../../../config')
const SymbolUtil = require('../util/symbol-util')
const logger = require('../../../util/logger')(__filename)
const Checker = require('../../common/checker')
const InteractiveOutputStrategy = require('../../common/output/interactive-output-strategy')

/**
 *
 */
class AntQLHasProperty extends Checker {
  mng: any

  kit: any

  status: boolean

  output: string[]

  symbolMap: Map<string, string[]>

  alreadyExecutedEntries: Map<string, boolean>

  input!: string

  /**
   *
   * @param mng
   */
  constructor(mng: any) {
    super(mng, 'antql_hasproperty')
    this.mng = mng
    this.kit = mng.kit
    this.status = false
    this.output = []
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
    this.output = []
    this.status = true
  }

  /**
   * 处理输出
   */
  handleOutput(): void {
    const finding: Finding = {
      output: '',
    }
    if (this.input.includes('*') || this.input.includes('**')) {
      const output: string[] = []
      const qidList = Array.from(this.symbolMap.keys())
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
    this.status = false
    this.resultManager.newFinding(finding, InteractiveOutputStrategy.outputStrategyId)
  }

  /**
   * 通过callgraph获取entrypoint
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
      // analyzer.entryPoints = Array.from(uniqueEntries.values())

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
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtEndOfNode(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (node?.type === 'Identifier' || node?.type === 'MemberAccess') {
      this.checkIsIdentifier(node, info.val, scope, info)
    }
  }

  /**
   *
   * @param node
   * @param res
   * @param scope
   * @param info
   */
  private checkIsIdentifier(node: any, res: any, scope: any, info: any): void {
    const checkQid = QidUnifyUtil.unify(res)
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

module.exports = AntQLHasProperty
