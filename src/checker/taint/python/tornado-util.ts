const path = require('path')
const AstUtil = require('../../../util/ast-util')

export interface ImportSymbol {
  file: string
  originalName?: string
}

export interface RoutePair {
  path: string
  handlerName: string
  file?: string
}

export interface FileCache {
  vars: Map<string, any>
  classes: Map<string, any>
  importedSymbols: Map<string, ImportSymbol>
}

export interface ParamMeta {
  name: string
  locStart: number | 'all'
  locEnd: number | 'all'
}

export const tornadoSourceAPIs = new Set<string>([
  'get_argument',
  'get_query_argument',
  'get_body_argument',
  'get_query_arguments',
  'get_body_arguments',
  'get_cookie',
  'get_secure_cookie',
  'get_arguments',
  'get_json_body',
])

export const passthroughFuncs = new Set<string>(['decode', 'strip', 'replace', 'lower', 'upper', 'split'])

/**
 *
 * @param node
 */
export function isRequestAttributeAccess(node: any): boolean {
  if (node?.type !== 'MemberAccess') return false
  const propName = node.property?.name
  const inner = node.object
  if (inner?.type !== 'MemberAccess') return false
  const baseName = inner.object?.name
  const requestName = inner.property?.name
  return (
    baseName === 'self' &&
    requestName === 'request' &&
    ['body', 'query', 'headers', 'cookies', 'files', 'uri', 'path', 'arguments', 'query_arguments', 'body_arguments'].includes(propName)
  )
}

/**
 *
 * @param expr
 */
export function isRequestAttributeExpression(expr: any): boolean {
  if (!expr) return false
  if (expr.type === 'MemberAccess') return isRequestAttributeAccess(expr)
  if (expr.type === 'CallExpression' && expr.callee?.type === 'MemberAccess') {
    return isRequestAttributeAccess(expr.callee.object)
  }
  return false
}

/**
 * 用来判断是否是Tornado的请求函数,例如
 * @param node
 * @param targetName
 */
export function isTornadoCall(node: any, targetName: string): boolean {
  if (!node || node.type !== 'CallExpression' || !node.callee) return false
  const { callee } = node
  if (callee.type === 'MemberAccess' && callee.property?.name === targetName) {
    return true
  }
  if (callee.type === 'Identifier' && callee.name === targetName) {
    return true
  }
  // Handle pattern: tornado.web.Application.__init__(self, handlers, ...)
  // In this case, we need to check if 'Application' is in the member access chain
  // and the final property is '__init__'
  if (callee.type === 'MemberAccess' && callee.property?.name === '__init__') {
    // Check if any part of the member access chain matches the targetName
    let current = callee.object
    while (current) {
      if (current.type === 'Identifier' && current.name === targetName) {
        return true
      }
      if (current.type === 'MemberAccess' && current.property?.name === targetName) {
        return true
      }
      current = current.type === 'MemberAccess' ? current.object : null
    }
  }
  return false
}

/**
 *
 * @param route
 */
export function parseRoutePair(route: any): RoutePair | null {
  if (!route) return null

  const extractLiteral = (expr: any): string | null => {
    if (!expr) return null
    if (expr.type === 'StringLiteral' || expr.type === 'Literal') {
      return typeof expr.value === 'string' ? expr.value : null
    }
    return null
  }

  let pathExpr: any
  let handlerNode: any

  if (route.type === 'TupleExpression' && Array.isArray(route.elements)) {
    const [first, second] = route.elements
    pathExpr = first
    handlerNode = second
  } else if (route.type === 'CallExpression' && route.callee) {
    const { callee } = route

    /**
     * Check if callee is a URL helper function using AST node matching
     * Supports:
     * - url(...) - simple identifier
     * - something.url(...) - member access
     * - tornado.web.url(...) - nested member access chain
     * This avoids unreliable string-based matching via prettyPrint
     */
    const isIdentifierUrlHelper = callee.type === 'Identifier' && callee.name === 'url'

    const isMemberAccessUrlHelper =
      callee.type === 'MemberAccess' &&
      // Check if the final property/member is 'url'
      // Supports both 'property' and 'member' fields for different AST representations
      ((callee.property && callee.property.type === 'Identifier' && callee.property.name === 'url') ||
        (callee.member && callee.member.type === 'Identifier' && callee.member.name === 'url'))

    const isUrlHelper = isIdentifierUrlHelper || isMemberAccessUrlHelper

    if (isUrlHelper && Array.isArray(route.arguments)) {
      const [first, second] = route.arguments
      pathExpr = first
      handlerNode = second
    }
  }
  if (!pathExpr || !handlerNode || handlerNode.type !== 'Identifier') {
    return null
  }
  const pathValue = extractLiteral(pathExpr)
  if (!pathValue) return null

  return { path: pathValue, handlerName: handlerNode.name }
}

