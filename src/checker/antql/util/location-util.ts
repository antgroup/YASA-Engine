const path = require('path')

interface UastLocation {
  sourcefile?: string
  start?: {
    line?: number
    column?: number
  }
  end?: {
    line?: number
    column?: number
  }
  [key: string]: any
}

/**
 * 将uast的location转换成string格式
 * @param uastLocation
 * @param prefixPath
 */
function convertUastLocationToString(uastLocation: UastLocation | null | undefined, prefixPath: string = '.'): string {
  if (!uastLocation) {
    return ''
  }
  let sourceFile = uastLocation?.sourcefile
  if (prefixPath !== '.' && sourceFile) {
    sourceFile = sourceFile.substring(prefixPath.length)
  }
  const startLine = uastLocation?.start?.line
  const startColumn = uastLocation?.start?.column
  const endLine = uastLocation?.end?.line
  let endColumn = uastLocation?.end?.column
  // uast的column会比ql多1
  if (endColumn !== undefined) {
    if (endColumn < 0) {
      endColumn = 0
    } else {
      endColumn -= 1
    }
  } else {
    endColumn = 0
  }
  return `${sourceFile}:${startLine}:${startColumn}:${endLine}:${endColumn}`
}

/**
 *
 * @param qlLocationStringList
 * @param prefixPath
 */
function convertQLLocationStringListToUastLocation(
  qlLocationStringList: string[],
  prefixPath: string = '.'
): UastLocation[] {
  const result: UastLocation[] = []
  for (const qlLocationString of qlLocationStringList) {
    result.push(convertQLLocationStringToUastLocation(qlLocationString, prefixPath))
  }
  return result
}

/**
 *
 * @param qlLocationString
 * @param prefixPath
 */
function convertQLLocationStringToUastLocation(qlLocationString: string, prefixPath: string = '.'): UastLocation {
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
 * @param uastLocation
 * @param qlLocationList
 * @param prefixPath
 */
function findUastLocationInList(
  uastLocation: UastLocation | null | undefined,
  qlLocationList: string[],
  prefixPath: string = '.'
): string | null {
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
 * @param uastLocation
 * @param qlLocation
 * @param prefixPath
 */
function compareLocation(uastLocation: UastLocation, qlLocation: string, prefixPath: string = '.'): boolean {
  const qllocs = qlLocation.split(':')
  const qlSourceFile = qllocs[0]
  const qlStartLine = parseInt(qllocs[1], 10)
  const qlStartColumn = parseInt(qllocs[2], 10)
  const qlEndLine = parseInt(qllocs[3], 10)
  const qlEndColumn = parseInt(qllocs[4], 10)

  let uastSourceFile = uastLocation?.sourcefile
  if (prefixPath !== '.' && uastSourceFile) {
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
    if (uastStartColumn !== undefined && Math.abs(uastStartColumn - qlStartColumn) > 1) {
      return false
    }
  }

  if (uastEndColumn !== qlEndColumn) {
    if (uastEndColumn !== undefined && Math.abs(uastEndColumn - qlEndColumn) > 1) {
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
