import type { Value } from '../../../../types/analyzer'
import type { GoFrameworkCallContext } from '../framework-call-model'

import { UndefinedValue } from '../../common/value/undefine'
import { extractGoContextKeyText, getGoContextMember, normalizeGoContextKeyText, setGoContextMember } from '../common/builtins/go-context-builtins'

const GO_COBRA_CONTEXT_FIELD = '__yasa_go_context'

const cobraContextFallbackByHost = new WeakMap<object, Map<string, Value>>()

export function canProcessCobraContextMethod(methodName: string): boolean {
  return methodName === 'SetContext' || methodName === 'Context'
}

export function processCobraContextCall(context: GoFrameworkCallContext): Value | null {
  const { analyzer, methodName, receiver, argvalues } = context
  if (methodName === 'SetContext' && isCobraCommandContextReceiver(receiver) && argvalues[0]) {
    setGoContextMember(receiver, GO_COBRA_CONTEXT_FIELD, argvalues[0])
    setCobraContextFallback(analyzer, receiver, argvalues[0])
    return new UndefinedValue()
  }

  if (methodName === 'Context' && isCobraCommandContextReceiver(receiver)) {
    const stored = getGoContextMember(receiver, GO_COBRA_CONTEXT_FIELD) ?? getCobraContextFallback(analyzer, receiver)
    if (stored) return stored
  }

  return null
}

export function isCobraCommandContextReceiver(value: Value | null | undefined): value is Value {
  if (!value || typeof value !== 'object') return false
  const id = `${value.qid ?? ''}.${value.sid ?? ''}.${value.name ?? ''}.${extractGoContextKeyText(value.rtype?.definiteType ?? value.rtype)}`
  if (/github\.com\/spf13\/cobra\.Command|cobra\.Command/.test(id)) return true
  const rtypeName = extractGoContextKeyText(value.rtype?.definiteType ?? value.rtype)
  const normalizedType = normalizeGoContextKeyText(rtypeName).replace(/^\*+/, '')
  return normalizedType === 'Command' || normalizedType === 'cobra.Command' || normalizedType.endsWith('.cobra.Command')
}


function setCobraContextFallback(host: object, receiver: Value, contextValue: Value): void {
  const receiverKey = getCobraReceiverKey(receiver)
  if (!receiverKey) return
  let contextsByReceiver = cobraContextFallbackByHost.get(host)
  if (!contextsByReceiver) {
    contextsByReceiver = new Map<string, Value>()
    cobraContextFallbackByHost.set(host, contextsByReceiver)
  }
  contextsByReceiver.set(receiverKey, contextValue)
}

function getCobraContextFallback(host: object, receiver: Value): Value | undefined {
  const receiverKey = getCobraReceiverKey(receiver)
  if (!receiverKey) return undefined
  return cobraContextFallbackByHost.get(host)?.get(receiverKey)
}

function getCobraReceiverKey(receiver: Value): string {
  const rawType = extractGoContextKeyText(receiver.rtype?.definiteType ?? receiver.rtype)
  const idParts = [receiver.qid, receiver.sid, receiver.name, rawType]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
  return normalizeGoContextKeyText(idParts.join('.'))
}
