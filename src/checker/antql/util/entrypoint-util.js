const constValue = require('../../../util/constant')

/**
 * 合并entryPoints和analyzerEntryPoints，返回合并后的数组
 * @param entryPoints
 * @param analyzerEntryPoints
 */
function mergeEntryPoints(entryPoints, analyzerEntryPoints) {
  const uniqueEntries = new Map()

  analyzerEntryPoints.forEach((entryPoint) => {
    const key = getEntryPointUniqueKey(entryPoint)
    uniqueEntries.set(key, entryPoint)
  })

  entryPoints.forEach((entryPoint) => {
    const key = getEntryPointUniqueKey(entryPoint)
    uniqueEntries.set(key, entryPoint)
  })

  return uniqueEntries
}

/**
 * 获取entrypoint的唯一键
 * @param entryPoint
 */
function getEntryPointUniqueKey(entryPoint) {
  const loc = entryPoint?.entryPointSymVal?.ast?.loc
  if (loc) {
    return `${loc?.sourcefile}:${loc?.start?.line}:${loc?.start?.column}:${loc?.end?.line}:${loc?.end?.column}`
  }

  // 兜底策略
  switch (entryPoint.type) {
    case constValue.ENGIN_START_FUNCALL:
      return `${entryPoint?.filePath}.${entryPoint?.functionName}`
    default:
      return ''
  }
}

module.exports = {
  mergeEntryPoints,
}
