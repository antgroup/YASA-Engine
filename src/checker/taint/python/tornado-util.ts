const path = require('path')
const AstUtil = require('../../../util/ast-util')

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
 * Detect if node is an access to a Tornado request attribute (e.g., self.request.body)
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
    [
      'body',
      'query',
      'headers',
      'cookies',
      'files',
      'uri',
      'path',
      'arguments',
      'query_arguments',
      'body_arguments',
    ].includes(propName)
  )
}

/**
 * Detect if expression involves a Tornado request attribute
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
 * Check if node is a Tornado Application or handler call
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
  const propName = callee.property?.name
  if (callee.type === 'MemberAccess' && (propName === '__init__' || propName === '_CTOR_')) {
    // Check if any part of the member access chain matches the targetName
    let current = callee.object
    while (current) {
      if (current.type === 'Identifier' && current.name === targetName) {
        return true
      }
      if (current.type === 'MemberAccess' && current.property?.name === targetName) {
        return true
      }
      // Follow through super() or other calls
      if (current.type === 'CallExpression') {
        current = current.callee
      } else if (current.type === 'MemberAccess') {
        current = current.object
      } else {
        current = null
      }
    }
  }
  return false
}

/**
 * Extract parameters from function AST
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
