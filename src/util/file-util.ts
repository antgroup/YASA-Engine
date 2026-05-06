import fs from 'fs'
import jsonfile from 'jsonfile'
import path from 'path'
import _ from 'lodash'
import globby from 'fast-glob'
import stat from './statistics'

const { yasaLog, yasaWarning } = require('./format-util')
const logger = require('./logger')(__filename)

const RESOLVE_UAST_BINARY_STAGE = 'preProcess.parseCode'

interface LineInfo {
  line: number
  code: string
}

interface FileContent {
  file: string
  content: string
}

interface ASTFileUnit {
  ast: any
  file?: string
  language?: number
}

const astCache: Record<string, { content: string }> = {}
const useASTCache = false
const config = require('../config')
const { handleException } = require('../engine/analyzer/common/exception-handler')

// e.g. for printing source lines
/**
 * 读取文件的指定行
 * @param filename - 文件名
 * @param lineNumbers - 行号数组
 * @returns {LineInfo[]} 行信息数组
 */
function readLinesSync(filename: string, lineNumbers: number[]): LineInfo[] {
  const lines: LineInfo[] = []
  if (_.isArray(lineNumbers) && lineNumbers) {
    let data
    try {
      filename = filename.toString()
      if (useASTCache) {
        // check cache first
        const cache = astCache[filename]
        if (cache) data = cache.content
        else {
          data = fs.readFileSync(filename, 'utf8')
          astCache[filename] = { content: data }
        }
      } else data = fs.readFileSync(filename, 'utf8')
    } catch (e) {
      return []
    }
    // var allLines = data.split(/\n|\r/);
    const allLines = data.split(/\n/)
    for (let i = 0; i < lineNumbers.length; i++) {
      let lineNumber = lineNumbers[i]
      if (lineNumber > allLines.length) {
        handleException(
          null,
          `Attempt to read line [${lineNumber}] in the file [${filename}] of which max line is [${allLines.length}]`,
          `Attempt to read line [${lineNumber}] in the file [${filename}] of which max line is [${allLines.length}]`
        )
        break
      }
      lines.push({
        line: lineNumber,
        code: allLines[--lineNumber],
      })
    }
  }
  return lines
}

//* *****************************  Text file ***********************************

/**
 * load the source recursively (by going into subdirectories)
 * @param filename the file to be considered (may be a directory or proper file)
 * @param nameFilter if the file doesn't ends in one of these strings, skip it
 * @param dirFilter - if the directory in there strings, skip it
 * @param extExcludes - if the file ends in one of these strings, skip it, prior than nameFilter
 * @param res accumulator list.  Added to by side-effect
 */
function loadFileTextRec(
  filename: string,
  nameFilter: string[],
  dirFilter: string[],
  res: FileContent[],
  extExcludes: string[]
): void {
  let fileStat
  try {
    fileStat = fs.lstatSync(filename)
  } catch (e) {
    // logger.info(e);
  }
  // logger.info('name: ' + filename);

  if (fileStat && fileStat.isDirectory()) {
    // logger.info('path: ' + path_string);
    const dir = filename
    if (
      dirFilter &&
      dirFilter.some(function (filter) {
        return path.basename(dir) === filter
      })
    ) {
      return
    }
    const files = fs.readdirSync(dir)
    for (const i in files) {
      const name = `${dir}/${files[i]}`
      loadFileTextRec(name, nameFilter, dirFilter, res, extExcludes)
    }
  } else {
    if (nameFilter && !nameFilter.some((filter) => filename.endsWith(filter))) return
    if (extExcludes && extExcludes.some((filter) => filename.endsWith(filter))) return
    try {
      // var contents = fs.readFileSync(filename, 'utf-8');
      let contents
      if (useASTCache) {
        const cache = astCache[filename]
        if (cache) contents = cache.content
        else {
          contents = fs.readFileSync(filename, 'utf8')
          astCache[filename] = { content: contents }
        }
      } else contents = fs.readFileSync(filename, 'utf8')
      res.push({ file: filename, content: contents })
    } catch (e) {
      // 忽略读取错误
    }
  }
}

