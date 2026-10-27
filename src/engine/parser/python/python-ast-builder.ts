/* eslint-disable @typescript-eslint/no-require-imports */
const { Parser: PythonUastParser } = require('@ant-yasa/uast-parser-python')

const pythonParser = new PythonUastParser()
let initialized = false
let initialization: Promise<void> | null = null

/** Load Python's tree-sitter WASM once in each Engine process. */
function ensureInitialized(): Promise<void> {
  if (initialized) return Promise.resolve()
  if (!initialization) {
    initialization = pythonParser.init().then(
      () => { initialized = true },
      (error: unknown) => { initialization = null; throw error }
    )
  }
  return initialization!
}

function parseSingleFile(code: string, options: Record<string, any> = {}): unknown {
  if (options.language && options.language !== 'python') {
    throw new Error('Python AST Builder received wrong language type: ' + options.language)
  }
  if (!initialized) throw new Error('Python parser not initialized. Call ensureInitialized() first.')
  return pythonParser.parse(code, options)
}

/** parser.ts owns file discovery, caching and AST postprocessing, as for PHP. */
async function parseProject(): Promise<null> {
  await ensureInitialized()
  return null
}

module.exports = { ensureInitialized, parseSingleFile, parseProject }
