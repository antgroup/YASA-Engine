/**
 * 解析器核心逻辑
 * 包含所有解析相关的函数，供 parser.ts 和 parser-worker.ts 使用
 */

const fs = require('fs-extra')
const path = require('path')
const AstUtil = require('../../util/ast-util')
const SourceLine = require('../analyzer/common/source-line')
const { Errors } = require('../../util/error-code')
const { addNodeHash } = require('../../util/ast-util')
const { md5 } = require('../../util/hash-util')
const logger = require('../../util/logger')(__filename)

// 语言解析器配置接口
interface LanguageParserConfig {
  language: string | string[]
  unit: 'file' | 'package'
  supportsIncremental: boolean
  filePatterns: string[]
  parseSingleFile?: (code: string, options: Record<string, any>) => any
  parseProject?: (rootDir: string, options: Record<string, any>) => Promise<any>
  needsSourcefile?: boolean
  parseAsFiles?: boolean
}

// 解析器缓存
const parsers: Record<string, ((code: string, options: Record<string, any>) => any) | null> = {
  java: null,
  javascript: null,
  js: null,
  python: null,
  golang: null,
}

/**
 * 获取语言解析器
 * @param {string} language - 语言标识
 * @returns {((code: string, options: Record<string, any>) => any) | null} 解析器函数或 null
 */
function getParser(language: string): ((code: string, options: Record<string, any>) => any) | null {
  if (parsers[language]) {
    return parsers[language]
  }

  let parser = null
  switch (language) {
    case 'java': {
      const JavaAstBuilder = require('./java/java-ast-builder')
      parser = (c: string, opts: Record<string, any>) => JavaAstBuilder.parseSingleFile(c, opts)
      parsers.java = parser
      break
    }
    case 'javascript':
    case 'js': {
      const JSAstBuilder = require('./javascript/js-ast-builder')
      parser = (c: string, opts: Record<string, any>) =>
        JSAstBuilder.parseSingleFile(c, {
          sanity: opts.sanity,
          sourcefile: opts.sourcefile,
        })
      parsers.javascript = parser
      parsers.js = parser
      break
    }
    case 'python': {
      const PythonParser = require('./python/python-ast-builder')
      parser = (c: string, opts: Record<string, any>) => PythonParser.parseSingleFile(c, opts)
      parsers.python = parser
      break
    }
    case 'golang': {
      const GoParser = require('./golang/go-ast-builder')
      parser = (_c: string, opts: Record<string, any>) => {
        if (!opts.sourcefile) {
          throw new Error('Go single file parsing requires sourcefile in options')
        }
        return GoParser.parseSingleFile(opts.sourcefile, opts)
      }
      parsers.golang = parser
      break
    }
    default:
      throw new Error(`Unsupported language: ${language}`)
  }

  return parser
}

/**
 * JSON.stringify 的 replacer 函数，用于跳过 parent 属性
 * @param {string} key - 属性键名
 * @param {any} value - 属性值
 * @returns {any} 如果 key 是 'parent' 则返回 undefined（跳过），否则返回原值
 */
function skipParentReplacer(key: string, value: any): any {
  if (key === 'parent') {
    return undefined
  }
  return value
}

/**
 * 检查 AST 是否已经有有效的 nodehash（用于缓存优化）
 * 需要验证 hash 是否在当前配置下仍然有效
 * @param {any} ast - AST 节点
 * @param {string} expectedSourcefile - 期望的 sourcefile
 * @returns {boolean} 如果 AST 已有有效的 hash 则返回 true
 */
function hasValidNodeHash(ast: any, expectedSourcefile: string): boolean {
  if (!ast || typeof ast !== 'object') return false

  // 检查根节点是否有 hash
  if (!ast._meta?.nodehash) return false

  // 关键检查：验证 sourcefile 是否匹配
  // nodehash 的计算依赖于 loc.sourcefile（通过 maindirPrefix 影响 relateFilePath）
  // 如果 sourcefile 不匹配，说明 hash 可能是在不同的配置下计算的，需要重新计算
  const actualSourcefile = ast.loc?.sourcefile || ''

  // sourcefile 必须匹配，且已有 hash，才能跳过重新计算
  // 注意：这里假设 maindirPrefix 在增量分析时不会变化
  // 如果 maindirPrefix 变化，会导致 hash 不一致，但这种情况应该很少见
  return actualSourcefile === expectedSourcefile
}

