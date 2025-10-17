const path = require('path')

/**
 * 将uast的location转换成string格式
 * @param uastLocation
 * @param prefixPath
 */
function convertUastLocationToString(uastLocation, prefixPath = '.') {
  if (!uastLocation) {
    return ''
  }
  let sourceFile = uastLocation?.sourcefile
  if (prefixPath !== '.') {
    sourceFile = sourceFile.substring(prefixPath.length)
  }
  const startLine = uastLocation?.start?.line
  const startColumn = uastLocation?.start?.column
  const endLine = uastLocation?.end?.line
  let endColumn = uastLocation?.end?.column
  // uast的column会比ql多1
  endColumn = endColumn < 0 ? 0 : endColumn - 1
  return `${sourceFile}:${startLine}:${startColumn}:${endLine}:${endColumn}`
}

/**
 *
 * @param qlLocationStringList
 */
function convertQLLocationStringListToUastLocation(qlLocationStringList, prefixPath = '.') {
  const result = []
  for (const qlLocationString of qlLocationStringList) {
    result.push(convertQLLocationStringToUastLocation(qlLocationString, prefixPath))
  }
  return result
}

/**
 *
 * @param qlLocationString
 */
function convertQLLocationStringToUastLocation(qlLocationString, prefixPath = '.') {
  const qllocs = qlLocationString.split(':')
  const qlSourceFile = qllocs[0]
  const qlStartLine = parseInt(qllocs[1], 10)
  const qlStartColumn = parseInt(qllocs[2], 10)
  const qlEndLine = parseInt(qllocs[3], 10)
  const qlEndColumn = parseInt(qllocs[4], 10)

  return {
    sourcefile: prefixPath === '.' ? qlSourceFile : path.join(prefixPath, qlSourceFile),
    start: {
      line: qlStartLine,
      column: qlStartColumn,
    },
    end: {
      line: qlEndLine,
      column: qlEndColumn,
    },
  }
}

/**
 *
 */
function findUastLocationInList(uastLocation, qlLocationList, prefixPath = '.') {
  if (!uastLocation || !qlLocationList) {
    return null
  }
  for (const qlLocation of qlLocationList) {
    if (compareLocation(uastLocation, qlLocation, prefixPath)) {
      return qlLocation
    }
  }
  return null
}

/**
 *
 */
function compareLocation(uastLocation, qlLocation, prefixPath = '.') {
  const qllocs = qlLocation.split(':')
  const qlSourceFile = qllocs[0]
  const qlStartLine = parseInt(qllocs[1], 10)
  const qlStartColumn = parseInt(qllocs[2], 10)
  const qlEndLine = parseInt(qllocs[3], 10)
  const qlEndColumn = parseInt(qllocs[4], 10)

  let uastSourceFile = uastLocation?.sourcefile
  if (prefixPath !== '.') {
    uastSourceFile = uastSourceFile.substring(prefixPath.length)
  }
  const uastStartLine = uastLocation?.start?.line
  const uastStartColumn = uastLocation?.start?.column
  const uastEndLine = uastLocation?.end?.line
  const uastEndColumn = uastLocation?.end?.column

  // 硬性要求：文件路径及行号必须一致
  if (qlSourceFile !== uastSourceFile || qlStartLine !== uastStartLine || qlEndLine !== uastEndLine) {
    return false
  }

  if (uastStartColumn !== qlStartColumn) {
    if (Math.abs(uastStartColumn - qlStartColumn) > 1) {
      return false
    }
  }

  if (uastEndColumn !== qlEndColumn) {
    if (Math.abs(uastEndColumn - qlEndColumn) > 1) {
      return false
    }
  }

  return true
}

module.exports = {
  convertUastLocationToString,
  // compareLocationList,
  findUastLocationInList,
  convertQLLocationStringListToUastLocation,
  convertQLLocationStringToUastLocation,
}