/**
 * recursively load the bodies of all the files under the current path/file
 * @param filename file or directory to load.
 *        If directory, recur and load all files not excluded by nameFilter
 * @param nameFilter - array of strings that the filename should end with
 * @param dirFilter - array of strings that the directory shouldn't contained
 * @param extExcludes - array of strings that the filename should not end with
 * @returns {FileContent[]} list of records of the form { fileName , fileContent }
 */
function loadAllFileText(
  filename: string,
  nameFilter: string[],
  dirFilter: string[],
  extExcludes: string[]
): FileContent[] {
  const res: FileContent[] = []
  const parsingStart = new Date().getTime()
  loadFileTextRec(filename, nameFilter, dirFilter, res, extExcludes)
  const parsingEnd = new Date().getTime()
  stat.parsingTime += parsingEnd - parsingStart
  return res
}

// globby version of load all file text
/**
 * 使用 globby 加载所有文件文本
 * @param srcFilter - 源文件过滤模式
 * @param cwd - 当前工作目录
 * @returns {FileContent[]} 文件内容数组
 */
function loadAllFileTextGlobby(srcFilter: string[], cwd: string): FileContent[] {
  const res: FileContent[] = []

  const parsingStart = new Date().getTime()
  const files = globby.sync(srcFilter, { cwd })
  for (const file of files) {
    const filepath = path.join(cwd, file)
    try {
      const content = fs.readFileSync(filepath, 'utf8')
      res.push({ file: filepath, content })
    } catch (err) {
      logger.warn(`Failed to read file: ${filepath}, error: ${(err as Error).message}`)
    }
  }

  stat.parsingTime += new Date().getTime() - parsingStart
  return res
}

//* ***************************** Source in JSON ***********************************

// from file to memory
/**
 * 从文件加载 JSON
 * @param filename - 文件名
 * @returns {any} 解析后的 JSON 对象
 */
function loadJSONfile(filename: string): any {
  if (!fs.existsSync(filename)) {
    throw new Error(`JSON file not found: ${filename}`)
  }
  try {
    return jsonfile.readFileSync(filename)
  } catch (e) {
    handleException(e, `jsonfile parse error:${filename}`, `jsonfile parse error:${filename}`)
    throw new Error(`Failed to parse JSON file: ${filename}`)
  }
}

// load and parse JSON files
/**
 * 加载并解析 JSON 文件 AST（未使用）
 * @param filename - 文件名
 * @returns {ASTFileUnit[] | ASTFileUnit} AST 文件单元或数组
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function loadJsonFileAsts(filename: string): ASTFileUnit[] | ASTFileUnit {
  const pathString = filename
  let fileStat
  let ast
  try {
    fileStat = fs.lstatSync(pathString)
  } catch (e) {
    // 忽略错误
  }

  if (fileStat && fileStat.isDirectory()) {
    // logger.info('path: ' + pathString);
    const dir = pathString
    let res: ASTFileUnit[] = []
    const files = fs.readdirSync(dir)
    for (let i = 0; i < files.length; i++) {
      const name = `${dir}/${files[i]}`
      if (fs.statSync(name).isDirectory()) {
        // go into the subdirectories
        const subRes = loadJsonFileAsts(name)
        res = res.concat(subRes)
        continue
      }

      const lastDotIndex = name.lastIndexOf('.')
      if (lastDotIndex === -1 || lastDotIndex === name.length - 1) {
        continue
      }
      const fileExtension = name.substring(lastDotIndex + 1)
      if (fileExtension !== 'json') {
        continue
      }

      ast = loadJSONfile(name)
      res.push({
        file: filename,
        ast,
        language: (global as any).constants?.Language?.JAVA,
      })
    }
    return res
  }
  // logger.info('file: ' + pathString);
  if (filename.indexOf('.json') === -1) {
    filename += '.json'
  }

  ast = loadJSONfile(filename)
  if (!ast) return []

  logger.info(`loaded: ${filename}`)
  if (Array.isArray(ast)) {
    return ast.map(function (unit: any) {
      return { ast: unit }
    })
  }
  return {
    file: filename,
    ast,
  }
}

// write JSON into a file
/**
 * 将 JSON 写入文件
 * @param filename - 文件名
 * @param value - 要写入的值
 */
