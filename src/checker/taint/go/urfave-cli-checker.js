const _ = require('lodash')
const commonUtil = require('../../../util/common-util')
const { completeEntryPoint, entryPointsUpToUser } = require('./entry-points-util')
const config = require('../../../config')

const processedBuiltInRegistry = new Set()
const builtInOnjectList = ['github.com/urfave/cli.NewApp()']
const builtInPropertyList = ['Action']

const CheckerId = 'urfave-cli-builtIn'

/**
 * urfave.cli bulitIn checker
 * 为第三方库方法urfave.cli做建模，添加entryPoints
 */
class urfaveCliChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    this.entryPoints = []
    this.sourceScope = {
      complete: false,
      value: [],
    }
    this.resultManager = resultManager
    commonUtil.initSourceScope(this.sourceScope)
  }

  /**
   * @returns {string}
   * @constructor
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
  triggerAtAssignment(analyzer, scope, node, state, info) {
    const { lvalue, rvalue } = info
    if (config.entryPointMode === 'ONLY_CUSTOM' && entryPointsUpToUser) return // 不路由自采集
    if (!lvalue || !rvalue || rvalue.vtype !== 'fclos') return
    const { object, property } = lvalue
    if (!object || !property) return
    if (!builtInOnjectList.includes(object._qid) || !builtInPropertyList.includes(property.name)) return
    const hash = JSON.stringify(node.right.loc)
    if (processedBuiltInRegistry.has(hash)) return
    processedBuiltInRegistry.add(hash)
    analyzer.entryPoints.push(completeEntryPoint(rvalue))
  }
}

module.exports = urfaveCliChecker
