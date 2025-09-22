const childProcess = require('child_process')
const path = require('path')
const fs = require('fs')
const FileUtil = require('../../../util/file-util')
const config = require('../../../config')
const { handleException } = require('../../analyzer/common/exception-handler')

let uastFilePath = './uast'

/**
 *
 * @param rootDir
 * @param options
 */
function buildUAST(rootDir, options) {
  options = options || {}
  if (options.language && options.language !== 'python') {
    handleException(
      new Error(`Python AST Builder received wrong language type: ${options.language}`),
      `Error: Python AST Builder received wrong language type: ${options.language}`,
      `Error: Python AST Builder received wrong language type: ${options.language}`
    )
    process.exit(1)
  }

  let isSingle = ''
  if (options.single) {
    isSingle = '--singleFileParse=True'
    uastFilePath += '.json'
  } else {
    isSingle = '--singleFileParse=False'
  }

  let uast4python_path = path.join(__dirname, '../../../../deps/uast4python/uast4python')

  if (options.uastSDKPath && options.uastSDKPath !== '') {
    uast4python_path = options.uastSDKPath
  } else {
    handleException(
      null,
      // eslint-disable-next-line sonarjs/no-duplicate-string
      'no uast4python sdk file set. please set --uastSDKPath',
      'no uast4python sdk file set. please set --uastSDKPath'
    )
    process.exit(1)
  }

  if (options.ASTFileOutput) {
    uastFilePath = options.ASTFileOutput
  }
  if (!fs.existsSync(uast4python_path)) {
    handleException(
      null,
      // eslint-disable-next-line sonarjs/no-duplicate-string
      'no uast4python sdk file set. please set --uastSDKPath',
      'no uast4python sdk file set. please set --uastSDKPath'
    )
    process.exit(1)
  }
  const command = `${uast4python_path} ${isSingle}` + ` --rootDir="${rootDir}"` + ` --output="${uastFilePath}"`

  try {
    const options_for_command = {
      maxBuffer: 5 * 1024 * 1024 * 1024, // 5GB
    }
    childProcess.execSync(command, options_for_command)
  } catch (e) {
    handleException(e, `[python-ast-builder] 解析python AST时发生错误`, `[python-ast-builder] 解析python AST时发生错误`)
    return null
  }
}

/**
 *
 * @param fpath
 */
function deleteUAST(fpath) {
  try {
    const stats = fs.statSync(fpath) // 获取文件/目录状态

    if (stats.isFile()) {
      // 如果是文件直接删除
      fs.unlinkSync(fpath)
    } else if (stats.isDirectory()) {
      // 使用现代API递归删除目录
      fs.rmSync(fpath, { recursive: true, force: true })
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      handleException(err, `[python-ast-builder] 路径不存在: ${fpath}`, `[python-ast-builder] 路径不存在: ${fpath}`)
    } else {
      handleException(err, `[python-ast-builder] 删除操作失败: ${fpath}`, `[python-ast-builder] 删除操作失败: ${fpath}`)
    }
  }
}

/**
 *
 * @param filename
 * @param options
 */
function parseSingleFile(filename, options) {
  options = options || {}
  options.single = true
  buildUAST(filename, options)
  const data = fs.readFileSync(uastFilePath, 'utf8')
  if (data.startsWith('Syntax error in file') || data.startsWith('UnicodeDecodeError in file')) {
    handleException(
      null,
      `[python-ast-builder] parseSingleFile failed: ${filename}`,
      `[python-ast-builder] parseSingleFile failed: ${filename}`
    )
    if (fs.existsSync(uastFilePath)) {
      deleteUAST(uastFilePath)
    }
    return
  }
  const obj = JSON.parse(data)
  if (!options.dumpAST) {
    if (fs.existsSync(uastFilePath)) {
      deleteUAST(uastFilePath)
    }
  }
  return obj
}

/**
 *
 * @param astManager
 * @param rootDir
 * @param options
 */
function parsePackages(astManager, rootDir, options) {
  if (fs.existsSync(uastFilePath)) {
    deleteUAST(uastFilePath)
  }
  options = options || {}
  options.single = false
  try {
    buildUAST(rootDir, options)
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
          deleteUAST(uastFile.file)
        }
        continue
      }
      const obj = JSON.parse(data)
      const filename = config.maindir + uastFile.file.replace('uast/', '').replace('.json', '.py')
      astManager[filename] = obj
    }
  } catch (e) {
    handleException(
      e,
      `[python-ast-builder] parsePackage error: ${rootDir}`,
      `[python-ast-builder] parsePackage error: ${rootDir}`
    )
    if (fs.existsSync(uastFilePath)) {
      deleteUAST(uastFilePath)
    }
  }

  if (!options.dumpAST) {
    if (fs.existsSync(uastFilePath)) {
      deleteUAST(uastFilePath)
    }
  }
}

module.exports = {
  parseSingleFile,
  parsePackages,
}
