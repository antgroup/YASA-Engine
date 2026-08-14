import type { TraceItem } from '../../../../../util/finding-util'
import type { Scope, State, Value } from '../../../../../types/analyzer'
import type { CallExpression } from '../../../../../types/uast'
import type { GoFrameworkCallContext } from '../../framework-call-model'

import { PrimitiveValue } from '../../../common/value/primitive'
import { UndefinedValue } from '../../../common/value/undefine'

const fs = require('fs') as typeof import('fs')
const SourceLine = require('../../../common/source-line') as {
  addSrcLineInfo: (
    val: JsonMutableValue | JsonMutableValue[] | undefined | null,
    node: JsonNodeWithLoc,
    sourcefile: string | undefined,
    tag: string,
    affectedNodeName: string | undefined
  ) => JsonMutableValue | JsonMutableValue[] | undefined | null
}

type UnknownRecord = Record<string, unknown>

interface SourcePosition {
  line?: number
  column?: number
}

interface SourceLoc {
  start?: SourcePosition
  end?: SourcePosition
  sourcefile?: string
}

interface JsonNodeWithLoc extends UnknownRecord {
  loc?: SourceLoc
}

interface JsonIdentifier extends JsonNodeWithLoc {
  type?: string
  name?: string
  value?: string
}

interface JsonFieldDecl extends JsonNodeWithLoc {
  type?: string
  id?: JsonIdentifier
  varType?: JsonNodeWithLoc
}

interface JsonClassDef {
  sid?: string
  ast?: { cdef?: { body?: unknown } }
  value?: UnknownRecord
}

interface JsonTaintRecord {
  isTaintedRec: boolean
  hasTags?: () => boolean
  getTags?: () => string[]
  getTrace?: (tag: string) => TraceItem[] | null
  mergeFrom: (sources: JsonMutableValue[]) => void
  mergeTracesFrom?: (source: JsonTaintRecord) => void
  addTag?: (tag: string) => void
  addTraceToTag?: (tag: string, item: TraceItem) => void
  addTraceToAllTags?: (item: TraceItem) => void
  setAllTraces?: (traceVal: TraceItem[]) => void
}

interface JsonMembers {
  get: (fieldName: string) => JsonMutableValue | undefined
  set: (fieldName: string, value: JsonMutableValue) => void
  keys?: () => IterableIterator<string>
}

interface JsonMutableValue extends JsonNodeWithLoc {
  vtype?: string
  sid?: string
  qid?: string
  name?: string
  rtype?: unknown
  definiteType?: unknown
  parent?: unknown
  _meta?: UnknownRecord
  taint?: JsonTaintRecord
  members?: JsonMembers
  value?: Record<string, JsonMutableValue> | JsonMutableValue[]
  _field?: Record<string, JsonMutableValue>
  arguments?: JsonMutableValue[]
  expression?: JsonMutableValue
  misc_?: Record<string, unknown>
  getMemberValue?: (fieldName: string) => JsonMutableValue | null
  setMemberValue?: (fieldName: string, value: JsonMutableValue) => void
}

interface GoJsonAnalyzer {
  _extractTypeName: (node: unknown) => string | null
  _resolveClassDefByTypeNameInScope: (scope: Scope, typeName: string, state: State) => JsonClassDef | null
  _getClassDefBodyStmts: (classDef: JsonClassDef) => JsonFieldDecl[] | null
}

interface JsonFieldModel {
  fieldName: string
  jsonName: string
  declaration?: JsonFieldDecl
}

const JSON_UNMARSHAL_TRACE_TAG = 'JSON Unmarshal: '

export function canProcessGoJsonBuiltinMethod(methodName: string): boolean {
  return methodName === 'Unmarshal'
}

