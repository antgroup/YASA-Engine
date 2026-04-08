import { getLegacyArgValues } from '../../../engine/analyzer/common/call-args'

const config = require('../../../config')

const RouteRegistryProperty = ['Filter', 'To', 'If']
const RouteRegistryObject = [
  /github\.com\/emicklei\/go-restful\/v3\.WebService<instance_.*?>/,
  /github\.com\/emicklei\/go-restful\.WebService<instance_.*?>/,
]
const IntroduceTaint = require('../common-kit/source-util')
const Checker = require('../../common/checker')
const completeEntryPoint = require('../common-kit/entry-points-util')

const processedRouteRegistry = new Set()

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
    const { fclos, callInfo } = info
    const argvalues = getLegacyArgValues(callInfo)
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
    if (!object.qid || !property.name) return
    const objectQid = object.qid
    const propertyName = property.name
    if (RouteRegistryObject.some((prefix) => prefix.test(objectQid)) && RouteRegistryProperty.includes(propertyName)) {
      if (argValues.length < 1) return
      const arg0 = argValues[0]

      if (arg0?.vtype === 'fclos' && arg0?.ast.node.loc) {
        const hash = JSON.stringify(arg0.ast.node.loc)
        if (!processedRouteRegistry.has(hash)) {
          processedRouteRegistry.add(hash)
          IntroduceTaint.introduceFuncArgTaintBySelfCollection(arg0, state, analyzer, '0', 'GO_INPUT')
          const entryPoint = completeEntryPoint(arg0)
          analyzer.entryPoints.push(entryPoint)
        }
      }
    }
  }
}

module.exports = RestfulEntrypointCollectChecker
