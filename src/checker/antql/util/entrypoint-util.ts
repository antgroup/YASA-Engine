import type { EntryPoint } from '../../../engine/analyzer/common/entrypoint'

const Constant = require('../../../util/constant')

/**
 * 合并entryPoints和analyzerEntryPoints，返回合并后的数组
 * @param entryPoints
 * @param analyzerEntryPoints
 */
function mergeEntryPoints(entryPoints: EntryPoint[], analyzerEntryPoints: EntryPoint[]): Map<string, EntryPoint> {
  const uniqueEntries = new Map<string, EntryPoint>()

  analyzerEntryPoints.forEach((entryPoint: EntryPoint) => {
    const key = getEntryPointUniqueKey(entryPoint)
    uniqueEntries.set(key, entryPoint)
  })

  entryPoints.forEach((entryPoint: EntryPoint) => {
    const key = getEntryPointUniqueKey(entryPoint)
    uniqueEntries.set(key, entryPoint)
  })

  return uniqueEntries
}

/**
 * 获取entrypoint的唯一键
 * @param entryPoint
 */
function getEntryPointUniqueKey(entryPoint: EntryPoint): string {
  const loc = entryPoint?.entryPointSymVal?.ast?.loc
  if (loc) {
    return `${loc?.sourcefile}:${loc?.start?.line}:${loc?.start?.column}:${loc?.end?.line}:${loc?.end?.column}`
  }

  // 兜底策略
  switch (entryPoint.type) {
    case Constant.ENGIN_START_FUNCALL:
      return `${entryPoint?.filePath}.${entryPoint?.functionName}`
    default:
      return ''
  }
}

module.exports = {
  mergeEntryPoints,
}