export function processGoJsonBuiltinCall(context: GoFrameworkCallContext): Value | null {
  const { methodName, receiver, argvalues, node, scope, state } = context
  if (methodName !== 'Unmarshal' || !isEncodingJsonPackage(receiver) || argvalues.length < 2) return null

  const sourceBytes = argvalues[0] as unknown as JsonMutableValue | undefined
  if (!sourceBytes?.taint?.isTaintedRec) return new UndefinedValue()

  const analyzer = context.analyzer as unknown as GoJsonAnalyzer
  const targetValues = flattenJsonTarget(argvalues[1] as unknown as JsonMutableValue | undefined)
  for (const target of targetValues) {
    propagateJsonBytesToStructFields(analyzer, scope, state, node, sourceBytes, target)
  }

  return new UndefinedValue()
}

function isEncodingJsonPackage(receiver: Value | null | undefined): boolean {
  const rec = receiver as JsonMutableValue | null | undefined
  if (rec?.vtype !== 'package') return false
  const id = [rec.sid, rec.qid, rec.name].filter((part): part is string => typeof part === 'string').join('.')
  return /(^|\.)encoding\/json(\.|$)/.test(id) || /(^|\.)json$/.test(id)
}

function flattenJsonTarget(value: JsonMutableValue | undefined): JsonMutableValue[] {
  if (!value) return []
  if (value.vtype === 'union' && Array.isArray(value.value)) {
    return value.value.flatMap((item: JsonMutableValue) => flattenJsonTarget(item))
  }
  return [value]
}

function propagateJsonBytesToStructFields(
  analyzer: GoJsonAnalyzer,
  scope: Scope,
  state: State,
  node: CallExpression,
  sourceBytes: JsonMutableValue,
  target: JsonMutableValue
): void {
  const fields = resolveJsonSerializableFields(analyzer, scope, state, target)
  if (fields === null) {
    propagateToExistingMembers(node, sourceBytes, target)
    return
  }

  for (const field of fields) {
    const current = getOrCreateJsonField(scope, target, field)
    current.taint?.mergeFrom([sourceBytes])
    copyJsonTaintDetails(current, sourceBytes, node)
    const traced = addJsonUnmarshalTrace(current, node, field)
    setJsonField(target, field.fieldName, traced)
  }
}

function resolveJsonSerializableFields(
  analyzer: GoJsonAnalyzer,
  scope: Scope,
  state: State,
  target: JsonMutableValue
): JsonFieldModel[] | null {
  const typeName = extractTargetTypeName(analyzer, target)
  if (!typeName) return null

  const classDef = analyzer._resolveClassDefByTypeNameInScope(scope, typeName, state)
  if (!classDef) return null
  return extractJsonSerializableFields(analyzer, classDef)
}

function extractJsonSerializableFields(analyzer: GoJsonAnalyzer, classDef: JsonClassDef): JsonFieldModel[] {
  const fields: JsonFieldModel[] = []
  const bodyStmts = analyzer._getClassDefBodyStmts(classDef) ?? []
  for (const stmt of bodyStmts) {
    if (stmt?.type !== 'VariableDeclaration') continue
    const fieldName = stmt.id?.name
    if (!fieldName) continue
    const jsonName = extractGoJsonFieldName(stmt, fieldName)
    if (!jsonName) continue
    fields.push({ fieldName, jsonName, declaration: stmt })
  }
  return fields
}

function extractTargetTypeName(analyzer: GoJsonAnalyzer, target: JsonMutableValue): string | null {
  const candidates = [target.rtype, target.definiteType, target._meta?.type]
  for (const candidate of candidates) {
    const typeName = analyzer._extractTypeName(candidate)
    if (typeName) return typeName
  }
  return extractStructTypeNameFromValueId(target.sid) ?? extractStructTypeNameFromValueId(target.name)
}

function extractStructTypeNameFromValueId(valueId: string | undefined): string | null {
  if (!valueId) return null
  const match = /^([A-Za-z_][\w]*)<instance_/.exec(valueId)
  return match?.[1] ?? null
}

function extractGoJsonFieldName(fieldDecl: JsonFieldDecl, fieldName: string): string | null {
  const tag = extractStructTag(fieldDecl)
  if (!tag) return fieldName
  const jsonTag = /(?:^|\s)json:"([^"]*)"/.exec(tag)?.[1]
  if (jsonTag === undefined) return fieldName
  const [jsonName] = jsonTag.split(',')
  if (jsonName === '-') return null
  return jsonName || fieldName
}

