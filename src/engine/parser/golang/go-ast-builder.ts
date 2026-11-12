/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable @typescript-eslint/no-use-before-define */
// eslint-disable-next-line import/no-import-module-exports -- Dirent 只提供类型，不产生运行时导入。
import type { Dirent } from 'fs'

const { LanguageType } = require('@ant-yasa/uast-parser-java-js')
const ChildProcess = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const JSONStream = require('JSONStream')
const { handleException } = require('../../analyzer/common/exception-handler')
const { resolveUastBinaryPath } = require('../../../util/file-util')
const logger = require('../../../util/logger')(__filename)

interface GoAstBuilderOptions {
  language?: string
  single?: boolean
  uastSDKPath?: string
  ASTFileOutput?: string
  dumpAST?: boolean
  dumpAllAST?: boolean
}

interface SourceFile {
  name: string
  content: string
}

interface ParseError {
  file: string
  message: string
  severity: 'error' | 'warning'
  kind: string
}

/** npm 解析器的运行时接口；原生模式不需要这个包。 */
interface GoParser {
  init(): Promise<void>
  readonly lastErrors: ParseError[]
  parseSourceRaw(name: string, content: string): string
  parseProject(files: SourceFile[], options: { root: string }): unknown
}

/** 进程内 parser 单例；原生子进程路径不使用此实例。 */
let inProcessParser: GoParser | null = null
let initPromise: Promise<void> | null = null

// 初始化与后端选择

/**
 * 是否使用原生 Go 解析器。
 *
 * `YASA_GO_PARSER=native` 强制原生；未设置或为空时，SDK 路径选择原生，否则默认 Tree-sitter。
 * @param options - 构建选项
 * @returns {boolean} true 表示走 native（execSync）路径
 */
function isNativeFallback(options?: GoAstBuilderOptions): boolean {
  const mode = process.env.YASA_GO_PARSER
  if (mode === 'native') return true
  if (mode !== undefined && mode !== '') {
    const message = `Invalid YASA_GO_PARSER=${JSON.stringify(mode)}. Unset it for the default parser, or use native.`
    // 单文件 CLI 的外层只输出通用错误，因此在 Go 选择入口给出具体提示。
    logger.info(message)
    throw new Error(message)
  }
  return Boolean(options?.uastSDKPath)
}

/**
 * 确保进程内 Go parser 已异步初始化，多次调用共享初始化结果。
 *
 * - 配置选择原生路径时直接返回；
 * - 初始化失败会重置单例并抛出带 fallback 提示的错误（不静默降级）。
 * @param options - 构建选项（用于判断是否需要 native fallback）
 * @returns {Promise<void>} 初始化完成的 Promise
 */
async function ensureInitialized(options?: GoAstBuilderOptions): Promise<void> {
  if (isNativeFallback(options) || inProcessParser) return
  if (!initPromise) {
    initPromise = Promise.resolve()
      .then(async () => {
        // 原生模式不加载 npm parser；保留静态模块名供 pkg 收集。
        const { Parser } = require('@ant-yasa/uast-parser-go')
        const parser: GoParser = new Parser()
        await parser.init()
        inProcessParser = parser
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
          `[go-ast-builder] Tree-sitter 初始化失败: ${detail}；请检查 @ant-yasa/uast-parser-go 安装，` +
            '或设置 YASA_GO_PARSER=native 使用原生 SDK'
        )
      })
      .finally(() => {
        initPromise = null
      })
  }
  await initPromise
}

// 项目文件收集

/**
 * 读取项目的 Go 源码和模块文件，跳过原生 parser 排除的 vendor 路径。
 *
 * - 进程内项目模式依据传入的 go.mod 计算
 *   moduleName/goModPath/numOfGoMod；只传 `.go` 会退化成 `__unknown_module__`，使引擎内部
 *   import 判定与跨包分析失效。
 * - 点目录（`.` 开头）不在 JS 侧剪枝：CLI 仅当点目录直接包含 `.go` 时才 SkipDir，
 *   该语义由 parser 的 `preparePackagesFromSources`/`prunedByDotDir` 处理；native 的
 *   `findAllGoMod` 同样递归点目录。因此这里也不跳过点目录。
 * @param rootDir - 项目根目录
 * @returns {SourceFile[]} 内存源码文件列表
 */
