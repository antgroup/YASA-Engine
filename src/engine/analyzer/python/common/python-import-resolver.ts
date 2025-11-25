/**
 * Python Import Path Resolver
 *
 * 核心思想：
 * 1. 维护一个搜索路径列表（类似 Python 的 sys.path）
 * 2. 从当前文件向上查找，识别所有可能的包根目录
 * 3. 对于绝对导入，从所有搜索路径中查找
 * 4. 对于相对导入，从当前文件所在目录开始查找
 */

const path = require('path')
const Config = require('../../../../config')
const handleException = require('../../common/exception-handler')

/**
 * 构建搜索路径列表
 * 参考 Python 的 sys.path 机制，按优先级排序：
 * 1. 当前文件所在目录
 * 2. 从当前文件向上查找的所有包含 __init__.py 的包目录
 * 3. 项目根目录（Config.maindir）
 * 4. 项目根目录的所有子目录（如果包含 Python 文件）
 *
 * @param sourceFile - 当前源文件的绝对路径
 * @param fileList - 所有 Python 文件的列表
 * @param projectRoot - 项目根目录
 * @returns 搜索路径列表（按优先级排序）
 */
function buildSearchPaths(sourceFile: string, fileList: string[], projectRoot: string): string[] {
  const searchPaths: string[] = []

  if (!sourceFile || !fileList || !projectRoot) {
    return searchPaths
  }

  try {
    const normalizedProjectRoot = path.normalize(projectRoot.replace(/\/$/, ''))

    // 1. 当前文件所在目录（最高优先级）
    const currentDir = path.dirname(sourceFile)
    if (currentDir && !searchPaths.includes(currentDir)) {
      searchPaths.push(currentDir)
    }

    // 2. 从当前文件向上查找所有包含 __init__.py 的包目录
    let dir = currentDir
    let loopCount = 0
    const maxLoops = 10 // 防止无限循环

    while (dir && dir !== normalizedProjectRoot && dir !== path.dirname(dir) && loopCount < maxLoops) {
      try {
        const initFile = path.join(dir, '__init__.py')
        if (
          fileList.some((f: string) => {
            return path.normalize(f) === path.normalize(initFile)
          }) &&
          !searchPaths.includes(dir)
        ) {
          searchPaths.push(dir)
        }
        const parentDir = path.dirname(dir)
        if (parentDir === dir) break
        dir = parentDir
        loopCount++
      } catch (e) {
        handleException(
          e,
          `[buildSearchPaths] Error searching package directories at ${dir}`,
          `[buildSearchPaths] Error searching package directories at ${dir}`
        )
        break
      }
    }

    // 3. 项目根目录
    if (normalizedProjectRoot && !searchPaths.includes(normalizedProjectRoot)) {
      searchPaths.push(normalizedProjectRoot)
    }

    // 4. 项目根目录的所有直接子目录（如果包含 Python 文件）
    try {
      const subDirsWithPythonFiles = new Set<string>()
      const normalizedProjectRootWithSep = normalizedProjectRoot + path.sep

      for (const file of fileList) {
        try {
          const normalizedFile = path.normalize(file)
          if (normalizedFile.startsWith(normalizedProjectRootWithSep)) {
            const relativePath = normalizedFile.substring(normalizedProjectRootWithSep.length)
            const firstDirIndex = relativePath.indexOf(path.sep)

            if (firstDirIndex > 0) {
              // 文件在子目录中，提取第一个目录名
              const firstDir = relativePath.substring(0, firstDirIndex)
              const subDirPath = path.join(normalizedProjectRoot, firstDir)
              subDirsWithPythonFiles.add(path.normalize(subDirPath))
            }
          }
        } catch (e) {
          handleException(
            e,
            `[buildSearchPaths] Error processing file in subdirectory search: ${e}, file: ${file}`,
            `[buildSearchPaths] Error processing file in subdirectory search: ${e}, file: ${file}`
          )
          continue
        }
      }

      for (const subDir of subDirsWithPythonFiles) {
        if (!searchPaths.includes(subDir)) {
          searchPaths.push(subDir)
        }
      }
    } catch (e) {
      handleException(
        e,
        `[buildSearchPaths] Error processing subdirectories of ${normalizedProjectRoot}`,
        `[buildSearchPaths] Error processing subdirectories of ${normalizedProjectRoot}`
      )
    }
  } catch (e) {
    // 如果整个函数出错，至少返回当前目录
    const currentDir = path.dirname(sourceFile)
    if (currentDir && !searchPaths.includes(currentDir)) {
      searchPaths.push(currentDir)
    }
  }

  return searchPaths
}

