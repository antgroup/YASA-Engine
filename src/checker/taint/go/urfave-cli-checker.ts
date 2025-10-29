const {
  completeEntryPoint: completeEntryPointUrfaveCli,
  entryPointsUpToUser: entryPointsUpToUserUrfaveCli,
} = require('./entry-points-util')
const configUrfaveCli = require('../../../config')
const CheckerUrfaveCli = require('../../common/checker')

const processedBuiltInRegistryUrfaveCli = new Set()
const builtInOnjectListUrfaveCli = ['github.com/urfave/cli.NewApp()']
const builtInPropertyListUrfaveCli = ['Action']

/**
 * urfave.cli bulitIn checker
 * 为第三方库方法urfave.cli做建模，添加entryPoints
 */
class urfaveCliChecker extends CheckerUrfaveCli {
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
    if (configUrfaveCli.entryPointMode === 'ONLY_CUSTOM') return // 不路由自采集
    if (!lvalue || !rvalue || rvalue.vtype !== 'fclos') return
    const { object, property } = lvalue
    if (!object || !property) return
    if (!builtInOnjectListUrfaveCli.includes(object._qid) || !builtInPropertyListUrfaveCli.includes(property.name))
      return
    const hash = JSON.stringify(node.right.loc)
    if (processedBuiltInRegistryUrfaveCli.has(hash)) return
    processedBuiltInRegistryUrfaveCli.add(hash)
    analyzer.entryPoints.push(completeEntryPointUrfaveCli(rvalue))
  }
}

export = urfaveCliChecker