function readProjectSources(rootDir: string): SourceFile[] {
  const result: SourceFile[] = []
  const walk = (dir: string): void => {
    if (dir.split(path.sep).join('/').includes('/vendor')) return
    const entries = fs.readdirSync(dir, { withFileTypes: true }) as Dirent[]
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const isGoMod = entry.name === 'go.mod'
      if (entry.isDirectory() && !isGoMod) {
        walk(fullPath)
      } else if (isGoMod || entry.name.endsWith('.go')) {
        const source = readProjectFile(fullPath, entry, isGoMod)
        if (source) result.push(source)
      }
    }
  }
  walk(rootDir)
  return result
}

/**
 * 单个源文件读取失败时保留其余文件；模块文件无法读取时不能猜测分析根。
 * @param file - 文件路径
 * @param entry - 目录项
 * @param isGoMod - 是否为模块文件
 * @returns {SourceFile | undefined} 文件内容；跳过的目录链接或坏文件返回 undefined
 */
function readProjectFile(file: string, entry: Dirent, isGoMod: boolean): SourceFile | undefined {
  try {
    const isFile = entry.isFile() || (entry.isSymbolicLink() && fs.statSync(file).isFile())
    if (isFile) return { name: file, content: fs.readFileSync(file, 'utf8') }
    if (isGoMod) throw new Error(`Not a regular file: ${file}`)
  } catch (error) {
    if (isGoMod) throw error
    const message = error instanceof Error ? error.message : String(error)
    reportFileErrors([{ file, message, severity: 'error', kind: 'read_error' }])
  }
  return undefined
}

// 运行时失效与诊断

/**
 * 报告本次解析诊断。运行时失活只重置后续请求，本次错误交回调用者。
 * @param error - 捕获到的错误
 */
function reportParseFailure(error: unknown): void {
  const failure = error as { runtimeInvalid?: boolean; errors?: ParseError[] } | null | undefined
  if (failure?.runtimeInvalid) inProcessParser = null
  reportFileErrors(failure?.errors)
}

/**
 * 上报 parser 返回的文件级诊断：error 级走 handleException，warning 级记日志。
 * @param errors - parser.lastErrors
 */
function reportFileErrors(errors: ParseError[] | null | undefined): void {
  if (!Array.isArray(errors)) return
  for (const err of errors) {
    const detail = `${err.file}: [${err.severity}/${err.kind}] ${err.message}`
    if (err.severity === 'error') {
      handleException(null, `[go-ast-builder] ${detail}`, `[go-ast-builder] ${detail}`)
    } else {
      logger.warn(`[go-ast-builder] ${detail}`)
    }
  }
}

/**
 * 构建 Go UAST
 * @param rootDir - 根目录
 * @param options - 构建选项
 * @param uastOutputPath - UAST 输出路径
 */
function buildUASTGo(rootDir: string, options: GoAstBuilderOptions, uastOutputPath: string): void {
  options = options || {}
  if (options.language && options.language !== LanguageType.LANG_GO && options.language !== 'golang') {
    throw new Error(`Go AST Builder received wrong language type: ${options.language}`)
  }

  let isSingle = ''
  if (options.single) {
    isSingle = '-single'
  }

  // 使用统一的路径解析函数
  const devPath = path.join(__dirname, '../../../../deps/uast4go/uast4go')
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const uast4go_path = resolveUastBinaryPath({
    uastSDKPath: options.uastSDKPath,
    binaryName: 'uast4go',
    devPath,
  })

  // if uast4goPath does not exist, exit with error
  if (!uast4go_path || !fs.existsSync(uast4go_path)) {
    throw new Error('uast4go binary not found, please check uastSDKPath configuration')
  }

  fs.mkdirSync(path.dirname(uastOutputPath), { recursive: true })
  const command = `${quoteShellArg(uast4go_path)} ${isSingle} -rootDir=${quoteShellArg(rootDir)} -output=${quoteShellArg(uastOutputPath)}`

  try {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const options_for_command = {
      maxBuffer: 5 * 1024 * 1024 * 1024, // 5GB
    }
    ChildProcess.execSync(command, options_for_command)
  } catch (e) {
    // eslint-disable-next-line prettier/prettier
    handleException(e, 'Error occurred in go-ast-builder.buildUAST', 'Error occurred in go-ast-builder.buildUAST')
    throw e
  }
}

