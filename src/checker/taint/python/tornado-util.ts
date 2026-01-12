export interface ParamMeta {
  name: string
  locStart: number | 'all'
  locEnd: number | 'all'
}

/**
 * Tornado Source APIs
 */
export const tornadoSourceAPIs = new Set([
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

export const passthroughFuncs = new Set(['decode', 'strip', 'replace', 'lower', 'upper', 'split'])

/**
 * Detect if node is an access to a Tornado request attribute
 * @param node
 */
export function isRequestAttributeAccess(node: any): boolean {
  if (node?.type !== 'MemberAccess') return false
  const inner = node.object
  return (
    inner?.type === 'MemberAccess' &&
    inner.object?.name === 'self' &&
    inner.property?.name === 'request' &&
    ['body', 'query', 'headers', 'cookies', 'files', 'uri', 'path', 'arguments'].includes(node.property?.name)
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
 * Check if node is a Tornado Application call
 * @param node
 * @param targetName
 */
export function isTornadoCall(node: any, targetName: string): boolean {
  if (!node || node.type !== 'CallExpression') return false
  const { callee } = node
  if (callee.name === targetName || callee.property?.name === targetName) return true

  // Handle __init__ pattern
  if (['__init__', '_CTOR_'].includes(callee.property?.name)) {
    let current = callee.object
    while (current) {
      if (current.name === targetName || current.property?.name === targetName) return true
      current = current.object || current.callee
    }
  }
  return false
}

/**
 * Extract parameter info from URL regex patterns
 * @param pattern
 */
export function extractTornadoParams(pattern: string): { named: string[]; positionalCount: number } {
  if (!pattern) return { named: [], positionalCount: 0 }
  const named = Array.from(pattern.matchAll(/\(\?P<(\w+)>/g)).map((m) => m[1])
  if (named.length > 0) return { named, positionalCount: 0 }

  const cleaned = pattern.replace(/\\\(|\\\)/g, '')
  const positionalCount = (cleaned.match(/\((?!\?)/g) || []).length
  return { named: [], positionalCount }
}
