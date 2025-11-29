import { processEntryPointAndTaintSource } from './util'

const config = require('../../../config')
const GoAnalyzer = require('../../../engine/analyzer/golang/common/go-analyzer')

const RouteRegistryProperty = ['Filter', 'To', 'If']
const KnownPackageName = {
  'github.com/emicklei/go-restful': 'restful',
  'github.com/emicklei/go-restful/v3': 'restful',
}
const RouteRegistryObject = [
  'github.com/emicklei/go-restful.WebService<instance>',
  'github.com/emicklei/go-restful/v3.WebService<instance>',
]
const Checker = require('../../common/checker')

const processedRouteRegistry = new Set<string>()

/**
 *
 */
class RestfulEntrypointCollectChecker extends Checker {
  /**
   *
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'go-restful-entryPoints-collect-checker')
    GoAnalyzer.registerKnownPackageNames(KnownPackageName)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, argvalues } = info

    this.collectRouteRegistry(node, fclos, argvalues, scope, info)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
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
  collectRouteRegistry(callExpNode: any, calleeFClos: any, argValues: any, scope: any, info: any) {
    const { analyzer, state } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    if (!(calleeFClos && calleeFClos.object && calleeFClos.property)) return
    const { object, property } = calleeFClos
    if (!object._qid || !property.name) return
    const objectQid = object._qid
    const propertyName = property.name
    if (
      RouteRegistryObject.some((prefix) => objectQid.startsWith(prefix)) &&
      RouteRegistryProperty.includes(propertyName) &&
      argValues[0]
    ) {
      processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, argValues[0], '0')
    }
  }
}

module.exports = RestfulEntrypointCollectChecker