function writeJSONfile(filename: string, value: any): void {
  // logger.info('writing JSON file: ' + filename);
  try {
    // 检测循环引用的函数
    const detectCircularRefs = (
      obj: any,
      path: string[] = [],
      visited: WeakMap<any, string[]> = new WeakMap()
    ): string[] => {
      const circularPaths: string[] = []

      if (obj == null || typeof obj !== 'object') {
        return circularPaths
      }

      // 检查是否已经访问过这个对象
      const previousPath = visited.get(obj)
      if (previousPath) {
        // 找到循环引用，记录完整路径
        const currentPathStr = path.join('.')
        const previousPathStr = previousPath.join('.')
        circularPaths.push(`Circular reference: ${currentPathStr} -> ${previousPathStr}`)
        return circularPaths
      }

      // 记录当前路径
      visited.set(obj, path)

      // 处理普通对象
      if (!Array.isArray(obj)) {
        for (const key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            // 跳过内部属性
            if (key.startsWith('__') || key === 'symbolTable' || key === 'astManager') {
              continue
            }

            try {
              const val = obj[key]
              if (val != null && typeof val === 'object') {
                const newPath = [...path, key]
                const subCircular = detectCircularRefs(val, newPath, visited)
                circularPaths.push(...subCircular)
              }
            } catch (e) {
              // 忽略访问器错误
            }
          }
        }
      } else {
        // 处理数组
        for (let i = 0; i < obj.length; i++) {
          const item = obj[i]
          if (item != null && typeof item === 'object') {
            const newPath = [...path, `[${i}]`]
            const subCircular = detectCircularRefs(item, newPath, visited)
            circularPaths.push(...subCircular)
          }
        }
      }

      return circularPaths
    }

    // 在序列化前检测循环引用
    const circularPaths = detectCircularRefs(value, ['root'])
    if (circularPaths.length > 0) {
      logger.error('=== Circular References Detected ===')
      circularPaths.forEach((path, index) => {
        logger.error(`${index + 1}. ${path}`)
      })
      logger.error('====================================')

      // 尝试打印第一个循环引用的详细信息
      if (circularPaths.length > 0) {
        logger.error('Detailed analysis of first circular reference:')
        const visited = new WeakMap<any, string[]>()
        const findFirstCircular = (obj: any, path: string[]): any => {
          if (obj == null || typeof obj !== 'object') {
            return null
          }

          const previousPath = visited.get(obj)
          if (previousPath) {
            logger.error(`  Current path: ${path.join('.')}`)
            logger.error(`  Previous path: ${previousPath.join('.')}`)
            logger.error(`  Object type: ${obj.constructor?.name || 'Object'}`)
            if (obj.vtype) logger.error(`  vtype: ${obj.vtype}`)
            if (obj.qid) logger.error(`  qid: ${obj.qid}`)
            if (obj.uuid) logger.error(`  uuid: ${obj.uuid}`)
            if (obj.sid) logger.error(`  sid: ${obj.sid}`)
            return obj
          }

          visited.set(obj, path)

          if (!Array.isArray(obj)) {
            for (const key in obj) {
              if (Object.prototype.hasOwnProperty.call(obj, key)) {
                if (key.startsWith('__') || key === 'symbolTable' || key === 'astManager') {
                  continue
                }
                try {
                  const result = findFirstCircular(obj[key], [...path, key])
                  if (result) return result
                } catch (e) {
                  // 忽略访问器错误
                }
              }
            }
          } else {
            for (let i = 0; i < obj.length; i++) {
              const result = findFirstCircular(obj[i], [...path, `[${i}]`])
              if (result) return result
            }
          }

          return null
        }

        findFirstCircular(value, ['root'])
      }
    }

    jsonfile.writeFileSync(filename, value, {})
  } catch (err: any) {
    // 如果错误是循环引用相关的，进行详细诊断
    if (
      err.message &&
      (err.message.includes('circular') ||
        err.message.includes('Converting circular structure') ||
        err.message.includes('circular reference'))
    ) {
      logger.error('=== JSON Serialization Error: Circular Reference ===')
      logger.error(`Error message: ${err.message}`)
      logger.error('Attempting to locate circular reference...')

      const visited = new WeakMap<any, string[]>()
      const circularInfo: Array<{ current: string; previous: string; obj: any }> = []

      const findCircular = (obj: any, path: string[]): void => {
        if (obj == null || typeof obj !== 'object') {
          return
        }

        const previousPath = visited.get(obj)
        if (previousPath) {
          circularInfo.push({
            current: path.join('.'),
            previous: previousPath.join('.'),
            obj,
          })
          return
        }

        visited.set(obj, path)

        if (!Array.isArray(obj)) {
          for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
              if (key.startsWith('__') || key === 'symbolTable' || key === 'astManager') {
                continue
              }
              try {
                findCircular(obj[key], [...path, key])
              } catch (e) {
                // 忽略访问器错误
              }
            }
          }
        } else {
          for (let i = 0; i < obj.length; i++) {
            findCircular(obj[i], [...path, `[${i}]`])
          }
        }
      }

      findCircular(value, ['root'])

      if (circularInfo.length > 0) {
        logger.error(`Found ${circularInfo.length} circular reference(s):`)
        circularInfo.forEach((info, index) => {
          logger.error(`\n${index + 1}. Circular Reference:`)
          logger.error(`   Current path: ${info.current}`)
          logger.error(`   Previous path: ${info.previous}`)
          logger.error(`   Object type: ${info.obj.constructor?.name || 'Object'}`)
          if (info.obj.vtype) logger.error(`   vtype: ${info.obj.vtype}`)
          if (info.obj.qid) logger.error(`   qid: ${info.obj.qid}`)
          if (info.obj.uuid) logger.error(`   uuid: ${info.obj.uuid}`)
          if (info.obj.sid) logger.error(`   sid: ${info.obj.sid}`)

          // 打印对象的关键属性（前10个）
          const keys = Object.keys(info.obj).slice(0, 10)
          if (keys.length > 0) {
            logger.error(`   Sample keys: ${keys.join(', ')}`)
          }
        })
      } else {
        logger.error('Could not locate circular reference (may be in getter/setter)')
      }

      logger.error('====================================================')
    }

    handleException(err, 'Error occurred in file-util.writeJSONfile', 'Error occurred in file-util.writeJSONfile')
  }
}

