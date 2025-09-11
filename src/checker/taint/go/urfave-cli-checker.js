const _ = require('lodash')
const commonUtil = require('../../../util/common-util')
const { completeEntryPoint, entryPointsUpToUser } = require('./entry-points-util')
const config = require('../../../config')
const Checker = require('../../common/checker')

const processedBuiltInRegistry = new Set()
const builtInOnjectList = ['github.com/urfave/cli.NewApp()']
const builtInPropertyList = ['Action']

/**
 * urfave.cli bulitIn checker
 * 为第三方库方法urfave.cli做建模，添加entryPoints
 */
class urfaveCliChecker extends Checker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    super(resultManager, 'urfave-cli-builtIn')
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
    if (config.entryPointMode === 'ONLY_CUSTOM') return // 不路由自采集
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