/**
 * AST 后处理：设置 sourcefile、添加 parent 指针、添加节点哈希
 *
 * 重要：此函数会为 AST 添加 parent 属性
 * - annotateAST 会调用 adjustASTNode，为所有节点添加 parent 指针
 * - 无论是新解析的 AST 还是从缓存加载的 AST，都会添加 parent
 * - 最终返回的 AST 包含完整的 parent 链，用于后续分析
 *
 * @param {any} ast - AST 节点（可能没有 parent，如从缓存加载的）
 * @param {any} code - 源代码内容
 * @param {Record<string, any>} options - 解析选项
 * @param {boolean} [needsSourcefile] - 是否需要设置 sourcefile
 * @param {boolean} [skipHashIfExists] - 如果 AST 已有 hash 且 sourcefile 匹配，是否跳过 hash 计算（用于缓存优化）
 * @returns {any} 处理后的 AST（包含 parent 属性）
 */
function processAst(
  ast: any,
  code: any,
  options: Record<string, any>,
  needsSourcefile?: boolean,
  skipHashIfExists?: boolean
): any {
  const shouldSetSourcefile = needsSourcefile !== false

  const fname = code != null ? SourceLine.storeCode(options?.sourcefile, code) : options?.sourcefile || ''

  if (shouldSetSourcefile) {
    // annotateAST 会调用 adjustASTNode，为所有节点添加 parent 指针
    AstUtil.annotateAST(ast, options ? { sourcefile: fname } : null)
    if (!ast.loc) ast.loc = {}
    ast.loc.sourcefile = fname
  } else {
    // 即使不设置 sourcefile，也会添加 parent 指针
    AstUtil.annotateAST(ast, { skipSourcefile: true })
  }

  if (skipHashIfExists && hasValidNodeHash(ast, fname)) {
    // hash 已存在且有效（sourcefile 匹配），跳过重新计算
    // 这样可以避免对缓存加载的 AST 重复计算 hash，显著提升性能
  } else {
    addNodeHash(ast)
  }

  return ast
}

/**
 * 后处理解析后的 AST
 * @param {any} ast - AST 节点
 * @param {string | null} code - 源代码内容（可为 null）
 * @param {Record<string, any>} options - 解析选项
 * @param {LanguageParserConfig} config - 语言配置
 * @param {boolean} [skipHashIfExists] - 如果 AST 已有 hash 且 sourcefile 匹配，是否跳过 hash 计算（用于缓存优化）
 * @returns {any} 处理后的 AST
 */
function processParsedAst(
  ast: any,
  code: string | null,
  options: Record<string, any>,
  config: LanguageParserConfig,
  skipHashIfExists?: boolean
): any {
  if (!ast) {
    return null
  }

  if (config.unit === 'package') {
    if (Array.isArray(ast)) {
      const [packageInfo, moduleName] = ast
      const processedPackageInfo = processAst(packageInfo, code, options, config.needsSourcefile, skipHashIfExists)
      return { packageInfo: processedPackageInfo, moduleName }
    }
    if (ast && typeof ast === 'object' && 'packageInfo' in ast && 'moduleName' in ast) {
      ast.packageInfo = processAst(ast.packageInfo, code, options, config.needsSourcefile, skipHashIfExists)
      return ast
    }
    return processAst(ast, code, options, config.needsSourcefile, skipHashIfExists)
  }
  return processAst(ast, code, options, config.needsSourcefile, skipHashIfExists)
}

/**
 * 解析文件（同步版本）
 * @param {string} filepath - 文件路径
 * @param {string} code - 源代码内容
 * @param {string} language - 语言标识
 * @param {Record<string, any>} options - 解析选项
 * @param {{ unit: string; needsSourcefile?: boolean }} config - 配置对象
 * @param {string} config.unit - 分析单元类型
 * @param {boolean} [config.needsSourcefile] - 是否需要设置 sourcefile
 * @returns {{ filepath: string; ast: any }} 解析结果
 */
function parseFile(
  filepath: string,
  code: string,
  language: string,
  options: Record<string, any>,
  config: { unit: string; needsSourcefile?: boolean }
): { filepath: string; ast: any } {
  // 获取解析器（使用缓存）
  const parseSingleFile = getParser(language)

  if (!parseSingleFile) {
    throw new Error(`Language ${language} does not support parseSingleFile`)
  }

  // 解析文件
  const parseResult = parseSingleFile(code, options)

  if (!parseResult) {
    Errors.ParseError(`Failed to parse file: ${filepath}`)
    return { filepath, ast: null }
  }

  // 后处理 AST
  const processedAst = processParsedAst(parseResult, code, options, config as LanguageParserConfig)

  return { filepath, ast: processedAst }
}

/**
 * 从缓存加载 AST（核心能力，不做路径计算）
 *
 * 注意：从缓存加载的 AST 不包含 parent 属性（因为保存时跳过了）
 * - 加载后需要通过 processParsedAst 重新添加 parent
 * - processParsedAst 会调用 annotateAST，为所有节点添加 parent 指针
 *
 * @param {string} jsonFilePath - 缓存文件的完整路径
 * @returns {Promise<any>} 解析后的 AST（不包含 parent），失败返回 null
 */