//* *****************************  Others ************************************

// Recurse into a directory to find a file with the given name
/**
 * 递归查找文件
 * @param rootdir - 根目录
 * @param tofind - 要查找的文件名或正则表达式
 * @param subdir - 子目录
 * @returns {boolean} 是否找到
 */
function findfile(rootdir: string, tofind: string | RegExp, subdir?: string): boolean {
  const abspath = subdir ? path.join(rootdir, subdir) : rootdir
  const files = fs.readdirSync(abspath)
  for (let i = 0; i < files.length; i++) {
    const filename = files[i]
    if (tofind instanceof RegExp) {
      if (tofind.test(filename)) return true
    } else if (filename === tofind) return true
    const filepath = path.join(abspath, filename)
    try {
      const fileStat = fs.statSync(filepath)
      if (fileStat.isDirectory() && findfile(rootdir, tofind, path.join(subdir || '', filename || ''))) {
        return true
      }
    } catch (e) {
      // 忽略错误
    }
  }
  return false
}

// FIXME: share code with above functions
// obtain recursively the files with the given extension and not included in the given list
/**
 * 获取目录中的文件列表
 * @param absPath - 绝对路径
 * @param file_ex - 文件扩展名
 * @param excluded - 排除的目录列表
 * @returns {string[] | undefined} 文件路径数组
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
function getFilesInDirectory(absPath: string, file_ex: string, excluded: string[]): string[] | undefined {
  const sourcePath = absPath
  let fileStat
  try {
    fileStat = fs.lstatSync(sourcePath)
  } catch (e) {
    logger.info('directory not found')
  }

  if (fileStat) {
    if (fileStat.isDirectory()) {
      let res: string[] = []
      const files = fs.readdirSync(sourcePath)
      for (const i in files) {
        const name = `${sourcePath}/${files[i]}`

        const fileStatItem = fs.lstatSync(name)
        if (fileStatItem.isSymbolicLink()) continue
        if (fileStatItem.isDirectory()) {
          // go into the subdirectories
          if (excluded && excluded.indexOf(files[i]) !== -1) continue
          const subRes = getFilesInDirectory(name, file_ex, excluded)
          if (subRes) res = res.concat(subRes)
          continue
        }

        const j = name.lastIndexOf('.')
        if (j === -1 || j === name.length - 1) {
          continue
        }
        const fileExtension = name.substring(j + 1)
        if (fileExtension !== file_ex) continue
        res.push(name)
      } // end for
      return res
    }
    // logger.info('File to analyze: ' + sourcePath);
    const i = sourcePath.lastIndexOf('.')
    if (i === -1 || i === sourcePath.length - 1) return
    const fileExtension = sourcePath.substring(i + 1)
    if (fileExtension !== file_ex) return
    return [sourcePath]
  }
}

/**
 * 加载源代码文件
 * @param absdirs - 绝对目录路径数组
 * @param options - 选项对象
 * @returns {any[]} 文件列表
 */