/**
 * Resolve Python import path to file path
 * @param modulePath - The import path (e.g., "handlers.user_handler" or ".handlers.user_handler")
 * @param currentFile - The current file path
 * @param mainDir - Optional project root directory for absolute imports
 * @returns Resolved file path or null
 */
export function resolveImportPath(modulePath: string, currentFile: string, mainDir?: string): string | null {
  if (!modulePath) return null

  const currentDir = path.dirname(currentFile)
  const leadingDots = modulePath.match(/^\.+/)?.[0] ?? ''
  let baseDir: string

  if (leadingDots.length > 0) {
    // Relative import: resolve from current file's directory
    baseDir = path.resolve(currentDir, '../'.repeat(leadingDots.length - 1))
  } else if (mainDir) {
    // Absolute import: resolve from project root (mainDir)
    baseDir = mainDir
  } else {
    // Fallback for absolute imports when mainDir is not provided.
    // This is the original behavior and is likely incorrect.
    baseDir = currentDir
  }

  const remainder = modulePath.slice(leadingDots.length)
  const normalized = remainder ? remainder.split('.').join(path.sep) : ''
  const resolved = normalized ? path.resolve(baseDir, normalized) : baseDir

  // Check if it's a package (directory with __init__.py)
  const fs = require('fs')
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, '__init__.py')
  }

  // Regular module file
  return `${resolved}.py`
}

/**
 *
 * @param stmt
 */
export function extractImportEntries(stmt: any): Array<{ local: string; imported?: string }> {
  const res: Array<{ local: string; imported?: string }> = []
  const { init } = stmt
  if (!init) return res

  if (Array.isArray(init?.imports) && init.imports.length > 0) {
    for (const spec of init.imports) {
      const local = spec.local?.name || spec.local?.value || spec.name || spec.value
      const imported = spec.imported?.name || spec.imported?.value || spec.name || spec.value
      if (local) res.push({ local, imported })
    }
    return res
  }

  if (stmt.id?.name) {
    const importedName = init?.imported?.name || init?.imported?.value || init?.name?.name || init?.name?.value
    res.push({ local: stmt.id.name, imported: importedName })
  }
  return res
}

/**
 *
 * @param funcNode
 */
export function extractParamsFromAst(funcNode: any): ParamMeta[] {
  if (!funcNode) return []
  const rawParams = Array.isArray(funcNode?.parameters?.parameters)
    ? funcNode.parameters.parameters
    : Array.isArray(funcNode?.parameters)
      ? funcNode.parameters
      : []
  const fallbackLine = typeof funcNode?.loc?.start?.line === 'number' ? funcNode.loc.start.line : 'all'
  const result: ParamMeta[] = []
  for (const param of rawParams) {
    const name = param?.id?.name || param?.name
    if (!name) continue
    const locStart = typeof param?.loc?.start?.line === 'number' ? param.loc.start.line : fallbackLine
    const locEnd = typeof param?.loc?.end?.line === 'number' ? param.loc.end.line : fallbackLine
    result.push({ name, locStart, locEnd })
  }
  return result
}

/**
 * Extract named parameter names or positional count from Tornado URL patterns (regex)
 * Supports pattern like (?P<name>...) or (...)
 * @param pattern - Tornado URL regex pattern
 */
export function extractTornadoParams(pattern: string): { named: string[]; positionalCount: number } {
  if (!pattern) return { named: [], positionalCount: 0 }
  
  const namedGroups: string[] = []
  const namedRegex = /\(\?P<(\w+)>/g
  let match: RegExpExecArray | null
  while ((match = namedRegex.exec(pattern)) !== null) {
    namedGroups.push(match[1])
  }

  if (namedGroups.length > 0) {
    return { named: namedGroups, positionalCount: 0 }
  }

  // Count positional groups.
  // Remove escaped parens first.
  const cleaned = pattern.replace(/\\\(|\\\)/g, '')
  let positionalCount = 0
  // Matches '(' NOT followed by '?' (which covers (?:, (?P<, (?=, (?!, etc.)
  const positionalRegex = /\((?!\?)/g
  while (positionalRegex.exec(cleaned) !== null) {
    positionalCount++
  }

  return { named: [], positionalCount }
}
