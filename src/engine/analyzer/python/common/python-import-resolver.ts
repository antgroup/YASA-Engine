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

const normalizePath = (filePath: string) => path.normalize(filePath)

/**
 * 文件列表缓存结构
 * 存储规范化后的文件路径集合和相关元数据
 */
let fileListCache: {
  normalizedFileSet: Set<string>
  fileListHash: string
  projectRoot: string
  subDirs: Set<string>
} | null = null

/**
 * 搜索路径缓存
 * 按目录路径存储对应的搜索路径列表（同目录下的文件共享相同的搜索路径）
 */
const searchPathsCache = new Map<string, string[]>()

/**
 * 导入解析结果缓存
 * 按导入路径和目录组合存储解析结果（同目录下的文件共享缓存）
 */
const resolveCache = new Map<string, string | null>()

/**
 * 目录规范化缓存
 * 缓存已规范化的目录路径，避免重复调用 path.dirname 和 path.normalize
 */
const dirCache = new Map<string, string>()

/**
 * 模块候选路径缓存
 * 按 baseDir + modulePath + fieldName 组合缓存候选结果
 */
const moduleCandidatesCache = new Map<string, string[]>()

/**
 * 生成文件列表的哈希标识
 * 用于判断文件列表是否发生变化
 * @param fileList
 */
function getFileListHash(fileList: string[]): string {
  return `${fileList.length}_${fileList[0] || ''}_${fileList[fileList.length - 1] || ''}`
}

/**
 * 获取文件所在的规范化目录
 * 使用缓存避免重复的 dirname 和 normalize 调用
 * @param filePath
 */
function getNormalizedDir(filePath: string): string {
  const cached = dirCache.get(filePath)
  if (cached !== undefined) {
    return cached
  }
  const normalized = path.normalize(path.dirname(filePath))
  dirCache.set(filePath, normalized)
  return normalized
}

/**
 * 初始化或更新文件列表缓存
 * 将文件列表规范化并建立索引，同时提取项目的子目录结构
 * @param fileList
 * @param projectRoot
 */
function ensureFileListCache(fileList: string[], projectRoot: string): void {
  const hash = getFileListHash(fileList)

  if (fileListCache && fileListCache.fileListHash === hash && fileListCache.projectRoot === projectRoot) {
    return // 缓存仍然有效
  }

  // 重建缓存
  const normalizedFileSet = new Set<string>()
  const subDirs = new Set<string>()
  const normalizedProjectRoot = path.normalize(projectRoot.replace(/\/$/, ''))
  const normalizedProjectRootWithSep = normalizedProjectRoot + path.sep

  for (const file of fileList) {
    const normalizedFile = path.normalize(file)
    normalizedFileSet.add(normalizedFile)

    // 提取子目录
    if (normalizedFile.startsWith(normalizedProjectRootWithSep)) {
      const relativePath = normalizedFile.substring(normalizedProjectRootWithSep.length)
      const firstDirIndex = relativePath.indexOf(path.sep)
      if (firstDirIndex > 0) {
        const firstDir = relativePath.substring(0, firstDirIndex)
        const subDirPath = path.normalize(path.join(normalizedProjectRoot, firstDir))
        subDirs.add(subDirPath)
      }
    }
  }

  fileListCache = {
    normalizedFileSet,
    fileListHash: hash,
    projectRoot: normalizedProjectRoot,
    subDirs,
  }

  // 清空依赖缓存
  searchPathsCache.clear()
  resolveCache.clear()
  dirCache.clear()
  moduleCandidatesCache.clear()
}

/**
 * 检查文件是否存在
 * 优先通过规范化路径集合进行查找
 * @param fileList
 * @param filePath
 */
function fileExists(_fileList: string[] | undefined, filePath: string): boolean {
  const normalizedPath = path.normalize(filePath)
  // 直接用 Set 查找，去掉 O(n) 线性扫描 fallback
  return fileListCache?.normalizedFileSet.has(normalizedPath) ?? false
}

