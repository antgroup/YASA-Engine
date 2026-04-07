import type Unit from '../../../engine/analyzer/common/value/unit'

const IntroduceTaint = require('./source-util')
const completeEntryPoint = require('./entry-points-util')

/**
 *
 * @param list
 */
export function flattenUnionValues(list: Array<Unit>): Array<Unit> {
  return list.filter(Boolean).flatMap((unit) => {
    switch (unit.vtype) {
      case 'union':
        return flattenUnionValues(unit.value)
      case 'fclos':
      case 'symbol':
      case 'object':
      case 'primitive':
        return [unit]
      default:
        throw new Error(`flattenUnionValues: Unknown type ${unit.vtype}`)
    }
  })
}

/**
 *
 * @param analyzer
 * @param state
 * @param processedRouteRegistry
 * @param entryPointUnitValue
 * @param source
 * @param taintKind
 */
export function processEntryPointAndTaintSource(
  analyzer: any,
  state: any,
  processedRouteRegistry: Set<string>,
  entryPointUnitValue: Unit,
  source: string,
  taintKind: string
) {
  flattenUnionValues([entryPointUnitValue])
    .filter((val) => val.vtype === 'fclos')
    .forEach((entryPointFuncValue) => {
      if (entryPointFuncValue?.ast?.node?.loc) {
        const hash = JSON.stringify(entryPointFuncValue.ast.node.loc)
        if (!processedRouteRegistry.has(hash)) {
          processedRouteRegistry.add(hash)
          IntroduceTaint.introduceFuncArgTaintBySelfCollection(entryPointFuncValue, state, analyzer, source, taintKind)
          const entryPoint = completeEntryPoint(entryPointFuncValue)
          analyzer.entryPoints.push(entryPoint)
        }
      }
    })
}
