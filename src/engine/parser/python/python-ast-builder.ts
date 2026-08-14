/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable sonarjs/cognitive-complexity */
const ChildProcess = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const FileUtil = require('../../../util/file-util')
const { handleException } = require('../../analyzer/common/exception-handler')
const { resolveUastBinaryPath } = require('../../../util/file-util')

interface BuildOptions {
  language?: string
  single?: boolean
  uastSDKPath?: string
  ASTFileOutput?: string
  [key: string]: any
}

const DEFAULT_UAST_OUTPUT_PATH = './uast'
let uastFilePath = DEFAULT_UAST_OUTPUT_PATH

/**
 * 构建 Python UAST
 * @param rootDir - 根目录
 * @param options - 构建选项
 * @returns {any} 构建结果
 */
function buildUASTPython(rootDir: string, options?: BuildOptions): string | null {
  options = options || {}
  // 每次调用重置模块级路径，防止多次调用时 .json 无限追加
  uastFilePath = './uast'
  if (options.language && options.language !== 'python') {
    throw new Error(`Python AST Builder received wrong language type: ${options.language}`)
  }

  const isSingle = options.single ? '--singleFileParse' : ''
  const outputPath = options.ASTFileOutput || (options.single ? `${DEFAULT_UAST_OUTPUT_PATH}.json` : DEFAULT_UAST_OUTPUT_PATH)

  // 使用统一的路径解析函数
  const devPath = path.join(__dirname, '../../../../deps/uast4py/uast4py')
  const uast4pyPath = resolveUastBinaryPath({
    uastSDKPath: options.uastSDKPath,
    binaryName: 'uast4py',
    devPath,
  })

  // if uast4pyPath does not exist, exit with error
  if (!uast4pyPath || !fs.existsSync(uast4pyPath)) {
    throw new Error('uast4py binary not found, please check uastSDKPath configuration')
  }

  uastFilePath = outputPath

  // 并行任务数：根据 CPU 核心数自动设置
  const numJobs = os.cpus().length
  const command = `${uast4pyPath} ${isSingle} --rootDir="${rootDir}" --output="${outputPath}" -j${numJobs}`

  try {
    const optionForCommand = {
      maxBuffer: 5 * 1024 * 1024 * 1024, // 5GB
    }
    ChildProcess.execSync(command, optionForCommand)
    return outputPath
  } catch (e) {
    // eslint-disable-next-line prettier/prettier
    handleException(e, `[python-ast-builder] 解析python AST时发生错误`, `[python-ast-builder] 解析python AST时发生错误`)
    return null
  }
}

/**
 * 删除 Python UAST 文件
 * @param fpath - 文件路径
 */
function deleteUASTPython(fpath: string) {
  try {
    const stats = fs.statSync(fpath) // 获取文件/目录状态

    if (stats.isFile()) {
      // 如果是文件直接删除
      fs.unlinkSync(fpath)
    } else if (stats.isDirectory()) {
      // 使用现代API递归删除目录
      fs.rmSync(fpath, { recursive: true, force: true })
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // eslint-disable-next-line prettier/prettier
      handleException(err, `[python-ast-builder] 路径不存在: ${fpath}`, `[python-ast-builder] 路径不存在: ${fpath}`)
    } else {
      // eslint-disable-next-line prettier/prettier
      handleException(err, `[python-ast-builder] 删除操作失败: ${fpath}`, `[python-ast-builder] 删除操作失败: ${fpath}`)
    }
  }
}

/**
 * 解析单个文件（统一接口）
 * @param code - 源代码内容
 * @param options - 解析选项（包含 sourcefile）
 * @returns {any} 解析后的 AST（未处理后处理）
 */
