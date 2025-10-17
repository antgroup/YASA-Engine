const LocationUtil = require('../util/location-util')
const entrypointUtil = require('../util/entrypoint-util')
const Config = require('../../../config')
const symbolUtil = require('../util/symbol-util')
const QidUnifyUtil = require('../util/qid-unify-util')
const Checker = require('../../common/checker')
const InteractiveOutputStrategy = require('../../common/output/interactive-output-strategy')
const locationUtil = require('../util/location-util')

/**
 *
 */
class AntQLHasFunctionCall extends Checker {
  /**
   *
   * @param mng
   */
  constructor(mng) {
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
  getStrategyId() {
    return [InteractiveOutputStrategy.outputStrategyId]
  }

  /**
   * 处理输入，0 = functioncall
   * @param args
   */
  handleInput(args) {
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
   * @param success
   * @param message
   * @param body
   */
  handleOutput(success, message, body) {
    this.status = false

    const finding = {
      output: '',
    }

    if (this.input.includes('*') || this.input.includes('**')) {
      const qidList = Array.from(this.symbolMap.keys())
      const output = []
      for (const qid of qidList) {
        if (symbolUtil.matchPattern(qid, this.input)) {
          output.push(this.symbolMap.get(qid))
        }
      }
      finding.output = output.join(',')
    } else if (this.symbolMap.has(this.input)) {
      finding.output = this.symbolMap.get(this.input)?.join(',')
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
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
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
      const uniqueEntries = entrypointUtil.mergeEntryPoints(fullCallGraphEntrypoint, analyzer.entryPoints)
      const prepareEntryPoints = []
      for (const key of uniqueEntries.keys()) {
        if (!this.alreadyExecutedEntries.has(key)) {
          this.alreadyExecutedEntries.set(key, true)
          prepareEntryPoints.push(uniqueEntries.get(key))
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
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    const { fclos, argvalues } = info
    const checkQid = QidUnifyUtil.unify(fclos)

    if (checkQid) {
      const nodeLoc = LocationUtil.convertUastLocationToString(node.loc, Config.prefixPath)
      if (!this.symbolMap.has(checkQid)) {
        this.symbolMap.set(checkQid, [])
      }
      if (!this.symbolMap.get(checkQid).includes(nodeLoc)) {
        this.symbolMap.get(checkQid).push(nodeLoc)
      }
    }
  }
}

module.exports = AntQLHasFunctionCall
