import type { Scope, State, Value } from '../../../types/analyzer'
import type { CallExpression } from '../../../types/uast'
import type { CallInfo } from '../common/call-args'
import { getCallbackApiExecution, type CallbackApiModel } from '../common/callback-model'
import { handleGradioCall } from './gradio/gradio-call-model'

export interface PythonFrameworkCallAnalyzer {
  executeCall(node: CallExpression, fclos: Value, state: State, scope: Scope, callInfo: CallInfo): unknown
  executeCallbackModelCall(node: CallExpression, fclos: Value, state: State, scope: Scope, callInfo: CallInfo): boolean
}

export interface PythonFrameworkCallContext {
  analyzer: PythonFrameworkCallAnalyzer
  scope: Scope
  node: CallExpression
  state: State
  fclos: Value
  res: Value | undefined
  argvalues: Value[]
  callInfo: CallInfo
  collectedArgs: unknown[]
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' ? value as UnknownRecord : undefined
}

function getStringField(value: unknown, field: string): string | undefined {
  const fieldValue = asRecord(value)?.[field]
  return typeof fieldValue === 'string' ? fieldValue : undefined
}

function getQualifiedName(node: unknown): string | undefined {
  const record = asRecord(node)
  if (!record) return undefined
  const name = getStringField(record, 'name')
  if (record.type === 'Identifier') return name
  const idName = getStringField(asRecord(record.id), 'name')
  if (record.type === 'ScopedType') {
    const scopeName = getQualifiedName(record.scope)
    return scopeName && idName ? `${scopeName}.${idName}` : idName
  }
  if (record.type === 'MemberAccess') {
    const objectName = getQualifiedName(record.object)
    const propertyName = getStringField(asRecord(record.property), 'name')
    return objectName && propertyName ? `${objectName}.${propertyName}` : undefined
  }
  return undefined
}

function findRootNode(node: unknown): UnknownRecord | undefined {
  let current = asRecord(node)
  const visited = new Set<UnknownRecord>()
  while (current?.parent && !visited.has(current)) {
    visited.add(current)
    current = asRecord(current.parent)
  }
  return current
}

function getNodePosition(node: UnknownRecord | undefined): number {
  const start = asRecord(asRecord(node?.loc)?.start)
  const line = start?.line
  const column = start?.column
  return typeof line === 'number' && typeof column === 'number' ? line * 1_000_000 + column : Number.MAX_SAFE_INTEGER
}

function getReceiverDeclaration(receiver: UnknownRecord): UnknownRecord | undefined {
  let current = asRecord(asRecord(receiver.ast)?.node)
  const visited = new Set<UnknownRecord>()
  while (current && !visited.has(current)) {
    visited.add(current)
    if (current.type === 'VariableDeclaration') return current
    current = asRecord(current.parent)
  }
  return undefined
}

function hasNestedBinding(node: UnknownRecord | undefined, localName: string): boolean {
  const root = findRootNode(node)
  const referencePosition = getNodePosition(node)
  const pending: Array<{ value: unknown; nested: boolean }> = Array.isArray(root?.body)
    ? root.body.map((value) => ({ value, nested: false }))
    : []
  while (pending.length > 0) {
    const entry = pending.pop()
    const candidate = asRecord(entry?.value)
    if (!candidate) continue

    const declaredName = candidate.type === 'VariableDeclaration'
      ? getStringField(asRecord(candidate.id), 'name')
      : undefined
    const assignedName = candidate.type === 'AssignmentExpression'
      ? getStringField(asRecord(candidate.left), 'name')
      : undefined
    if (
      entry?.nested &&
      getNodePosition(candidate) < referencePosition &&
      (declaredName === localName || assignedName === localName)
    ) return true
    for (const [key, value] of Object.entries(candidate)) {
      if (key === 'parent' || key === 'loc' || key === '_meta') continue
      const nested = entry?.nested || candidate.type === 'ScopedStatement' || candidate.type === 'IfStatement' || candidate.type === 'TryStatement'
      if (Array.isArray(value)) {
        for (const item of value) pending.push({ value: item, nested })
      } else if (value && typeof value === 'object') {
        pending.push({ value, nested })
      }
    }
  }
  return false
}

