const fs = require('fs-extra')
const pathMod = require('path')
const stat = require('../../util/statistics')
const AstUtil = require('../../util/ast-util')
const SourceLine = require('../analyzer/common/source-line')
const { Errors } = require('../../util/error-code')
const gomodParser = require('./golang/go-ast-builder')
const pythonParser = require('./python/python-ast-builder')
const FileUtil = require('../../util/file-util')
const HashUtil = require('../../util/hash-util')
const { handleException } = require('../analyzer/common/exception-handler')
const { addNodeHash, deleteParent } = require('../../util/ast-util')

/**
 * * Parse the javascript source code (a string) using babel
 * @param code
 * @param options
 */
function parseJavaScript(code, options) {
  const JSAstBuilder = require('./javascript/js-ast-builder')
  const parsingStart = new Date().getTime()
  const ast = JSAstBuilder.parse(code, { sanity: options.sanity, sourcefile: options.sourcefile })
  if (!ast) {
    stat.parsingTime += new Date().getTime() - parsingStart
    Errors.ParseError(`no ast generated from code`)
  }

  const fname = SourceLine.storeCode(options && options.sourcefile, code)
  AstUtil.annotateAST(ast, options ? { sourcefile: fname } : null)
  ast.loc.sourcefile = fname
  addNodeHash(ast)
  stat.parsingTime += new Date().getTime() - parsingStart
  return ast
}

/**
 *
 * @param code
 * @param options
 */
function parseJavaScriptRaw(code, options) {
  const JSAstBuilder = require('./javascript/js-ast-builder')
  const parsingStart = new Date().getTime()
  const ast = JSAstBuilder.parse(code, { sanity: options.sanity, sourcefile: options.sourcefile })
  if (!ast) {
    stat.parsingTime += new Date().getTime() - parsingStart
    Errors.ParseError(`no ast generated from code`)
  }
  AstUtil.annotateAST(ast, options ? { sourcefile: options && options.sourcefile } : null)
  ast.loc.sourcefile = SourceLine.storeCode(options && options.sourcefile, code)
  addNodeHash(ast)
  deleteParent(ast)
  stat.parsingTime += new Date().getTime() - parsingStart

  return ast
}

/**
 * * Parse the javascript source code (a string)
 * @param code
 * @param options
 */
function parseJava(code, options) {
  const JavaAstBuilder = require('./java/java-ast-builder')
  const parsingStart = new Date().getTime()
  const ast = JavaAstBuilder.parse(code, {
    sanity: options.sanity,
    sourcefile: options.sourcefile,
    language: 'java',
  })
  if (!ast) {
    stat.parsingTime += new Date().getTime() - parsingStart
    Errors.ParseError(`no ast generated from code`)
  }

  const fname = SourceLine.storeCode(options && options.sourcefile, code)
  AstUtil.annotateAST(ast, options ? { sourcefile: fname } : null)
  ast.loc.sourcefile = fname
  addNodeHash(ast)
  stat.parsingTime += new Date().getTime() - parsingStart
  return ast
}

/**
 * * Parse the javascript source code (a string), only add loc
 * @param code
 * @param options
 */
function parseJavaRaw(code, options) {
  const JavaAstBuilder = require('./java/java-ast-builder')
  const parsingStart = new Date().getTime()
  const ast = JavaAstBuilder.parse(code, {
    sanity: options.sanity,
    sourcefile: options.sourcefile,
    language: 'java',
  })
  if (!ast) {
    stat.parsingTime += new Date().getTime() - parsingStart
    Errors.ParseError(`no ast generated from code`)
  }
  AstUtil.annotateAST(ast, options ? { sourcefile: options && options.sourcefile } : null)
  ast.loc.sourcefile = SourceLine.storeCode(options && options.sourcefile, code)
  addNodeHash(ast)
  deleteParent(ast)
  stat.parsingTime += new Date().getTime() - parsingStart
  return ast
}

/**
 * Parse the source code according to the source language
 * @param code
 * @param options
 * @returns {*}
 */
