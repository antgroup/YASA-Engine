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
])

export const passthroughFuncs = new Set<string>([
  'decode',
  'strip',
  'replace',
  'lower',
  'upper',
  'split',
])

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
    ['body', 'query', 'headers', 'cookies'].includes(propName)
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
 *
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
    const isUrlHelper =
      (callee.type === 'Identifier' && callee.name === 'url') ||
      (callee.type === 'MemberAccess' &&
        AstUtil.prettyPrint(callee).includes('url'))
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
 *
 * @param modulePath
 * @param currentFile
 */
export function resolveImportPath(
  modulePath: string,
  currentFile: string,
): string | null {
  if (!modulePath) return null
  const currentDir = path.dirname(currentFile)
  const leadingDots = modulePath.match(/^\.+/)?.[0] ?? ''
  let baseDir = currentDir
  if (leadingDots.length > 0) {
    baseDir = path.resolve(currentDir, '../'.repeat(leadingDots.length - 1))
  }
  const remainder = modulePath.slice(leadingDots.length)
  const normalized = remainder ? remainder.split('.').join(path.sep) : ''
  const resolved = normalized ? path.resolve(baseDir, normalized) : baseDir
  return `${resolved}.py`
}

/**
 *
 * @param stmt
 */
export function extractImportEntries(
  stmt: any,
): Array<{ local: string; imported?: string }> {
  const res: Array<{ local: string; imported?: string }> = []
  const { init } = stmt
  if (!init) return res

  if (Array.isArray(init?.imports) && init.imports.length > 0) {
    for (const spec of init.imports) {
      const local =
        spec.local?.name || spec.local?.value || spec.name || spec.value
      const imported =
        spec.imported?.name || spec.imported?.value || spec.name || spec.value
      if (local) res.push({ local, imported })
    }
    return res
  }

  if (stmt.id?.name) {
    const importedName =
      init?.imported?.name ||
      init?.imported?.value ||
      init?.name?.name ||
      init?.name?.value
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
  const fallbackLine =
    typeof funcNode?.loc?.start?.line === 'number'
      ? funcNode.loc.start.line
      : 'all'
  const result: ParamMeta[] = []
  for (const param of rawParams) {
    const name = param?.id?.name || param?.name
    if (!name) continue
    const locStart =
      typeof param?.loc?.start?.line === 'number'
        ? param.loc.start.line
        : fallbackLine
    const locEnd =
      typeof param?.loc?.end?.line === 'number'
        ? param.loc.end.line
        : fallbackLine
    result.push({ name, locStart, locEnd })
  }
  return result
}
