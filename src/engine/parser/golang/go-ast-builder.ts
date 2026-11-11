/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable @typescript-eslint/no-use-before-define */
// eslint-disable-next-line import/no-import-module-exports -- Dirent 只提供类型，不产生运行时导入。
import type { Dirent } from 'fs'

const childProcess = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const readGoProjectJson = require('./go-project-json-reader').default
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
  parseProject(files: SourceFile[], options: { root: string }): GoProjectResult
}

interface GoPackageTree {
  files?: Record<string, { node?: { type?: string } } | null> | null
  subs?: Record<string, GoPackageTree> | null
}

interface GoProjectResult {
  packageInfo: GoPackageTree
  moduleName: string
  goModPath?: string
  numOfGoMod?: number
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

// 原生子进程调用

/**
 * 构建 Go UAST（native fallback，原 execSync 路径）
 * @param rootDir - 根目录
 * @param options - 构建选项
 * @param uastOutputPath - UAST 输出路径
 */
function buildUASTGo(rootDir: string, options: GoAstBuilderOptions, uastOutputPath: string): void {
  options = options || {}
  if (options.language && options.language !== 'golang') {
    throw new Error(`Go AST Builder received wrong language type: ${options.language}`)
  }

  let singleFlag = ''
  if (options.single) {
    singleFlag = '-single'
  }

  // 兼容显式 SDK 路径、打包快照与开发目录。
  const devPath = path.join(__dirname, '../../../../deps/uast4go/uast4go')
  const uast4goPath = resolveUastBinaryPath({
    uastSDKPath: options.uastSDKPath,
    binaryName: 'uast4go',
    devPath,
  })

  if (!uast4goPath || !fs.existsSync(uast4goPath)) {
    throw new Error('uast4go binary not found, please check uastSDKPath configuration')
  }

  fs.mkdirSync(path.dirname(uastOutputPath), { recursive: true })
  // 本次子进程必须创建产物；不能读取前一次输出，也不跟随旧输出路径上的软链。
  try {
    fs.unlinkSync(uastOutputPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const command = `${quoteShellArg(uast4goPath)} ${singleFlag} -rootDir=${quoteShellArg(rootDir)} -output=${quoteShellArg(uastOutputPath)}`

  try {
    const commandOptions = {
      maxBuffer: 5 * 1024 * 1024 * 1024, // 5GB
    }
    childProcess.execSync(command, commandOptions)
  } catch (e) {
    if (fs.existsSync(uastOutputPath)) deleteUAST(uastOutputPath)
    // eslint-disable-next-line prettier/prettier
    handleException(e, 'Error occurred in go-ast-builder.buildUAST', 'Error occurred in go-ast-builder.buildUAST')
    throw e
  }
}

/**
 * 只运行一次原生解析器；只有输出超过同步读取上限时才分块读取。
 * @param rootDir - 根目录
 * @param options - 解析选项
 * @returns {Promise<any>} 解析结果
 */
async function parseNativeProject(rootDir: string, options: GoAstBuilderOptions) {
  const uastFilePath = resolveUastFilePath(options)
  buildUASTGo(rootDir, options, uastFilePath)
  let success = false
  try {
    const data = await readNativeProjectOutput(uastFilePath)
    const result = Array.isArray(data)
      ? { packageInfo: data[0], moduleName: data[1], goModPath: data[2] ?? '', numOfGoMod: data[3] ?? 0 }
      : data
    if (!hasCompileUnit(result?.packageInfo)) throw new Error(`No Go compilation units in native output: ${rootDir}`)
    success = true
    return result
  } finally {
    if ((!success || (!options.dumpAST && !options.dumpAllAST)) && fs.existsSync(uastFilePath)) {
      deleteUAST(uastFilePath)
    }
  }
}

/**
 * 普通输出用 JSON.parse；过大的输出逐个文件解码。
 * @param uastFilePath - UAST 文件路径
 * @returns {Promise<any>} 解析结果
 */
async function readNativeProjectOutput(uastFilePath: string) {
  let data: string
  try {
    data = fs.readFileSync(uastFilePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_FS_FILE_TOO_LARGE' || error instanceof RangeError) {
      return readGoProjectJson(uastFilePath)
    }
    throw error
  }
  return JSON.parse(data)
}

/**
 * 旧 SDK 可能退出 0 却未产生可分析的文件。
 * @param tree - 原生解析器返回的包树
 * @returns {boolean} 是否至少有一个完整的文件节点
 */
function hasCompileUnit(tree: GoPackageTree | null | undefined): boolean {
  if (!tree) return false
  return (
    Object.values(tree.files ?? {}).some((file) => file?.node?.type === 'CompileUnit') ||
    Object.values(tree.subs ?? {}).some(hasCompileUnit)
  )
}

/**
 * 删除 UAST 文件
 * @param uastFilePath - UAST 文件路径
 */
function deleteUAST(uastFilePath: string) {
  try {
    fs.unlinkSync(uastFilePath)
  } catch (error) {
    handleException(error, `[go-ast-builder] 无法删除 ${uastFilePath}`, '[go-ast-builder] UAST cleanup failed')
  }
}

/**
 * 解析单个文件（native fallback，统一接口）
 * @param filepath - 文件路径
 * @param options - 解析选项
 * @returns {any} 解析结果（包含 packageInfo 和 moduleName）
 */
function parseSingleFileNative(filepath: string, options?: GoAstBuilderOptions): any {
  const opts = { ...options, single: true }
  const uastFilePath = resolveUastFilePath(opts)
  buildUASTGo(filepath, opts, uastFilePath)
  let success = false
  try {
    const data = JSON.parse(fs.readFileSync(uastFilePath, 'utf8'))
    const result = Array.isArray(data) ? { packageInfo: data[0], moduleName: data[1] } : data
    if (!hasCompileUnit(result?.packageInfo)) throw new Error(`No Go compilation units in native output: ${filepath}`)
    if (opts.dumpAST || opts.dumpAllAST) {
      const { deleteParent } = require('../../../util/ast-util')
      deleteParent(result)
    }
    success = true
    return result
  } finally {
    if ((!success || (!opts.dumpAST && !opts.dumpAllAST)) && fs.existsSync(uastFilePath)) {
      deleteUAST(uastFilePath)
    }
  }
}

/**
 * 解析 native fallback 的 UAST 输出文件路径（ASTFileOutput 或系统临时目录）。
 * @param options - 构建选项
 * @returns {string} UAST 输出文件绝对路径
 */
function resolveUastFilePath(options: GoAstBuilderOptions): string {
  if (options.ASTFileOutput) {
    return path.isAbsolute(options.ASTFileOutput)
      ? options.ASTFileOutput
      : path.resolve(process.cwd(), options.ASTFileOutput)
  }
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-uast-go-')), 'uast.json')
}

/**
 * 用单引号包裹 shell 参数并转义其中的单引号（native fallback 命令拼接用）。
 * @param value - 原始参数
 * @returns {string} 安全的 shell 参数
 */
function quoteShellArg(value: string): string {
  const escaped = value.replace(/'/g, `'\\''`)
  return `'${escaped}'`
}

// 进程内解析与结果输出

/**
 * `--dumpAST`/`--dumpAllAST` 时原样写出 parser 返回的单文件 JSON 字符串。
 * @param raw - `parseSourceRaw` 返回的原始 JSON 字符串
 * @param options - 解析选项（含 dumpAST/dumpAllAST/ASTFileOutput）
 */
function writeDumpOutput(raw: string, options?: GoAstBuilderOptions): void {
  if (!options || (!options.dumpAST && !options.dumpAllAST) || !options.ASTFileOutput) return
  const outPath = path.isAbsolute(options.ASTFileOutput)
    ? options.ASTFileOutput
    : path.resolve(process.cwd(), options.ASTFileOutput)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, raw)
}

/**
 * 解析单个文件（统一接口，进程内 parser；native fallback 由 options/env 决定）
 *
 * 调用前必须先 `await ensureInitialized()`（分析器会先 ensure）。未初始化时报错，
 * 不会静默降级。`dumpAST`/`dumpAllAST` + `ASTFileOutput` 时按 native `-output` 语义落盘。
 * @param filepath - 文件路径
 * @param options - 解析选项
 * @returns {any} 解析结果（包含 packageInfo 和 moduleName）
 */
function parseSingleFile(filepath: string, options?: GoAstBuilderOptions): any {
  if (isNativeFallback(options)) {
    return parseSingleFileNative(filepath, options)
  }
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
    const obj = JSON.parse(raw)
    if (Array.isArray(obj)) {
      return { packageInfo: obj[0], moduleName: obj[1] }
    }
    return obj
  } catch (error) {
    reportParseFailure(error)
    throw error
  }
}

/**
 * 解析项目（统一接口，进程内 parser；native fallback 由 options/env 决定）
 *
 * 仅文件级错误允许返回其余文件的 UAST；请求失败由分析或导出入口处理。
 * @param rootDir - 项目根目录
 * @param options - 解析选项
 * @returns {Promise<GoProjectResult>} 解析结果（包含 packageInfo/moduleName/goModPath/numOfGoMod）
 */
async function parseProject(rootDir: string, options?: GoAstBuilderOptions): Promise<GoProjectResult> {
  const result = isNativeFallback(options)
    ? await parseNativeProject(rootDir, options || {})
    : await parseInProcessProject(rootDir, options)
  if (result.numOfGoMod && result.numOfGoMod > 1) {
    logger.info(`[go-ast-builder] Found ${result.numOfGoMod} go.mod files; selected ${result.goModPath}`)
  }
  return result
}

/**
 * 解析内存源码并保留 parser 提供的诊断。
 * @param rootDir - 项目根目录
 * @param options - 解析选项
 * @returns {Promise<GoProjectResult>} 解析结果
 */
async function parseInProcessProject(rootDir: string, options?: GoAstBuilderOptions): Promise<GoProjectResult> {
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
  ensureInitialized,
  parseSingleFile,
  parseProject,
}