function parseSingleFilePython(code: string, options?: BuildOptions): any {
  options = options || {}
  options.single = true

  // 创建临时文件，写入传入的代码内容
  const tempDir = os.tmpdir()
  const tempFileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.py`
  const tempFilePath = path.join(tempDir, tempFileName)
  fs.writeFileSync(tempFilePath, code, 'utf8')
  const actualFilePath = tempFilePath

  // 保留原始的 sourcefile 用于 AST 标注，但使用临时文件路径进行解析
  // buildUASTPython 使用 actualFilePath 参数，不会读取 options.sourcefile

  try {
    const outputPath = buildUASTPython(actualFilePath, options)
    if (!outputPath) return
    const data = fs.readFileSync(outputPath, 'utf8')
    if (data.startsWith('Syntax error in file') || data.startsWith('UnicodeDecodeError in file')) {
      handleException(
        null,
        `[python-ast-builder] parseSingleFile failed: ${actualFilePath}`,
        `[python-ast-builder] parseSingleFile failed: ${actualFilePath}`
      )
      if (fs.existsSync(outputPath)) {
        deleteUASTPython(outputPath)
      }
      return
    }
    const obj = JSON.parse(data)
    if (!options.dumpAST && fs.existsSync(outputPath)) {
      deleteUASTPython(outputPath)
    }
    return obj
  } finally {
    // 清理临时文件（如果创建了）
    if (tempFilePath) {
      try {
        fs.unlinkSync(tempFilePath)
      } catch (e) {
        // 忽略清理错误
      }
    }
  }
}

// UTF-8 BOM 字节序列
const UTF8_BOM: Buffer = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * 仅读首 3 字节判断是否 UTF-8 BOM 文件，避免大文件全量 IO
 * @param filePath - 文件路径
 * @returns 是否以 UTF-8 BOM 开头
 */
function fileStartsWithUtf8Bom(filePath: string): boolean {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const head: Buffer = Buffer.alloc(3)
    const n: number = fs.readSync(fd, head, 0, 3, 0)
    return n === 3 && head.equals(UTF8_BOM)
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

/**
 * 从 uast4py 错误字符串中解析出失败源文件绝对路径
 * 错误形如：`Syntax error in file /abs/path: invalid non-printable...`
 * @param errorText - uast4py 写入失败 JSON 的错误文本
 * @returns 解析到的源文件路径，失败返回 null
 */
function extractFailedSourcePath(errorText: string): string | null {
  const match: RegExpMatchArray | null = errorText.match(/in file (.+?):/)
  if (match && match[1]) {
    return match[1].trim()
  }
  return null
}

/**
 * BOM 失败兜底：拷贝到 tmpdir 去 BOM，singleFileParse 重跑，路径反向映射回原 path
 * 严禁修改用户源码（rootDir 内任何路径都不写入）
 * @param originalPath - 原始源文件绝对路径（位于 rootDir 内）
 * @param tmpRoot - 本次 parsePackages 调用专属 tmpdir
 * @param uast4pyPath - uast4py 二进制路径
 * @returns 反向映射后的 UAST 对象，失败返回 null
 */
function tryRecoverBomFile(
  originalPath: string,
  tmpRoot: string,
  uast4pyPath: string
): any | null {
  if (!fileStartsWithUtf8Bom(originalPath)) {
    return null
  }
  let tmpInputPath: string | null = null
  let tmpOutputPath: string | null = null
  try {
    // 在 tmpRoot 下保留原文件 basename，避免 sourcefile 字段歧义
    const base: string = path.basename(originalPath)
    const unique: string = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
    tmpInputPath = path.join(tmpRoot, `${unique}_${base}`)
    tmpOutputPath = path.join(tmpRoot, `${unique}_${base}.json`)

    // 全量读 → 去 BOM → 写入 tmp
    const buf: Buffer = fs.readFileSync(originalPath)
    if (!buf.subarray(0, 3).equals(UTF8_BOM)) {
      return null
    }
    fs.writeFileSync(tmpInputPath, buf.subarray(3))

    // singleFileParse 直接调 binary，避免 buildUASTPython 修改模块级 uastFilePath
    const cmd: string = `${uast4pyPath} --singleFileParse --rootDir="${tmpInputPath}" --output="${tmpOutputPath}" -j1`
    ChildProcess.execSync(cmd, { maxBuffer: 5 * 1024 * 1024 * 1024 })

    if (!fs.existsSync(tmpOutputPath)) {
      return null
    }
    const recovered: string = fs.readFileSync(tmpOutputPath, 'utf8')
    if (
      recovered.startsWith('Syntax error in file') ||
      recovered.startsWith('UnicodeDecodeError in file')
    ) {
      // 兜底失败（BOM 之外还有其它语法问题），交还失败语义
      return null
    }
    // sourcefile 字段反向映射：tmpInputPath 唯一，全文 JSON 文本替换安全
    const escaped: string = JSON.stringify(tmpInputPath).slice(1, -1) // 转义 JSON 字符串字面量内的 tmp 路径
    const originalEscaped: string = JSON.stringify(originalPath).slice(1, -1)
    const remapped: string = recovered.split(escaped).join(originalEscaped)
    return JSON.parse(remapped)
  } catch (e) {
    handleException(
      e,
      `[python-ast-builder] BOM fallback failed: ${originalPath}`,
      `[python-ast-builder] BOM fallback failed: ${originalPath}`
    )
    return null
  } finally {
    // 清理本次 tmp 单文件产物（tmpRoot 整体在 parsePackages finally 清理）
    if (tmpInputPath && fs.existsSync(tmpInputPath)) {
      try {
        fs.unlinkSync(tmpInputPath)
      } catch {
        /* 忽略 */
      }
    }
    if (tmpOutputPath && fs.existsSync(tmpOutputPath)) {
      try {
        fs.unlinkSync(tmpOutputPath)
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 解析 Python 包（内部使用）
 * @param pyAstParseManager - AST 管理器
 * @param rootDir - 根目录
 * @param options - 构建选项
 */
function parsePackages(pyAstParseManager: any, rootDir: string, options?: BuildOptions): void {
  if (fs.existsSync(uastFilePath)) {
    deleteUASTPython(uastFilePath)
  }
  options = options || {}
  options.single = false
  // BOM fallback 专属 tmpdir，惰性创建（happy path 零开销）
  let bomTmpRoot: string | null = null
  // 解析 uast4py 路径用于 fallback 单文件重跑
  const devPath: string = path.join(__dirname, '../../../../deps/uast4py/uast4py')
  const uast4pyPath: string = resolveUastBinaryPath({
    uastSDKPath: options.uastSDKPath,
    binaryName: 'uast4py',
    devPath,
  })
  try {
    buildUASTPython(rootDir, options)

    const uastJsonFiles = FileUtil.loadAllFileTextGlobby(['**/*.(json)'], uastFilePath)

    for (const uastFile of uastJsonFiles) {
      const data: string = uastFile.content

      if (data.startsWith('Syntax error in file') || data.startsWith('UnicodeDecodeError in file')) {
        // BOM 兜底：解析错误文本中的失败文件，命中 BOM 则 tmpdir 单文件重跑
        const failedPath: string | null = extractFailedSourcePath(data)
        let recovered: any | null = null
        if (failedPath && fs.existsSync(failedPath)) {
          if (bomTmpRoot === null) {
            bomTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-bom-shim-'))
          }
          recovered = tryRecoverBomFile(failedPath, bomTmpRoot as string, uast4pyPath)
        }

        if (recovered !== null) {
          const filename: string | undefined = recovered?.loc?.sourcefile
          if (filename) {
            pyAstParseManager[filename] = recovered
          }
          if (fs.existsSync(uastFile.file)) {
            deleteUASTPython(uastFile.file)
          }
          continue
        }

        handleException(
          null,
          `[python-ast-builder] parsePackage error: get python ast failed. ${rootDir}`,
          `[python-ast-builder] parsePackage error: get python ast failed. ${rootDir}`
        )
        if (fs.existsSync(uastFile.file)) {
          deleteUASTPython(uastFile.file)
        }
        continue
      }

      let obj: any
      try {
        obj = JSON.parse(data)
      } catch (e) {
        handleException(
          e,
          `[python-ast-builder] parsePackage error: invalid ast json. ${uastFile.file}`,
          `[python-ast-builder] parsePackage error: invalid ast json. ${uastFile.file}`
        )
        if (fs.existsSync(uastFile.file)) {
          deleteUASTPython(uastFile.file)
        }
        continue
      }

      const filename = obj?.loc?.sourcefile
      if (filename) {
        pyAstParseManager[filename] = obj
      }
    }
  } catch (e) {
    handleException(
      e,
      `[python-ast-builder] parsePackage error: ${rootDir}`,
      `[python-ast-builder] parsePackage error: ${rootDir}`
    )
    if (fs.existsSync(uastFilePath)) {
      deleteUASTPython(uastFilePath)
    }
  } finally {
    // 清理 BOM fallback tmpdir（happy path 不会创建）
    if (bomTmpRoot !== null && fs.existsSync(bomTmpRoot)) {
      try {
        fs.rmSync(bomTmpRoot, { recursive: true, force: true })
      } catch {
        /* 忽略清理失败 */
      }
    }
  }

  if (!options.dumpAST && fs.existsSync(uastFilePath)) {
    deleteUASTPython(uastFilePath)
  }
}

/**
 * 解析项目（统一接口）
 * @param rootDir - 项目根目录
 * @param options - 解析选项
 * @returns {Promise<Record<string, any>>} AST 管理器对象
 */
async function parseProject(rootDir: string, options?: BuildOptions): Promise<Record<string, any>> {
  const astManager: Record<string, any> = {}
  parsePackages(astManager, rootDir, options)
  return astManager
}

module.exports = {
  parseSingleFile: parseSingleFilePython,
  parseProject,
}
