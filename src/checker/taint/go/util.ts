import type Unit from '../../../engine/analyzer/common/value/unit'

const IntroduceTaint = require('../common-kit/source-util')
const completeEntryPoint = require('../common-kit/entry-points-util')

/**
 *
 * @param list
 */
export function flattenUnionValues(list: Array<Unit>): Array<Unit> {
  return list.flatMap((unit) => {
    switch (unit.vtype) {
      case 'union':
        return flattenUnionValues(unit.value)
      case 'fclos':
      case 'symbol':
      case 'object':
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
 */
export function processEntryPointAndTaintSource(
  analyzer: any,
  state: any,
  processedRouteRegistry: Set<string>,
  entryPointUnitValue: Unit,
  source: string
) {
  flattenUnionValues([entryPointUnitValue])
    .filter((val) => val.vtype === 'fclos')
    .forEach((entryPointFuncValue) => {
      if (entryPointFuncValue?.ast.loc) {
        const hash = JSON.stringify(entryPointFuncValue.ast.loc)
        if (!processedRouteRegistry.has(hash)) {
          processedRouteRegistry.add(hash)
          IntroduceTaint.introduceFuncArgTaintBySelfCollection(entryPointFuncValue, state, analyzer, source, 'GO_INPUT')
          const entryPoint = completeEntryPoint(entryPointFuncValue)
          analyzer.entryPoints.push(entryPoint)
        }
      }
    })
}