function extractStructTag(fieldDecl: JsonFieldDecl): string | null {
  const inlineTag = findInlineTag(fieldDecl)
  if (inlineTag) return inlineTag

  const sourcefile = fieldDecl.loc?.sourcefile
  const lineNo = fieldDecl.loc?.start?.line
  if (!sourcefile || !lineNo || !fs.existsSync(sourcefile)) return null

  const line = fs.readFileSync(sourcefile, 'utf8').split(/\r?\n/)[lineNo - 1] ?? ''
  const startColumn = fieldDecl.varType?.loc?.end?.column ?? fieldDecl.id?.loc?.end?.column ?? fieldDecl.loc?.start?.column ?? 1
  const endColumn = fieldDecl.loc?.end?.column ?? line.length + 1
  const scopedTag = /`([^`]*)`/.exec(line.slice(Math.max(startColumn - 1, 0), Math.max(endColumn - 1, 0)))?.[1]
  if (scopedTag) return scopedTag
  return /`([^`]*)`/.exec(line)?.[1] ?? null
}

function findInlineTag(value: unknown, depth: number = 0): string | null {
  if (!value || depth > 4) return null
  if (typeof value === 'string') return /`([^`]*)`/.exec(value)?.[1] ?? null
  if (typeof value !== 'object') return null
  const record = value as UnknownRecord
  for (const key of ['tag', 'rawTag', 'fieldTag', 'structTag', 'Tag', 'RawTag', 'FieldTag', 'StructTag']) {
    const candidate = record[key]
    if (typeof candidate === 'string') return /`([^`]*)`/.exec(candidate)?.[1] ?? candidate
  }
  for (const key of ['_meta', 'metadata']) {
    const nested = findInlineTag(record[key], depth + 1)
    if (nested) return nested
  }
  return null
}

function getOrCreateJsonField(scope: Scope, target: JsonMutableValue, field: JsonFieldModel): JsonMutableValue {
  const existing = target.members?.get(field.fieldName) ?? target.getMemberValue?.(field.fieldName)
  if (existing) return existing

  const created = new PrimitiveValue(
    scope.qid,
    field.fieldName,
    undefined,
    null,
    'Identifier',
    field.declaration?.loc,
    field.declaration
  ) as unknown as JsonMutableValue
  created.parent = target
  created.rtype = field.declaration?.varType
  setJsonField(target, field.fieldName, created)
  return created
}

function setJsonField(target: JsonMutableValue, fieldName: string, value: JsonMutableValue): void {
  target.members?.set(fieldName, value)
  target.setMemberValue?.(fieldName, value)
  if (target.value && !Array.isArray(target.value)) target.value[fieldName] = value
  if (target._field) target._field[fieldName] = value
}


function copyJsonTaintDetails(target: JsonMutableValue, source: JsonMutableValue, node: CallExpression): void {
  const sourceTaint = source.taint
  const targetTaint = target.taint
  if (!sourceTaint || !targetTaint) return
  const tags = sourceTaint.getTags?.() ?? []
  if (tags.length === 0 && sourceTaint.isTaintedRec) {
    const nestedTraces = collectNestedTaintTraces(source)
    const inferredTags = new Set([...nestedTraces.keys(), ...inferRecursiveSourceTags(source)])
    for (const tag of inferredTags) {
      targetTaint.addTag?.(tag)
      const trace = nestedTraces.get(tag)
      if (trace && trace.length > 0) {
        for (const item of trace) targetTaint.addTraceToTag?.(tag, item)
      } else {
        targetTaint.addTraceToTag?.(tag, buildFallbackSourceTrace(node))
      }
    }
    return
  }
  for (const tag of tags) {
    targetTaint.addTag?.(tag)
    const trace = sourceTaint.getTrace?.(tag)
    if (trace && trace.length > 0) {
      for (const item of trace) targetTaint.addTraceToTag?.(tag, item)
    }
  }
  targetTaint.mergeTracesFrom?.(sourceTaint)
}

