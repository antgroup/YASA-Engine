const ChildProcess = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const FileUtil = require('../../../util/file-util')
const { handleException } = require('../../analyzer/common/exception-handler')
const { addNodeHash, deleteParent } = require('../../../util/ast-util')
const AstUtil = require('../../../util/ast-util')

interface BuildOptions {
  language?: string
  single?: boolean
  uastSDKPath?: string
  ASTFileOutput?: string
  [key: string]: any
}

let uastFilePath = './uast'

/**
 *
 * @param rootDir
 * @param options
 */
function buildUASTPython(rootDir: string, options?: BuildOptions): any {
  options = options || {}
  if (options.language && options.language !== 'python') {
    handleException(
      new Error(
        `Python AST Builder received wrong language type: ${options.language}`,
      ),
      `Error: Python AST Builder received wrong language type: ${options.language}`,
      `Error: Python AST Builder received wrong language type: ${options.language}`,
    )
    process.exit(1)
  }

  let isSingle = ''
  if (options.single) {
    isSingle = '--singleFileParse'
    uastFilePath += '.json'
  } else {
    isSingle = ''
  }

  // prefer user-provided SDK path if present
  let uast4pyPath = ''
  if (options.uastSDKPath && options.uastSDKPath !== '') {
    uast4pyPath = options.uastSDKPath
  } else {
    // fallback to default deps location
    uast4pyPath = path.join(__dirname, '../../../../deps/uast4py/uast4py')
  }
  // if uast4pyPath does not exist, exit with error
  if (!fs.existsSync(uast4pyPath)) {
    handleException(
      null,
      // eslint-disable-next-line sonarjs/no-duplicate-string
      'no uast4py sdk file set. please set --uastSDKPath',
      'no uast4py sdk file set. please set --uastSDKPath',
    )
    process.exit(0)
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
    handleException(
      e,
      `[python-ast-builder] 解析python AST时发生错误`,
      `[python-ast-builder] 解析python AST时发生错误`,
    )
    return null
  }
}

/**
 *
 * @param fpath
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
      handleException(
        err,
        `[python-ast-builder] 路径不存在: ${fpath}`,
        `[python-ast-builder] 路径不存在: ${fpath}`,
      )
    } else {
      handleException(
        err,
        `[python-ast-builder] 删除操作失败: ${fpath}`,
        `[python-ast-builder] 删除操作失败: ${fpath}`,
      )
    }
  }
}

/**
 *
 * @param filename
 * @param options
 */
function parseSingleFilePython(filename: string, options?: BuildOptions): any {
  options = options || {}
  options.single = true
  buildUASTPython(filename, options)
  const data = fs.readFileSync(uastFilePath, 'utf8')
  if (
    data.startsWith('Syntax error in file') ||
    data.startsWith('UnicodeDecodeError in file')
  ) {
    handleException(
      null,
      `[python-ast-builder] parseSingleFile failed: ${filename}`,
      `[python-ast-builder] parseSingleFile failed: ${filename}`,
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
  AstUtil.annotateAST(obj, { sourcefile: filename })
  addNodeHash(obj)
  deleteParent(obj)
  return obj
}

/**
 *
 * @param astManager
 * @param rootDir
 * @param options
 */
function parsePackages(
  astManager: any,
  rootDir: string,
  options?: BuildOptions,
): void {
  if (fs.existsSync(uastFilePath)) {
    deleteUASTPython(uastFilePath)
  }
  options = options || {}
  options.single = false
  try {
    buildUASTPython(rootDir, options)

    const uastJsonFiles = FileUtil.loadAllFileTextGlobby(
      ['**/*.(json)'],
      uastFilePath,
    )

    for (const uastFile of uastJsonFiles) {
      const data = uastFile.content

      if (
        data.startsWith('Syntax error in file') ||
        data.startsWith('UnicodeDecodeError in file')
      ) {
        handleException(
          null,
          `[python-ast-builder] parsePackage error: get python ast failed. ${rootDir}`,
          `[python-ast-builder] parsePackage error: get python ast failed. ${rootDir}`,
        )
        if (fs.existsSync(uastFile.file)) {
          deleteUASTPython(uastFile.file)
        }
        continue
      }

      const obj = JSON.parse(data)

      AstUtil.annotateAST(obj, { sourcefile: obj.loc?.sourcefile })

      addNodeHash(obj)

      deleteParent(obj)

      const filename = obj?.loc?.sourcefile
      if (filename) {
        astManager[filename] = obj
      }
    }
  } catch (e) {
    handleException(
      e,
      `[python-ast-builder] parsePackage error: ${rootDir}`,
      `[python-ast-builder] parsePackage error: ${rootDir}`,
    )
    if (fs.existsSync(uastFilePath)) {
      deleteUASTPython(uastFilePath)
    }
  }

  if (!options.dumpAST) {
    if (fs.existsSync(uastFilePath)) {
      deleteUASTPython(uastFilePath)
    }
  }
}

module.exports = {
  parseSingleFile: parseSingleFilePython,
  parsePackages,
}
