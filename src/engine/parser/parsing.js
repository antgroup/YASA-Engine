const stat = require('../../util/statistics')
const AstUtil = require('../../util/ast-util')
const SourceLine = require('../analyzer/common/source-line')
const { Errors } = require('../../util/error-code')
const gomodParser = require('./golang/go-ast-builder')
const pythonParser = require('./python/python-ast-builder')

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
  ast.sourcefile = fname
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
  ast.sourcefile = SourceLine.storeCode(options && options.sourcefile, code)
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

// ***

module.exports = {
  parseCode,
  parseCodeRaw,
}