const buildModuleCandidates = (
  baseDir: string,
  modulePath: string,
  fileList: string[],
  fieldName?: string
): string[] => {
  const cacheKey = `${baseDir}|${modulePath}|${fieldName || ''}`
  const cached = moduleCandidatesCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const candidates: string[] = []
  const fsPath = modulePath.replace(/\./g, path.sep)

  // 候选路径1：作为文件查找
  const filePath = path.join(baseDir, `${fsPath}.py`)
  const normalizedFilePath = path.normalize(filePath)
  if (fileExists(fileList, normalizedFilePath)) {
    candidates.push(normalizedFilePath)
  }

  // 候选路径2：作为包目录查找（包含 __init__.py）
  const packagePath = path.join(baseDir, fsPath)
  const normalizedPackagePath = path.normalize(packagePath)
  const initFile = path.join(normalizedPackagePath, '__init__.py')
  if (fileExists(fileList, initFile)) {
    candidates.push(normalizedPackagePath)

    // 如果指定了字段名，也查找包内的子模块文件（例如：package/module.py）
    if (fieldName) {
      const subModulePath = path.join(normalizedPackagePath, `${fieldName}.py`)
      const normalizedSubModulePath = path.normalize(subModulePath)
      if (fileExists(fileList, normalizedSubModulePath)) {
        candidates.push(normalizedSubModulePath)
      }
    }
  }

  // 候选路径3：查找包内的模块文件（例如：A/module.py）
  const packageModulePath = path.join(normalizedPackagePath, `${path.basename(fsPath)}.py`)
  if (fileExists(fileList, packageModulePath)) {
    candidates.push(packageModulePath)
  }

  moduleCandidatesCache.set(cacheKey, candidates)
  return candidates
}

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
    ensureFileListCache(fileList, projectRoot)

    // 1. 当前文件所在目录（最高优先级）
    const currentDir = getNormalizedDir(sourceFile)
    const cached = searchPathsCache.get(currentDir)
    if (cached) {
      return cached
    }

    const normalizedProjectRoot = fileListCache!.projectRoot

    if (currentDir && !searchPaths.includes(currentDir)) {
      searchPaths.push(currentDir)
    }
    const seenPaths = new Set<string>(searchPaths)

    // 2. 从当前文件向上查找所有包含 __init__.py 的包目录
    let dir = currentDir
    let loopCount = 0
    const maxLoops = 10 // 防止无限循环

    while (dir && dir !== normalizedProjectRoot && dir !== path.dirname(dir) && loopCount < maxLoops) {
      const initFile = path.normalize(path.join(dir, '__init__.py'))
      if (fileExists(fileList, initFile) && !seenPaths.has(dir)) {
        searchPaths.push(dir)
        seenPaths.add(dir)
      }
      const parentDir = path.dirname(dir)
      if (parentDir === dir) break
      dir = parentDir
      loopCount++
    }

    // 3. 项目根目录
    if (normalizedProjectRoot && !seenPaths.has(normalizedProjectRoot)) {
      searchPaths.push(normalizedProjectRoot)
      seenPaths.add(normalizedProjectRoot)
    }

    // 4. 项目根目录的所有直接子目录（从缓存读取）
    for (const subDir of fileListCache!.subDirs) {
      if (!seenPaths.has(subDir)) {
        searchPaths.push(subDir)
        seenPaths.add(subDir)
      }
    }
  } catch (e) {
    // 如果整个函数出错，至少返回当前目录
    const currentDir = getNormalizedDir(sourceFile)
    if (currentDir && !searchPaths.includes(currentDir)) {
      searchPaths.push(currentDir)
    }
    handleException(
      e,
      `[buildSearchPaths] Error building search paths for ${sourceFile}`,
      `[buildSearchPaths] Error building search paths for ${sourceFile}`
    )
  }

  // 按目录缓存结果，同目录下的文件可以共享
  const currentDir = getNormalizedDir(sourceFile)
  searchPathsCache.set(currentDir, searchPaths)
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
  const hash = getFileListHash(fileList || [])
  if (fileListCache && fileListCache.fileListHash === hash && fileListCache.projectRoot) {
    return fileListCache.projectRoot
  }
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
 * 获取绝对导入的所有候选路径（按优先级排序）
 *
 * @param modulePath - 模块路径
 * @param searchPaths - 搜索路径列表
 * @param fileList - 所有 Python 文件的列表
 * @param fieldName - 可选的字段名（用于 `from module import fieldName` 的情况）
 * @returns 候选路径数组（按优先级排序）
 */
