const { LanguageType } = require('@ant-yasa/uast-parser-java-js')
const childProcess = require('child_process')
const path = require('path')
const fs = require('fs')
const JSONStream = require('JSONStream')
const { handleException } = require('../../analyzer/common/exception-handler')

let uastFilePath = './uast.json'

/**
 *
 * @param rootDir
 * @param options
 */
function buildUAST(rootDir, options) {
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
  let uast4go_path = path.join(__dirname, '../../../../deps/uast4go/uast4go')

  if (options.uastSDKPath && options.uastSDKPath !== '') {
    uast4go_path = options.uastSDKPath
  } else {
    handleException(
      null,
      // eslint-disable-next-line sonarjs/no-duplicate-string
      'no uast4go sdk file set. please set --uastSDKPath',
      'no uast4go sdk file set. please set --uastSDKPath'
    )
    process.exit(1)
  }

  if (options.ASTFileOutput) {
    uastFilePath = options.ASTFileOutput
  }
  if (!fs.existsSync(uast4go_path)) {
    handleException(
      null,
      'no uast4go sdk file set. please set --uastSDKPath',
      'no uast4go sdk file set. please set --uastSDKPath'
    )
    process.exit(1)
  }
  const command = `${uast4go_path} ${isSingle}` + ` -rootDir=${rootDir}` + ` -output=${uastFilePath}`

  try {
    const options_for_command = {
      maxBuffer: 5 * 1024 * 1024 * 1024, // 5GB
    }
    childProcess.execSync(command, options_for_command)
  } catch (e) {
    handleException(e, 'Error occurred in go-ast-builder.buildUAST', 'Error occurred in go-ast-builder.buildUAST')
    return null
  }
}

/**
 *
 * @param rootDir
 * @param options
 */
async function parsePackage(rootDir, options) {
  if (fs.existsSync(uastFilePath)) {
    deleteUAST()
  }
  try {
    return parseSinglePackage(rootDir, options)
  } catch (e) {
    try {
      return await parseLargePackage(rootDir, options)
    } catch (e1) {
      handleException(e1, `[go-ast-builder] 解析Go AST时发生错误`, `[go-ast-builder] 解析Go AST时发生错误`)
      if (fs.existsSync(uastFilePath)) {
        deleteUAST()
      }
      return null
    }
  }
}

/**
 *
 * @param rootDir
 * @param options
 */
async function parseLargePackage(rootDir, options) {
  buildUAST(rootDir, options)
  const data = await parseLargeJsonFile(uastFilePath)
  if (!options.dumpAST) {
    addParent(data)
    if (fs.existsSync(uastFilePath)) {
      deleteUAST()
    }
  }
  return { packageInfo: data[0], moduleName: data[1] }
}

/**
 *
 * @param rootDir
 * @param options
 */
function parseSinglePackage(rootDir, options) {
  buildUAST(rootDir, options)
  const data = fs.readFileSync(uastFilePath, 'utf8')
  const obj = JSON.parse(data)
  if (!options.dumpAST) {
    addParent(obj)
    if (fs.existsSync(uastFilePath)) {
      deleteUAST()
    }
  }
  return obj
}

/**
 *
 */
function deleteUAST() {
  const stats = fs.statSync(uastFilePath) // 获取文件/目录状态
  if (stats.isFile()) {
    fs.unlink(uastFilePath, (err) => {
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
function parseLargeJsonFile(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const parser = JSONStream.parse('*') // '*' 表示解析所有对象

    const results = []

    parser.on('data', (data) => {
      results.push(data) // 将每个解析出来的对象添加到结果数组中
    })

    parser.on('end', () => {
      resolve(results) // 当所有数据解析完毕后，解析结果
    })

    parser.on('error', (err) => {
      reject(err) // 如果发生错误，拒绝Promise
    })

    stream.pipe(parser)
  })
}

/**
 *
 * @param obj
 * @param parent
 */
function addParent(obj, parent) {
  if (!obj) return
  if (Array.isArray(obj)) {
    obj.forEach((o) => {
      addParent(o, parent)
    })
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) return
  for (const key in obj) {
    if (key === 'parent') continue
    if (obj.hasOwnProperty(key)) {
      const subObj = obj[key]
      if (subObj?.type) {
        subObj.parent = obj
        addParent(subObj, subObj)
      } else {
        addParent(subObj, obj)
      }
    }
  }
}

/**
 *
 * @param rootDir
 * @param options
 */
function parseSingleFile(rootDir, options) {
  options = options || {}
  options.single = true
  return parseSinglePackage(rootDir, options)
}

module.exports = {
  parsePackage,
  parseSingleFile,
}