function parseCode(code, options) {
  try {
    if (options) {
      switch (options.language) {
        case 'js':
        case 'javascript':
          return parseJavaScript(code, options)
        case 'java':
          return parseJava(code, options)
        case 'python':
          return pythonParser.parseSingleFile(code, options)
        default:
      }
    }
    return parseJavaScript(code, options)
  } catch (e) {
    const err_location_tip = options && options.sourcefile ? options.sourcefile : `code snippet: ${code.substr(0, 70)}`
    Errors.ParseError(`[${err_location_tip}] parse failed, err: ${e.toString()}`)
  }
}

/**
 *
 * @param filepath
 * @param code
 * @param options
 */
function parseCodeRaw(filepath, code, options) {
  try {
    if (options) {
      switch (options.language) {
        case 'js':
        case 'javascript':
          return parseJavaScriptRaw(code, options)
        case 'golang':
          if (filepath.endsWith('.go')) {
            options.single = true
          }
          return gomodParser.parsePackage(filepath, options)
        case 'java':
          return parseJavaRaw(code, options)
        case 'python':
          return pythonParser.parseSingleFile(filepath, options)
        default:
      }
    }
    return parseJavaScriptRaw(code, options)
  } catch (e) {
    const err_location_tip = options && options.sourcefile ? options.sourcefile : `code snippet: ${code.substr(0, 70)}`
    Errors.ParseError(`[${err_location_tip}] parseRaw failed, err: ${e.toString()}`)
  }
}

/**
 *
 * @param dir
 * @param options
 */
async function parseDirectory(dir, options) {
  try {
    if (options) {
      if (!options.reportDir) {
        options.reportDir = './uastParseDir'
      }
      const stats = fs.statSync(options.reportDir) // 获取文件/目录状态

      if (stats.isFile()) {
        // 如果是文件直接删除
        fs.unlinkSync(options.reportDir)
      } else if (stats.isDirectory()) {
        // 使用现代API递归删除目录
        fs.rmSync(options.reportDir, { recursive: true, force: true })
      }
      if (!fs.existsSync(options.reportDir)) {
        fs.mkdirSync(options.reportDir, { recursive: true })
      }
      if (!options.language) {
        handleException(
          'please set target language. YASA support language: js, java, golang, python',
          'please set target language. YASA support language: js, java, golang, python',
          null
        )
        process.exit(1)
      }
      switch (options.language) {
        case 'js':
        case 'javascript': {
          const modules = FileUtil.loadAllFileTextGlobby(
            [
              '**/*.(js|ts|mjs|cjs)',
              '!**/*.test.(js|ts|mjs|cjs|jsx)',
              '!**/node_modules',
              '!web',
              '!**/public/**',
              '!**/*.d.ts',
              '!**/*.d.js',
            ],
            dir
          )
          if (modules.length === 0) {
            Errors.NoCompileUnitError('no javascript file found in source path')
            process.exit(1)
          }
          for (const mod of modules) {
            options.sourcefile = mod.file
            const ast = parseCodeRaw(mod.file, mod.content, options)
            const parseResult = JSON.stringify(ast)
            if (!options.reportDir) {
              options.reportDir = './uastParseDir'
            }
            const fileName = `${HashUtil.md5(mod.file)}.json`

            fs.writeFileSync(`${options.reportDir}/${fileName}`, parseResult)
          }
          break
        }
        case 'golang': {
          const goUast = await gomodParser.parsePackage(dir, options)
          processGoUast(goUast, options)
          const uastFile = fs.statSync('./uast.json') // 获取文件/目录状态
          if (uastFile.isFile()) {
            fs.unlink('./uast.json', (err) => {
              if (err) {
                handleException(
                  err,
                  `[go-ast-builder] 删除uast.json文件时发生错误`,
                  `[go-ast-builder] 删除uast.json文件时发生错误`
                )
              }
            })
          }
          break
        }
        case 'java': {
          const packageFiles = FileUtil.loadAllFileTextGlobby(['**/*.java', '!target/**', '!src/test/**'], dir)
          if (packageFiles.length === 0) {
            Errors.NoCompileUnitError('no java file found in source path')
            process.exit(1)
          }
          for (const packageFile of packageFiles) {
            options.sourcefile = packageFile.file
            const ast = parseJavaRaw(packageFile.content, options)
            const parseResult = JSON.stringify(ast)
            const fileName = `${HashUtil.md5(packageFile.file)}.json`
            fs.writeFileSync(`${options.reportDir}/${fileName}`, parseResult)
          }
          break
        }
        case 'python': {
          const pythonUast = {}
          pythonParser.parsePackages(pythonUast, dir, options)
          processPythonUast(pythonUast, options)
          break
        }
        default:
      }
    }
  } catch (e) {
    Errors.ParseError(`[${dir}] parseDirectory failed, err: ${e.toString()}`)
  }
}

