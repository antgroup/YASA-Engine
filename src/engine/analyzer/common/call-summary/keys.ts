import { createHash } from 'crypto'
import type { State, Value } from '../../../../types/analyzer'
import { DEFAULT_CALL_SUMMARY_RISK_CONTEXT } from './types'
import type { BuildCallSummaryKeyOptions, CallSummaryLayerKey, CallSummaryLayerLevel, CallSummaryRiskContext } from './types'

const MAX_INLINE_CALL_SUMMARY_KEY_BYTES = 64

function normalizeRiskContextField(value: string | undefined): string {
  return value && value.length > 0 ? value.replace(/[|=;]/g, '_') : 'unknown'
}

export function buildCallSummaryRiskContext(
  context: Partial<CallSummaryRiskContext> | string | undefined
): CallSummaryRiskContext {
  if (typeof context === 'string') {
    return {
      ...DEFAULT_CALL_SUMMARY_RISK_CONTEXT,
      sideEffectRisk: normalizeRiskContextField(context),
    }
  }
  return {
    callKind: normalizeRiskContextField(context?.callKind ?? DEFAULT_CALL_SUMMARY_RISK_CONTEXT.callKind),
    receiverShape: normalizeRiskContextField(context?.receiverShape ?? DEFAULT_CALL_SUMMARY_RISK_CONTEXT.receiverShape),
    argEffectShape: normalizeRiskContextField(context?.argEffectShape ?? DEFAULT_CALL_SUMMARY_RISK_CONTEXT.argEffectShape),
    resultUse: normalizeRiskContextField(context?.resultUse ?? DEFAULT_CALL_SUMMARY_RISK_CONTEXT.resultUse),
    sideEffectRisk: normalizeRiskContextField(context?.sideEffectRisk ?? DEFAULT_CALL_SUMMARY_RISK_CONTEXT.sideEffectRisk),
  }
}

export function serializeCallSummaryRiskContext(
  context: Partial<CallSummaryRiskContext> | string | undefined
): string {
  const normalized = buildCallSummaryRiskContext(context)
  return [
    `callKind=${normalized.callKind}`,
    `receiverShape=${normalized.receiverShape}`,
    `argEffectShape=${normalized.argEffectShape}`,
    `resultUse=${normalized.resultUse}`,
    `sideEffectRisk=${normalized.sideEffectRisk}`,
  ].join(';')
}


function buildCallSummarySha256(parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function estimateRawKeyBytes(parts: readonly string[]): number {
  const separators = Math.max(parts.length - 1, 0)
  return parts.reduce((total, part) => total + part.length, separators)
}

function buildLayerKey(parts: readonly string[]): CallSummaryLayerKey {
  const rawBytes = estimateRawKeyBytes(parts)
  const rawKey = parts.join('|')
  const key = rawBytes > MAX_INLINE_CALL_SUMMARY_KEY_BYTES ? `sha256:${buildCallSummarySha256(parts)}` : rawKey
  return {
    key,
    rawBytes,
    storedBytes: key.length,
  }
}

/**
 * 读取对象字符串字段。
 * @param value 来源对象
 * @param field 字段名
 * @returns {string} 字段字符串值
 */
function readStringField(value: unknown, field: string): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  const result = record[field]
  return typeof result === 'string' ? result : ''
}

/**
 * 判断 Value 是否已有污点。
 * @param value 分析值
 * @returns {boolean} 是否带污点
 */
function isTaintedValue(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as {
    readonly _taint?: { readonly isTaintedRec?: boolean }
    readonly taint?: { readonly isTaintedRec?: boolean }
  }
  return Boolean(record._taint?.isTaintedRec || record.taint?.isTaintedRec)
}

export function buildCallSummaryTargetKey(
  options: Pick<BuildCallSummaryKeyOptions, 'callerQid' | 'callee'>
): CallSummaryLayerKey {
  return buildLayerKey([
    options.callerQid ?? '',
    readStringField(options.callee, 'qid'),
  ])
}

export function buildCallSummaryArgKey(
  callArgs: readonly { readonly node?: unknown; readonly value?: unknown }[]
): CallSummaryLayerKey {
  const parts: string[] = [String(callArgs.length)]
  for (const callArg of callArgs) {
    parts.push(readStringField(callArg.node, 'type') || '?')
  }
  return buildLayerKey(parts)
}