/**
 * 解析 Go 包（内部使用）
 * @param rootDir - 根目录
 * @param options - 解析选项
 * @returns {Promise<any>} 解析结果
 */
async function parsePackage(rootDir: string, options: GoAstBuilderOptions) {
  const uastFilePath = resolveUastFilePath(options)
  if (fs.existsSync(uastFilePath)) {
    deleteUAST(uastFilePath)
  }
  try {
    return parseSinglePackage(rootDir, options, uastFilePath)
  } catch (e) {
    try {
      return await parseLargePackage(rootDir, options, uastFilePath)
    } catch (e1) {
      // eslint-disable-next-line prettier/prettier
      handleException(e1, `[go-ast-builder] 解析Go AST时发生错误`, `[go-ast-builder] 解析Go AST时发生错误`)
      if (fs.existsSync(uastFilePath)) {
        deleteUAST(uastFilePath)
      }
      return null
    }
  }
}

/**
 * 解析大型 Go 包
 * @param rootDir - 根目录
 * @param options - 解析选项
 * @param uastFilePath - UAST 文件路径
 * @returns {Promise<any>} 解析结果
 */
async function parseLargePackage(rootDir: string, options: GoAstBuilderOptions, uastFilePath: string) {
  buildUASTGo(rootDir, options, uastFilePath)
  const data = (await parseLargeJsonFile(uastFilePath)) as any[]
  if (options.dumpAST || options.dumpAllAST) {
    const { deleteParent } = require('../../../util/ast-util')
    deleteParent(data)
  } else if (fs.existsSync(uastFilePath)) {
    deleteUAST(uastFilePath)
  }
  return { packageInfo: data[0], moduleName: data[1] }
}

/**
 * 解析单个 Go 包
 * @param rootDir - 根目录
 * @param options - 解析选项
 * @param uastFilePath - UAST 文件路径
 * @returns {any} 解析结果
 */
function parseSinglePackage(rootDir: string, options: GoAstBuilderOptions, uastFilePath: string) {
  buildUASTGo(rootDir, options, uastFilePath)
  const data = fs.readFileSync(uastFilePath, 'utf8')
  const obj = JSON.parse(data)
  if (options.dumpAST || options.dumpAllAST) {
    const { deleteParent } = require('../../../util/ast-util')
    deleteParent(obj)
  } else if (fs.existsSync(uastFilePath)) {
    deleteUAST(uastFilePath)
  }
  return obj
}

/**
 * 删除 UAST 文件
 * @param uastFilePath - UAST 文件路径
 */
function deleteUAST(uastFilePath: string) {
  const stats = fs.statSync(uastFilePath) // 获取文件/目录状态
  if (stats.isFile()) {
    fs.unlink(uastFilePath, (err: any) => {
      if (err) {
        handleException(
          err,
          `[go-ast-builder] 删除uast.json文件时发生错误`,
          `[go-ast-builder] 删除uast.json文件时发生错误`
        )
      }
    })
  }
}

