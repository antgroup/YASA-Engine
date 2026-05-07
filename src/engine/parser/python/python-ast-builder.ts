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

let uastFilePath = './uast'

/**
 * 构建 Python UAST
 * @param rootDir - 根目录
 * @param options - 构建选项
 * @returns {any} 构建结果
 */
function buildUASTPython(rootDir: string, options?: BuildOptions): any {
  options = options || {}
  if (options.language && options.language !== 'python') {
    throw new Error(`Python AST Builder received wrong language type: ${options.language}`)
  }

  let isSingle = ''
  if (options.single) {
    isSingle = '--singleFileParse'
    uastFilePath += '.json'
  } else {
    isSingle = ''
  }

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

  if (options.ASTFileOutput) {
    uastFilePath = options.ASTFileOutput
  }

  // 并行任务数：根据 CPU 核心数自动设置
  const numJobs = os.cpus().length
  const command = `${uast4pyPath} ${isSingle} --rootDir="${rootDir}" --output="${uastFilePath}" -j${numJobs}`

  try {
    const optionForCommand = {
      maxBuffer: 5 * 1024 * 1024 * 1024, // 5GB
    }
    ChildProcess.execSync(command, optionForCommand)
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
    buildUASTPython(actualFilePath, options)
    const data = fs.readFileSync(uastFilePath, 'utf8')
    if (data.startsWith('Syntax error in file') || data.startsWith('UnicodeDecodeError in file')) {
      handleException(
        null,
        `[python-ast-builder] parseSingleFile failed: ${actualFilePath}`,
        `[python-ast-builder] parseSingleFile failed: ${actualFilePath}`
      )
      if (fs.existsSync(uastFilePath)) {
        deleteUASTPython(uastFilePath)
      }
      return
    }
    const obj = JSON.parse(data)
    if (!options.dumpAST && fs.existsSync(uastFilePath)) {
      deleteUASTPython(uastFilePath)
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
  try {
    buildUASTPython(rootDir, options)

    const uastJsonFiles = FileUtil.loadAllFileTextGlobby(['**/*.(json)'], uastFilePath)

    for (const uastFile of uastJsonFiles) {
      const data = uastFile.content

      if (data.startsWith('Syntax error in file') || data.startsWith('UnicodeDecodeError in file')) {
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

      const obj = JSON.parse(data)

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