function loadSource(absdirs: string[], options: Record<string, any>): any[] {
  let srcFilter = ['**/*.sol']
  // var dirFilter = [];
  // let ext_excludes = [];

  switch (options.language) {
    case 'golang':
      srcFilter = ['**/*.go', '!**/vendor']
      // dirFilter.push("vendor");
      break
    case 'javascript':
    case 'js':
      srcFilter = [
        '**/*.(js|ts|mjs|cjs)',
        '!**/*.test.(js|ts|mjs|cjs|jsx|tsx)',
        '!**/node_modules',
        '!**/app/public',
        '!**/*.d.ts',
        '!**/*.d.js',
      ]
      // ext_excludes.push(...['.test.js', '.test.ts', '.test.mjs', '.test.cjs', '.test.jsx']);
      // dirFilter.push("node_modules");
      break
    default:
      // 默认使用 .sol
      break
  }
  const res: any[] = []
  for (const dir of absdirs) {
    const files = globby.sync(srcFilter, { cwd: dir })
    // 计算文件数量（用于统计）
    const fileCount = files.length
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    fileCount
  }

  // const res = [];
  // for (let dir of absdirs) {
  //     const srcTxts = loadAllFileText(dir, Array.isArray(fext)? fext : [fext], dirFilter, ext_excludes);
  //     for (let txt of srcTxts) {
  //         // txt: { file: ..., content: ... }
  //         res.push(txt);
  //     }
  // }
  // return res;
  return res
}

/**
 * 移除第一个斜杠之前的内容
 * @param str - 字符串
 * @returns {string} 处理后的字符串
 */
function removeBeforeFirstSlash(str: string): string {
  // 找到第一个'/'的索引
  const index = str.indexOf('/')

  // 如果找到了'/'，则从该位置开始截取字符串；否则返回原字符串
  if (index !== -1) {
    return str.substring(index)
  }
  return str // 如果没有找到'/'，则返回原始字符串
}

/**
 * 自定义路径拼接
 * @param segments - 路径片段数组
 * @returns {string} 拼接后的路径
 */
function customJoin(...segments: string[]): string {
  // 处理路径数组并展开所有分段
  const parts: string[] = []
  segments.forEach((segment) => {
    parts.push(...segment.split(path.sep))
  })

  const finalStack: string[] = []

  for (const part of parts) {
    if (part === '' || part === '.') {
      continue
    } else if (part.startsWith('..')) {
      // 自定义逻辑处理 `..` 或更多点层级
      for (let i = 0; i < part.length - 1; i++) {
        finalStack.pop()
      }
    } else {
      // 普通目录，压入到最终路径的栈中
      finalStack.push(part)
    }
  }

  // 使用 path.join() 生成标准化的路径
  return `/${path.join(...finalStack)}`
}

/**
 * 提取子字符串之后的内容
 * @param fullString - 完整字符串
 * @param subString - 子字符串
 * @returns {string} 提取后的字符串
 */
function extractAfterSubstring(fullString: string, subString: string): string {
  if (fullString) {
    const index = fullString?.indexOf(subString)
    if (index === -1) {
      // 如果 fullString 中不包含 subString，返回原字符串或空字符串
      return '' // 或者 fullString，根据你的需求
    }
    // 返回从 subString 之后的部分
    return removeBeforeFirstSlash(fullString.substring(index + subString.length))
  }
  return ''
}