async function loadAstFromCache(jsonFilePath: string): Promise<any> {
  try {
    const astContent = await fs.promises.readFile(jsonFilePath, 'utf8')
    // 加载的 AST 不包含 parent（因为保存时跳过了）
    return JSON.parse(astContent)
  } catch (error) {
    logger.warn(`Failed to load AST cache from ${jsonFilePath}: ${(error as Error).message}`)
    return null
  }
}

/**
 * 保存 AST 到缓存（核心能力，不做路径计算）
 *
 * 重要：保存到文件的 AST 不包含 parent 属性
 * - parent 是循环引用，无法序列化到 JSON
 * - 使用 skipParentReplacer 在序列化时跳过 parent 属性
 * - 原 AST 对象不会被修改（仍然保留 parent，用于返回给用户）
 * - 从缓存加载后，会通过 processParsedAst 重新添加 parent
 *
 * @param {any} ast - AST 节点（可能包含 parent 属性，但保存时会跳过）
 * @param {string} jsonFilePath - 缓存文件的完整路径
 * @returns {Promise<boolean>} 是否保存成功
 */
async function saveAstToCache(ast: any, jsonFilePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      // 确保目录存在
      const cacheDir = path.dirname(jsonFilePath)
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true })
      }

      // 使用 skipParentReplacer 跳过 parent 属性
      // 序列化时跳过 parent，避免循环引用问题和减少文件大小
      // 原 AST 对象保持不变（仍然有 parent，用于返回给用户）
      const astSerialized = JSON.stringify(ast, skipParentReplacer)
      fs.writeFile(jsonFilePath, astSerialized, 'utf8', (err: NodeJS.ErrnoException | null) => {
        if (err) {
          logger.warn(`Failed to write AST cache to ${jsonFilePath}: ${err.message}`)
          resolve(false)
          return
        }
        resolve(true)
      })
    } catch (error) {
      logger.warn(`Failed to save AST cache to ${jsonFilePath}: ${(error as Error).message}`)
      resolve(false)
    }
  })
}

/**
 * 从 filePatterns 中提取文件扩展名
 * @param {string[]} filePatterns - 文件匹配模式数组
 * @returns {string} 文件扩展名（如 '.go'），如果无法提取则返回空字符串
 */
function extractFileExtension(filePatterns: string[]): string {
  if (!filePatterns || filePatterns.length === 0) {
    return ''
  }

  const firstPattern = filePatterns.find((pattern) => !pattern.startsWith('!'))
  if (!firstPattern) {
    return ''
  }

  const match = firstPattern.match(/\.\(([^)]+)\)|\.([a-zA-Z0-9]+)(?:\s|$|,|})/)
  if (match) {
    if (match[1]) {
      const extensions = match[1].split(',').map((ext) => ext.trim())
      return `.${extensions[0]}`
    }
    if (match[2]) {
      return `.${match[2]}`
    }
  }

  return ''
}

/**
 * 递归提取 packageInfo 中所有文件的 AST 并写入文件
 * @param {any} packageInfo - package 类型的解析结果（包含 files 和 subs）
 * @param {string} reportDir - 输出目录
 * @param {LanguageParserConfig} config - 语言配置
 * @returns {string[]} AST 文件列表（文件名）
 */
function extractAndDumpPackageAst(packageInfo: any, reportDir: string, config: LanguageParserConfig): string[] {
  const astFileList: string[] = []

  if (!packageInfo || typeof packageInfo !== 'object') {
    return astFileList
  }

  const fileExtension = extractFileExtension(config.filePatterns)
  if (!fileExtension) {
    logger.warn(`Cannot extract file extension from filePatterns for language: ${config.language}`)
    return astFileList
  }

  /**
   * 深度搜索并提取 AST
   * @param {any} obj - 要搜索的对象
   */
  function deepSearch(obj: any) {
    if (!obj || typeof obj !== 'object') {
      return
    }

    if (Array.isArray(obj)) {
      obj.forEach((item) => deepSearch(item))
      return
    }

    for (const [key, value] of Object.entries(obj)) {
      if (typeof key === 'string' && key.endsWith(fileExtension) && value && typeof value === 'object') {
        const { node } = value as any
        if (node && typeof node === 'object' && node.type === 'CompileUnit') {
          const fileName = `${md5(key)}.json`
          const astFilePath = path.join(reportDir, fileName)
          fs.writeFileSync(astFilePath, JSON.stringify(node, skipParentReplacer))
          astFileList.push(fileName)
        }
        continue
      }

      deepSearch(value)
    }
  }

  deepSearch(packageInfo)
  return astFileList
}

