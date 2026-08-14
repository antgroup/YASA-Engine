import type { Value } from '../../../../../types/analyzer'
import type { GoFrameworkCallContext } from '../../framework-call-model'

const AstUtil = require('../../../../../util/ast-util')

const {
  ValueUtil: { ObjectValue, UndefinedValue },
} = require('../../../../util/value-util')

export const GO_CONTEXT_VALUE_FIELD = '__yasa_go_context_value'
export const GO_CONTEXT_PARENT_FIELD = '__yasa_go_context_parent'
export const GO_CONTEXT_KEY_FIELD = '__yasa_go_context_key'

export function canProcessGoContextBuiltinMethod(methodName: string): boolean {
  return methodName === 'WithValue' || methodName === 'Value'
}

export function processGoContextBuiltinCall(context: GoFrameworkCallContext): Value | null {
  const { scope, node, methodName, receiver, argvalues } = context
  if (methodName === 'WithValue' && isGoContextPackage(receiver) && argvalues.length >= 3) {
    const ctx = new ObjectValue(scope.qid, {
      sid: `WithValue(${argvalues[0]?.sid ?? 'parent'}, ${argvalues[1]?.sid ?? 'key'}, ${argvalues[2]?.sid ?? 'value'})`,
      qid: `${scope.qid}.<go_context_with_value_${node.loc?.start?.line ?? 'x'}_${node.loc?.start?.column ?? 'x'}>`,
      parent: scope,
      loc: node.loc,
      ast: node,
    })
    setGoContextMember(ctx, GO_CONTEXT_PARENT_FIELD, argvalues[0])
    setGoContextMember(ctx, GO_CONTEXT_KEY_FIELD, argvalues[1])
    setGoContextMember(ctx, GO_CONTEXT_VALUE_FIELD, argvalues[2])
    return ctx
  }

  if (methodName === 'Value') {
    const storedContext = findGoContextValueObject(receiver)
    if (storedContext) return resolveGoContextValue(storedContext, argvalues[0])
  }

  return null
}

export function setGoContextMember(target: Value | null | undefined, fieldName: string, value: Value | null | undefined): void {
  if (!target || !value) return
  target.members?.set(fieldName, value)
  if (!target.misc_) target.misc_ = {}
  target.misc_[fieldName] = value
}

export function getGoContextMember(target: Value | null | undefined, fieldName: string): Value | undefined {
  return target?.misc_?.[fieldName] ?? target?.members?.get(fieldName)
}

export function findGoContextValueObject(value: Value | null | undefined): Value | null {
  if (!value) return null
  if (getGoContextMember(value, GO_CONTEXT_VALUE_FIELD)) return value
  if (value.vtype === 'union' && Array.isArray(value.value)) {
    return value.value.find((item: Value) => getGoContextMember(item, GO_CONTEXT_VALUE_FIELD)) ?? null
  }
  return null
}

export function isGoContextPackage(value: Value | null | undefined): boolean {
  const id = `${value?.qid ?? ''}.${value?.sid ?? ''}.${value?.name ?? ''}`
  return value?.vtype === 'package' && /(^|\.)context(\.|$)/.test(id)
}

export function resolveGoContextValue(ctx: Value, key: Value | undefined): Value {
  const storedKey = getGoContextMember(ctx, GO_CONTEXT_KEY_FIELD)
  const storedValue = getGoContextMember(ctx, GO_CONTEXT_VALUE_FIELD)
  if (storedValue && isSameGoContextKey(storedKey, key)) {
    return storedValue
  }
  const parent = getGoContextMember(ctx, GO_CONTEXT_PARENT_FIELD)
  if (parent && getGoContextMember(parent, GO_CONTEXT_VALUE_FIELD)) return resolveGoContextValue(parent, key)
  return new UndefinedValue()
}

export function isSameGoContextKey(left: Value | undefined, right: Value | undefined): boolean {
  if (!left || !right) return false
  if (left === right) return true
  const leftType = normalizeGoContextKeyType(left)
  const rightType = normalizeGoContextKeyType(right)
  if (leftType && rightType) return leftType === rightType
  const leftId = normalizeGoContextKeyId(left)
  const rightId = normalizeGoContextKeyId(right)
  return leftId !== '' && rightId !== '' && leftId === rightId
}

export function normalizeGoContextKeyType(value: Value | undefined): string {
  const rawType = value?.rtype?.definiteType ?? value?.rtype ?? value?._meta?.type ?? value?.definiteType
  const typeName = extractGoContextKeyText(rawType)
  return normalizeGoContextKeyText(typeName)
}

export function normalizeGoContextKeyId(value: Value | undefined): string {
  const idParts = [value?.qid, value?.sid, value?.name]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
  return normalizeGoContextKeyText(idParts.join('.'))
}

export function extractGoContextKeyText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return AstUtil.prettyPrint(value)
  const namedValue = value as { name?: unknown; qid?: unknown; sid?: unknown }
  if (typeof namedValue.name === 'string') return namedValue.name
  if (typeof namedValue.qid === 'string') return namedValue.qid
  if (typeof namedValue.sid === 'string') return namedValue.sid
  return AstUtil.prettyPrint(value)
}

export function normalizeGoContextKeyText(value: string): string {
  return value
    .replace(/<instance_[^>]*>/g, '')
    .replace(/<copied_[^>]*>/g, '')
    .replace(/\.\d+(?=\.|$)/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '')
}
