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

type MemberAccessNode = {
  type: 'MemberAccess'
  object?: unknown
  property?: unknown
}

const tornadoPreparedBodyReads = new WeakSet<MemberAccessNode>()

export function registerPreparedBodyRead(node: MemberAccessNode): void {
  tornadoPreparedBodyReads.add(node)
}

export function isPreparedBodyRead(node: unknown): node is MemberAccessNode {
  return typeof node === 'object' && node !== null && tornadoPreparedBodyReads.has(node as MemberAccessNode)
}

const tornadoHandlerApplications = new Map<string, Set<unknown>>()

type TornadoClassValue = {
  qid?: unknown
  ast?: {
    cdef?: unknown
    node?: unknown
  }
}

function getTornadoHandlerClassKey(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const handler = value as TornadoClassValue
  if (typeof handler.qid !== 'string') return undefined
  const classDefinitions = [handler.ast?.node, handler.ast?.cdef]
  if (!classDefinitions.some((node) => (node as { type?: unknown } | undefined)?.type === 'ClassDefinition')) return undefined
  return handler.qid
}

export function registerTornadoHandlerApplication(handler: unknown, application: unknown): void {
  const handlerClassKey = getTornadoHandlerClassKey(handler)
  if (!handlerClassKey || typeof application !== 'object' || application === null) return
  const applications = tornadoHandlerApplications.get(handlerClassKey) ?? new Set<unknown>()
  applications.add(application)
  tornadoHandlerApplications.set(handlerClassKey, applications)
}

export function getUniqueTornadoHandlerApplication(handler: unknown): unknown {
  const handlerClassKey = getTornadoHandlerClassKey(handler)
  if (!handlerClassKey) return undefined
  const applications = tornadoHandlerApplications.get(handlerClassKey)
  if (applications?.size !== 1) return undefined
  return applications.values().next().value
}

export function resetTornadoHandlerApplications(): void {
  tornadoHandlerApplications.clear()
}

/**
 * Check if node is a Tornado Application call
 * @param node
 * @param targetName
 */
export function isTornadoCall(node: any, targetName: string): boolean {
  if (!node || node.type !== 'CallExpression') return false
  const { callee } = node
  const funcName = callee.property?.name || callee.name
  const objectName = callee.object?.name || callee.object?.property?.name
  if (funcName === targetName || objectName === targetName) {
    return true
  }
  if (['__init__', '_CTOR_'].includes(funcName)) {
    let current = callee.object
    while (current) {
      const currentName = current.name || current.property?.name
      if (currentName === targetName) return true
      current = current.object || current.callee
    }
  }
  return false
}

type TornadoFrameworkCallable = {
  node_module?: boolean
  qid?: string
  sid?: string
  super?: unknown
  ast?: {
    cdef?: { type?: unknown }
    node?: { type?: unknown }
  }
}

function isTornadoApplicationBase(callable: unknown): boolean {
  if (typeof callable !== 'object' || callable === null) return false
  const value = callable as TornadoFrameworkCallable
  return value.node_module === true && typeof value.qid === 'string' && /(?:^|\.)tornado\.web\.Application$/.test(value.qid)
}

function isLocalTornadoApplicationSubclass(callable: TornadoFrameworkCallable): boolean {
  const classDefinitions = [callable.ast?.node, callable.ast?.cdef]
  return (
    callable.node_module !== true &&
    classDefinitions.some((definition) => definition?.type === 'ClassDefinition') &&
    isTornadoApplicationBase(callable.super)
  )
}

export function isTornadoFrameworkCall(node: unknown, targetName: string, callable: unknown): boolean {
  if (!isTornadoCall(node, targetName)) return false
  if (typeof callable !== 'object' || callable === null) return false
  const value = callable as TornadoFrameworkCallable
  const qualifiedId = value.qid ?? value.sid
  const isExternalTornadoCall =
    value.node_module === true &&
    typeof qualifiedId === 'string' &&
    (targetName === 'Application' ? isTornadoApplicationBase(value) : qualifiedId.includes('tornado.web.'))
  return isExternalTornadoCall || (targetName === 'Application' && isLocalTornadoApplicationSubclass(value))
}
