const { completeEntryPoint, entryPointsUpToUser } = require('./entry-points-util')
const config = require('../../../config')
const commonUtil = require('../../../util/common-util')

const RouteRegistryProperty = ['HandleFunc', 'Handle', 'Handler']
const RouteRegistryObject = ['github.com/gorilla/mux.NewRouter()']
const IntroduceTaint = require('../common-kit/source-util')
const Checker = require('../../common/checker')

const processedRouteRegistry = new Set()

/**
 * Mux entryPoint采集以及框架source添加
 * checker
 */
class MuxEntryPointCollectChecker extends Checker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    super(resultManager, 'gorilla-mux-entrypoint-collect-checker')
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

    this.collectRouteRegistry(node, fclos, argvalues, scope, info)
  }

  /**
   * 每次运行完main后清空hash
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer, scope, node, state, info) {
    if (info?.entryPoint.functionName === 'main') processedRouteRegistry.clear()
  }

  /**
   *
   * @param callExpNode
   * @param calleeFClos
   * @param argValues
   * @param scope
   * @param info
   */
  collectRouteRegistry(callExpNode, calleeFClos, argValues, scope, info) {
    const { analyzer, state } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return // 不路由自采集
    if (!(calleeFClos && calleeFClos.object && calleeFClos.property)) return
    const { object, property } = calleeFClos
    if (!object._qid || !property.name) return
    const objectQid = object._qid
    const propertyName = property.name
    if (
      RouteRegistryObject.some((muxPrefix) => objectQid.startsWith(muxPrefix)) &&
      RouteRegistryProperty.includes(propertyName)
    ) {
      for (const arg of argValues) {
        if (arg?.vtype === 'fclos' && arg?.ast.loc) {
          const hash = JSON.stringify(arg.ast.loc)
          if (!processedRouteRegistry.has(hash)) {
            processedRouteRegistry.add(hash)
            IntroduceTaint.introduceFuncArgTaintBySelfCollection(arg, state, analyzer, '1:', 'GO_INPUT')
            const entryPoint = completeEntryPoint(arg)
            analyzer.entryPoints.push(entryPoint)
          }
        }
      }
    }
  }
}

module.exports = MuxEntryPointCollectChecker