/**
 * 从给定目录向上查找，直到找到包含所有文件的公共父目录
 *
 * @param fileList - 所有文件的列表
 * @param startDir - 起始目录
 * @returns 项目根目录
 */
function findProjectRoot(fileList: string[], startDir: string): string {
  if (!fileList || fileList.length === 0) {
    return startDir || process.cwd()
  }

  if (!startDir) {
    startDir = process.cwd()
  }

  try {
    const normalizedStartDir = path.normalize(startDir.replace(/\/$/, ''))

    const normalizedFiles: string[] = []
    for (const f of fileList) {
      const normalizedFile = path.normalize(f)
      if (normalizedFile.startsWith(normalizedStartDir + path.sep) || normalizedFile === normalizedStartDir) {
        normalizedFiles.push(normalizedFile)
      }
    }

    if (normalizedFiles.length === 0) {
      return normalizedStartDir
    }

    let commonPrefix = path.dirname(normalizedFiles[0])
    let loopCount = 0
    const maxLoops = 10 // 防止无限循环

    // 确保 commonPrefix 在 startDir 下
    while (
      !commonPrefix.startsWith(normalizedStartDir) &&
      commonPrefix !== path.dirname(commonPrefix) &&
      loopCount < maxLoops
    ) {
      const parentPrefix = path.dirname(commonPrefix)
      if (parentPrefix === commonPrefix) break
      commonPrefix = parentPrefix
      loopCount++
    }

    // 如果 commonPrefix 不在 startDir 下，使用 startDir
    if (!commonPrefix.startsWith(normalizedStartDir)) {
      return normalizedStartDir
    }

    for (const file of normalizedFiles) {
      if (loopCount >= maxLoops) break
      const dir = path.dirname(file)
      // 找到公共前缀，但不能超出 startDir
      while (
        !dir.startsWith(commonPrefix) &&
        commonPrefix.startsWith(normalizedStartDir) &&
        commonPrefix !== path.dirname(commonPrefix) &&
        loopCount < maxLoops
      ) {
        const parentPrefix = path.dirname(commonPrefix)
        if (parentPrefix === commonPrefix || !parentPrefix.startsWith(normalizedStartDir)) break
        commonPrefix = parentPrefix
        loopCount++
      }
    }

    return commonPrefix.startsWith(normalizedStartDir) ? normalizedStartDir : commonPrefix
  } catch (e) {
    // 如果出错，返回 startDir
    return startDir || process.cwd()
  }
}

/**
 * 解析绝对导入路径
 * 从所有搜索路径中查找模块
 *
 * @param modulePath - 模块路径
 * @param searchPaths - 搜索路径列表
 * @param fileList - 所有 Python 文件的列表
 * @returns 解析后的文件路径，如果找不到返回 null
 */
function resolveAbsoluteImport(modulePath: string, searchPaths: string[], fileList: string[]): string | null {
  const fsPath = modulePath.replace(/\./g, path.sep)

  for (const searchPath of searchPaths) {
    // 尝试作为文件查找
    const filePath = path.join(searchPath, `${fsPath}.py`)
    const normalizedFilePath = path.normalize(filePath)
    if (fileList.some((f) => path.normalize(f) === normalizedFilePath)) {
      return normalizedFilePath
    }

    // 尝试作为包目录查找（包含 __init__.py）
    const packagePath = path.join(searchPath, fsPath)
    const normalizedPackagePath = path.normalize(packagePath)
    const initFile = path.join(normalizedPackagePath, '__init__.py')
    if (fileList.some((f) => path.normalize(f) === path.normalize(initFile))) {
      return normalizedPackagePath
    }

    // 尝试查找包内的模块文件
    const packageModulePath = path.join(normalizedPackagePath, `${path.basename(fsPath)}.py`)
    if (fileList.some((f) => path.normalize(f) === path.normalize(packageModulePath))) {
      return packageModulePath
    }
  }

  return null
}

/**
 * 解析相对导入路径
 * 从当前文件所在目录开始查找
 *
 * 相对导入规则：
 * - 向上层级数 = 点号数量 - 1
 * - `..` 表示父包/目录本身（用于 `from .. import module`）
 *
 * @param relativePath - 相对路径（如 ".module" 或 "..parent.module" 或 ".." 或 "...."）
 * @param currentFile - 当前文件的绝对路径
 * @param fileList - 所有 Python 文件的列表
 * @param moduleName - 可选的模块名（用于 `from .. import moduleName` 的情况）
 * @returns 解析后的文件路径，如果找不到返回 null
 */
