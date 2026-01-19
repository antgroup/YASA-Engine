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
])

/**
 * Detect if node is an access to a Tornado request attribute
 * @param node
 */
export function isRequestAttributeAccess(node: any): boolean {
  if (node?.type !== 'MemberAccess') return false
  const inner = node.object
  return (
    inner?.type === 'MemberAccess' &&
    inner.object?.type === 'Identifier' &&
    inner.object?.name === 'self' &&
    inner.property?.name === 'request' &&
    [
      'body',
      'query',
      'headers',
      'cookies',
      'files',
      'uri',
      'path',
      'arguments',
      'remote_ip',
      'host',
      'query_arguments',
      'body_arguments',
    ].includes(node.property?.name)
  )
}

/**
 * Check if node is a Tornado Application call
 * @param node
 * @param targetName
 */
export function isTornadoCall(node: any, targetName: string): boolean {
  if (!node || node.type !== 'CallExpression') return false
  const { callee } = node
  const names = [targetName]
  if (names.includes(callee.name) || names.includes(callee.property?.name)) return true
  // Handle __init__ pattern
  if (['__init__', '_CTOR_'].includes(callee.property?.name)) {
    let current = callee.object
    while (current) {
      if (names.includes(current.name) || names.includes(current.property?.name)) return true
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