/**
 * 提取相对路径
 * @param fullPath - 完整路径
 * @param dir - 目录路径
 * @returns {string | null} 相对路径
 */
function extractRelativePath(fullPath: string, dir: string): string | null {
  if (!fullPath) {
    return null
  }
  if (!dir) {
    return null
  }
  let relativePath = fullPath.substring(dir.length)
  if (!relativePath.startsWith('/')) {
    relativePath = `/${relativePath}`
  }
  return relativePath
}

/**
 * 组装完整路径
 * @param relativePath - 相对路径
 * @param dir - 目录路径
 * @returns {string} 完整路径
 */
function assembleFullPath(relativePath: string, dir: string): string {
  if (!relativePath) return dir || ''
  if (relativePath.startsWith(dir)) {
    return relativePath
  }
  if (!relativePath.startsWith('/')) {
    relativePath = `/${relativePath}`
  }
  return (dir + relativePath).replace(/\/\//g, '/')
}

/**
 * 规范化并拼接路径
 * @param sourcefile - 源文件路径
 * @param fname - 文件名
 * @returns {string} 规范化后的路径
 */
function normalizeAndJoin(sourcefile: string, fname: string): string {
  if (fname.startsWith('.')) {
    const splitIndex = fname.indexOf('/') !== -1 ? fname.indexOf('/') : fname.length
    const leadingDots = fname.slice(0, splitIndex).replace(/\.(?=[a-zA-Z])/g, './')
    const remainingPath = fname.slice(splitIndex + 1)

    // 拼接路径：处理 ".." 或 "."，再拼接剩余部分
    return customJoin(sourcefile, leadingDots, remainingPath)
  }
  return path.resolve(config.maindir, fname)
}

/**
 * remove the shared prefix of the file paths
 * @param original - 原始路径
 * @param path_prefix - 路径前缀
 * @returns {string} 缩短后的路径
 */
function shortenSourceFile(original: string, path_prefix: string): string {
  if (path_prefix && original.startsWith(path_prefix)) {
    return original.substring(path_prefix.length)
  }
  return original
}

/**
 * 获取绝对路径
 * @param p - 路径
 * @returns {string} 绝对路径
 */
function getAbsolutePath(p: string): string {
  if (path.isAbsolute(p)) {
    return p
  }

  const res = path.join(require.main?.filename || '', '../../', p)
  if (fs.existsSync(res)) {
    return res
  }
  return path.join(process.cwd(), p)
}

/**
 * 从缓存中移除文件
 * @param fname - 文件名
 */
function removeFileFromCache(fname: string): void {
  if (useASTCache) delete astCache[fname]
}

/**
 * 检查是否在 pkg 打包环境中
 * @param mainFile - 主文件路径
 * @returns {boolean} 是否在 pkg 环境中
 */
function isPkgEnv(mainFile: string): boolean {
  return !!(process as any).pkg || !!(mainFile && mainFile.replace(/\\/g, '/').includes('/snapshot/'))
}

/**
 * 解析项目根目录（支持打包环境）
 * @returns {string} 项目根目录路径
 */
function resolveProjectRoot(): string {
  const mainFile = require.main?.filename || process.execPath
  const isPkg = isPkgEnv(mainFile)
  let projectRoot = process.cwd()
  if (isPkg) {
    const distIdx = mainFile.indexOf('/dist/')
    if (distIdx > 0) {
      projectRoot = mainFile.slice(0, distIdx) // /snapshot/<project>
    } else {
      // 兜底：取主文件目录再回退一级
      projectRoot = path.resolve(path.dirname(mainFile), '..')
    }
  }
  return projectRoot
}

function resolveBinaryFromDir(baseDir: string, binaryName: string): string | null {
  const candidate = path.join(baseDir, binaryName, binaryName)
  if (fs.existsSync(candidate)) return candidate
  return null
}

/**
 * 将 pkg 资产中的二进制文件解压到真实文件系统中
 * @param snapshotBinaryPath - /snapshot 下的二进制路径
 * @param binaryName - 二进制名称（用于生成缓存文件名）
 * @param execBase - pkg 实际执行目录
 * @returns {string | null} 可执行文件的真实路径
 */
function extractBinaryFromSnapshot(snapshotBinaryPath: string, binaryName: string, execBase: string): string | null {
  try {
    if (!fs.existsSync(snapshotBinaryPath)) return null
    const targetDir = path.join(execBase, 'deps-runtime', binaryName)
    const targetPath = path.join(targetDir, binaryName)
    if (fs.existsSync(targetPath)) {
      try {
        fs.chmodSync(targetPath, 0o755)
      } catch (e) {
        yasaWarning(`chmod existing ${binaryName} failed: ${(e as Error).message}`, RESOLVE_UAST_BINARY_STAGE)
      }
      return targetPath
    }
    fs.mkdirSync(targetDir, { recursive: true })
    fs.copyFileSync(snapshotBinaryPath, targetPath)
    fs.chmodSync(targetPath, 0o755)
    yasaLog(`Materialized ${binaryName} into ${targetPath}`, RESOLVE_UAST_BINARY_STAGE)
    return targetPath
  } catch (err) {
    yasaWarning(`extract binary failed for ${binaryName}: ${(err as Error).message}`, RESOLVE_UAST_BINARY_STAGE)
    return null
  }
}

/**
 * 统一解析 UAST 二进制文件路径（Python 和 Go 共用）
 * 在 pkg 打包环境中，从 /snapshot 资产中解压到运行目录（execBase/deps-runtime/）
 * @param options - 选项对象
 * @param options.uastSDKPath - 用户指定的 SDK 路径
 * @param options.binaryName - 二进制文件名（'uast4py' 或 'uast4go'）
 * @param options.devPath - 开发环境路径
 * @returns {string | null} 二进制文件路径，如果不存在返回 null
 */
function resolveUastBinaryPath(options: {
  uastSDKPath?: string
  binaryName: 'uast4py' | 'uast4go'
  devPath: string
}): string | null {
  const { uastSDKPath, binaryName, devPath } = options

  // 优先级1: 用户指定的路径
  if (uastSDKPath && uastSDKPath !== '') {
    if (fs.existsSync(uastSDKPath)) {
      const stats = fs.statSync(uastSDKPath)
      if (stats.isDirectory()) {
        const resolvedFromDir = resolveBinaryFromDir(uastSDKPath, binaryName)
        if (resolvedFromDir) return resolvedFromDir
      } else {
        return uastSDKPath
      }
    }
    return null
  }

  // 优先级2: pkg 打包环境 - 从 /snapshot 资产解压到运行目录
  const mainFile = require.main?.filename || process.execPath
  const isPkg = isPkgEnv(mainFile)
  if (isPkg) {
    const execBase = path.dirname(process.execPath)
    const snapshotBinaryPath = resolveBinaryFromDir(path.join(resolveProjectRoot(), 'deps'), binaryName)
    yasaLog(`extracting ${binaryName} from snapshot to ${execBase}/deps-runtime/`, RESOLVE_UAST_BINARY_STAGE)
    if (snapshotBinaryPath) {
      const extractedPath = extractBinaryFromSnapshot(snapshotBinaryPath, binaryName, execBase)
      if (extractedPath) {
        return extractedPath
      }
    }
    yasaWarning(`Failed to extract ${binaryName} from snapshot`, RESOLVE_UAST_BINARY_STAGE)
  }

  // 优先级3: 开发环境路径
  if (fs.existsSync(devPath)) {
    return devPath
  }

  // 优先级4: 当前工作目录
  const cwdPath = resolveBinaryFromDir(path.join(process.cwd(), 'deps'), binaryName)
  if (cwdPath && fs.existsSync(cwdPath)) {
    return cwdPath
  }

  return null
}

//* *****************************  exports **************************

export {
  loadAllFileText,
  loadAllFileTextGlobby,
  writeJSONfile,
  loadJSONfile,
  readLinesSync,
  findfile,
  getFilesInDirectory,
  loadSource,
  removeBeforeFirstSlash,
  extractAfterSubstring,
  extractRelativePath,
  assembleFullPath,
  normalizeAndJoin,
  shortenSourceFile,
  getAbsolutePath,
  removeFileFromCache,
  isPkgEnv,
  resolveProjectRoot,
  resolveUastBinaryPath,
}
