import type { CallExpression } from '../../../types/uast'
import type { Scope, State, Value } from '../../../types/analyzer'

import { canProcessGoContextBuiltinMethod, processGoContextBuiltinCall } from './common/builtins/go-context-builtins'
import { canProcessGoJsonBuiltinMethod, processGoJsonBuiltinCall } from './common/builtins/go-json-builtins'
import { canProcessCobraContextMethod, processCobraContextCall } from './cobra/cobra-context-model'

export interface GoFrameworkCallAnalyzer {
  processInstruction(scope: Scope, node: unknown, state: State): Value
}

export interface GoFrameworkCallInput {
  analyzer: GoFrameworkCallAnalyzer
  scope: Scope
  node: CallExpression
  state: State
  fclos: Value | null | undefined
  argvalues: Value[]
}

export interface GoFrameworkCallContext extends GoFrameworkCallInput {
  methodName: string
  receiver: Value | null | undefined
}

export function processGoFrameworkCall(input: GoFrameworkCallInput): Value | null {
  const { analyzer, scope, node, state } = input
  const callee = node.callee
  if (!callee || callee.type !== 'MemberAccess') return null
  const methodName = getGoMemberName(callee.property)
  if (!methodName) return null
  if (
    !canProcessGoContextBuiltinMethod(methodName) &&
    !canProcessGoJsonBuiltinMethod(methodName) &&
    !canProcessCobraContextMethod(methodName)
  ) return null
  const receiver = analyzer.processInstruction(scope, callee.object, state)
  return handleGoFrameworkCall({ ...input, methodName, receiver })
}

export function handleGoFrameworkCall(context: GoFrameworkCallContext): Value | null {
  const contextResult = processGoContextBuiltinCall(context)
  if (contextResult) return contextResult

  const jsonResult = processGoJsonBuiltinCall(context)
  if (jsonResult) return jsonResult

  return processCobraContextCall(context)
}

export function getGoMemberName(property: { name?: unknown; value?: unknown; sid?: unknown } | null | undefined): string | null {
  if (!property) return null
  if (typeof property.name === 'string') return property.name
  if (typeof property.value === 'string') return property.value
  if (typeof property.sid === 'string') return property.sid
  return null
}