function resolveUastFilePath(options: GoAstBuilderOptions): string {
  if (options.ASTFileOutput) {
    return path.isAbsolute(options.ASTFileOutput)
      ? options.ASTFileOutput
      : path.resolve(process.cwd(), options.ASTFileOutput)
  }
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-uast-go-')), 'uast.json')
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 读取并解析大JSON文件
 * @param {string} filePath - JSON文件的路径
 * @returns {Promise<any[]>} - 解析后的JSON对象数组
 */
function parseLargeJsonFile(filePath: string) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const parser = JSONStream.parse('*') // '*' 表示解析所有对象

    const results: any[] = []

    parser.on('data', (data: any) => {
      results.push(data) // 将每个解析出来的对象添加到结果数组中
    })

    parser.on('end', () => {
      resolve(results) // 当所有数据解析完毕后，解析结果
    })

    parser.on('error', (err: any) => {
      reject(err) // 如果发生错误，拒绝Promise
    })

    stream.pipe(parser)
  })
}

/**
 * 解析单个文件（统一接口）
 * @param filepath - 文件路径
 * @param options - 解析选项
 * @returns {any} 解析结果（包含 packageInfo 和 moduleName）
 */
function parseSingleFile(filepath: string, options?: GoAstBuilderOptions): any {
  if (!isNativeFallback(options)) return parseInProcessSingleFile(filepath, options)
  const opts = { ...options, single: true }
  const result = parseSinglePackage(filepath, opts, resolveUastFilePath(opts))
  // 将数组格式 [packageInfo, moduleName] 转换为对象格式 { packageInfo, moduleName }
  if (Array.isArray(result)) {
    return { packageInfo: result[0], moduleName: result[1] }
  }
  return result
}

/**
 * 解析项目（统一接口）
 * @param rootDir - 项目根目录
 * @param options - 解析选项
 * @returns {Promise<any>} 解析结果（包含 packageInfo 和 moduleName）
 */
async function parseProject(rootDir: string, options?: GoAstBuilderOptions): Promise<any> {
  if (!isNativeFallback(options)) return parseInProcessProject(rootDir, options)
  return parsePackage(rootDir, options || {})
}

/**
 * 单文件导出时原样写出 parser 返回的 UAST JSON。
 * @param raw - `parseSourceRaw` 返回的原始 JSON 字符串
 * @param options - 解析选项（含 dumpAST/dumpAllAST/ASTFileOutput）
 */
function writeDumpOutput(raw: string, options?: GoAstBuilderOptions): void {
  if (!options || (!options.dumpAST && !options.dumpAllAST) || !options.ASTFileOutput) return
  fs.mkdirSync(path.dirname(options.ASTFileOutput), { recursive: true })
  fs.writeFileSync(options.ASTFileOutput, raw)
}

/**
 * 解析单个文件，保留既有 UAST 输出格式。
 *
 * 由单文件分析或导出入口先调用 `await ensureInitialized()`。
 * @param filepath - 文件路径
 * @param options - 解析选项
 * @returns {any} 解析结果（包含 packageInfo 和 moduleName）
 */
function parseInProcessSingleFile(filepath: string, options?: GoAstBuilderOptions): any {
  if (!inProcessParser) {
    throw new Error(
      '[go-ast-builder] 进程内 Go parser 未初始化，请先 await ensureInitialized()；' +
        '或设置 YASA_GO_PARSER=native 使用 native fallback'
    )
  }
  try {
    const raw = inProcessParser.parseSourceRaw(filepath, fs.readFileSync(filepath, 'utf8'))
    reportFileErrors(inProcessParser.lastErrors)
    writeDumpOutput(raw, options)
    return JSON.parse(raw)
  } catch (error) {
    reportParseFailure(error)
    throw error
  }
}

/**
 * 解析内存源码并保留 parser 提供的诊断。
 * @param rootDir - 项目根目录
 * @param options - 解析选项
 * @returns {Promise<unknown>} 解析结果
 */
async function parseInProcessProject(rootDir: string, options?: GoAstBuilderOptions): Promise<unknown> {
  await ensureInitialized(options)
  const parser = inProcessParser!
  try {
    const result = parser.parseProject(readProjectSources(rootDir), { root: rootDir })
    reportFileErrors(parser.lastErrors)
    return result
  } catch (error) {
    reportParseFailure(error)
    throw error
  }
}

module.exports = {
  isNativeFallback,
  ensureInitialized,
  parseSingleFile,
  parseProject,
}