function getImportBinding(node: unknown, localName: string): string | undefined {
  const declaration = asRecord(node)
  if (hasNestedBinding(declaration, localName)) return undefined
  const root = findRootNode(node)
  const body = root?.body
  const referencePosition = getNodePosition(asRecord(node))
  if (!Array.isArray(body) || referencePosition === Number.MAX_SAFE_INTEGER) return undefined

  let binding: string | undefined
  for (const statement of body) {
    const declaration = asRecord(statement)
    if (!declaration || getNodePosition(declaration) >= referencePosition) continue
    const init = asRecord(declaration.init)
    const local = getStringField(asRecord(declaration.id), 'name')
    const assignedName = getStringField(asRecord(declaration.left), 'name')
    const declaredName = getStringField(asRecord(declaration.id), 'name')
    if (init?.type === 'ImportExpression' && local === localName) {
      const imported = asRecord(init.imported)
      const importedName = getStringField(imported, 'name') ?? getStringField(imported, 'value')
      const fromModule = getStringField(asRecord(init.from), 'value')
      if (importedName === 'BackgroundTasks' && (fromModule === 'fastapi' || fromModule === 'starlette.background')) {
        binding = `${fromModule}.BackgroundTasks`
      } else if (importedName === 'background' && fromModule === 'starlette') {
        binding = 'starlette.background'
      } else if (!fromModule && (importedName === 'fastapi' || importedName === 'starlette.background' || importedName === 'starlette')) {
        binding = importedName
      } else {
        binding = undefined
      }
    } else if (assignedName === localName || declaredName === localName) {
      binding = undefined
    }
  }
  return binding
}

function resolveBackgroundTasksAnnotation(declaration: UnknownRecord | undefined): string | undefined {
  const annotationName = getQualifiedName(declaration?.varType)
  if (!annotationName) return undefined
  const [localName, ...properties] = annotationName.split('.')
  const binding = getImportBinding(declaration, localName)
  if (!binding) return undefined
  const suffix = properties.join('.')
  if (binding.endsWith('.BackgroundTasks') && properties.length === 0) return binding
  if (binding === 'fastapi' && suffix === 'BackgroundTasks') return 'fastapi.BackgroundTasks'
  if (binding === 'starlette.background' && suffix === 'BackgroundTasks') return 'starlette.background.BackgroundTasks'
  if (binding === 'starlette' && suffix === 'background.BackgroundTasks') return 'starlette.background.BackgroundTasks'
  return undefined
}

function getReceiverIdentities(receiver: unknown): string[] {
  const record = asRecord(receiver)
  if (!record) return []
  const identities = new Set<string>()
  const receiverType = getStringField(record, 'receiverType')
  if (receiverType) identities.add(receiverType)

  const rtype = asRecord(record.rtype)
  const definiteType = asRecord(rtype?.definiteType)
  const typeName = getStringField(definiteType, 'name')
  if (typeName) identities.add(typeName)

  const declaration = getReceiverDeclaration(record)
  const annotationIdentity = resolveBackgroundTasksAnnotation(declaration)
  if (annotationIdentity) identities.add(annotationIdentity)
  return [...identities]
}

function getMethodName(node: CallExpression, fclos: Value): string | undefined {
  if (node.callee?.type === 'MemberAccess' && node.callee.property?.type === 'Identifier') {
    return node.callee.property.name
  }
  return getStringField(fclos, 'sid')
}

export function dispatchPythonCallbackApiModel(context: PythonFrameworkCallContext, models?: CallbackApiModel[]): boolean {
  const methodName = getMethodName(context.node, context.fclos)
  if (!methodName) return false

  const receiverIdentities = getReceiverIdentities(context.callInfo.callArgs?.receiver)
  if (receiverIdentities.length === 0) return false

  const callbackCall = getCallbackApiExecution({
    language: 'python',
    methodName,
    receiverIdentities,
    callInfo: context.callInfo,
  }, models)
  if (!callbackCall) return false
  return context.analyzer.executeCallbackModelCall(
    context.node,
    callbackCall.callback,
    context.state,
    context.scope,
    callbackCall.callInfo
  )
}

export function handlePythonFrameworkCall(context: PythonFrameworkCallContext): void {
  handleGradioCall(context)
}