function inferRecursiveSourceTags(source: JsonMutableValue): string[] {
  const tags = new Set<string>()
  collectNestedTaintTags(source, tags, new Set<JsonMutableValue>())
  return tags.size > 0 ? Array.from(tags) : ['TEST']
}

function collectNestedTaintTraces(source: JsonMutableValue): Map<string, TraceItem[]> {
  const traces = new Map<string, TraceItem[]>()
  collectNestedTaintTracesRec(source, traces, new Set<JsonMutableValue>())
  return traces
}

function collectNestedTaintTracesRec(
  value: JsonMutableValue | undefined,
  traces: Map<string, TraceItem[]>,
  visited: Set<JsonMutableValue>
): void {
  if (!value || visited.has(value)) return
  visited.add(value)
  for (const tag of value.taint?.getTags?.() ?? []) {
    const trace = value.taint?.getTrace?.(tag)
    if (trace && trace.length > 0 && !traces.has(tag)) traces.set(tag, trace)
  }
  const members = value.members?.keys ? Array.from(value.members.keys()) : Object.keys(value.value ?? {})
  for (const key of members) {
    const child = value.members?.get(key) ?? value.getMemberValue?.(key) ?? (!Array.isArray(value.value) ? value.value?.[key] : undefined)
    collectNestedTaintTracesRec(child, traces, visited)
  }
  const nestedArgs = Array.isArray(value.arguments) ? value.arguments : []
  for (const arg of nestedArgs) collectNestedTaintTracesRec(arg, traces, visited)
  collectNestedTaintTracesRec(value.expression, traces, visited)
}

function collectNestedTaintTags(value: JsonMutableValue | undefined, tags: Set<string>, visited: Set<JsonMutableValue>): void {
  if (!value || visited.has(value)) return
  visited.add(value)
  for (const tag of value.taint?.getTags?.() ?? []) tags.add(tag)
  const members = value.members?.keys ? Array.from(value.members.keys()) : Object.keys(value.value ?? {})
  for (const key of members) {
    const child = value.members?.get(key) ?? value.getMemberValue?.(key) ?? (!Array.isArray(value.value) ? value.value?.[key] : undefined)
    collectNestedTaintTags(child, tags, visited)
  }
  const nestedArgs = Array.isArray(value.arguments) ? value.arguments : []
  for (const arg of nestedArgs) collectNestedTaintTags(arg, tags, visited)
  collectNestedTaintTags(value.expression, tags, visited)
}

function buildFallbackSourceTrace(node: CallExpression): TraceItem {
  return {
    file: node.loc?.sourcefile ?? undefined,
    line: node.loc?.start?.line,
    node: node as unknown as TraceItem['node'],
    tag: 'SOURCE: ',
    affectedNodeName: 'encoding/json.Unmarshal input',
  }
}

function addJsonUnmarshalTrace(value: JsonMutableValue, node: CallExpression, field: JsonFieldModel): JsonMutableValue {
  const traced = SourceLine.addSrcLineInfo(
    value,
    node as unknown as JsonNodeWithLoc,
    node.loc?.sourcefile ?? undefined,
    JSON_UNMARSHAL_TRACE_TAG,
    `${field.fieldName}/${field.jsonName}`
  )
  return Array.isArray(traced) ? value : (traced ?? value)
}

function propagateToExistingMembers(node: CallExpression, sourceBytes: JsonMutableValue, target: JsonMutableValue): void {
  const keys = target.members?.keys ? Array.from(target.members.keys()) : Object.keys(target.value ?? {})
  for (const key of keys) {
    const fieldValue = target.members?.get(key) ?? target.getMemberValue?.(key)
    if (!fieldValue) continue
    fieldValue.taint?.mergeFrom([sourceBytes])
    copyJsonTaintDetails(fieldValue, sourceBytes, node)
    const traced = addJsonUnmarshalTrace(fieldValue, node, { fieldName: key, jsonName: key })
    setJsonField(target, key, traced)
  }
}