function resolveRelativeImport(
  relativePath: string,
  currentFile: string,
  fileList: string[],
  moduleName?: string
): string | null {
  if (!relativePath || !currentFile || !fileList) {
    return null
  }

  const currentDir = path.dirname(path.normalize(currentFile))

  let modulePath = relativePath

  // 计算前导点号的数量
  let upLevels = 0
  let dotIndex = 0

  while (dotIndex < modulePath.length && modulePath[dotIndex] === '.') {
    upLevels++
    dotIndex++
  }

  // 计算目标目录
  let targetDir = currentDir
  if (upLevels > 1) {
    const levelsToGoUp = upLevels - 1
    const normalizedDir = path.normalize(currentDir)
    const isAbsolute = path.isAbsolute(normalizedDir)
    const parts = normalizedDir.split(path.sep).filter((p: string) => p !== '')

    const targetLevel = parts.length - levelsToGoUp

    if (targetLevel < 0) {
      return null
    }

    if (targetLevel === 0) {
      // 到达根目录
      targetDir = isAbsolute ? path.sep : '.'
    } else {
      const targetParts = parts.slice(0, targetLevel)
      if (isAbsolute) {
        targetDir = path.sep + targetParts.join(path.sep)
      } else {
        targetDir = targetParts.join(path.sep) || '.'
      }
    }

    const normalizedTarget = path.normalize(targetDir)
    if (normalizedTarget === normalizedDir && levelsToGoUp > 0) {
      // 路径没有变化，说明已经到达根目录但还需要向上（用于验证）
      return null
    }
  }

  if (dotIndex > 0) {
    modulePath = modulePath.substring(dotIndex).replace(/^\/+/, '')
  }

  // 处理 `from .. import moduleName` 的情况
  // 如果 relativePath 只有点号（如 ".."），使用 moduleName
  if (!modulePath && moduleName) {
    modulePath = moduleName
  }

  // 如果没有模块路径（只有点号且没有 moduleName），返回当前目录
  if (!modulePath) {
    return targetDir
  }

  const fsPath = modulePath.replace(/\./g, path.sep)

  // 尝试作为文件查找
  const filePath = path.join(targetDir, `${fsPath}.py`)
  const normalizedFilePath = path.normalize(filePath)
  const foundFile = fileList.find((f: string) => {
    return path.normalize(f) === normalizedFilePath
  })
  if (foundFile) {
    return normalizedFilePath
  }

  // 尝试作为包目录查找（包含 __init__.py）
  const packagePath = path.join(targetDir, fsPath)
  const normalizedPackagePath = path.normalize(packagePath)
  const initFile = path.join(normalizedPackagePath, '__init__.py')
  const foundInit = fileList.find((f: string) => {
    return path.normalize(f) === path.normalize(initFile)
  })
  if (foundInit) {
    return normalizedPackagePath
  }

  // 尝试查找包内的模块文件（例如：A/module.py）
  const packageModulePath = path.join(normalizedPackagePath, `${path.basename(fsPath)}.py`)
  const foundPackageModule = fileList.find((f: string) => {
    return path.normalize(f) === path.normalize(packageModulePath)
  })
  if (foundPackageModule) {
    return packageModulePath
  }

  return null
}

/**
 * import解析函数，根据导入类型（绝对或相对）选择合适的解析策略
 *
 * @param importPath - 导入路径（from 子句的值，如 "A.cross_module_003_T_a" 或 ".module"）
 * @param currentFile - 当前文件的绝对路径
 * @param fileList - 所有 Python 文件的列表
 * @param projectRoot - 项目根目录（可选，如果不提供则从 fileList 推断）
 * @returns 解析后的文件路径，如果找不到返回 null
 */
function resolveImportPath(
  importPath: string,
  currentFile: string,
  fileList: string[],
  projectRoot?: string
): string | null {
  if (!importPath) {
    return null
  }
  const root = projectRoot || findProjectRoot(fileList, Config.maindir || process.cwd())
  const searchPaths = buildSearchPaths(currentFile, fileList, root)

  if (importPath.startsWith('.')) {
    return resolveRelativeImport(importPath, currentFile, fileList)
  }
  return resolveAbsoluteImport(importPath, searchPaths, fileList)
}

export = {
  resolveImportPath,
  resolveRelativeImport,
}