function buildCallSummaryArgTaintBits(
  callArgs: readonly { readonly value?: unknown }[]
): string {
  if (callArgs.length === 0) return '0'
  return callArgs.map((arg) => (isTaintedValue(arg.value) ? '1' : '0')).join('')
}

function hasNonZeroTaintBits(taintBits: string): boolean {
  return taintBits.includes('1')
}

type UnknownRecord = Record<string, unknown>

const CALL_SUMMARY_VALUE_SHAPE_STRING_FIELDS = [
  'qid',
  '_qid',
  'logicalQid',
  'sid',
  '_sid',
  'vtype',
  'type',
  'name',
  'affectedNodeName',
  'nodeName',
  'property',
  'propertyName',
  'propertyPath',
  'sourcePropertyPath',
  'fieldName',
  'sourcePath',
  'sourceFile',
  'file',
  'path',
] as const

const CALL_SUMMARY_VALUE_SHAPE_NESTED_FIELDS = [
  'field',
  'object',
  'parent',
  'source',
  'origin',
  'node',
  'ast',
  'loc',
] as const

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' ? (value as UnknownRecord) : undefined
}

function readBooleanTaintFlag(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) return false
  const taint = asRecord(record._taint) ?? asRecord(record.taint)
  return Boolean(taint?.isTaintedRec || taint?.isTainted)
}

function readArrayField(value: unknown, field: string): readonly unknown[] {
  const record = asRecord(value)
  const result = record?.[field]
  return Array.isArray(result) ? result : []
}

function readTraceShapeParts(value: unknown): string[] {
  const record = asRecord(value)
  const taint = asRecord(record?._taint) ?? asRecord(record?.taint)
  const traces = typeof taint?.getFirstTrace === 'function' ? taint.getFirstTrace.call(taint) : undefined
  if (!Array.isArray(traces)) return []
  const parts: string[] = []
  for (const trace of traces.slice(0, 4)) {
    const traceRecord = asRecord(trace)
    if (!traceRecord) continue
    for (const field of ['tag', 'file', 'sourcePath', 'affectedNodeName', 'propertyName', 'name'] as const) {
      const fieldValue = traceRecord[field]
      if (typeof fieldValue === 'string' && fieldValue.length > 0) {
        parts.push(`trace.${field}=${fieldValue}`)
      }
    }
    const lineValue = traceRecord.line
    if (typeof lineValue === 'number' || typeof lineValue === 'string') {
      parts.push(`trace.line=${String(lineValue)}`)
    }
  }
  return parts
}

function hasReadableSourceShape(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) return false
  for (const field of CALL_SUMMARY_VALUE_SHAPE_STRING_FIELDS) {
    const lowerField = field.toLowerCase()
    if ((lowerField.includes('source') || lowerField.includes('path') || lowerField.includes('property') || field === 'affectedNodeName') && readStringField(record, field)) {
      return true
    }
  }
  if (readTraceShapeParts(value).length > 0) return true
  const property = record.property
  return typeof property === 'string' && property.length > 0
}

function isSymbolicValue(value: unknown): boolean {
  const vtype = readStringField(value, 'vtype')
  return vtype === 'symbol' || vtype.endsWith('Expr') || vtype === 'identifier-ref'
}

function shouldIncludeValueShape(value: unknown): boolean {
  if (readBooleanTaintFlag(value) || isSymbolicValue(value) || hasReadableSourceShape(value)) return true
  const vtype = readStringField(value, 'vtype')
  if (vtype === 'primitive' || vtype === 'undefine' || vtype === 'void') return false
  return Boolean(readStringField(value, 'qid') || readStringField(value, 'sid'))
}

