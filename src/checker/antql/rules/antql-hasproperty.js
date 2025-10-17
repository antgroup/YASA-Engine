const LocationUtil = require('../util/location-util')
const entrypointUtil = require('../util/entrypoint-util')
const QidUnifyUtil = require('../util/qid-unify-util')
const Config = require('../../../config')
const symbolUtil = require('../util/symbol-util')
const logger = require('../../../util/logger')(__filename)
const Checker = require('../../common/checker')
const InteractiveOutputStrategy = require(
  '../../common/output/interactive-output-strategy')

/**
 *
 */
class AntQLHasProperty extends Checker {
  /**
   *
   * @param mng
   */
  constructor(mng) {
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
  getStrategyId() {
    return [InteractiveOutputStrategy.outputStrategyId]
  }

  /**
   * 处理输入，0 = functioncall
   * @param args
   */
  handleInput(args) {
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
   * @param success
   * @param message
   * @param body
   */
  handleOutput(success, message, body) {
    const finding = {
      output: '',
    }
    if (this.input.includes('*') || this.input.includes('**')) {
      const output = []
      const qidList = Array.from(this.symbolMap.keys())
      for (const qid of qidList) {
        if (symbolUtil.matchPattern(qid, this.input)) {
          output.push(this.symbolMap.get(qid))
        }
      }
      finding.output = output.join(',')
    } else if (this.symbolMap.has(this.input)) {
      finding.output = this.symbolMap.get(this.input).join(',')
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
      // analyzer.entryPoints = Array.from(uniqueEntries.values())

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
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtEndOfNode(analyzer, scope, node, state, info) {
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
  checkIsIdentifier(node, res, scope, info) {
    const checkQid = QidUnifyUtil.unify(res)
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

module.exports = AntQLHasProperty