function getAllAbsoluteImportCandidates(
  modulePath: string,
  searchPaths: string[],
  fileList: string[],
  fieldName?: string
): string[] {
  const candidates: string[] = []
  if (!modulePath || !searchPaths || !fileList) {
    return candidates
  }

  if (!fileListCache) {
    const root = findProjectRoot(fileList, Config.maindir || process.cwd())
    ensureFileListCache(fileList, root)
  }

  for (const searchPath of searchPaths) {
    candidates.push(...buildModuleCandidates(searchPath, modulePath, fileList, fieldName))
  }

  return candidates
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
  const candidates = getAllAbsoluteImportCandidates(modulePath, searchPaths, fileList)
  return candidates.length > 0 ? candidates[0] : null
}

const resolveRelativeTarget = (
  relativePath: string,
  currentFile: string
): { targetDir: string | null; modulePath: string; invalid: boolean } => {
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
      return { targetDir: null, modulePath: '', invalid: true }
    }

    if (targetLevel === 0) {
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
      return { targetDir: null, modulePath: '', invalid: true }
    }
  }

  if (dotIndex > 0) {
    modulePath = modulePath.substring(dotIndex).replace(/^\/+/, '')
  }

  return { targetDir, modulePath, invalid: false }
}

const getRelativeCandidates = (
  targetDir: string,
  modulePath: string,
  fileList: string[],
  fieldName?: string
): string[] => {
  return buildModuleCandidates(targetDir, modulePath, fileList, fieldName)
}
/**
 * 获取相对导入的所有候选路径（按优先级排序）
 *
 * @param relativePath - 相对路径（如 ".module" 或 "..parent.module"）
 * @param currentFile - 当前文件的绝对路径
 * @param fileList - 所有 Python 文件的列表
 * @param moduleName - 可选的模块名（用于 `from .. import moduleName` 的情况）
 * @param fieldName - 可选的字段名（用于 `from .module import fieldName` 的情况）
 * @returns 候选路径数组（按优先级排序）
 */
function getAllRelativeImportCandidates(
  relativePath: string,
  currentFile: string,
  fileList: string[],
  moduleName?: string,
  fieldName?: string
): string[] {
  const candidates: string[] = []
  if (!relativePath || !currentFile || !fileList) {
    return candidates
  }

  if (!fileListCache) {
    const root = findProjectRoot(fileList, Config.maindir || process.cwd())
    ensureFileListCache(fileList, root)
  }

  const { targetDir, modulePath: parsedModulePath, invalid } = resolveRelativeTarget(relativePath, currentFile)
  if (invalid || !targetDir) {
    return candidates
  }

  // 处理 `from .. import moduleName` 的情况
  let modulePath = parsedModulePath
  if (!modulePath && moduleName) {
    modulePath = moduleName
  }

  if (!modulePath) {
    return candidates
  }
  return getRelativeCandidates(targetDir, modulePath, fileList, fieldName)
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

  const { targetDir, modulePath: parsedModulePath, invalid } = resolveRelativeTarget(relativePath, currentFile)
  if (invalid || !targetDir) {
    return null
  }

  // 处理 `from .. import moduleName` 的情况
  // 如果 relativePath 只有点号（如 ".."），使用 moduleName
  let modulePath = parsedModulePath
  if (!modulePath && moduleName) {
    modulePath = moduleName
  }

  // 如果没有模块路径（只有点号且没有 moduleName），返回当前目录
  if (!modulePath) {
    return targetDir
  }
  const candidates = getRelativeCandidates(targetDir, modulePath, fileList)
  return candidates.length > 0 ? candidates[0] : null
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
  ensureFileListCache(fileList, root)

  const currentDir = getNormalizedDir(currentFile)
  const cacheKey = `${importPath}|${currentDir}`
  const cached = resolveCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const searchPaths = buildSearchPaths(currentFile, fileList, root)
  const result = importPath.startsWith('.')
    ? resolveRelativeImport(importPath, currentFile, fileList)
    : resolveAbsoluteImport(importPath, searchPaths, fileList)

  resolveCache.set(cacheKey, result)
  return result
}

export = {
  resolveImportPath,
  resolveRelativeImport,
  getAllRelativeImportCandidates,
  getAllAbsoluteImportCandidates,
  buildSearchPaths,
  findProjectRoot,
}