/**
 * 从 package 信息中递归提取 AST
 * @param {any} packageInfo - package 信息对象
 * @param {Array<{ ast: any; filename: string }>} astList - AST 列表（用于收集结果）
 */
function extractFromPackage(packageInfo: any, astList: Array<{ ast: any; filename: string }>): void {
  if (packageInfo.files) {
    for (const [filename, fileAst] of Object.entries(packageInfo.files)) {
      astList.push({ ast: fileAst, filename })
    }
  }
  if (packageInfo.subs) {
    // 与 master 版本保持一致，使用 Object.values()
    for (const subPackage of Object.values(packageInfo.subs)) {
      extractFromPackage(subPackage, astList)
    }
  }
}

/**
 * 处理项目 AST：为所有 AST 设置 sourcefile、添加 parent 指针和节点哈希（核心编译逻辑）
 * @param {any} result - 解析结果
 * @param {LanguageParserConfig} config - 语言配置
 * @param {Record<string, any>} options - 解析选项
 * @param {Record<string, string>} sourceCodeCache - 源代码缓存（必须提供，包含所有需要的文件内容）
 */
function processProjectAst(
  result: any,
  config: LanguageParserConfig,
  options: Record<string, any>,
  sourceCodeCache: Record<string, string>
): void {
  const astList: Array<{ ast: any; filename: string }> = []

  if (config.unit === 'package') {
    if (result && result.packageInfo) {
      extractFromPackage(result.packageInfo, astList)
    }
  } else if (config.unit === 'file') {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      for (const [filename, ast] of Object.entries(result)) {
        astList.push({ ast, filename })
      }
    }
  } else {
    astList.push({ ast: result, filename: '' })
  }

  for (const { ast, filename } of astList) {
    const sourceCode = sourceCodeCache[filename] || null
    processParsedAst(ast, sourceCode, { sourcefile: filename, ...options }, config)
  }
}

/**
 * 导出所有 AST 到文件
 * @param {any} results - 解析结果
 * @param {string} reportDir - 输出目录
 * @param {LanguageParserConfig} config - 语言配置
 * @returns {Promise<void>}
 */
async function dumpAllAST(results: any, reportDir: string, config: LanguageParserConfig): Promise<void> {
  const UAST_JSON = './uast.json'

  // 确保 reportDir 存在（不删除，保留现有内容）
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true })
  }

  const astFileList: string[] = []

  if (config.unit === 'file') {
    if (results && typeof results === 'object' && !Array.isArray(results)) {
      for (const [filename, ast] of Object.entries(results)) {
        const fileName = `${md5(filename)}.json`
        const astFilePath = path.join(reportDir, fileName)
        fs.writeFileSync(astFilePath, JSON.stringify(ast, skipParentReplacer))
        astFileList.push(fileName)
      }
    }
  } else if (config.unit === 'package') {
    if (results && results.packageInfo) {
      const packageAstFiles = extractAndDumpPackageAst(results.packageInfo, reportDir, config)
      astFileList.push(...packageAstFiles)
    }

    if (fs.existsSync(UAST_JSON)) {
      try {
        const uastFile = fs.statSync(UAST_JSON)
        if (uastFile.isFile()) {
          fs.unlinkSync(UAST_JSON)
        }
      } catch (err) {
        // Ignore deletion errors
      }
    }
  }

  // 生成 astList.json
  const astListPath = path.join(reportDir, 'astList.json')
  fs.writeFileSync(astListPath, JSON.stringify(astFileList, null, 2))
}

/**
 * 只做原始 parse，不含 processAst（annotateAST/addNodeHash）
 * 供子进程使用，主线程收到结果后再补 processAst
 * @param {string} filepath - 文件路径
 * @param {string} code - 源代码内容
 * @param {string} language - 语言标识
 * @param {Record<string, any>} options - 解析选项
 * @param {{ unit: string; needsSourcefile?: boolean }} config - 配置对象
 * @returns {{ filepath: string; ast: any }} 原始解析结果（未处理 parent/hash）
 */
function parseFileRaw(
  filepath: string,
  code: string,
  language: string,
  options: Record<string, any>,
  config: { unit: string; needsSourcefile?: boolean }
): { filepath: string; ast: any } {
  const parseSingleFile = getParser(language)

  if (!parseSingleFile) {
    throw new Error(`Language ${language} does not support parseSingleFile`)
  }

  const parseResult = parseSingleFile(code, options)

  if (!parseResult) {
    Errors.ParseError(`Failed to parse file: ${filepath}`)
    return { filepath, ast: null }
  }

  return { filepath, ast: parseResult }
}

module.exports = {
  parseFile,
  parseFileRaw,
  getParser,
  processParsedAst,
  processProjectAst,
  loadAstFromCache,
  saveAstToCache,
  dumpAllAST,
}
