/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable @typescript-eslint/no-use-before-define */
const { LanguageType } = require('@ant-yasa/uast-parser-java-js')
const ChildProcess = require('child_process')
const path = require('path')
const fs = require('fs')
const JSONStream = require('JSONStream')
const { handleException } = require('../../analyzer/common/exception-handler')
const { resolveUastBinaryPath } = require('../../../util/file-util')

let uastFilePath = './uast.json'

/**
 * 构建 Go UAST
 * @param rootDir - 根目录
 * @param options - 构建选项
 * @returns {any} 构建结果
 */
function buildUASTGo(rootDir: any, options: Record<string, any>) {
  options = options || {}
  if (options.language && options.language !== LanguageType.LANG_GO && options.language !== 'golang') {
    handleException(
      new Error(`Go AST Builder received wrong language type: ${options.language}`),
      `Error: Go AST Builder received wrong language type: ${options.language}`,
      `Error: Go AST Builder received wrong language type: ${options.language}`
    )
    process.exit(1)
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
    handleException(
      null,
      `uast4go not found. Please set --uastSDKPath to the binary or deps directory, or install it under deps/uast4go/uast4go`,
      `uast4go not found. Please set --uastSDKPath to the binary or deps directory, or install it under deps/uast4go/uast4go`
    )
    process.exit(1)
  }

  if (options.ASTFileOutput) {
    uastFilePath = options.ASTFileOutput
  }

  const command = `${uast4go_path} ${isSingle} -rootDir=${rootDir} -output=${uastFilePath}`

  try {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const options_for_command = {
      maxBuffer: 5 * 1024 * 1024 * 1024, // 5GB
    }
    ChildProcess.execSync(command, options_for_command)
  } catch (e) {
    // eslint-disable-next-line prettier/prettier
    handleException(e, 'Error occurred in go-ast-builder.buildUAST', 'Error occurred in go-ast-builder.buildUAST')
    return null
  }
}

/**
 * 解析 Go 包（内部使用）
 * @param rootDir - 根目录
 * @param options - 解析选项
 * @returns {Promise<any>} 解析结果
 */
async function parsePackage(rootDir: any, options: Record<string, any>) {
  if (fs.existsSync(uastFilePath)) {
    deleteUAST()
  }
  try {
    return parseSinglePackage(rootDir, options)
  } catch (e) {
    try {
      return await parseLargePackage(rootDir, options)
    } catch (e1) {
      // eslint-disable-next-line prettier/prettier
      handleException(e1, `[go-ast-builder] 解析Go AST时发生错误`, `[go-ast-builder] 解析Go AST时发生错误`)
      if (fs.existsSync(uastFilePath)) {
        deleteUAST()
      }
      return null
    }
  }
}

/**
 * 解析大型 Go 包
 * @param rootDir - 根目录
 * @param options - 解析选项
 * @returns {Promise<any>} 解析结果
 */
async function parseLargePackage(rootDir: any, options: Record<string, any>) {
  buildUASTGo(rootDir, options)
  const data = (await parseLargeJsonFile(uastFilePath)) as any[]
  if (options.dumpAST || options.dumpAllAST) {
    const { deleteParent } = require('../../../util/ast-util')
    deleteParent(data)
  } else if (fs.existsSync(uastFilePath)) {
    deleteUAST()
  }
  return { packageInfo: data[0], moduleName: data[1] }
}

/**
 * 解析单个 Go 包
 * @param rootDir - 根目录
 * @param options - 解析选项
 * @returns {any} 解析结果
 */
function parseSinglePackage(rootDir: any, options: Record<string, any>) {
  buildUASTGo(rootDir, options)
  const data = fs.readFileSync(uastFilePath, 'utf8')
  const obj = JSON.parse(data)
  if (options.dumpAST || options.dumpAllAST) {
    const { deleteParent } = require('../../../util/ast-util')
    deleteParent(obj)
  } else if (fs.existsSync(uastFilePath)) {
    deleteUAST()
  }
  return obj
}

/**
 * 删除 UAST 文件
 */
function deleteUAST() {
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
function parseSingleFile(filepath: string, options?: Record<string, any>): any {
  const opts = { ...options, single: true }
  const result = parseSinglePackage(filepath, opts)
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
async function parseProject(rootDir: string, options?: Record<string, any>): Promise<any> {
  return parsePackage(rootDir, options || {})
}

module.exports = {
  parseSingleFile,
  parseProject,
}