/**
 * 处理goUast对象，深度搜索符合条件的节点并序列化到文件中
 * @param {Object} goUast - golang解析后的UAST对象
 * @param options
 */
function processGoUast(goUast, options) {
  if (!goUast || typeof goUast !== 'object') {
    return
  }

  /**
   * 深度优先搜索对象
   * @param obj
   * @param parentPath
   */
  function deepSearch(obj, parentPath = '') {
    if (!obj || typeof obj !== 'object') {
      return
    }

    // 处理数组
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        deepSearch(item, `${parentPath}[${index}]`)
      })
      return
    }

    // 处理对象的每个键值对
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = parentPath ? `${parentPath}.${key}` : key

      // 检查key是否以.go结尾
      if (typeof key === 'string' && key.endsWith('.go') && value && typeof value === 'object') {
        // 在value中查找包含'node'且node.type为'CompileUnit'的节点
        if (value.node && typeof value.node === 'object' && value.node.type === 'CompileUnit') {
          // 创建没有parent的node副本
          const nodeWithoutParent = removeParentProperty(JSON.parse(JSON.stringify(value.node)))

          // 生成输出文件路径
          const fileName = HashUtil.md5(key)
          const outputPath = `${options.reportDir}/${fileName}.json`

          try {
            // JSON序列化并写入文件
            fs.writeFileSync(outputPath, JSON.stringify(nodeWithoutParent))
          } catch (error) {
            handleException(error, `写入文件失败: ${outputPath}`, `写入文件失败: ${outputPath}, 错误: ${error.message}`)
          }
        }
        break
      }

      // 递归搜索子对象
      deepSearch(value, currentPath)
    }
  }

  /**
   * 移除所有parent属性的辅助函数
   * @param obj
   */
  function removeParentProperty(obj) {
    if (!obj || typeof obj !== 'object') {
      return obj
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => removeParentProperty(item))
    }

    const result = {}
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'parent') {
        result[key] = removeParentProperty(value)
      }
    }

    return result
  }

  // 开始深度搜索
  deepSearch(goUast)
}

/**
 * 处理pythonUast对象，将其内容输出到文件中
 * @param {Object} pythonUast - python解析后的UAST对象
 * @param {Object} options - 处理选项
 */
function processPythonUast(pythonUast, options) {
  if (!pythonUast || typeof pythonUast !== 'object') {
    return
  }

  // 设置输出目录
  const outputDir = options.reportDir

  // 确保输出目录存在
  try {
    fs.ensureDirSync(outputDir)
  } catch (error) {
    handleException(error, `创建目录失败: ${outputDir}`, `创建目录失败: ${outputDir}, 错误: ${error.message}`)
    return
  }

  /**
   * 遍历pythonUast对象的所有key，将每个key的value写入对应的JSON文件
   * @param {Object} obj - 要处理的对象
   * @param {string} basePath - 基础路径
   */
  function traverseAndWrite(obj, basePath = '') {
    if (!obj || typeof obj !== 'object') {
      return
    }

    for (const [key, value] of Object.entries(obj)) {
      const fileName = HashUtil.md5(key)
      const filePath = `${outputDir}/${fileName}.json`

      try {
        // 写入JSON文件
        fs.writeFileSync(filePath, JSON.stringify(value))
      } catch (error) {
        handleException(
          error,
          `写入Python UAST文件失败: ${filePath}`,
          `写入文件失败: ${filePath}, 错误: ${error.message}`
        )
      }
    }
  }

  // 开始处理
  traverseAndWrite(pythonUast)
}

// ***

module.exports = {
  parseCode,
  parseCodeRaw,
  parseDirectory,
}