function collectValueShapeParts(value: unknown, prefix: string, depth: number, visited: WeakSet<object>, parts: string[]): void {
  const record = asRecord(value)
  if (!record || visited.has(record) || depth > 2) return
  visited.add(record)

  for (const field of CALL_SUMMARY_VALUE_SHAPE_STRING_FIELDS) {
    const fieldValue = record[field]
    if (typeof fieldValue === 'string' && fieldValue.length > 0) {
      parts.push(`${prefix}.${field}=${fieldValue}`)
    }
  }

  for (const field of ['line', 'column', 'start', 'end'] as const) {
    const fieldValue = record[field]
    if (typeof fieldValue === 'number' || typeof fieldValue === 'string') {
      parts.push(`${prefix}.${field}=${String(fieldValue)}`)
    }
  }

  parts.push(...readTraceShapeParts(value).map((part) => `${prefix}.${part}`))

  for (const field of CALL_SUMMARY_VALUE_SHAPE_NESTED_FIELDS) {
    collectValueShapeParts(record[field], `${prefix}.${field}`, depth + 1, visited, parts)
  }

  const values = readArrayField(value, 'values')
  for (let index = 0; index < Math.min(values.length, 3); index++) {
    collectValueShapeParts(values[index], `${prefix}.values${index}`, depth + 1, visited, parts)
  }
}

function buildCallSummaryArgValueShapeHash(callArgs: readonly { readonly value?: unknown }[]): string {
  const parts: string[] = []
  for (let index = 0; index < callArgs.length; index++) {
    const value = callArgs[index]?.value
    if (!shouldIncludeValueShape(value)) continue
    const argParts: string[] = []
    collectValueShapeParts(value, `arg${index}`, 0, new WeakSet<object>(), argParts)
    if (argParts.length > 0) {
      parts.push(`arg${index}:${buildCallSummarySha256(argParts.sort())}`)
    }
  }
  return parts.length > 0 ? buildCallSummarySha256(parts) : '0'
}

function buildCallSummaryPcondHash(pcond: State['pcond'] | undefined): string {
  if (!Array.isArray(pcond) || pcond.length === 0) return '0'
  const parts: string[] = []
  for (const item of pcond) {
    const node = item as {
      readonly type?: string
      readonly loc?: { readonly start?: { readonly line?: number; readonly column?: number } }
    }
    const line = node.loc?.start?.line ?? 0
    const column = node.loc?.start?.column ?? 0
    parts.push(typeof item === 'string' ? item : `${node.type ?? ''}@${line}:${column}`)
  }
  return buildCallSummarySha256(parts)
}

export function buildCallSummaryPcondKey(pcond: State['pcond'] | undefined): CallSummaryLayerKey {
  return buildLayerKey([buildCallSummaryPcondHash(pcond)])
}

function buildCallSummaryReceiverTaintBit(receiver: unknown): string {
  return isTaintedValue(receiver) ? '1' : '0'
}

export function hasCallSummaryOptionalRuntimeState(
  callArgs: readonly { readonly value?: unknown }[],
  receiver: unknown,
  pcond: State['pcond'] | undefined
): boolean {
  const taintBits = buildCallSummaryArgTaintBits(callArgs)
  const receiverBit = buildCallSummaryReceiverTaintBit(receiver)
  const hasPcond = Array.isArray(pcond) && pcond.length > 0
  const valueShapeHash = buildCallSummaryArgValueShapeHash(callArgs)
  return hasNonZeroTaintBits(taintBits) || receiverBit === '1' || hasPcond || valueShapeHash !== '0'
}

export function buildCallSummaryRuntimeStateKey(
  callArgs: readonly { readonly value?: unknown }[],
  receiver: unknown,
  pcond: State['pcond'] | undefined
): CallSummaryLayerKey {
  return buildLayerKey([
    buildCallSummaryArgTaintBits(callArgs),
    buildCallSummaryReceiverTaintBit(receiver),
    buildCallSummaryPcondHash(pcond),
    buildCallSummaryArgValueShapeHash(callArgs),
  ])
}

export function buildCallSummaryOptionalRuntimeStateKey(
  callArgs: readonly { readonly value?: unknown }[],
  receiver: unknown,
  pcond: State['pcond'] | undefined
): CallSummaryLayerKey | undefined {
  if (!hasCallSummaryOptionalRuntimeState(callArgs, receiver, pcond)) return undefined
  return buildCallSummaryRuntimeStateKey(callArgs, receiver, pcond)
}

export function buildCallSummaryLayerLevelKey(layerLevel: CallSummaryLayerLevel): CallSummaryLayerKey {
  return buildLayerKey([layerLevel])
}

export function buildCallSummaryRiskKey(
  context: Partial<CallSummaryRiskContext> | string | undefined
): CallSummaryLayerKey {
  return buildLayerKey([serializeCallSummaryRiskContext(context)])
}
