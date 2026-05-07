/* eslint-disable @typescript-eslint/no-require-imports */
const { Parser: PhpUastParser } = require('@ant-yasa/uast-parser-php')

let phpParser: InstanceType<typeof PhpUastParser> | null = null
let initPromise: Promise<void> | null = null

/**
 * 确保 PHP parser 已异步初始化（加载 tree-sitter WASM）
 * 多次调用安全，只初始化一次
 */
async function ensureInitialized(): Promise<void> {
  if (!phpParser) {
    phpParser = new PhpUastParser()
    initPromise = phpParser.init()
  }
  if (initPromise) {
    await initPromise
    initPromise = null
  }
}

/**
 * 解析单个 PHP 文件（同步接口）
 * 调用前必须已完成 ensureInitialized()
 * @param code - PHP 源代码
 * @param options - 解析选项（包含 sourcefile）
 * @returns UAST 节点
 */
function parseSingleFile(code: string, options?: Record<string, unknown>): unknown {
  if (!phpParser || initPromise) {
    throw new Error('PHP parser 未初始化，请先调用 ensureInitialized()')
  }
  return phpParser.parse(code, options || {})
}

/**
 * 项目解析接口（由 parser.ts 统一处理文件级解析）
 * @param _rootDir - 项目根目录（未使用）
 * @param _options - 解析选项（未使用）
 * @returns null，由 parser.ts 逐文件调用 parseSingleFile
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function parseProject(_rootDir: string, _options?: Record<string, unknown>): Promise<null> {
  return null
}

module.exports = {
  ensureInitialized,
  parseSingleFile,
  parseProject,
}
