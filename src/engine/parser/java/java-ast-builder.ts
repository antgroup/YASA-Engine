/* eslint-disable @typescript-eslint/no-require-imports */
const { Parser: UastParser, LanguageType } = require('@ant-yasa/uast-parser-java-js')
const { handleException } = require('../../analyzer/common/exception-handler')

interface ParseOptions {
  language?: string
  [key: string]: any
}

const uastParser = new UastParser()

/**
 * 解析 Java 代码
 * @param code - 源代码内容
 * @param options - 解析选项
 * @returns {any} 解析后的 AST
 */
function parseJava(code: string, options?: ParseOptions) {
  options = options || {}
  if (options.language && options.language !== LanguageType.LANG_JAVA && options.language !== 'java') {
    handleException(
      new Error(`Java AST Builder received wrong language type: ${options.language}`),
      `Error: Java AST Builder received wrong language type: ${options.language}`,
      `Error: Java AST Builder received wrong language type: ${options.language}`
    )
    process.exit(1)
  }
  options.language = LanguageType.LANG_JAVA
  return uastParser.parse(code, options)
}

/**
 * 解析单个文件（统一接口）
 * @param code - 源代码内容
 * @param options - 解析选项
 * @returns {any} 解析后的 AST（未处理后处理）
 */
function parseSingleFile(code: string, options?: ParseOptions): any {
  return parseJava(code, options)
}

/**
 * 解析项目（统一接口）
 * Java 是单文件语言，项目解析由 parser.ts 统一处理
 * @param _rootDir - 项目根目录（未使用）
 * @param _options - 解析选项（未使用）
 * @returns {Promise<any>} 解析结果（空对象，表示没有解析结果）
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function parseProject(_rootDir: string, _options?: ParseOptions): Promise<any> {
  // 返回空对象而不是 null，确保调用者可以安全地迭代
  return {}
}

module.exports = {
  parseSingleFile,
  parseProject,
}
