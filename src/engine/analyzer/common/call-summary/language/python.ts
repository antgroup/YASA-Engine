import type { CallArgs, CallInfo } from '../../call-args'
import type { Scope, State, Value } from '../../../../../types/analyzer'
import { buildCallSummaryRiskContext } from '../keys'
import type { CallSummaryRiskContext } from '../types'
import type { CallSummaryLanguagePolicy, CallSummaryLanguagePolicyContext } from './types'

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readRecordField(value: unknown, field: string): unknown {
  return isRecordValue(value) ? value[field] : undefined
}

function readStringField(value: unknown, field: string): string {
  const fieldValue = readRecordField(value, field)
  return typeof fieldValue === 'string' ? fieldValue : ''
}

function readUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function getPythonCallSummaryCallKind(fclos: Value | undefined): string {
  if (!fclos) return 'unknown'
  if (fclos.vtype === 'union') return 'union'
  if (fclos.vtype === 'fclos') return 'function'
  if (fclos.vtype === 'class') return 'class'
  return 'unknown'
}

function hasTaintedPythonCallSummaryValue(value: unknown, seen: Set<unknown> = new Set()): boolean {
  if (!isRecordValue(value)) return false
  if (seen.has(value)) return false
  seen.add(value)
  const taint = readRecordField(value, 'taint') ?? readRecordField(value, '_taint')
  if (isRecordValue(taint) && taint.isTaintedRec === true) return true
  const args = readUnknownArray(readRecordField(value, 'args'))
  if (args.some((arg) => hasTaintedPythonCallSummaryValue(arg, seen))) return true
  const receiver = readRecordField(value, 'receiver')
  if (hasTaintedPythonCallSummaryValue(receiver, seen)) return true
  const nestedValue = readRecordField(value, 'value')
  if (nestedValue !== value && hasTaintedPythonCallSummaryValue(nestedValue, seen)) return true
  return false
}

function getPythonCallSummaryArgEffectShape(callArgs: CallArgs | undefined): string {
  if (!callArgs) return 'unknown'
  const parts: string[] = []
  if (callArgs.receiver) parts.push('receiver')
  const args = callArgs.args ?? []
  parts.push(`argc_${args.length}`)
  parts.push(args.map((arg) => arg.kind ?? 'unknown').join('_') || 'no_args')
  parts.push(hasTaintedPythonCallSummaryValue(callArgs) ? 'tainted' : 'untainted')
  return parts.join('_')
}

function getPythonCallSummaryCalleeShape(fclos: Value | undefined): string {
  if (!fclos) return 'callee_unknown'
  if (fclos.vtype === 'union') {
    const values = readUnknownArray(readRecordField(fclos, 'value'))
    const shapes = values.map((value) => getPythonCallSummaryCalleeShape(value as Value)).sort()
    return `union_${shapes.join('_') || 'empty'}`
  }
  const qidShape = readStringField(fclos, 'qid') ? 'qid' : 'no_qid'
  const ast = readRecordField(fclos, 'ast')
  const fdef = readRecordField(ast, 'fdef')
  const fdefShape = readStringField(fdef, 'type') || 'no_fdef'
  return `${fclos.vtype ?? 'unknown'}_${qidShape}_${fdefShape}`
}

function getPythonCallSummaryEffectShape(
  scope: Scope,
  fclos: Value | undefined,
  callInfo: CallInfo | undefined,
  state: State
): string {
  const calleeShape = getPythonCallSummaryCalleeShape(fclos)
  const taintShape = hasTaintedPythonCallSummaryValue(callInfo?.callArgs) ? 'tainted' : 'untainted'
  const pcondShape = state?.pcond && state.pcond.length > 0 ? 'pcond' : 'no_pcond'
  const callerShape = scope?.qid ? 'caller_qid' : 'caller_unknown'
  return `${calleeShape}_${taintShape}_${pcondShape}_${callerShape}`
}

// Python policy 实现封装 call kind、参数影响、pcond 与 callee 风险形态。
function buildPythonCallSummaryRiskContext(
  context: CallSummaryLanguagePolicyContext
): CallSummaryRiskContext {
  const { scope, fclos, callInfo, state } = context
  const callArgs = callInfo?.callArgs
  return buildCallSummaryRiskContext({
    callKind: getPythonCallSummaryCallKind(fclos),
    receiverShape: callArgs?.receiver ? 'has_receiver' : 'no_receiver',
    argEffectShape: getPythonCallSummaryArgEffectShape(callArgs),
    resultUse: state?.pcond && state.pcond.length > 0 ? 'pcond' : 'no_pcond',
    sideEffectRisk: getPythonCallSummaryEffectShape(scope, fclos, callInfo, state),
  })
}

export const pythonCallSummaryPolicy: CallSummaryLanguagePolicy = {
  buildRiskContext: buildPythonCallSummaryRiskContext,
}
