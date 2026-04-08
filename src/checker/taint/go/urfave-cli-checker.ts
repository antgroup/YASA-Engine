const completeEntryPoint = require('../common-kit/entry-points-util')
const config = require('../../../config')
const Checker = require('../../common/checker')

const processedBuiltInRegistry = new Set()
const builtInObjectList = ['github.com/urfave/cli.NewApp()']
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
  constructor(resultManager: any) {
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
  triggerAtAssignment(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { lvalue, rvalue } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return // 不路由自采集
    if (!lvalue || !rvalue || rvalue.vtype !== 'fclos') return
    const { object, property } = lvalue
    if (!object || !property) return
    if (!builtInObjectList.includes(object.qid) || !builtInPropertyList.includes(property.name)) return
    const hash = JSON.stringify(node.right.loc)
    if (processedBuiltInRegistry.has(hash)) return
    processedBuiltInRegistry.add(hash)
    analyzer.entryPoints.push(completeEntryPoint(rvalue, true))
  }
}

export = urfaveCliChecker
