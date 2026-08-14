import { FindingsCheckpointWriter, combineFindingsFinalizationErrors } from '../../common/findings-checkpoint'
/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-unused-vars, @typescript-eslint/no-use-before-define */
import JavaTypeRelatedInfoResolver from '../../../../resolver/java/java-type-related-info-resolver'
import type { Invocation } from '../../../../resolver/common/value/invocation'
import type { ClassHierarchy } from '../../../../resolver/common/value/class-hierarchy'
import type { TypeRelatedInfoResult } from '../../../../resolver/common/value/type-related-info-result'
import type { TaintRecord } from '../../common/value/taint-record'
import type {
  Scope,
  State,
  Value,
  SymbolValue as SymbolValueType,
  VoidValue as VoidValueType,
  BinaryExprValue,
  UnaryExprValue,
} from '../../../../types/analyzer'
import type {
  CompileUnit,
  VariableDeclaration,
  Identifier,
  MemberAccess,
  ClassDefinition,
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  NewExpression,
  UnaryExpression,
  TryStatement,
  RangeStatement,
  FunctionDefinition,
} from '../../../../types/uast'
import type { PrimitiveValue as PrimitiveValueType } from '../../../../types/value'
import type { CallInfo } from '../../common/call-args'
import { javaCallSummaryPolicy } from '../../common/call-summary/language/java'
import type { CallSummaryLanguagePolicy } from '../../common/call-summary/language/types'
import type Unit from '../../common/value/unit'

const _ = require('lodash')
const UastSpec = require('@ant-yasa/uast-spec')
const QidUnifyUtil = require('../../../../util/qid-unify-util')
const logger: import('../../../../util/logger').Logger = require('../../../../util/logger')(__filename)
const ScopeClass = require('../../common/scope')
const Parser = require('../../../parser/parser')
const JavaInitializer = require('./java-initializer')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const {
  ValueUtil: { FunctionValue, Scoped, PackageValue, PrimitiveValue, SymbolValue, VoidValue },
} = require('../../../util/value-util')
const Analyzer: typeof import('../../common/analyzer').Analyzer = require('../../common/analyzer')
const CheckerManager = require('../../common/checker-manager')
const CurrentEntryPoint = require('../../common/entrypoint/current-entrypoint')
const { executeViaEntryPointExecutor } =
  require('../../common/entrypoint/entrypoint-executor') as typeof import('../../common/entrypoint/entrypoint-executor')
const Constant = require('../../../../util/constant')
const Config = require('../../../../config')
const { handleException } = require('../../common/exception-handler')
const MemState = require('../../common/memState')
const {
  ValueUtil: { UndefinedValue, UnionValue },
} = require('../../../util/value-util')
const FullCallGraphFileEntryPoint = require('../../../../checker/common/full-callgraph-file-entrypoint')
const AstUtil = require('../../../../util/ast-util')
const SourceLine = require('../../common/source-line')
const { checkInvocationMatchSink } = require('../../../../checker/taint/common-kit/sink-util')
const { filterDataFromScope } = require('../../../../util/common-util')
const { getLegacyArgValues } = require('../../common/call-args')
const { addElementToBuffer, getAllElementFromBuffer, collectDeepTaintDonors } = require('./builtins/buffer')
const { yasaLog } = require('../../../../util/format-util')
const { createDeadlinePlan, createTimeoutLatch, formatBudgetMs } =
  require('../../common/entrypoint/deadline-scheduler') as typeof import('../../common/entrypoint/deadline-scheduler')

/** 接口虚分派未解析具体 receiver 时的 exhaustive fan-out 上限：超过阈值保留 lib fallback 防执行爆炸 */
const INTERFACE_EXHAUSTIVE_FAN_OUT_LIMIT = 64
const JAVA_INPUT_TAG = 'JAVA_INPUT'

type JavaTraceCarrier = Unit & {
  value?: Record<string, unknown> | unknown[]
  taint?: TaintRecord
}

type JavaRuntimeType = {
  definiteType?: unknown
  vagueType?: unknown
  type?: unknown
}

type JavaRuntimeValue = Unit & {
  object?: unknown
  parent?: unknown
  _this?: unknown
  rtype?: JavaRuntimeType
  runtime?: { execute?: unknown }
  getThisObj?: () => unknown
}

type MiscBufferCarrier = Value & {
  setMisc?: (key: string, value: unknown) => void
}

// 异步 callable 分派的执行单元：解释入口 fclos + 沿父作用域回读到的闭包实参。
type JavaCallableExecution = {
  executable: Value
  callArgs: Value[]
}

type JavaCalleeNode = {
  type?: string
  name?: string
  value?: string | number | boolean | null
  qid?: string
  sid?: string
  object?: JavaCalleeNode
  property?: JavaCalleeNode
}

type JavaSourceLocationShape = {
  sourcefile?: string | null
  start?: { line?: number; column?: number }
  end?: { line?: number; column?: number }
}

type JavaNodeMetaShape = {
  nodehash?: string
}

type JavaFunctionNodeShape = {
  loc?: JavaSourceLocationShape
  _meta?: JavaNodeMetaShape
}

type JavaFanoutMethodShape = SymbolValueType & {
  qid?: string
  uuid?: string
  loc?: JavaSourceLocationShape
  ast?: { node?: JavaFunctionNodeShape; fdef?: JavaFunctionNodeShape }
}

type JavaFanoutCallsiteNodeShape = CallExpression & {
  loc?: JavaSourceLocationShape
  _meta?: JavaNodeMetaShape
}

type JavaEntryPointShape = {
  type?: unknown
  filePath?: unknown
  functionName?: unknown
  attribute?: unknown
  entryPointSymVal?: {
    qid?: unknown
    ast?: {
      node?: { parameters?: unknown; loc?: { start?: { line?: number }; end?: { line?: number } } }
      fdef?: FunctionDefinition
    }
    overloaded?: unknown[]
    value?: Record<string, unknown>
  }
  scopeVal?: unknown
}

/**
 *
 * @param value
 */
function hasJavaInputSourceTrace(value: unknown): value is JavaTraceCarrier {
  const trace = (value as JavaTraceCarrier | undefined)?.taint?.getTrace(JAVA_INPUT_TAG)
  return (
    Array.isArray(trace) &&
    trace.some((step: unknown) => {
      const sourceStep = step as { tag?: unknown; str?: unknown }
      return (
        sourceStep.tag === 'SOURCE: ' || (typeof sourceStep.str === 'string' && sourceStep.str.includes('SOURCE: '))
      )
    })
  )
}

/**
 *
 * @param root
 * @param maxDepth
 * @param maxVisited
 * @param maxFanOut
 */
function findJavaInputTraceDonor(
  root: unknown,
  maxDepth = 4,
  maxVisited = 128,
  maxFanOut = 32
): JavaTraceCarrier | null {
  const deepDonors = collectDeepTaintDonors(root, {
    includeObjectValue: true,
    maxDepth: Math.max(maxDepth, 6),
    tag: JAVA_INPUT_TAG,
  }) as JavaTraceCarrier[]
  const sourceDonor = deepDonors.find((donor) => hasJavaInputSourceTrace(donor))
  if (sourceDonor) return sourceDonor

  const seen = new Set<unknown>()
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  while (queue.length > 0 && seen.size < maxVisited) {
    const current = queue.shift()
    if (!current) break
    const { value, depth } = current
    if (!value || typeof value !== 'object' || depth > maxDepth || seen.has(value)) continue
    seen.add(value)
    if (hasJavaInputSourceTrace(value)) {
      return value
    }
    if (depth === maxDepth) continue

    const carrier = value as JavaTraceCarrier
    let fanOut = 0
    const enqueue = (child: unknown): void => {
      if (fanOut >= maxFanOut || seen.size + queue.length >= maxVisited) return
      if (child && typeof child === 'object' && !seen.has(child)) {
        queue.push({ value: child, depth: depth + 1 })
        fanOut++
      }
    }
    const buffer = typeof carrier.getMisc === 'function' ? carrier.getMisc('buffer') : carrier.misc_?.buffer
    if (Array.isArray(buffer)) {
      for (const child of buffer) enqueue(child)
    }
    if (carrier.vtype === 'union' && Array.isArray(carrier.value)) {
      for (const child of carrier.value) enqueue(child)
    } else if (carrier.value && typeof carrier.value === 'object') {
      for (const child of Object.values(carrier.value)) enqueue(child)
    }
    const members = (carrier as unknown as { _members?: { forEach?: (callback: (child: unknown) => void) => void } })
      ._members
    if (members && typeof members.forEach === 'function') {
      try {
        members.forEach((child: unknown) => enqueue(child))
      } catch (_error) {
        // 代理成员可能抛出迭代异常，忽略后继续使用其它 donor。
      }
    }
  }
  return null
}

/**
 *
 * @param target
 * @param donor
 */
function attachJavaInputTraceFromDonor(target: unknown, donor: JavaTraceCarrier | null): boolean {
  if (!target || typeof target !== 'object' || !donor?.taint) return false
  const targetCarrier = target as JavaTraceCarrier
  if (!targetCarrier.taint || targetCarrier === donor || hasJavaInputTraceKey(targetCarrier)) return false
  const buffer =
    typeof targetCarrier.getMisc === 'function' ? targetCarrier.getMisc('buffer') : targetCarrier.misc_?.buffer
  if (typeof targetCarrier.getMisc === 'function' && (!Array.isArray(buffer) || !buffer.includes(donor))) {
    addElementToBuffer(targetCarrier, donor)
  }
  if (typeof targetCarrier.taint.addTag === 'function') targetCarrier.taint.addTag(JAVA_INPUT_TAG)
  if (typeof targetCarrier.taint.mergeTracesFrom === 'function') {
    targetCarrier.taint.mergeTracesFrom(donor.taint)
    return true
  }
  return false
}

/**
 *
 * @param target
 * @param donor
 */
function attachJavaInputTraceKeyFromDonor(target: unknown, donor: JavaTraceCarrier | null): boolean {
  if (!target || typeof target !== 'object' || !donor?.taint) return false
  const targetCarrier = target as JavaTraceCarrier
  if (!targetCarrier.taint || targetCarrier === donor || hasJavaInputTraceKey(targetCarrier)) return false
  if (typeof targetCarrier.taint.addTag === 'function') targetCarrier.taint.addTag(JAVA_INPUT_TAG)
  if (typeof targetCarrier.taint.mergeTracesFrom === 'function') {
    targetCarrier.taint.mergeTracesFrom(donor.taint)
    return true
  }
  return false
}

/**
 *
 * @param value
 */
function isJavaMapperBeanCopyReturn(value: unknown): boolean {
  if (!isObjectLikeJavaReturn(value)) return false
  const typeText = getJavaCarrierTypeText(value)
  if (!typeText) return true
  return (
    /(^|[.$])(Request|Req|Query|Param|Command|Cmd|DTO|Dto|VO|Vo|BO|Bo|DO|Do)(<|$|[.$_])/.test(typeText) ||
    /(Request|Req|Query|Param|Command|Cmd|DTO|Dto|VO|Vo|BO|Bo|DO|Do)(<|$)/.test(typeText) ||
    /\b(convert|copy|map|transform|translate)[A-Z0-9_]/.test(typeText)
  )
}

/**
 *
 * @param node
 */
function getJavaMethodNameFromCallee(node: CallExpression): string | undefined {
  const callee = node.callee as JavaCalleeNode | undefined
  const property = callee?.property
  if (typeof property?.name === 'string') return property.name
  if (typeof property?.sid === 'string') return property.sid
  if (typeof property?.qid === 'string') return property.qid.split('.').pop()
  if (typeof callee?.name === 'string') return callee.name
  if (typeof callee?.sid === 'string') return callee.sid
  if (typeof callee?.qid === 'string') return callee.qid.split('.').pop()
  return undefined
}

/**
 *
 * @param methodName
 */
function isJavaBeanCopyMethodName(methodName: string | undefined): boolean {
  if (!methodName) return false
  return /^(convert|copy|map|to|from|build|transform|translate|parse|create)[A-Z0-9_]/.test(methodName)
}

/**
 * @param methodName
 */
function isJavaRequestBuilderMethodName(methodName: string | undefined): boolean {
  if (!methodName) return false
  const simpleName = methodName.split('.').pop() ?? methodName
  return /^(build|create|make|new)[A-Z0-9_].*(Request|Query|Clause)$/.test(simpleName)
}

/**
 * @param methodName
 */
function isJavaDataAccessMethodName(methodName: string | undefined): boolean {
  if (!methodName) return false
  const prefixes = ['find', 'query', 'select', 'search', 'load', 'fetch']
  return prefixes.some((prefix) => {
    const pascalPrefix = prefix.charAt(0).toUpperCase() + prefix.slice(1)
    const upperPrefix = prefix.toUpperCase()
    return (
      methodName === prefix ||
      (methodName.startsWith(prefix) && /[A-Z0-9_]/.test(methodName.charAt(prefix.length))) ||
      methodName === pascalPrefix ||
      (methodName.startsWith(pascalPrefix) && /[A-Z0-9_]/.test(methodName.charAt(pascalPrefix.length))) ||
      javaMethodHasCamelToken(methodName, pascalPrefix) ||
      methodName === upperPrefix ||
      methodName.startsWith(`${upperPrefix}_`)
    )
  })
}

/**
 * @param methodName
 * @param token
 */
function javaMethodHasCamelToken(methodName: string, token: string): boolean {
  const index = methodName.indexOf(token)
  if (index <= 0) return false
  const previous = methodName.charAt(index - 1)
  const next = methodName.charAt(index + token.length)
  return /[a-z0-9]/.test(previous) && (next === '' || /[A-Z0-9_]/.test(next))
}

/**
 *
 * @param node
 * @param fclos
 */
function isJavaInterfaceOrNoBodyMapperCall(node: CallExpression, fclos: Value): boolean {
  if (node.callee?.type !== 'MemberAccess') return false
  if (fclos.runtime?.execute) return false
  if (fclos.vtype !== 'fclos' && fclos.vtype !== 'symbol') return false
  if (fclos.vtype === 'symbol') return true
  const fdef = (fclos as SymbolValueType).ast?.fdef as { body?: { type?: string; body?: unknown[] } } | undefined
  if (!fdef?.body || fdef.body.type === 'Noop') return true
  return Array.isArray(fdef.body.body) && fdef.body.body.length === 0
}

/**
 *
 * @param value
 */
function hasJavaInputTraceKey(value: unknown): boolean {
  const carrier = value as JavaTraceCarrier | undefined
  const trace = carrier?.taint?.getTrace?.(JAVA_INPUT_TAG)
  if (Array.isArray(trace)) return true
  const tagCarrier = carrier?.taint as { tagTraces?: unknown } | undefined
  const tagTraces = tagCarrier?.tagTraces
  return tagTraces instanceof Map && tagTraces.has(JAVA_INPUT_TAG)
}

/**
 *
 * @param value
 */
function isObjectLikeJavaReturn(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const carrier = value as JavaTraceCarrier
  if (carrier.vtype === 'primitive' || carrier.vtype === 'fclos' || carrier.vtype === 'class') return false
  return typeof carrier.getMisc === 'function' || Boolean(carrier.value && typeof carrier.value === 'object')
}

/**
 *
 * @param value
 */
function isJavaObjectCarrier(value: unknown): value is JavaTraceCarrier {
  if (!value || typeof value !== 'object') return false
  const carrier = value as JavaTraceCarrier
  return (carrier.vtype === 'object' || carrier.vtype === 'symbol') && Boolean(carrier.taint)
}

/**
 *
 * @param argvalues
 */
function findJavaInputArgumentDonor(argvalues: readonly unknown[]): JavaTraceCarrier | null {
  for (const arg of argvalues) {
    const donor = findJavaInputTraceDonor(arg)
    if (donor) return donor
  }
  return null
}

/**
 *
 * @param value
 */
function getJavaCarrierTypeText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const carrier = value as {
    logicalQid?: unknown
    qid?: unknown
    sid?: unknown
    rtype?: { type?: unknown; definiteType?: unknown }
  }
  const raw =
    carrier.logicalQid ?? carrier.rtype?.definiteType ?? carrier.rtype?.type ?? carrier.qid ?? carrier.sid ?? ''
  return typeof raw === 'string' ? raw : AstUtil.prettyPrint(raw)
}

/**
 *
 * @param value
 */
function isRequestLikeJavaCarrier(value: unknown): boolean {
  const typeText = getJavaCarrierTypeText(value)
  return (
    /(^|[.$])(Request|Req|Query|Param|Command|Cmd|DTO|Dto)(<|$|[.$_])/.test(typeText) ||
    /(Request|Req|Query|Param|Command|Cmd|DTO|Dto)(<|$)/.test(typeText)
  )
}

/**
 *
 * @param methodName
 */
function getJavaBeanSetterFieldName(methodName: string | undefined): string | undefined {
  if (!methodName || !/^set[A-Z]/.test(methodName) || methodName.length <= 3) return undefined
  const suffix = methodName.slice(3)
  return suffix.charAt(0).toLowerCase() + suffix.slice(1)
}

type JavaAstRecord = Record<string, unknown>
type JavaClassScopeRecord = {
  members?: Map<string, SymbolValueType>
  value?: Record<string, SymbolValueType>
  ast?: { node?: JavaAstRecord }
}

/**
 *
 * @param value
 */
function isJavaAstRecord(value: unknown): value is JavaAstRecord {
  return Boolean(value && typeof value === 'object')
}

/**
 *
 * @param value
 */
function getJavaAstIdentifierName(value: unknown): string | null {
  if (!isJavaAstRecord(value)) return null
  if (typeof value.name === 'string') return value.name
  const { id } = value
  if (isJavaAstRecord(id) && typeof id.name === 'string') return id.name
  return null
}

/**
 *
 * @param fdef
 */
function collectJavaParameterNames(fdef: unknown): Set<string> {
  return new Set(collectJavaParameterNameList(fdef).filter((name): name is string => Boolean(name)))
}

/**
 *
 * @param fdef
 */
function collectJavaParameterNameList(fdef: unknown): Array<string | null> {
  if (!isJavaAstRecord(fdef) || !Array.isArray(fdef.parameters)) return []
  return fdef.parameters.map((parameter) => getJavaAstIdentifierName(parameter))
}

/**
 * @param fdef
 */
function javaAstGetExecutableStatements(fdef: JavaAstRecord): unknown[] {
  const { body } = fdef
  if (isJavaAstRecord(body) && Array.isArray(body.body)) return [...body.body]
  if (Array.isArray(body)) return [...body]
  return [fdef]
}

/**
 * @param value
 */
function isJavaNestedExecutableContainer(value: unknown): boolean {
  return isJavaAstRecord(value) && (value.type === 'FunctionDefinition' || value.type === 'ClassDefinition')
}

/**
 *
 * @param root
 * @param names
 * @param maxDepth
 */
function javaAstContainsIdentifier(root: unknown, names: ReadonlySet<string>, maxDepth = 12): boolean {
  const seen = new Set<unknown>()
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    const { value, depth } = current
    if (!isJavaAstRecord(value) || seen.has(value) || depth > maxDepth) continue
    seen.add(value)
    const nodeType = value.type
    if (nodeType === 'Identifier') {
      const name = getJavaAstIdentifierName(value)
      if (name && names.has(name)) return true
    }
    if (depth === maxDepth) continue
    for (const [key, child] of Object.entries(value)) {
      if (key === 'loc' || key === 'range' || key === 'comments' || key === 'parent') continue
      if (Array.isArray(child)) {
        for (const item of child) queue.push({ value: item, depth: depth + 1 })
      } else if (isJavaAstRecord(child)) {
        queue.push({ value: child, depth: depth + 1 })
      }
    }
  }
  return false
}

/**
 *
 * @param fdef
 */
function javaReturnExpressionReferencesParameter(fdef: unknown): boolean {
  const parameterNames = collectJavaParameterNames(fdef)
  if (parameterNames.size === 0 || !isJavaAstRecord(fdef)) return false
  const seen = new Set<unknown>()
  const queue: unknown[] = [fdef]
  while (queue.length > 0) {
    const value = queue.shift()
    if (!isJavaAstRecord(value) || seen.has(value)) continue
    seen.add(value)
    if (value !== fdef && value.type === 'FunctionDefinition') continue
    if (value.type === 'ReturnStatement' && javaAstContainsIdentifier(value.argument, parameterNames)) {
      return true
    }
    enqueueJavaAstChildrenSkippingNestedFunctions(queue, value, fdef)
  }
  return false
}

/**
 *
 * @param root
 */
function javaAstNodeText(root: unknown): string {
  if (!root) return ''
  if (isJavaAstRecord(root)) {
    const directName = getJavaAstIdentifierName(root)
    if (directName) return directName
    if (root.type === 'MemberAccess') {
      return `${javaAstNodeText(root.object)}.${javaAstNodeText(root.property)}`
    }
    if (root.type === 'FunctionCall' || root.type === 'CallExpression') {
      return javaAstNodeText(root.callee ?? root.expression)
    }
  }
  try {
    const printed = AstUtil.prettyPrint(root)
    if (printed && printed !== '[object Object]') return printed
  } catch (_error) {
    // prettyPrint 失败时使用节点元数据保留可匹配名称。
  }
  const record = root as { name?: unknown; sid?: unknown; qid?: unknown; value?: unknown }
  return String(record.name ?? record.sid ?? record.qid ?? record.value ?? '')
}

/**
 *
 * @param node
 */
function javaCallNameFromAst(node: JavaAstRecord): string {
  const callee = isJavaAstRecord(node.callee)
    ? node.callee
    : isJavaAstRecord(node.expression)
      ? node.expression
      : undefined
  const property = isJavaAstRecord(callee?.property) ? callee.property : undefined
  const candidates = [property, callee, node]
  for (const candidate of candidates) {
    const name = getJavaAstIdentifierName(candidate)
    if (name) return name
  }
  return javaAstNodeText(callee).split('.').pop() ?? ''
}

/**
 *
 * @param node
 */
function isJavaAstCallNode(node: JavaAstRecord): boolean {
  return node.type === 'CallExpression' || node.type === 'FunctionCall'
}

/**
 *
 * @param node
 */
function javaAstCallReceiverName(node: JavaAstRecord): string | null {
  const callee = isJavaAstRecord(node.callee)
    ? node.callee
    : isJavaAstRecord(node.expression)
      ? node.expression
      : undefined
  return getJavaAstIdentifierName((callee as JavaCalleeNode | undefined)?.object)
}

/**
 *
 * @param node
 */
function javaExternalQueryCallBoundaryText(node: JavaAstRecord): string {
  const callee = isJavaAstRecord(node.callee)
    ? node.callee
    : isJavaAstRecord(node.expression)
      ? node.expression
      : undefined
  const object = isJavaAstRecord(callee?.object) ? callee.object : undefined
  return `${javaAstNodeText(callee)} ${javaAstNodeText(object)}`.toLowerCase()
}

/**
 *
 * @param node
 */
function javaAstCallMatchesExternalQueryBoundary(node: JavaAstRecord): boolean {
  if (!isJavaAstCallNode(node)) return false
  const methodName = javaCallNameFromAst(node)
  const boundaryText = javaExternalQueryCallBoundaryText(node)
  const hasDataAccessBoundary =
    /(mapper|dao|repository|jdbc|sql|database|datasource|table|storage|cache|redis|hbase|lindorm|elastic|search|client|adapter|template)/.test(
      boundaryText
    )
  if (!hasDataAccessBoundary) return false
  if (
    /^(getData|getObject|getBy|select|selectBy|query|queryBy|find|findBy|fetch|load|read|scan|search)(?:$|[A-Z0-9_])/.test(
      methodName
    )
  ) {
    return true
  }
  return /(?:List|Page|Count|Detail|Info|Infos)$/.test(methodName)
}

/**
 *
 * @param root
 * @param maxDepth
 */
function javaAstContainsExternalQueryCall(root: unknown, maxDepth = 12): boolean {
  const seen = new Set<unknown>()
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    const { value, depth } = current
    if (!isJavaAstRecord(value) || seen.has(value) || depth > maxDepth) continue
    seen.add(value)
    if (javaAstCallMatchesExternalQueryBoundary(value)) return true
    if (depth === maxDepth) continue
    for (const [key, child] of Object.entries(value)) {
      if (key === 'loc' || key === 'range' || key === 'comments' || key === 'parent') continue
      if (Array.isArray(child)) {
        for (const item of child) queue.push({ value: item, depth: depth + 1 })
      } else if (isJavaAstRecord(child)) {
        queue.push({ value: child, depth: depth + 1 })
      }
    }
  }
  return false
}

/**
 *
 * @param queue
 * @param value
 * @param root
 */
function enqueueJavaAstChildrenSkippingNestedFunctions(queue: unknown[], value: JavaAstRecord, root: unknown): void {
  for (const [key, child] of Object.entries(value)) {
    if (key === 'parameters' || key === 'loc' || key === 'range' || key === 'comments' || key === 'parent') continue
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item !== root && isJavaAstRecord(item) && item.type === 'FunctionDefinition') continue
        queue.push(item)
      }
    } else if (isJavaAstRecord(child)) {
      if (child !== root && child.type === 'FunctionDefinition') continue
      queue.push(child)
    }
  }
}

/**
 *
 * @param fdef
 */
function javaReturnExpressionReferencesExternalQueryResult(fdef: unknown): boolean {
  const parameterNames = collectJavaParameterNames(fdef)
  if (parameterNames.size === 0 || !isJavaAstRecord(fdef)) return false
  const carrierNames = new Set(parameterNames)
  const queryResultNames = new Set<string>()
  const seen = new Set<unknown>()
  const queue: unknown[] = [fdef]
  while (queue.length > 0) {
    const value = queue.shift()
    if (!isJavaAstRecord(value) || seen.has(value)) continue
    seen.add(value)
    if (value !== fdef && value.type === 'FunctionDefinition') continue
    if (value.type === 'VariableDeclaration') {
      const name = getJavaAstIdentifierName(value.id)
      if (name && javaAstContainsIdentifier(value.init, carrierNames)) {
        if (javaAstContainsExternalQueryCall(value.init)) queryResultNames.add(name)
        carrierNames.add(name)
      }
    }
    enqueueJavaAstChildrenSkippingNestedFunctions(queue, value, fdef)
  }
  if (queryResultNames.size === 0) return false

  const returnSeen = new Set<unknown>()
  const returnQueue: unknown[] = [fdef]
  while (returnQueue.length > 0) {
    const value = returnQueue.shift()
    if (!isJavaAstRecord(value) || returnSeen.has(value)) continue
    returnSeen.add(value)
    if (value !== fdef && value.type === 'FunctionDefinition') continue
    if (value.type === 'ReturnStatement' && javaAstContainsIdentifier(value.argument, queryResultNames)) {
      return true
    }
    enqueueJavaAstChildrenSkippingNestedFunctions(returnQueue, value, fdef)
  }
  return false
}

/**
 * @param fdef
 */
const javaQueryReturnDecisionCache: WeakMap<JavaAstRecord, Map<string, boolean>> = new WeakMap()

/**
 * @param fdef
 * @param argvalues
 */
function javaReturnExpressionReferencesTaintedQueryResult(fdef: unknown, argvalues: readonly unknown[]): boolean {
  if (!isJavaAstRecord(fdef)) return false
  const parameterNames = collectJavaParameterNameList(fdef)
  const taintedNames = new Set<string>()
  const taintedIndexes: number[] = []
  parameterNames.forEach((name, index) => {
    if (name && findJavaInputTraceDonor(argvalues[index])) {
      taintedNames.add(name)
      taintedIndexes.push(index)
    }
  })
  if (taintedNames.size === 0) return false

  const cacheKey = taintedIndexes.join(',')
  const cachedByMethod = javaQueryReturnDecisionCache.get(fdef)
  const cached = cachedByMethod?.get(cacheKey)
  if (cached !== undefined) return cached

  const queryResultNames = new Set<string>()
  const returnedNames = new Set<string>()
  const seen = new Set<unknown>()
  const queue: unknown[] = javaAstGetExecutableStatements(fdef)
  while (queue.length > 0) {
    const value = queue.shift()
    if (!isJavaAstRecord(value) || seen.has(value)) continue
    seen.add(value)

    if (value.type === 'FunctionDefinition' || value.type === 'ClassDefinition') continue
    if (isJavaAstCallNode(value)) {
      javaAstMarkCopiedTaintNames(value, taintedNames)
    }
    if (value.type === 'VariableDeclaration') {
      const name = getJavaAstIdentifierName(value)
      const initializer = value.initializer ?? value.init ?? value.value ?? value.right ?? value.expression
      if (name && javaAstContainsIdentifier(initializer, taintedNames)) taintedNames.add(name)
      if (name && javaAstLooksLikeDataAccessCallUsingNames(initializer, taintedNames)) queryResultNames.add(name)
    }
    if (value.type === 'ReturnStatement') {
      javaAstCollectReferencedNames(value.argument, returnedNames)
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'parameters' || key === 'loc' || key === 'range' || key === 'comments' || key === 'parent') continue
      if (isJavaNestedExecutableContainer(child)) continue
      if (Array.isArray(child)) queue.push(...child.filter((item) => !isJavaNestedExecutableContainer(item)))
      else if (isJavaAstRecord(child)) queue.push(child)
    }
  }
  const result =
    javaSetIntersects(returnedNames, queryResultNames) ||
    javaSetIntersects(returnedNames, collectJavaLocalsDerivedFromQuery(fdef, queryResultNames))
  const nextCache = cachedByMethod ?? new Map<string, boolean>()
  nextCache.set(cacheKey, result)
  if (!cachedByMethod) javaQueryReturnDecisionCache.set(fdef, nextCache)
  return result
}

/**
 * @param root
 * @param taintedNames
 */
function javaAstLooksLikeDataAccessCallUsingNames(root: unknown, taintedNames: ReadonlySet<string>): boolean {
  if (!isJavaAstRecord(root)) return false
  const seen = new Set<unknown>()
  const queue: unknown[] = [root]
  while (queue.length > 0) {
    const value = queue.shift()
    if (!isJavaAstRecord(value) || seen.has(value)) continue
    seen.add(value)
    if (
      isJavaAstCallNode(value) &&
      javaAstCallMatchesExternalQueryBoundary(value) &&
      javaAstContainsIdentifier(value, taintedNames)
    ) {
      return true
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'loc' || key === 'range' || key === 'comments' || key === 'parent') continue
      if (Array.isArray(child)) queue.push(...child)
      else if (isJavaAstRecord(child)) queue.push(child)
    }
  }
  return false
}

/**
 * @param root
 * @param names
 */
function javaAstCollectReferencedNames(root: unknown, names: Set<string>): void {
  const seen = new Set<unknown>()
  const queue: unknown[] = [root]
  while (queue.length > 0) {
    const value = queue.shift()
    if (!isJavaAstRecord(value) || seen.has(value)) continue
    seen.add(value)
    if (value.type === 'Identifier') {
      const name = getJavaAstIdentifierName(value)
      if (name) names.add(name)
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'loc' || key === 'range' || key === 'comments' || key === 'parent') continue
      if (Array.isArray(child)) queue.push(...child)
      else if (isJavaAstRecord(child)) queue.push(child)
    }
  }
}

/**
 * @param fdef
 * @param queryResultNames
 */
function collectJavaLocalsDerivedFromQuery(fdef: unknown, queryResultNames: ReadonlySet<string>): Set<string> {
  const derivedNames = new Set<string>()
  if (queryResultNames.size === 0 || !isJavaAstRecord(fdef)) return derivedNames
  const seen = new Set<unknown>()
  const queue: unknown[] = javaAstGetExecutableStatements(fdef)
  while (queue.length > 0) {
    const value = queue.shift()
    if (!isJavaAstRecord(value) || seen.has(value)) continue
    seen.add(value)
    if (value.type === 'FunctionDefinition' || value.type === 'ClassDefinition') continue
    if (isJavaAstCallNode(value)) {
      const methodName = javaCallNameFromAst(value)
      if (methodName === 'add' && javaAstContainsIdentifier(value, queryResultNames)) {
        const receiverName = javaAstCallReceiverName(value)
        if (receiverName) derivedNames.add(receiverName)
      }
      if (methodName === 'forEach' && javaAstReceiverNameInSet(value, queryResultNames)) {
        javaAstCollectAddReceivers(value, derivedNames)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'parameters' || key === 'loc' || key === 'range' || key === 'comments' || key === 'parent') continue
      if (isJavaNestedExecutableContainer(child)) continue
      if (Array.isArray(child)) queue.push(...child.filter((item) => !isJavaNestedExecutableContainer(item)))
      else if (isJavaAstRecord(child)) queue.push(child)
    }
  }
  return derivedNames
}

/**
 * @param root
 * @param taintedNames
 */
function javaAstMarkCopiedTaintNames(root: JavaAstRecord, taintedNames: Set<string>): void {
  const methodName = javaCallNameFromAst(root)
  if (!methodName || !/^(copyProperties|copy)$/.test(methodName)) return
  const args = Array.isArray(root.arguments) ? root.arguments : []
  if (args.length < 2 || !javaAstContainsIdentifier(args[0], taintedNames)) return
  const targetName = getJavaAstIdentifierName(args[1])
  if (targetName) taintedNames.add(targetName)
}

/**
 * @param call
 * @param names
 */
function javaAstReceiverNameInSet(call: JavaAstRecord, names: ReadonlySet<string>): boolean {
  const receiverName = javaAstCallReceiverName(call)
  return Boolean(receiverName && names.has(receiverName))
}

/**
 * @param root
 * @param receiverNames
 */
function javaAstCollectAddReceivers(root: unknown, receiverNames: Set<string>): void {
  const seen = new Set<unknown>()
  const queue: unknown[] = [root]
  while (queue.length > 0) {
    const value = queue.shift()
    if (!isJavaAstRecord(value) || seen.has(value)) continue
    seen.add(value)
    if (isJavaAstCallNode(value)) {
      const methodName = javaCallNameFromAst(value)
      if (methodName === 'add') {
        const receiverName = javaAstCallReceiverName(value)
        if (receiverName) receiverNames.add(receiverName)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'loc' || key === 'range' || key === 'comments' || key === 'parent') continue
      if (Array.isArray(child)) queue.push(...child)
      else if (isJavaAstRecord(child)) queue.push(child)
    }
  }
}

/**
 * @param left
 * @param right
 */
function javaSetIntersects<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  for (const value of left) {
    if (right.has(value)) return true
  }
  return false
}

/**
 *
 * @param target
 * @param donor
 */
function attachJavaInputTraceToReturnGraph(target: unknown, donor: JavaTraceCarrier | null): void {
  if (!target || typeof target !== 'object' || !donor) return
  if (javaReturnGraphAlreadyHasDonor(target, donor)) return
  attachJavaInputTraceFromDonor(target, donor)
  const carrier = target as JavaTraceCarrier
  const buffer = typeof carrier.getMisc === 'function' ? carrier.getMisc('buffer') : carrier.misc_?.buffer
  if (Array.isArray(buffer)) {
    for (const child of buffer) attachJavaInputTraceFromDonor(child, donor)
  }
  if (carrier.value && typeof carrier.value === 'object') {
    for (const child of Object.values(carrier.value)) {
      if (child && typeof child === 'object') attachJavaInputTraceFromDonor(child, donor)
    }
  }
}

/**
 * @param target
 * @param donor
 */
function javaReturnGraphAlreadyHasDonor(target: unknown, donor: JavaTraceCarrier): boolean {
  if (!target || typeof target !== 'object') return false
  const carrier = target as JavaTraceCarrier
  const buffer = typeof carrier.getMisc === 'function' ? carrier.getMisc('buffer') : carrier.misc_?.buffer
  return Array.isArray(buffer) && buffer.includes(donor) && hasJavaInputTraceKey(carrier)
}

/**
 * @param receiver
 */
function javaSetterReceiverAcceptsInputTrace(receiver: JavaTraceCarrier): boolean {
  if (isRequestLikeJavaCarrier(receiver)) return true
  const typeText = getJavaCarrierTypeText(receiver)
  return typeText === '' || /(^|[.$])\w*(?:Request|Query|Clause)(<|$|[.$_])/.test(typeText)
}

/**
 * Java 代码分析器
 */
class JavaAnalyzer extends Analyzer {
  protected override readonly callSummaryLanguagePolicy: CallSummaryLanguagePolicy = javaCallSummaryPolicy

  // 同一 callsite 单入口内解释次数限流：避免 builder/fluent chain 重复进入导致路径爆炸
  protected callsiteInterpretCount: Map<string, number> = new Map()

  private static readonly CALLSITE_INTERPRET_LIMIT = 200

  // 同一方法（fclos qid/sid）单入口内累计执行时间限流：避免重业务方法展开耗尽入口点预算
  protected methodCumulativeTime: Map<string, number> = new Map()

  private static readonly METHOD_CUMULATIVE_TIME_LIMIT_MS = 2000

  private unprocessedFileScopes?: Set<Scope>

  protected completedFanoutImplementations: Map<string, Set<string>> = new Map()

  protected currentFanoutOverloadIdentity = ''

  /**
   * 构造函数
   * @param options - 分析器选项
   */
  constructor(options: any) {
    const checkerManager = new CheckerManager(
      options,
      options.checkerIds,
      options.checkerPackIds,
      options.printers,
      BasicRuleHandler
    )
    super(checkerManager, options)
    this.classMap = new Map()
    this.typeResolver = new JavaTypeRelatedInfoResolver()
    this.entryPointSymValArray = []
    this.globalState = {}
    this.enableLibArgToThis = true
    this.enablePruneDuringInterpret = true
    this.pruneInfoMap = {
      aggressiveMode: false,
      sinkArray: [],
      funcCallSourceSinkSanitizerArray: [],
      otherSourceArray: [],
      otherSanitizerArray: [],
      matchSinkCacheMap: new Map(),
      matchSinkNoRecurseCacheMap: new Map(),
      matchFuncCallSourceSinkSanitizerCacheMap: new Map(),
      sofaStrictMatchSinkCacheMap: new Map(),
      dynamicClassArray: [
        'Class',
        'Thread',
        'Runnable',
        'java.util.Timer',
        'java.util.TimerTask',
        'org.springframework.util.ReflectionUtils',
      ],
      dynamicPackageArray: [
        'java.util.concurrent',
        'java.lang.reflect',
        'java.util.function',
        'org.springframework.core.task',
        'org.springframework.scheduling',
        'org.springframework.util.function',
        'org.springframework.retry',
        'org.springframework.web.reactive.function',
        'org.springframework.web.servlet.function',
        'org.springframework.integration.dsl',
        'org.springframework.cloud.function',
        'org.springframework.kafka.listener',
        'reactor.core',
      ],
    }
    this.timeoutEntryPoints = []
    this.clearFanoutContinuationState()
    this.extraClassHierarchyByNameMap = new Map()
  }

  /**
   * 预处理单个文件
   * @param source - 源代码内容
   * @param fileName - 文件名
   */
  preProcess4SingleFile(source: any, fileName: any) {
    JavaInitializer.initGlobalScope(this.topScope)
    JavaInitializer.initPackageScope(this.topScope.context.packages)

    this.preloadFileToPackage(source, fileName)
    for (const unprocessedFileScope of this.unprocessedFileScopes!) {
      if (unprocessedFileScope.isProcessed) continue
      const state = this.initState(unprocessedFileScope)
      this.processInstruction(unprocessedFileScope, unprocessedFileScope.ast?.node, state)
    }
    this.unprocessedFileScopes?.clear()
    this.unprocessedFileScopes = undefined

    this.assembleClassMap(this.topScope.context.packages)

    JavaInitializer.addClassProto(this.classMap, this.topScope.context.packages, this)
  }

  /**
   * 扫描项目目录，解析 Java 文件并预构建包作用域
   *
   * @param dir - 项目目录
   */
  // eslint-disable-next-line complexity
  async scanPackages(dir: any) {
    this.unprocessedFileScopes = new Set()
    const PARSE_CODE_STAGE = 'preProcess.parseCode'
    const PRELOAD_STAGE = 'preProcess.preload'

    // 开始解析阶段：解析源代码为 AST
    this.performanceTracker.start(PARSE_CODE_STAGE)
    const astMap = await Parser.parseProject(dir, this.options, this.sourceCodeCache)
    this.performanceTracker.end(PARSE_CODE_STAGE)

    // 防御性检查：确保 astMap 不为 null 或 undefined
    if (!astMap) {
      handleException(
        null,
        'JavaAnalyzer.scanPackages: parseProject returned null or undefined',
        'JavaAnalyzer.scanPackages: parseProject returned null or undefined'
      )
      return
    }

    // 开始预加载阶段：预构建包作用域
    this.performanceTracker.start(PRELOAD_STAGE)
    for (const filename in astMap) {
      const ast = astMap[filename]
      if (ast) {
        // sourceCodeCache 已在 parseProject 中自动填充，不需要重新读取
        const code = this.sourceCodeCache.get(filename)
        this.preloadFileToPackage(code ? code.join('\n') : '', filename, ast)
      }
    }
    this.performanceTracker.end(PRELOAD_STAGE)
    // 开始 ProcessModule 阶段：处理所有文件作用域（分析 AST）
    const PROCESS_MODULE_STAGE = 'preProcess.processModule'
    this.performanceTracker.start(PROCESS_MODULE_STAGE)
    this.callSummarySessions[0].beginForLanguage('Java')
    try {
      for (const unprocessedFileScope of this.unprocessedFileScopes!) {
        if (unprocessedFileScope.isProcessed) continue
        // unprocessedFileScope.isProcessed = true;
        const state = this.initState(unprocessedFileScope)
        this.processInstruction(unprocessedFileScope, unprocessedFileScope.ast?.node, state)
      }
    } finally {
      this.unprocessedFileScopes?.clear()
      this.unprocessedFileScopes = undefined
      this.callSummarySessions[0].finish()
      this.performanceTracker.end(PROCESS_MODULE_STAGE)
    }

    // 输出时间统计（performanceTracker 已自动输出各阶段耗时）
  }

  /**
   * preload built-in packages
   */
  preloadBuiltinToPackage() {
    // this._preloadBuiltinToPackage('java.util', 'ArrayList', (arrayList as any))
  }

  /**
   * 预加载内置包到包管理器
   * @param packageName - 包名
   * @param className - 类名
   * @param methods - 方法集合
   */
  _preloadBuiltinToPackage(packageName: string, className: string, methods: any) {
    const packageScope = this.topScope.context.packages.getSubPackage(packageName, true)
    const qualifiedName = ScopeClass.joinQualifiedName(packageScope.qid, className)
    const classScope = ScopeClass.createSubScope(className, packageScope, 'class', qualifiedName)
    if (!packageScope.scope.exports) {
      packageScope.scope.exports = new Scoped(packageScope.qid, {
        sid: 'exports',
        parent: packageScope,
      })
    }
    packageScope.scope.exports.value[className] = classScope
    for (const prop in methods) {
      const method = methods[prop]
      const targetQid = `${classScope.qid}.${prop}`
      classScope.value[prop] = new FunctionValue('', {
        sid: prop,
        qid: targetQid,
        parent: classScope,
        runtime: { execute: method.bind(this) },
        _this: classScope,
      })
      this.funcSymbolTable[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)] = classScope.value[prop]
    }
  }

  /**
   * 解析文件并预加载到包管理器
   *
   * 注意：此方法在循环中被调用多次，每个文件的 parseCode 和 preload 时间都会累加到总时间中。
   * 如果提供了 preParsedAst，直接使用，避免重复解析。
   *
   * @param source - 源代码内容
   * @param filename - 文件名
   * @param preParsedAst - 可选的预解析 AST（来自 parseProject，如果提供则直接使用，避免重复解析）
   * @returns {any} 包作用域和文件作用域
   */
  preloadFileToPackage(source: any, filename: any, preParsedAst?: any) {
    const { options } = this
    options.sourcefile = filename

    const ast = preParsedAst || Parser.parseSingleFile(filename, options, this.sourceCodeCache)

    if (!ast) {
      handleException(
        null,
        `JavaAnalyzer.preloadFileToPackage: parse failed: ${filename}`,
        `JavaAnalyzer.preloadFileToPackage: parse failed: ${filename}`
      )
      return
    }
    if (!ast || ast.type !== 'CompileUnit') {
      handleException(
        null,
        `JavaAnalyzer.preloadFileToPackage: node type should be CompileUnit, but ${ast?.type}`,
        `JavaAnalyzer.preloadFileToPackage: node type should be CompileUnit, but ${ast?.type}`
      )
      // 清理 parse 失败时的 sourceCodeCache，避免后续代码误认为文件已处理
      if (this.sourceCodeCache && this.sourceCodeCache.get(filename)) {
        this.sourceCodeCache.delete(filename)
      }
      return undefined
    }
    const packageName = ast._meta.qualifiedName ?? ''

    const packageScope = this.topScope.context.packages.getSubPackage(packageName, true)

    // 开始记录 preload 时间：初始化文件作用域、处理类定义等
    this.performanceTracker.record('preProcess.preload')?.start()

    // file scope init
    // value specifies what module exports, closure specifies file closure
    const fileScope = this.initFileScope(ast, filename, packageScope)
    this.unprocessedFileScopes = this.unprocessedFileScopes ?? new Set()
    this.unprocessedFileScopes.add(fileScope)

    const { body } = ast
    this.entry_fclos = fileScope
    this.thisFClos = fileScope

    const state = this.initState(fileScope)
    // prebuild
    body.forEach((childNode: any) => {
      if (childNode.type === 'ExportStatement') {
        // the argument of ExportStatement is must be a ClassDefinition
        const classDef = childNode.argument
        if (classDef?.type !== 'ClassDefinition') {
          logger.fatal(`the argument of ExportStatement must be a ClassDefinition, check violation in ${filename}`)
        }
        const { className, classClos } = this.preprocessClassDefinitionRec(classDef, fileScope, fileScope, packageScope)
        if (classDef._meta.isPublic) {
          packageScope.scope.exports =
            packageScope.scope.exports ??
            new Scoped(packageScope.qid, {
              sid: 'export',
              parent: packageScope,
            })
          packageScope.scope.exports.setFieldValue(className, classClos)
        }
        packageScope.setFieldValue(className, classClos)
      } else if (childNode.type === 'ClassDefinition') {
        const { className, classClos } = this.preprocessClassDefinitionRec(childNode, fileScope, fileScope)
        packageScope.setFieldValue(className, classClos)
      }
    })

    // post handle module for module export
    // const moduleExports = modClos.getFieldValue('module.exports');
    // if (moduleExports !== {}) {
    //     modScope.value = moduleExports;
    // }

    if (this.checkerManager && this.checkerManager.checkAtEndOfCompileUnit) {
      this.checkerManager.checkAtEndOfCompileUnit(this, null, null, state, null)
    }
    this.fileManager[filename] = { uuid: fileScope.uuid, astNode: fileScope.ast.node }

    // 记录 preload 时间：累加到总 preload 时间中
    this.performanceTracker.record('preProcess.preload')?.end()

    return { packageScope, fileScope }
  }

  /**
   * 递归预处理类定义
   * @param node - AST 节点
   * @param scope - 作用域
   * @param fileScope - 文件作用域
   * @param packageScope - 包作用域
   * @returns {any} 类作用域
   */
  preprocessClassDefinitionRec(node: any, scope: any, fileScope: any, packageScope?: any) {
    const className = node.id?.name

    const classClos = ScopeClass.createSubScope(
      className,
      scope,
      'class',
      ScopeClass.joinQualifiedName(scope.qid, className)
    )
    classClos.scope.exports = new Scoped(classClos.qid, {
      sid: 'exports',
      parent: classClos,
    })
    if (node._meta.isPublic) {
      scope.scope.exports =
        scope.scope.exports ??
        new Scoped(classClos.qid, {
          sid: 'exports',
          parent: classClos,
        })
      scope.scope.exports.setFieldValue(className, classClos)
    }
    classClos.ast = node
    classClos.ast.fdef = node
    classClos.scope.fileScope = fileScope
    classClos.packageScope = packageScope
    const { body } = node
    if (!body) {
      return { className, classClos }
    }
    body.forEach((child: any) => {
      if (child.type === 'ClassDefinition') {
        this.preprocessClassDefinitionRec(child, classClos, fileScope, packageScope)
      }
    })
    return { className, classClos }
  }

  /**
   * process instruction
   * @param scope
   * @param node
   * @param state
   * @param prePostFlag
   * @returns {*}
   */
  protected override shouldAbortExecutionForTimeout(state: State): boolean {
    const timedState = state as State & {
      entryPointDeadline?: number
      entryPointTimeoutLatch?: ReturnType<typeof createTimeoutLatch>
      entryPointClock?: () => number
    }
    if (timedState.entryPointTimeoutLatch?.timedOut) return true
    const deadline = timedState.entryPointDeadline
    if (deadline === undefined || (timedState.entryPointClock ?? Date.now)() < deadline) return false
    timedState.entryPointTimeoutLatch ??= createTimeoutLatch()
    timedState.entryPointTimeoutLatch.trip()
    this.globalState.entryPointTimeout = true
    return true
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   * @param prePostFlag
   */
  override processInstruction(scope: any, node: any, state: any, prePostFlag?: any): any {
    if (this.shouldAbortExecutionForTimeout(state)) {
      return new UndefinedValue()
    }
    let hasException: boolean = false
    if (state?.throwstackScopeAndState) {
      for (const element of state.throwstackScopeAndState) {
        if (element.scope === scope && element.state === state) {
          hasException = true
        }
      }
    }
    if (hasException) {
      return new UndefinedValue()
    }
    return super.processInstruction(scope, node, state, prePostFlag)
  }

  /**
   * 处理编译单元
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 处理结果
   */
  override processCompileUnit(scope: Scope, node: CompileUnit, state: State): Value {
    scope.isProcessed = true
    return super.processCompileUnit(scope, node, state)
  }

  /**
   * 处理变量声明
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 变量值
   */
  override processVariableDeclaration(scope: Scope, node: VariableDeclaration, state: State): SymbolValueType {
    const initVal = super.processVariableDeclaration(scope, node, state)
    if (initVal && node.varType !== null && node.varType !== undefined) {
      initVal.rtype = { type: undefined }
      const val = this.getMemberValueNoCreate(scope, node.varType.id, state)
      if (val?.vtype === 'class') {
        initVal.rtype.definiteType = UastSpec.identifier(val.logicalQid)
      } else {
        initVal.rtype.definiteType = node.varType.id
      }
    }
    return initVal
  }

  /**
   * 处理标识符
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 标识符值
   */
  override processIdentifier(scope: Scope, node: Identifier, state: State): SymbolValueType {
    let res = super.processIdentifier(scope, node, state)

    if (res && !res.rtype) {
      res.rtype = { type: undefined }
      if ((res as any).vtype === 'class') {
        res.rtype.definiteType = UastSpec.identifier(res.logicalQid)
      }
    }

    const resFileScope = res?.scope?.fileScope
    if (resFileScope && !resFileScope.isProcessed) {
      this.processInstruction(resFileScope, resFileScope.ast?.node, this.initState(resFileScope))
    }

    if (
      res &&
      (res as any)?.vtype !== 'fclos' &&
      (res as any)?.vtype !== 'class' &&
      res?.parent?.vtype === 'class' &&
      this.thisFClos &&
      this.thisFClos.vtype === 'symbol'
    ) {
      const fieldDeclaredType = this.resolveClassFieldDeclaredType(scope, node.name, res)
      if (this.thisFClos.members?.get(node.name)) {
        res = this.thisFClos.members.get(node.name)
        this.fillMissingDefiniteType(res, fieldDeclaredType)
      } else {
        const vCopy = this.thisFClos.cloneAlias()
        res = res.cloneAlias ? res.cloneAlias() : _.clone(res)
        this.fillMissingDefiniteType(res, fieldDeclaredType)
        res._this = vCopy
        res.parent = vCopy
        res.object = vCopy
        if (vCopy.taint?.isTaintedRec) {
          res.taint?.markSource()
        }
      }
    }

    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  /**
   * 处理成员访问
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 成员值
   */
  // eslint-disable-next-line complexity
  override processMemberAccess(scope: Scope, node: MemberAccess, state: State): SymbolValueType {
    const defscope = this.processInstruction(scope, node.object, state)
    // 链式 builder 场景（`Type x = head.a().b().build();`）下，receiver 变量的 rtype.definiteType 可能被
    // 链头静态类（typeof RHS 而非 LHS）覆盖，导致 sink calleeType 严格匹配落空。
    // 这里从 resolver 的 declarationMap 取本地变量声明类型作为权威静态类型，回填到 defscope.rtype.definiteType。
    let staticReceiverFqn: string | undefined
    if (node.object?.type === 'Identifier' && defscope && typeof defscope === 'object' && defscope.vtype !== 'class') {
      const receiverName = (node.object as Identifier).name
      const declType = this.lookupDeclaredType(scope, receiverName)
      if (declType) {
        if (!defscope.rtype) defscope.rtype = { type: undefined }
        const currentDefinite = AstUtil.prettyPrint(defscope.rtype.definiteType)
        if (currentDefinite !== declType) {
          defscope.rtype.definiteType = UastSpec.identifier(declType)
        }
      } else if (!this.hasDefiniteReceiverType(defscope)) {
        const importedClass = this.resolveImportedClassReceiver(scope, receiverName)
        if (importedClass) {
          if (!defscope.rtype) defscope.rtype = { type: undefined }
          defscope.rtype.definiteType = UastSpec.identifier(importedClass)
          // 静态 wrapper 调用：receiver 是 import 类、未被本地变量遮蔽时，
          // 记录 FQN 供 getMemberValue 之后把 res 重定向到 classMap 里的真静态方法符号，
          // 让 dispatcher 的 fclos.ast.fdef 指向真实方法体而非块级合成 noBody 占位。
          staticReceiverFqn = importedClass
        }
      }
    }
    const prop = node.property
    let resolvedProp = prop
    // important, prop should be eval by scope rather than defscope
    if (node.computed || (prop.type !== 'Identifier' && prop.type !== 'Literal')) {
      resolvedProp = this.processInstruction(scope, prop, state)
    }
    let res
    if (resolvedProp?.type === 'Identifier' && resolvedProp.name === 'length' && defscope.length) {
      res = new PrimitiveValue(scope.qid, '<defscope_length>', defscope.length, 'number', 'Literal', node.loc)
    } else {
      res = this.getMemberValue(defscope, resolvedProp, state)
    }
    if (staticReceiverFqn) {
      const memberName = this.getResolvedPropName(resolvedProp)
      if (memberName && this.isMissingBodyFclos(res)) {
        const realMember = this.findStaticClassMember(staticReceiverFqn, memberName)
        if (realMember) {
          res = realMember
        }
      }
    }
    if (this.checkerManager && this.checkerManager.checkAtMemberAccess) {
      this.checkerManager.checkAtMemberAccess(this, defscope, node, state, { res })
    }

    if (
      Number.isInteger(res?.object?.length) &&
      res?.property?.vtype === 'primitive' &&
      res?.property?.literalType === 'number'
    ) {
      const index = Number(res.property.value)
      if (index >= res.object.length) {
        state.throwstack = state.throwstack ?? []
        let throwValue = res.object
        throwValue = SourceLine.addSrcLineInfo(
          throwValue,
          node.object,
          node.object.loc && node.object.loc.sourcefile,
          'Var Pass: ',
          AstUtil.prettyPrint(node.object)
        )
        state.throwstack.push(throwValue)

        state.throwstackScopeAndState = state.throwstackScopeAndState ?? []
        state.throwstackScopeAndState.push({ scope, state })
      }
    }

    if (node.property.type === 'ThisExpression' && defscope.vtype === 'class' && defscope.qid) {
      const ancestorInstance = this.getAncestorScopeByQid(scope, `${defscope.qid}`)
      if (ancestorInstance) {
        res = ancestorInstance
      }
    }
    if (defscope.vtype === 'fclos' && defscope.sid?.includes('anonymous') && res.vtype === 'symbol') {
      res = defscope
    }

    if (defscope.rtype && defscope.rtype !== 'DynamicType' && res.rtype === undefined) {
      res.rtype = { type: undefined }
      const resolvedMemberType = this.resolveMemberDeclaredTypeFromReceiver(defscope, resolvedProp, scope)
      res.rtype.definiteType = resolvedMemberType
        ? UastSpec.identifier(resolvedMemberType)
        : defscope.rtype.type
          ? defscope.rtype.type
          : defscope.rtype.definiteType
      res.rtype.vagueType = defscope.rtype.vagueType
        ? `${defscope.rtype.vagueType}.${resolvedProp.name}`
        : resolvedProp.name
    }
    const { fileScope } = res
    if (fileScope && !fileScope.isProcessed) {
      this.processInstruction(fileScope, fileScope.ast?.node, this.initState(fileScope))
    }

    if (node.object?.type !== 'SuperExpression') {
      if (res.vtype !== 'union' || !Array.isArray(res.value)) {
        res._this = defscope
      } else {
        const _thisUnion = defscope
        if (_thisUnion?.value && Array.isArray(_thisUnion?.value)) {
          for (const f of res.value) {
            for (const _thisObj of _thisUnion.value) {
              if (!f.sid || !_thisObj.value) {
                continue
              }
              if (f === _thisObj.value[f.sid]) {
                f._this = _thisObj
              }
            }
          }
        }
      }
      res._this = defscope
    } else {
      // For super.method() calls, bind this to the current instance.
      // In Java semantics, super only affects method dispatch (which class's implementation to call),
      // not this binding. this inside the parent method should still refer to the current instance.
      if (this.thisFClos) {
        res._this = this.thisFClos
      }
    }

    return res
  }

  /**
   * 处理模块导入：import "module"
   * @param scope - 作用域
   * @param node - AST 节点
   * @param _state - 状态（未使用）
   * @param state
   * @returns {any} 导入结果
   */
  processImportDirect(scope: any, node: any, state: any) {
    const importNode = node
    node = node.from
    const fromName = node?.value
    const importedName = importNode?.imported?.name || importNode?.local?.name

    // check cached imports first
    let packageName = ''
    const classNames: string[] = []
    let lastName: string = ''
    if (fromName || importedName) {
      const fullName = importedName ? `${fromName}.${importedName}` : fromName
      if (fullName?.includes('.')) {
        const lastDotIndex = fullName.lastIndexOf('.')
        packageName = fullName.substring(0, lastDotIndex)
        lastName = fullName.substring(lastDotIndex + 1)
        classNames.push(fullName.substring(lastDotIndex + 1))
      } else {
        lastName = fullName
        classNames.push(fullName)
      }
    }
    packageName = packageName.replace('<global>.packageManager.', '')
    let packageScope = this.topScope.context.packages.getSubPackage(packageName, true)
    // if package is not created from import statement, but from full qualified name access
    if (packageScope.vtype !== 'package') {
      packageScope = new PackageValue('', {
        vtype: 'package',
        sid: lastName,
        qid: packageName,
        parent: this,
      })
      const exports = new Scoped(packageScope.qid, {
        sid: 'exports',
        parent: packageScope,
      })
      packageScope.scope.exports = exports
    }
    let classScope = packageScope
    for (const className of classNames) {
      classScope = ScopeClass.createSubScope(
        className,
        packageScope,
        'class',
        ScopeClass.joinQualifiedName(packageScope.qid, className)
      )
      packageScope.scope.exports.value[className] = classScope
    }

    return classScope
  }

  /**
   * 处理类定义
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 类定义结果
   */
  // eslint-disable-next-line complexity
  override processClassDefinition(scope: Scope, node: ClassDefinition, state: State): SymbolValueType {
    const { annotations } = node._meta as any
    const annotationValues: any[] = []
    annotations?.forEach((annotation: any) => {
      annotationValues.push(this.processInstruction(scope, annotation, state))
    })

    // adjust the order of the class body, so that static field comes last
    const { body } = node
    let bodyStmt: any
    if (body && !Array.isArray(body) && (body as any).type === 'ScopedStatement') {
      bodyStmt = (body as any).body
    } else if (Array.isArray(body)) {
      bodyStmt = body
    }
    bodyStmt?.sort((a: any, b: any) => {
      return (a._meta?.isStatic ? 1 : 0) - (b._meta?.isStatic ? 1 : 0)
    })

    const res = super.processClassDefinition(scope, node, state)
    // TODO
    res.annotations = annotationValues
    for (const annotation of annotationValues) {
      if (annotation.qid.includes('lombok.Data')) {
        const value = res.members
        for (const prop of value.keys()) {
          const fieldValue = value.get(prop)
          if (fieldValue.vtype !== 'fclos') {
            const getterName = `get${getUpperCase(prop)}`
            if (!value.has(getterName)) {
              const targetQid = `${scope.qid}.${getterName}`
              value.set(
                getterName,
                new FunctionValue('', {
                  sid: getterName,
                  qid: targetQid,
                  parent: scope,
                  runtime: { execute: JavaInitializer.builtin.lombok.processGetter(getterName, prop) },
                })
              )
              this.funcSymbolTable[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)] = value.get(getterName)
            }
            const setterName = `set${getUpperCase(prop)}`
            if (!value.has(setterName)) {
              const targetQid = `${scope.qid}.${setterName}`
              value.set(
                setterName,
                new FunctionValue('', {
                  sid: setterName,
                  qid: targetQid,
                  parent: scope,
                  runtime: { execute: JavaInitializer.builtin.lombok.processSetter(setterName, prop) },
                })
              )
              this.funcSymbolTable[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)] = value.get(getterName)
            }
          }
        }
      } else if (annotation.qid.includes('lombok.AllArgsConstructor')) {
        const value = res.members
        if (!value.has('_CTOR_')) {
          value.set(
            '_CTOR_',
            new FunctionValue('', {
              sid: '_CTOR_',
              qid: `${res.qid}._CTOR_`,
              parent: scope,
              runtime: { execute: JavaInitializer.builtin.lombok._CTOR_ },
            })
          )
        }
      }
    }
    return res
  }

  /**
   *
   * @param rightVal
   * @param filter
   */
  override *getValueIterator(rightVal: any, filter: any) {
    const bufferedElements = getAllElementFromBuffer(rightVal)
    if (bufferedElements.length > 0) {
      for (const element of bufferedElements) {
        if (!filter || filter(element)) {
          yield { k: element?.sid || '<buffer>', v: element }
        }
      }
      return
    }
    yield* super.getValueIterator(rightVal, filter)
  }

  /**
   * 处理赋值表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 赋值结果
   */
  override processAssignmentExpression(scope: Scope, node: AssignmentExpression, state: State): SymbolValueType {
    const { left } = node
    const oldVal = this.processInstruction(scope, left, state)

    const res = super.processAssignmentExpression(scope, node, state)

    if (
      node.operator === '=' &&
      oldVal?.parent === this.thisFClos &&
      this.thisFClos?.members?.get('super') &&
      !this.checkFieldDefinedInClass(oldVal.sid, this.thisFClos.qid)
    ) {
      this.saveVarInScopeRec(
        this.thisFClos.members.get('super')!,
        left.type === 'MemberAccess' ? left.property : left,
        res,
        state
      )
    }

    if (node.operator === '=' && this.isJavaThisMemberFieldWrite(left)) {
      if (oldVal && typeof oldVal === 'object' && !hasJavaInputTraceKey(oldVal)) {
        const donor = findJavaInputTraceDonor(res)
        if (donor && donor !== oldVal) attachJavaInputTraceFromDonor(oldVal, donor)
      }
    }

    return res
  }

  /**
   * 处理二元表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 表达式结果
   */
  override processBinaryExpression(scope: Scope, node: BinaryExpression, state: State): BinaryExprValue {
    let res = super.processBinaryExpression(scope, node, state)

    if (
      res?.left?.vtype === 'primitive' &&
      res?.right?.vtype === 'primitive' &&
      res?.operator &&
      ['>', '<', '==', '!=', '>=', '<='].includes(res.operator)
    ) {
      const leftPrim = res.left as PrimitiveValueType
      const rightPrim = res.right as PrimitiveValueType
      let leftPrimitive = leftPrim.value
      if (leftPrim.literalType === 'string' && leftPrimitive != null && typeof leftPrimitive === 'string') {
        leftPrimitive = `'${leftPrimitive.replaceAll("'", "\\'")}'`
      }
      let rightPrimitive = rightPrim.value
      if (rightPrim.literalType === 'string' && rightPrimitive != null && typeof rightPrimitive === 'string') {
        rightPrimitive = `'${rightPrimitive.replaceAll("'", "\\'")}'`
      }
      if (leftPrimitive != null && rightPrimitive != null) {
        const expr = leftPrimitive + res.operator + rightPrimitive
        try {
          // eslint-disable-next-line no-eval
          const result = eval(expr)
          if (result != null) {
            res = new PrimitiveValue(
              scope.qid,
              `<operatorExp_${node.operator}_${node.loc.start?.line}_${node.loc.start?.column}_${node.loc.end?.line}_${node.loc.end?.column}>`,
              result,
              null,
              'Literal',
              node.loc
            )
          }
        } catch (e) {
          // 忽略 eval 错误
        }
      }
    } else if (res?.operator === 'instanceof') {
      if (res?.left?.vtype === 'primitive' && (res.left as PrimitiveValueType).literalType === 'null') {
        res = new PrimitiveValue(scope.qid, '<bool_false>', false, null, 'Literal', node.loc)
      } else if (res?.right?.vtype === 'class') {
        if (res.right.qid === 'java.lang.Object' || res.right.logicalQid === 'java.lang.Object') {
          // eslint-disable-next-line sonarjs/no-duplicate-string
          res = new PrimitiveValue(scope.qid, '<bool_true>', true, null, 'Literal', node.loc)
        } else if ((res?.left as any)?.rtype?.definiteType && !(res.left as any).rtype.vagueType) {
          const leftWithRtype = res.left as any
          const resType = AstUtil.prettyPrint(leftWithRtype.rtype.definiteType)
          if (resType === res.right.qid) {
            res = new PrimitiveValue(scope.qid, '<bool_true>', true, null, 'Literal', node.loc)
          } else {
            const classHierarchy: ClassHierarchy | undefined = this.typeResolver.classHierarchyMap.get(resType)
            if (classHierarchy) {
              const baseTypes: string[] = this.typeResolver.findBaseTypes(classHierarchy)
              for (const baseType of baseTypes) {
                if (baseType === res.right.qid) {
                  res = new PrimitiveValue(scope.qid, '<bool_true>', true, 'boolean', 'Literal', node.loc)
                  break
                }
              }
            }
          }
        }
      }
    }

    return res
  }

  /**
   *
   * @param arg
   */
  private isJavaClassLiteralAccess(arg: any): arg is MemberAccess {
    if (arg?.type !== 'MemberAccess') return false

    const { property } = arg
    return (
      (property?.type === 'Identifier' && property.name === 'class') ||
      (property?.type === 'Literal' && property.value === 'class')
    )
  }

  /**
   *
   * @param scope
   * @param arg
   * @param state
   */
  private evaluateNestedCallArgument(scope: Scope, arg: any, state: State): any {
    if (arg?.type !== 'CallExpression') {
      if (!this.isJavaClassLiteralAccess(arg)) {
        return this.processInstruction(scope, arg, state)
      }

      const savedThrowstack = state.throwstack ? [...state.throwstack] : undefined
      const savedThrowstackScopeAndState = state.throwstackScopeAndState
        ? [...state.throwstackScopeAndState]
        : undefined
      const value = this.processInstruction(scope, arg, state)
      if (savedThrowstack) {
        state.throwstack = savedThrowstack
      } else {
        delete state.throwstack
      }
      if (savedThrowstackScopeAndState) {
        state.throwstackScopeAndState = savedThrowstackScopeAndState
      } else {
        delete state.throwstackScopeAndState
      }
      return value
    }

    const nestedCall = arg as CallExpression
    const nestedFclos = this.processInstruction(scope, nestedCall.callee, state)
    if (!nestedFclos || nestedFclos.vtype !== 'fclos') {
      return this.processInstruction(scope, arg, state)
    }

    const nestedArgValues: any[] = []
    for (const nestedArg of nestedCall.arguments || []) {
      const nestedArgValue = this.evaluateNestedCallArgument(scope, nestedArg, state)
      if (Array.isArray(nestedArgValue)) {
        nestedArgValues.push(...nestedArgValue)
      } else {
        this.addRtypeToArg(nestedArg, nestedArgValue)
        nestedArgValues.push(nestedArgValue)
      }
    }
    return this.executeCall(nestedCall, nestedFclos, state, scope, {
      callArgs: this.buildCallArgs(nestedCall, nestedArgValues, nestedFclos),
    })
  }

  /**
   * 处理函数调用表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 调用结果
   */
  // eslint-disable-next-line complexity
  override processCallExpression(scope: Scope, node: CallExpression, state: State): Value {
    /* { callee,
        arguments,
      }
   */
    if (this.checkerManager && this.checkerManager.checkAtFuncCallSyntax)
      this.checkerManager.checkAtFuncCallSyntax(node, {
        pcond: state.pcond,
        einfo: state.einfo,
      })

    let fclos = this.processInstruction(scope, node.callee, state)

    if (!fclos) {
      // callee 不可解析时仍处理无名 / 匿名函数参数，避免 lambda 闭包体被静默丢弃
      for (const arg of node.arguments) {
        if (arg.type === 'FunctionDefinition') {
          const funcDef = arg as FunctionDefinition
          const funcName = funcDef.id?.type === 'Identifier' ? funcDef.id.name : ''
          if (!funcName || funcName.includes('<anonymous')) {
            const argv = this.evaluateNestedCallArgument(scope, arg, state)
            this.processAndCallFuncDef(scope, funcDef, argv, state, undefined, node)
          }
        }
      }
      return new UndefinedValue()
    }
    if (this.entryPointSymValArray.includes(fclos) && !Config.makeAllCG) {
      this.globalState.meetOtherEntryPoint = true
      return new UndefinedValue()
    }
    if (node.callee.type === 'ThisExpression' && fclos.qid.includes('<instance')) {
      if (fclos.members.get('_CTOR_')) {
        fclos = fclos.members.get('_CTOR_')!
      } else {
        return new UndefinedValue()
      }
    }

    // prepare the function arguments
    let argvalues: any[] = []
    let sameArgs = true // minor optimization to save memory
    let argExecuted = false
    for (const arg of node.arguments) {
      let argv = this.evaluateNestedCallArgument(scope, arg, state)
      // 处理参数是 箭头函数或匿名函数
      // 参数类型必须是函数定义,且fclos找不到定义或未建模适配
      // 如果参数适配建模，则会进入相应的逻辑模拟执行，例如array.push
      if (arg.type === 'FunctionDefinition') {
        const funcDef = arg as FunctionDefinition
        const funcName = funcDef.id?.type === 'Identifier' ? funcDef.id.name : ''
        if ((!funcName || funcName.includes('<anonymous')) && !fclos?.ast.fdef && !fclos?.runtime?.execute) {
          // let subscope = ScopeClass.createSubScope(argv.sid + '_scope', scope,'scope')
          let anonymousArgValues
          const _this = fclos.getThisObj()
          if (_this && funcDef.parameters && funcDef.parameters.length > 0) {
            anonymousArgValues = []
            let i = 0
            while (i < funcDef.parameters.length) {
              anonymousArgValues.push(_this)
              i++
            }
          }
          argv = this.processAndCallFuncDef(scope, funcDef, argv, state, anonymousArgValues, node)
          argExecuted = true
        }
      }
      if (argv !== arg) sameArgs = false
      if (logger.isTraceEnabled()) logger.trace(`arg: ${this.formatScope(argv)}`)
      if (Array.isArray(argv)) {
        argvalues.push(...argv)
      } else {
        this.addRtypeToArg(arg, argv)
        argvalues.push(argv)
      }
    }
    if (sameArgs) argvalues = node.arguments

    let res
    let meetSameFuncInCallstack = false

    const invocations: Invocation[] = this.findNodeInvocations(scope, node)
    const executedInvocations: Invocation[] = []
    let fclosExecuted = false
    let primaryFclosExecuted = false
    let sofaDispatched = false

    /* SOFA 分发：接口调用优先通过 SOFA 服务映射分发到实现类 */
    let sofaInterfaceName: string | undefined
    let sofaImplList: Array<{ uniqueId: string; ref: string }> | undefined

    if (fclos.vtype === 'fclos' && this.checkFclosInInterfaceOrAbstractClass(fclos)) {
      sofaInterfaceName = fclos.parent?.logicalQid
      sofaImplList = sofaInterfaceName
        ? this.topScope.spring?.sofaServiceInterfaceMap?.get(sofaInterfaceName)
        : undefined
    }

    /* 当 fclos 为 symbol（如 Map.get() 返回值的方法调用），从 invocations 目标推断 SOFA 接口 */
    if (
      !sofaImplList &&
      fclos.vtype === 'symbol' &&
      invocations.length > 10 &&
      this.topScope.spring?.sofaServiceInterfaceMap
    ) {
      const sofaMap = this.topScope.spring.sofaServiceInterfaceMap as Map<
        string,
        Array<{ uniqueId: string; ref: string }>
      >
      for (const [iface, implList] of sofaMap) {
        if (implList.length > 10 && implList.length <= invocations.length * 2) {
          /* 验证：SOFA 映射的 ref 能否匹配到 invocations 的目标类 */
          let matchCount = 0
          for (const impl of implList) {
            const beanInfo = this.topScope.spring.beanMap?.get(impl.ref)
            if (!beanInfo?.className) continue
            const classUuid = this.classMap.get(beanInfo.className)
            if (!classUuid) continue
            const classObj = this.symbolTable.get(classUuid)
            if (!classObj) continue
            const implFclos = classObj.members?.get(fclos.sid)
            if (
              implFclos &&
              invocations.some(
                (inv: Invocation) =>
                  inv.toScope === implFclos ||
                  (inv.toScope?.qid && inv.toScope.qid === implFclos.qid) ||
                  (inv.toScope?.logicalQid && inv.toScope.logicalQid === implFclos.logicalQid)
              )
            ) {
              matchCount++
            }
            if (matchCount >= 3) break
          }
          if (matchCount >= 3) {
            sofaInterfaceName = iface
            sofaImplList = implList
            break
          }
        }
      }
    }

    if (sofaImplList && sofaImplList.length > 0) {
      const methodName = fclos.sid
      const { sinkArray } = this.pruneInfoMap
      /* SOFA strict 匹配使用独立缓存，避免 strict=false 结果污染全局 dynamic 缓存 */
      const { sofaStrictMatchSinkCacheMap } = this.pruneInfoMap

      /* 获取 this 对象：fclos 可能是 symbol（Map.get() 返回值），需要安全处理 */
      const thisObj = typeof fclos.getThisObj === 'function' ? fclos.getThisObj() : fclos._this

      /* 只收集严格匹配 sink 的实现，跳过不匹配的（不再收集 dynamicMatched） */
      let strictMatchCount = 0
      for (const sofaImpl of sofaImplList) {
        const beanInfo = this.topScope.spring.beanMap?.get(sofaImpl.ref)
        if (!beanInfo?.className) continue
        const classUuid = this.classMap.get(beanInfo.className)
        if (!classUuid) continue
        const classObj = this.symbolTable.get(classUuid)
        if (!classObj) continue
        const implFclos = classObj.members?.get(methodName)
        if (!implFclos || implFclos.vtype !== 'fclos') continue
        const implFdef = implFclos.ast?.fdef
        if (!implFdef || implFdef.body?.type === 'Noop') continue

        /* 严格匹配：callgraph 中静态可达 sink 才执行 */
        const matchSink = this.checkFclosMatchSink(implFclos, [], sinkArray, sofaStrictMatchSinkCacheMap, false)
        if (!matchSink) continue

        strictMatchCount++
        implFclos.ast.fdef = implFdef
        const oldThis = implFclos._this
        implFclos._this = thisObj
        res = this.executeCall(node, implFclos, state, scope, {
          callArgs: this.buildCallArgs(node, argvalues, implFclos),
          callsiteNode: node,
        })
        if (res?.type === 'FunctionCall') {
          meetSameFuncInCallstack = true
        }
        implFclos._this = oldThis
      }

      if (strictMatchCount > 0) {
        sofaDispatched = true
        fclosExecuted = true
      }
    }

    const shouldPreferInvocationFallback = invocations.some((invocation) =>
      this.isExecutableInvocationCandidate(invocation, node, argvalues, state)
    )
    const concreteReceiverMethod = shouldPreferInvocationFallback
      ? undefined
      : this.resolveConcreteReceiverMethod(fclos, node, argvalues)
    let concreteReceiverExecuted = false
    if (!sofaDispatched && concreteReceiverMethod) {
      const candidateReceiver = fclos.getThisObj?.() ?? fclos._this
      if (this.isValidConcreteDispatchReceiver(candidateReceiver, fclos, concreteReceiverMethod)) {
        concreteReceiverExecuted = true
        const oldThis = concreteReceiverMethod._this
        concreteReceiverMethod._this = candidateReceiver
        res = this.executeCall(node, concreteReceiverMethod, state, scope, {
          callArgs: this.buildCallArgs(node, argvalues, concreteReceiverMethod),
          callsiteNode: node,
        })
        this.propagateBodyReturnFieldReceiverTaint(concreteReceiverMethod, res)
        if (res?.type === 'FunctionCall') {
          meetSameFuncInCallstack = true
        }
        concreteReceiverMethod._this = oldThis
        fclosExecuted = true
      }
    }

    /* 接口/抽象类虚分派 exhaustive fallback：concreteReceiverMethod / SOFA 都未解析、callgraph invocations 也无可执行
     * fclos 时，按类型层级穷举具体子类型同名方法逐个 invoke。普适 CHA 语义，非业务模板。 */
    let interfaceFanoutExecuted = false
    if (!sofaDispatched && !concreteReceiverExecuted && !shouldPreferInvocationFallback) {
      /* 从 invocation 提取 calleeType 作为 exhaustive fanout 的回退类型来源；
       * 当 receiver 的 rtype.definiteType 丢失（如 Map.get + class-cast + list-element 多次拷贝后
       * rtype 被覆盖），但 invocation 的 calleeType 仍保留了接口全限定名时，用 calleeType 回退查找实现类 */
      let calleeTypeFallback: string | undefined
      for (const inv of invocations) {
        if (inv.calleeType) {
          calleeTypeFallback = String(inv.calleeType)
          break
        }
      }
      const exhaustiveMethods = this.resolveInterfaceExhaustiveMethods(fclos, node, argvalues, calleeTypeFallback)
      const fanoutCallsiteKey = this.buildFanoutContinuationCallsiteKey(fclos, node, calleeTypeFallback)
      const prioritizedExhaustiveMethods = this.prioritizeFanoutMethodsForTimeoutRerun(
        exhaustiveMethods,
        fanoutCallsiteKey
      )
      if (prioritizedExhaustiveMethods.length > 0) {
        const receiverObj = fclos.getThisObj?.() ?? fclos._this
        /* sink-reachable CHA 过滤：fan-out 前按 callgraph sink 可达性裁剪候选实现，
         * 避免 pipeline/valve/策略模式等场景展开大量不相关实现导致路径爆炸 */
        const { sinkArray, sofaStrictMatchSinkCacheMap } = this.pruneInfoMap
        const sinkFilteredMethods =
          sinkArray.length > 0
            ? exhaustiveMethods.filter((method) =>
                this.checkFclosMatchSink(method, [], sinkArray, sofaStrictMatchSinkCacheMap, false, true)
              )
            : exhaustiveMethods
        if (sinkFilteredMethods.length === 0 && exhaustiveMethods.length > 0) {
          // 全部被过滤时回退到未过滤列表，避免 callgraph 不完备导致漏检
        }
        const finalMethods = sinkFilteredMethods.length > 0 ? sinkFilteredMethods : exhaustiveMethods
        /* fan-out trace 池化：同一 callsite 对 N 个具体子类型方法逐个 invoke，每次 invoke 都会向
         * argvalues / receiver 携带的 tagTraces 推同一帧 callsite step，导致单条 finding.trace
         * 堆叠 N 个相邻字面相同 step。
         * 策略：循环开始前 snapshot 全部相关 TaintRecord 的各 tag trace 长度；首次 invoke 之后记录
         * "首次 invoke 后的长度"作为后续上限；从第二次 invoke 起，invoke 完成后把 trace 长度截断回
         * 首次基线，确保单条 finding 内 callsite 只保留 1 帧。
         * 已捕获 finding 的 trace 由 sink 触发时拷贝写入 finding.trace（taint-checker 路径），
         * 截断仅作用于活跃 TaintRecord 的内部数组，不影响已落盘 finding。 */
        const prioritizedFinalMethods = this.prioritizeFanoutMethodsForTimeoutRerun(finalMethods, fanoutCallsiteKey)
        const traceTargets = this.collectFanoutTraceTargets(argvalues, receiverObj)
        let firstInvokeDone = false
        let firstInvokeLengths: Array<Map<string, number> | null> | null = null
        for (const implMethod of prioritizedFinalMethods) {
          if (this.shouldAbortExecutionForTimeout(state)) break
          const oldThis = implMethod._this
          implMethod._this = receiverObj
          const r = this.executeCall(node, implMethod, state, scope, {
            callArgs: this.buildCallArgs(node, argvalues, implMethod),
            callsiteNode: node,
          })
          this.propagateBodyReturnFieldReceiverTaint(implMethod, r)
          if (r?.type === 'FunctionCall') {
            meetSameFuncInCallstack = true
          }
          if (r && (!res || (!hasJavaInputTraceKey(res) && Boolean(findJavaInputTraceDonor(r))))) res = r
          implMethod._this = oldThis
          if (this.globalState.entryPointTimeout) {
            break
          }
          this.markFanoutImplementationCompleted(fanoutCallsiteKey, implMethod)
          if (!firstInvokeDone) {
            firstInvokeLengths = traceTargets.map((t) => t.snapshotTraceLengths())
            firstInvokeDone = true
          } else if (firstInvokeLengths) {
            for (let i = 0; i < traceTargets.length; i++) {
              traceTargets[i].truncateTraceLengths(firstInvokeLengths[i])
            }
          }
        }
        interfaceFanoutExecuted = true
        fclosExecuted = true
      }
    }
    this.executeAsyncBatchSubmitTasks(fclos, argvalues, node, state, scope)

    if (
      !sofaDispatched &&
      !concreteReceiverExecuted &&
      !interfaceFanoutExecuted &&
      (fclos.vtype !== 'fclos' || this.checkFclosInInterfaceOrAbstractClass(fclos))
    ) {
      // execute fclos found by callgraph
      for (const invocation of invocations) {
        if (
          invocation.toScope?.vtype === 'fclos' &&
          (invocation.toScopeAst || invocation.toScope.runtime?.execute) &&
          invocation.toScopeAst?.body?.type !== 'Noop' &&
          !this.checkFclosCanPruneDuringInterpret(invocation.toScope, node, argvalues, state, true)
        ) {
          if (invocation.toScope.qid === fclos.qid) {
            fclosExecuted = true
          }
          let executed: boolean = false
          for (const executedInvocation of executedInvocations) {
            if (
              (invocation.toScopeAst &&
                executedInvocation.toScopeAst &&
                invocation.toScopeAst._meta?.nodehash === executedInvocation.toScopeAst._meta?.nodehash) ||
              (invocation.toScope.runtime?.execute &&
                executedInvocation.toScope.runtime?.execute &&
                invocation.toScope.runtime.execute === executedInvocation.toScope.runtime.execute)
            ) {
              executed = true
              break
            }
          }
          if (executed) {
            continue
          }
          executedInvocations.push(invocation)
          invocation.toScope.ast.fdef = invocation.toScopeAst
          const oldThis = invocation.toScope._this
          invocation.toScope._this = fclos.getThisObj()
          res = this.executeCall(node, invocation.toScope, state, scope, {
            callArgs: this.buildCallArgs(node, argvalues, invocation.toScope),
            callsiteNode: node,
          })
          this.propagateBodyReturnFieldReceiverTaint(invocation.toScope, res)
          if (res?.type === 'FunctionCall') {
            meetSameFuncInCallstack = true
          }
          invocation.toScope._this = oldThis
        }
      }
    }

    // analyze the resolved function closure and the function arguments
    if (
      !sofaDispatched &&
      !concreteReceiverExecuted &&
      !interfaceFanoutExecuted &&
      ((fclos.vtype === 'fclos' && !fclosExecuted) || executedInvocations.length === 0)
    ) {
      // 接口集 body 全 Noop 场景：fclos 为 symbol（无实体 body），invocations 列表所有目标 body=Noop 全部 SKIP，
      // 当前内层条件无法命中 → 走 executeCall(symbol, ...) 不传播 taint。
      // 第三条件让"symbol fclos + 全 invocation body=Noop"降级到 processLibArgToRet（ARG→RET）。
      // 必须排除 fclos.vtype === 'fclos'：此时 fclos 已是 callgraph 解析到的真实匿名实现（body 非 Noop），
      // invocations 中残留的接口声明 body=Noop 不能误判为"应当 lib 传播"，否则匿名实现 body 不会被解释。
      const allInvocationsBodyNoop =
        fclos.vtype !== 'fclos' &&
        executedInvocations.length === 0 &&
        invocations.length > 0 &&
        invocations.every((inv) => inv.toScopeAst?.body?.type === 'Noop')
      const callsiteOverLimit = this.incrementAndCheckCallsiteLimit(node)
      const methodOverTimeLimit = this.checkMethodCumulativeTimeLimit(fclos)
      // 先走廉价检查（Noop / prune / limit），只有原本要走 executeCall 的路径才尝试粗传播
      if (
        this.checkFclosCanPruneDuringInterpret(fclos, node, argvalues, state, false) ||
        fclos?.ast?.fdef?.body?.type === 'Noop' ||
        allInvocationsBodyNoop ||
        callsiteOverLimit ||
        methodOverTimeLimit
      ) {
        // Noop body / pruned 路径走 processLibArgToRet 时不走 executeCall，
        // 导致 checkerManager.checkAtFunctionCallBefore 不触发，sink 匹配在此路径缺失。
        // 补调一次 checkAtFunctionCallBefore 确保 taint checker 能在此调用点匹配 sink。
        this.checkerManager?.checkAtFunctionCallBefore(this, scope, node, state, {
          callInfo: { callArgs: this.buildCallArgs(node, argvalues, fclos), callsiteNode: node },
          fclos,
          pcond: state.pcond,
          entry_fclos: this.entry_fclos,
          einfo: state.einfo,
          state,
          analyzer: this,
          ainfo: this.ainfo,
        })
        if (!res) {
          res = this.processLibArgToRet(node, fclos, argvalues, scope, state, {
            callArgs: this.buildCallArgs(node, argvalues, fclos),
          })
        }
      } else {
        // 原本要走 executeCall：尝试粗传播，有 taint 且不可达 sink 时跳过方法体
        const coarseResult = this.tryCoarseTaintPropagation(scope, node, state, fclos, argvalues)
        if (coarseResult !== undefined) {
          res = coarseResult
        } else {
          const callInfo: CallInfo = { callArgs: this.buildCallArgs(node, argvalues, fclos), callsiteNode: node }
          const methodExecStart = Date.now()
          res = this.executeWithSummary(
            scope,
            fclos,
            callInfo,
            state,
            () => this.executeCall(node, fclos, state, scope, callInfo),
            { includeStage: false }
          )
          const methodExecElapsed = Date.now() - methodExecStart
          this.accumulateMethodTime(fclos, methodExecElapsed)
          primaryFclosExecuted = fclos.vtype === 'fclos'
          // post-executeCall taint 补殖：
          // 方法体正常执行保 sink 检测，但若返回值缺失 JAVA_INPUT taint 且参数有，
          // 从参数 donor 传播 taint 到返回值（仅参数 donor，不做 THIS→RET 防扩散）
          if (Config.enableCoarseTaintPropagation && res && !hasJavaInputTraceKey(res)) {
            const taintedArg =
              Array.isArray(argvalues) &&
              argvalues.find(
                (a: any) => a?.taint?.isTaintedRec === true && (a.taint as any).tagTraces?.has('JAVA_INPUT')
              )
            if (taintedArg) {
              const donor = findJavaInputTraceDonor(taintedArg)
              if (donor) {
                this._postExecAttachHits = (this._postExecAttachHits || 0) + 1
                attachJavaInputTraceFromDonor(res, donor)
                // attachJavaInputTraceFromDonor 通过 mergeTracesFrom 只传 tagTraces，
                // 不传 source-line CALL trace；直接用 addTraceToTag 把 CALL 行
                // 写入 res 的 JAVA_INPUT tagTrace，绕过 addSrcLineInfo 的 isTaintedRec 守卫
                const _callsiteFile = node?.loc?.sourcefile
                const _fname = this.getCalledMethodName(node, fclos) || fclos?.ast?.fdef?.id?.name || fclos?.name
                if (_callsiteFile && typeof (res as any).taint?.addTraceToTag === 'function') {
                  const _startLine = node.loc?.start?.line ?? 0
                  const _endLine = node.loc?.end?.line ?? _startLine
                  const _tline = _startLine === _endLine ? _startLine : _.range(_startLine, _endLine + 1)
                  const _traceItem = {
                    file: _callsiteFile,
                    line: _tline,
                    node,
                    tag: 'CALL: ',
                    affectedNodeName: _fname,
                  }
                  ;(res as any).taint.addTraceToTag('JAVA_INPUT', _traceItem)
                }
              }
            }
          }
        }
      }
      if (res?.type === 'FunctionCall') {
        meetSameFuncInCallstack = true
      }
    }
    this.propagateReadWrapperReceiverTrace(node, fclos, res)

    if (
      node.callee?.type === 'MemberAccess' &&
      fclos?.vtype === 'fclos' &&
      !fclos.runtime?.execute &&
      this.isJavaBeanGetterCall(node, fclos) &&
      (node.arguments?.length ?? 0) === 0
    ) {
      const receiver = this.getReadWrapperReceiver(fclos)
      if (res && !hasJavaInputTraceKey(res) && isJavaObjectCarrier(receiver) && isRequestLikeJavaCarrier(receiver)) {
        const donor = findJavaInputTraceDonor(receiver)
        if (donor && donor !== res && attachJavaInputTraceFromDonor(res, donor)) {
          const resolvedRes = this.resolveRuntimeValueRef(res)
          if (resolvedRes !== res) attachJavaInputTraceFromDonor(resolvedRes, donor)
        }
      }
    }

    if (node.callee?.type === 'MemberAccess' && this.isJavaBeanSetterCall(node, fclos) && Array.isArray(argvalues)) {
      const methodName = this.getCalledMethodName(node, fclos) ?? 'unknown'
      const receiver = this.getReadWrapperReceiver(fclos)
      if (argvalues.length === 1 && isJavaObjectCarrier(receiver)) {
        const fieldName = getJavaBeanSetterFieldName(methodName)
        const setterArg = argvalues[0]
        const donor = findJavaInputTraceDonor(setterArg)
        if (donor && !hasJavaInputTraceKey(receiver)) {
          attachJavaInputTraceFromDonor(receiver, donor)
        }
        const storedField =
          fieldName && typeof (receiver as { getFieldValue?: unknown }).getFieldValue === 'function'
            ? (
                receiver as { getFieldValue: (fieldName: string, createIfNotExists?: boolean) => unknown }
              ).getFieldValue(fieldName, false)
            : undefined
        if (storedField && typeof storedField === 'object' && !hasJavaInputTraceKey(storedField)) {
          if (donor && donor !== storedField) attachJavaInputTraceFromDonor(storedField, donor)
        }
      }
    }

    if (res) {
      this.propagateBodyReturnFieldReceiverTaint(fclos, res)
      const resolvedRes = this.resolveRuntimeValueRef(res)
      if (resolvedRes && typeof resolvedRes === 'object') {
        this.mergeJavaCallResultType(resolvedRes as JavaRuntimeValue, fclos)
      }
    }

    // receiver→RET 反向染（union receiver 真实 body 路径）：union over-approximation 接力的语义补齐。
    // 场景：union<unionValue> 顶层 `taint.isTaintedRec=true` 的 receiver 调用 POJO `getter()`/普通方法时，
    // 各 branch field 上不携 tag（union 顶层 tag 不下推 branch field）→ res 自身 tagTraces 无 source tag。
    // 与 common/analyzer.ts processLibArgToRet 中的 receiver→RET 反向块对称：lib 调用走那里（fclos.vtype==='symbol'），
    // 而 union 派发的真实 Java 方法体走这里，两路径一致语义。
    // 仅限 fclos.vtype === 'union'：避免普通 fclos 方法体本身已正确传播 receiver field 时插入重复 trace。
    // 三写规约（lib-arg-to-ret-buffer.md §七）：addElementToBuffer + markSource + mergeTracesFrom，
    // 让 sink 侧 fCollectTags 起点过滤（tagTraces.has(tag)）通过、isTaintedRec 短路命中、buffer 递归扫到深层 tag。
    if (res && node.callee?.type === 'MemberAccess' && fclos.vtype === 'union' && _.isFunction((res as any).setMisc)) {
      const receiverVal = typeof fclos.getThisObj === 'function' ? fclos.getThisObj() : fclos._this
      // 守卫按 tag key 精确判（与下方 ARG→RET hook 同型）：union over-approximation 接力时 res.isTaintedRec 可能
      // 被早先路径置位但 tagTraces 未含 JAVA_INPUT，此时若用 isTaintedRec 总开关会误判为已染色 → 跳过三写 →
      // sink 侧 fCollectTags 起点过滤拒启动（lib-arg-to-ret-buffer.md「按 tag key 精确判不能只看 isTaintedRec 总开关」）。
      // 对侧 JI 来源也按 tag key 走 depth≤4 BFS，避免非 JAVA_INPUT tag 触发重复回写。
      //   旧守卫 `receiver.isTaintedRec` 在 receiver 仅有非 JI tag 时也 fire，3 写不写 JI → res 仍无 JI → 同 res
      //   下次再次命中 → addElementToBuffer 重复 push → union over-approx 多 branch fanout 下 buffer 无限膨胀 → OOM。
      //   故 receiver-side 也按 BFS 找 JI donor（自身或 buffer 后代 depth≤4），找不到不 fire。
      // 与 ARG→ARG buffer 传播保持同款幂等守卫：
      //   donor 已在 res.misc.buffer → 完全短路；防止 aggressive-prune 重试 / 同 callsite 多次解释累积。
      // 防环：res !== receiverVal（fluent chain `return this`）+ donor !== res（donor BFS 命中 res 自身后代时退）。
      if (receiverVal && receiverVal !== res && !(res as any).taint?.tagTraces?.has('JAVA_INPUT')) {
        const TAG_JI = 'JAVA_INPUT'
        // 只允许真实 SOURCE donor 回写，避免无 SOURCE 的中间 JAVA_INPUT trace 覆盖源头 trace。
        const donor = findJavaInputTraceDonor(receiverVal)
        if (donor && donor.taint && donor !== res) {
          const resBuf = _.isFunction((res as any).getMisc) ? (res as any).getMisc('buffer') : null
          const donorAlreadyInBuf = Array.isArray(resBuf) && resBuf.includes(donor)
          if (!donorAlreadyInBuf) {
            addElementToBuffer(res, donor)
            ;(res as any).taint?.markSource?.()
            if (_.isFunction((res as any).taint?.mergeTracesFrom)) {
              ;(res as any).taint.mergeTracesFrom(donor.taint)
            }
          }
        }
      }
    }

    // ARG→RET 反向染（union receiver 真实 body 路径）：union 派发场景下，receiver 本身不带 source、
    // 但被调用方的 arg 携带 JAVA_INPUT key（典型：builder fluent chain `.addX(taintedArg)`、静态工厂
    // `Factory.create(taintedArg, ...)`），union 各 branch impl 的真实 body 不会把 arg 端 source key
    // 反向写到 res 自身 tagTraces / buffer，导致 sink 侧 fCollectTags 起点过滤
    // (`tagTraces.has('JAVA_INPUT')`) 拒启动。
    // 与上方 receiver→RET 三写互补（场景区分：receiver 带 JI 走上面，arg 带 JI 走这里）；与
    // common/analyzer.ts processLibArgToRetWithBuffer 的 ARG→RET 三写规约一致
    // (`lib-arg-to-ret-buffer.md §十一`)。
    // 守卫硬约束（同 union-receiver-fclos-reverse.md §四）：
    // - fclos.vtype === 'union'：禁止扩到 'fclos'，否则普通 POJO trace 污染（test-java 201→155）
    // - !res 自身已含 JAVA_INPUT：与上方 receiver→RET hook 互斥，避免重复
    // - arg 必须自身 isTaintedRec=true 且 JAVA_INPUT key 在 arg 自身或其 buffer 后代 depth≤4 内可达
    if (
      res &&
      node.callee?.type === 'MemberAccess' &&
      fclos.vtype === 'union' &&
      _.isFunction((res as any).setMisc) &&
      Array.isArray(argvalues) &&
      argvalues.length > 0
    ) {
      const TAG = 'JAVA_INPUT'
      const resTagTraces = (res as any).taint?.tagTraces
      const resHasJI = resTagTraces instanceof Map && resTagTraces.has(TAG)
      if (!resHasJI) {
        // 只允许真实 SOURCE donor 回写，避免无 SOURCE 的中间 JAVA_INPUT trace 覆盖源头 trace。
        for (const arg of argvalues) {
          if (!arg?.taint?.isTaintedRec) continue
          const donor = findJavaInputTraceDonor(arg)
          if (!donor) continue
          addElementToBuffer(res, arg)
          ;(res as any).taint?.markSource?.()
          if (_.isFunction((res as any).taint?.mergeTracesFrom) && donor.taint) {
            ;(res as any).taint.mergeTracesFrom(donor.taint)
          }
          break
        }
      }
    }

    const returnReferencesParameter = javaReturnExpressionReferencesParameter(fclos.ast?.fdef)
    const returnReferencesExternalQueryResult = javaReturnExpressionReferencesExternalQueryResult(fclos.ast?.fdef)
    if (
      res &&
      (node.callee?.type === 'MemberAccess' || returnReferencesExternalQueryResult) &&
      fclos?.vtype === 'fclos' &&
      !fclos.runtime?.execute &&
      Array.isArray(argvalues) &&
      argvalues.length > 0 &&
      isObjectLikeJavaReturn(res) &&
      !hasJavaInputTraceKey(res) &&
      (returnReferencesParameter ||
        returnReferencesExternalQueryResult ||
        javaReturnExpressionReferencesTaintedQueryResult(fclos.ast?.fdef, argvalues))
    ) {
      const donor = findJavaInputArgumentDonor(argvalues)
      if (donor && donor !== res) {
        if (returnReferencesExternalQueryResult && !returnReferencesParameter) {
          attachJavaInputTraceKeyFromDonor(res, donor)
        } else {
          attachJavaInputTraceToReturnGraph(res, donor)
        }
      }
    }

    if (
      res &&
      Array.isArray(argvalues) &&
      argvalues.length > 0 &&
      isObjectLikeJavaReturn(res) &&
      !hasJavaInputTraceKey(res) &&
      isJavaInterfaceOrNoBodyMapperCall(node, fclos)
    ) {
      const calledMethodName = this.getCalledMethodName(node, fclos) ?? getJavaMethodNameFromCallee(node)
      const shouldPropagateInputToReturn =
        (isJavaBeanCopyMethodName(calledMethodName) && isJavaMapperBeanCopyReturn(res)) ||
        (isJavaRequestBuilderMethodName(calledMethodName) && isRequestLikeJavaCarrier(res))
      if (shouldPropagateInputToReturn) {
        const donor = findJavaInputArgumentDonor(argvalues)
        if (donor && donor !== res) {
          attachJavaInputTraceToReturnGraph(res, donor)
        }
      }
    }

    // search/RPC return 容器轻量挂载 query carrier 引用：让 stream.map(DTO::getX) 链路下游
    // mapped value 一次性继承 carrier 的 JAVA_INPUT trace（消费在 stream-builtins.ts 的 Stream.map）。
    // 不直接对 element 三写 markSource + mergeTracesFrom，避免百万次 Map 深合并触发 OOM
    // （onepaas 教训）。frequency = stream.map 调用数（千级），远小于"对所有 element 三写"。
    if (
      res &&
      _.isFunction((res as any).getMisc) &&
      _.isFunction((res as any).setMisc) &&
      Array.isArray(argvalues) &&
      argvalues.length > 0 &&
      fclos?.vtype === 'fclos' &&
      !fclos.runtime?.execute &&
      !(res as any).getMisc('_carrierTrace')
    ) {
      const hasBuffer =
        Array.isArray((res as any).getMisc('buffer')) && ((res as any).getMisc('buffer') as any[]).length > 0
      const hasPrecise =
        (res as any).getMisc?.('precise') && (res as any).value && typeof (res as any).value === 'object'
      if (hasBuffer || hasPrecise) {
        const receiver = typeof fclos.getThisObj === 'function' ? fclos.getThisObj() : fclos._this
        if (res !== receiver) {
          for (const arg of argvalues) {
            if (!arg || arg === receiver || arg === res) continue
            const vt = (arg as any).vtype
            if (vt === 'fclos' || vt === 'class' || vt === 'primitive') continue
            const tt = (arg as any).taint?.tagTraces
            if (tt instanceof Map && tt.size > 0) {
              ;(res as any).setMisc('_carrierTrace', arg)
              break
            }
          }
        }
      }
    }

    // 跨方法返回容器 element JAVA_INPUT 沉淀：项目方法返回 List/Map/Bean 时，引擎已把
    // res 标 isTaintedRec=true 但 tagTraces 不含 JAVA_INPUT 字符串 key，sink 端起点过
    // 滤 fail-closed 漏检。仅 addTag 补 key（不 mergeTracesFrom 拷贝 trace 节点），避免与
    // 既有 carrier 沉淀重叠引发 trace dedupe 折叠。触发条件保守收紧到"args 全不可达
    // 兜底"分支：args 全不可达（合成 call / 重写后 AST 已展开）+ 项目方法 fclos（非 lib
    // runtime）+ res 容器形态（buffer / precise / Bean-like 非空 value 对象）+ res ≠
    // receiver + res isTaintedRec=true + 体非平凡（≥2）+ buffer 非空 + res 子树深度 1
    // 内未含 JAVA_INPUT。
    // 注：不走 args 子树扫 JAVA_INPUT 的普通分支，避免 alias 场景（如 SimpleAlias.bar
    // 中 this.b1.attr=a 但 return this.b2.attr，因 b1≠b2 实际未流经）触发误报。
    if (
      res &&
      _.isFunction((res as any).getMisc) &&
      fclos?.vtype === 'fclos' &&
      !fclos.runtime?.execute &&
      Array.isArray(argvalues)
    ) {
      let effectiveArgs: any[] = argvalues
      if (argvalues.length === 0 && Array.isArray(node?.arguments) && node.arguments.length > 0) {
        try {
          const evald: any[] = []
          for (const argNode of node.arguments) {
            const argv = this.evaluateNestedCallArgument(scope, argNode as any, state)
            if (Array.isArray(argv)) evald.push(...argv)
            else evald.push(argv)
          }
          effectiveArgs = evald
        } catch (_e) {
          /* keep original */
        }
      }
      const receiver2 = typeof fclos.getThisObj === 'function' ? fclos.getThisObj() : fclos._this
      const resBuf = (res as any).getMisc('buffer')
      const resHasBuffer = Array.isArray(resBuf)
      const resPrecise =
        !!(res as any).getMisc('precise') && (res as any).value && typeof (res as any).value === 'object'
      const resBeanLike =
        ((res as any).vtype === 'object' || (res as any).vtype === 'symbol') &&
        (res as any).value &&
        typeof (res as any).value === 'object' &&
        Object.keys((res as any).value).length > 0
      const isContainer = resHasBuffer || resPrecise || resBeanLike
      if (isContainer && res !== receiver2) {
        const hasJavaInputKey = (v: any, depth: number): boolean => {
          if (!v || typeof v !== 'object' || depth < 0) return false
          if (v.taint?.tagTraces instanceof Map && v.taint.tagTraces.has('JAVA_INPUT')) return true
          if (depth > 0) {
            if (_.isFunction(v.getMisc) && Array.isArray(v.getMisc('buffer'))) {
              for (const e of getAllElementFromBuffer(v)) {
                if (hasJavaInputKey(e, depth - 1)) return true
              }
            }
            if (v.value && typeof v.value === 'object') {
              for (const k of Object.keys(v.value)) {
                const child = v.value[k]
                if (child && typeof child === 'object' && (child as any).vtype !== 'fclos') {
                  if (hasJavaInputKey(child, depth - 1)) return true
                }
              }
            }
          }
          return false
        }
        let argHasKey = false
        if (effectiveArgs.length === 0) {
          const bodyLen = fclos?.ast?.fdef?.body?.body?.length ?? 0
          if (
            (res as any)?.taint?.isTaintedRec === true &&
            bodyLen >= 2 &&
            resHasBuffer &&
            (resBuf?.length ?? 0) >= 1
          ) {
            argHasKey = true
          }
        }
        const resHasKey = hasJavaInputKey(res, 1)
        if (argHasKey && !resHasKey) {
          const elements: any[] = []
          if (resHasBuffer) {
            for (const e of getAllElementFromBuffer(res as any)) if (e) elements.push(e)
          }
          if ((res as any).value && typeof (res as any).value === 'object') {
            for (const k of Object.keys((res as any).value)) {
              const v = (res as any).value[k]
              if (v && typeof v === 'object' && (v as any).vtype !== 'fclos') {
                if (resPrecise && Number.isFinite(Number(k))) elements.push(v)
                else if (resBeanLike && !Number.isFinite(Number(k))) elements.push(v)
              }
            }
          }
          const donor = findJavaInputTraceDonor(res)
          if (donor) {
            attachJavaInputTraceFromDonor(res, donor)
            for (const elem of elements) {
              attachJavaInputTraceFromDonor(elem, donor)
            }
          }
        }
      }
    }

    if (
      res?.constructor?.name === 'UndefinedValue' &&
      fclos.sid?.includes('<anonymous') &&
      fclos.ast.fdef?.body?.body?.length === 1
    ) {
      const oldBodyExpr = fclos.ast.fdef.body.body[0]
      try {
        fclos.ast.fdef.body.body[0] = UastSpec.returnStatement(fclos.ast.fdef.body.body[0])
        res = this.executeCall(node, fclos, state, scope, {
          callArgs: this.buildCallArgs(node, argvalues, fclos),
          callsiteNode: node,
        })
      } catch (e) {
        // 忽略错误
      } finally {
        fclos.ast.fdef.body.body[0] = oldBodyExpr
      }
    }

    const anonymousCallbackMethods = this.findAnonymousObjectCallbackMethods(argvalues, node.arguments)
    const dispatchedCallbackMethods = new Set<SymbolValueType>()
    for (const { callback, callbackMethod, methodArgs } of anonymousCallbackMethods) {
      const callbackRes = this.executeCallbackMethodWithArgs(node, state, scope, callbackMethod, methodArgs, callback)
      dispatchedCallbackMethods.add(callbackMethod)
      if (callbackRes && !res) res = callbackRes
    }

    const bridgedCallbackRes = this.dispatchReceiverCallbackMethod(
      node,
      fclos,
      argvalues,
      state,
      scope,
      dispatchedCallbackMethods,
      primaryFclosExecuted || fclosExecuted
    )
    if (bridgedCallbackRes && !res) res = bridgedCallbackRes

    // function definition not found
    if (fclos.vtype !== 'fclos') {
      // examine possible call-back functions in the arguments
      // 当 union receiver 的某个分支已被 builtin（runtime.execute）接管并显式调用 callback
      // 时，跳过 executeFunctionInArguments，避免对 lambda 进行第二次空 args 调用——后者
      // 会用 uninitialized 形参覆盖 builtin 端正确绑定的元素，洗掉污点。
      let unionDispatchedByBuiltin = false
      if (fclos.vtype === 'union' && Array.isArray(fclos.value)) {
        for (const branch of fclos.value) {
          if (branch?.runtime?.execute) {
            unionDispatchedByBuiltin = true
            break
          }
        }
      }
      if (Config.invokeCallbackOnUnknownFunction && !unionDispatchedByBuiltin) {
        this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
      }

      // execute function not found callback
      if (fclos._this?.members?.get('_functionNotFoundCallback_')?.vtype === 'fclos') {
        this.executeCall(node, fclos._this.members.get('_functionNotFoundCallback_')!, state, scope, {
          callArgs: this.buildCallArgs(node, argvalues, fclos._this.members.get('_functionNotFoundCallback_')!),
          callsiteNode: node,
        })
      }

      // evaluate default equals result
      if (
        fclos.sid === 'equals' &&
        fclos.getThisObj()?.vtype === 'primitive' &&
        argvalues.length > 0 &&
        argvalues[0]?.vtype === 'primitive' &&
        fclos.getThisObj().value !== argvalues[0].value
      ) {
        res = new PrimitiveValue(scope.qid, '<bool_false>', false, null, 'Literal', node.loc)
      }
    }

    // execute fclos of this
    if (fclos?._this?.vtype === 'fclos') {
      if (['accept', 'apply', 'call', 'run', 'get'].includes(fclos.sid)) {
        this.executeCall(node, fclos._this, state, scope, {
          callArgs: this.buildCallArgs(node, argvalues, fclos._this),
          callsiteNode: node,
        })
      } else if (fclos.sid === 'invoke' && argvalues.length >= 1) {
        fclos._this._this = argvalues[0]
        this.executeCall(node, fclos._this, state, scope, {
          callArgs: this.buildCallArgs(node, argvalues.slice(1), fclos._this),
          callsiteNode: node,
        })
      }
    }

    if (meetSameFuncInCallstack && !argExecuted && node.arguments?.length === argvalues.length) {
      for (let i = 0; i < node.arguments.length; i++) {
        const arg = node.arguments[i]
        const argv = argvalues[i]
        const argNode = arg as { type?: string; name?: string; parameters?: Array<any> }
        if (argNode?.type === 'FunctionDefinition' && argNode?.name?.includes('<anonymous')) {
          const funcDef = arg as unknown as FunctionDefinition
          let anonymousArgValues
          const _this = fclos.getThisObj()
          if (_this && argNode.parameters && argNode.parameters.length > 0) {
            anonymousArgValues = []
            let j = 0
            while (j < argNode.parameters.length) {
              anonymousArgValues.push(_this)
              j++
            }
          }
          this.processAndCallFuncDef(scope, funcDef, argv, state, anonymousArgValues, node)
          argExecuted = true
        }
      }
    }

    if (res && this.checkerManager?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        argvalues,
        fclos,
        ret: res,
        pcond: state.pcond,
        einfo: state.einfo,
        callstack: state.callstack,
      })
    }

    if (!res) {
      res = new UndefinedValue()
    }
    return res
  }

  /**
   *
   * @param node
   * @param fclos
   * @param res
   */
  private propagateReadWrapperReceiverTrace(node: CallExpression, fclos: Value, res: Value | undefined): void {
    if (!res || node.callee?.type !== 'MemberAccess') return

    const methodName = this.getCalledMethodName(node, fclos)
    if (!this.isReadWrapperMethod(methodName, node)) return

    const receiver = this.getReadWrapperReceiver(fclos)
    if (!receiver || receiver === res) return

    if (this.attachReadWrapperSourceTrace(receiver, res)) return
    if (this.isJsonMemberReadMethod(methodName, node.arguments?.length ?? 0)) {
      this.attachReadWrapperSourceTrace(fclos, res)
    }
  }

  /**
   *
   * @param fclos
   * @param obj
   * @param callInfo
   * @param node
   */
  private propagateConstructorArgumentTrace(
    fclos: Value,
    obj: Value | undefined,
    callInfo: CallInfo,
    node: NewExpression
  ): void {
    if (!obj || !this.shouldPropagateConstructorArgumentTrace(fclos, callInfo, node)) return
    for (const arg of getLegacyArgValues(callInfo)) {
      if (!arg || arg === obj) continue
      this.attachReadWrapperSourceTrace(arg, obj)
    }
  }

  /**
   *
   * @param source
   * @param target
   */
  private attachReadWrapperSourceTrace(source: Value, target: Value): boolean {
    if (source === target) return false
    const donor = findJavaInputTraceDonor(source, 8)
    if (!donor?.taint || donor === target) return false
    const attached = attachJavaInputTraceFromDonor(target, donor)
    if (attached && _.isFunction((target as MiscBufferCarrier).setMisc)) {
      addElementToBuffer(target as MiscBufferCarrier, source)
    }
    return attached
  }

  /**
   *
   * @param methodName
   * @param node
   */
  private isReadWrapperMethod(methodName: string | undefined, node: CallExpression): boolean {
    if (!methodName) return false
    const argCount = node.arguments?.length ?? 0
    if (argCount === 0) return methodName === 'lines'
    if (argCount !== 1) return false
    if (this.isJsonMemberReadMethod(methodName, argCount)) return true
    return methodName === 'collect' && this.isReadWrapperCollectorArg(node.arguments?.[0])
  }

  /**
   *
   * @param arg
   */
  private isReadWrapperCollectorArg(arg: unknown): boolean {
    return /(^|\.)joining$/.test(this.getCollectorArgumentName(arg))
  }

  /**
   *
   * @param arg
   */
  private getCollectorArgumentName(arg: unknown): string {
    if (!arg || typeof arg !== 'object') return ''
    const node = arg as JavaCalleeNode & { callee?: JavaCalleeNode }
    if (node.type === 'CallExpression' && node.callee) return this.getJavaCalleeName(node.callee)
    return this.getJavaCalleeName(node)
  }

  /**
   *
   * @param callee
   */
  private getJavaCalleeName(callee: JavaCalleeNode | undefined): string {
    if (!callee) return ''
    if (callee.type === 'Identifier') return String(callee.name ?? callee.qid ?? callee.sid ?? '')
    if (callee.type === 'Literal') return String(callee.value ?? '')
    if (callee.type === 'MemberAccess') {
      const objectName = this.getJavaCalleeName(callee.object)
      const propertyName = this.getJavaCalleeName(callee.property)
      return [objectName, propertyName].filter(Boolean).join('.')
    }
    return String(callee.name ?? callee.qid ?? callee.sid ?? '')
  }

  /**
   *
   * @param methodName
   * @param argCount
   */
  private isJsonMemberReadMethod(methodName: string | undefined, argCount: number): boolean {
    return argCount === 1 && methodName !== undefined && /^(get|getString|getJSONObject|getJSONArray)$/.test(methodName)
  }

  /**
   *
   * @param fclos
   */
  private getReadWrapperReceiver(fclos: Value): Value | undefined {
    const callable = fclos as Value & { getThisObj?: () => unknown; _this?: unknown }
    const receiver = typeof callable.getThisObj === 'function' ? callable.getThisObj() : callable._this
    return receiver && typeof receiver === 'object' ? (receiver as Value) : undefined
  }

  /**
   *
   * @param fclos
   * @param callInfo
   * @param node
   */
  private shouldPropagateConstructorArgumentTrace(fclos: Value, callInfo: CallInfo, node: NewExpression): boolean {
    const hasSourceArgument = getLegacyArgValues(callInfo).some((arg: unknown) => findJavaInputTraceDonor(arg, 8))
    if (!hasSourceArgument) return false
    const fclosQid = String(fclos?.qid ?? fclos?.logicalQid ?? fclos?.sid ?? '')
    if (
      /(^|\.)java\.io\.(InputStreamReader|BufferedReader|Reader|InputStream)$|(^|\.)(InputStreamReader|BufferedReader)$/.test(
        fclosQid
      )
    ) {
      return true
    }
    const calleeName = this.getNewExpressionCalleeName(node)
    return /(^|\.)(InputStreamReader|BufferedReader|URL)$/.test(calleeName)
  }

  /**
   *
   * @param node
   */
  private getNewExpressionCalleeName(node: NewExpression): string {
    const callee = node.callee as JavaCalleeNode | undefined
    if (!callee) return ''
    if (callee.type === 'Identifier') return String(callee.name ?? '')
    if (callee.type === 'MemberAccess') {
      const objectName = this.getCalleePartName(callee.object)
      const propertyName = this.getCalleePartName(callee.property)
      return [objectName, propertyName].filter(Boolean).join('.')
    }
    return String(callee.name ?? callee.qid ?? callee.sid ?? '')
  }

  /**
   *
   * @param part
   */
  private getCalleePartName(part: JavaCalleeNode | undefined): string {
    if (!part) return ''
    if (part.type === 'Identifier') return part.name ?? ''
    if (part.type === 'Literal') return String(part.value ?? '')
    return part.name ?? ''
  }

  /**
   *
   * @param argvalues
   * @param argAsts
   */
  private findAnonymousObjectCallbackMethods(
    argvalues: unknown[],
    argAsts: unknown[]
  ): Array<{ callback: SymbolValueType; callbackMethod: SymbolValueType; methodArgs: unknown[] }> {
    const result: Array<{ callback: SymbolValueType; callbackMethod: SymbolValueType; methodArgs: unknown[] }> = []
    if (argvalues.length < 2 || argvalues.length !== argAsts.length) return result

    for (let i = 0; i < argvalues.length; i++) {
      const argvalue = argvalues[i]
      if (!this.isAnonymousCallbackObject(argvalue, argAsts[i])) continue
      for (const callbackMethod of this.getExecutableCallbackMethods(argvalue, argAsts[i])) {
        const methodArgs = this.selectCallbackMethodArgs(callbackMethod, argvalues, argvalue)
        if (!methodArgs) continue
        result.push({ callback: argvalue, callbackMethod, methodArgs })
      }
    }
    return result
  }

  /**
   *
   * @param value
   * @param argAst
   */
  private isAnonymousCallbackObject(value: unknown, argAst: unknown): value is SymbolValueType {
    if (!value || typeof value !== 'object') return false
    const candidate = value as {
      vtype?: string
      sid?: string
      ast?: { cdef?: ClassDefinition; node?: ClassDefinition }
    }
    if (candidate.vtype !== 'object' && candidate.vtype !== 'class') return false
    const astNode = argAst as { type?: string }
    if (astNode?.type !== 'NewExpression' && astNode?.type !== 'Sequence') return false
    return this.getExecutableCallbackMethods(value as SymbolValueType, argAst).length > 0
  }

  /**
   *
   * @param callback
   * @param argAst
   */
  private getExecutableCallbackMethods(callback: SymbolValueType, argAst: unknown): SymbolValueType[] {
    const { members } = callback as unknown as {
      members?: { forEach?: (callback: (member: unknown, name: unknown) => void) => void }
    }
    if (!members || typeof members.forEach !== 'function') return []
    const methods: SymbolValueType[] = []
    members.forEach((member: unknown, name: unknown) => {
      if (name === '_CTOR_' || name === '_functionNotFoundCallback_') return
      if (this.isExecutableAnonymousCallbackMethod(member) && this.isCallbackMethodDeclaredInline(member, argAst)) {
        methods.push(member)
      }
    })
    return methods
  }

  /**
   *
   * @param method
   * @param argAst
   */
  private isCallbackMethodDeclaredInline(method: SymbolValueType, argAst: unknown): boolean {
    const methodNode = method.ast?.fdef
    if (!methodNode?.loc || !(argAst as { loc?: unknown })?.loc) return false
    const argLoc = (argAst as { loc: { start?: { line?: number }; end?: { line?: number } } }).loc
    const methodStart = methodNode.loc.start?.line
    const methodEnd = methodNode.loc.end?.line
    const argStart = argLoc.start?.line
    const argEnd = argLoc.end?.line
    if (!methodStart || !methodEnd || !argStart || !argEnd) return false
    return methodStart >= argStart && methodEnd <= argEnd
  }

  /**
   *
   * @param method
   */
  private isExecutableAnonymousCallbackMethod(method: unknown): method is SymbolValueType {
    if (!method || typeof method !== 'object') return false
    const candidate = method as { vtype?: string; ast?: { fdef?: FunctionDefinition }; runtime?: { execute?: unknown } }
    if (candidate.vtype !== 'fclos') return false
    if (candidate.ast?.fdef?.body?.type === 'Noop') return false
    return !!(candidate.ast?.fdef || candidate.runtime?.execute)
  }

  /**
   *
   * @param node
   * @param state
   * @param scope
   * @param callbackMethod
   * @param methodArgs
   * @param callbackThis
   */
  private executeCallbackMethodWithArgs(
    node: CallExpression,
    state: State,
    scope: Scope,
    callbackMethod: SymbolValueType,
    methodArgs: unknown[],
    callbackThis: Unit | null | undefined
  ): Value | undefined {
    const oldThis = callbackMethod._this
    callbackMethod._this = callbackThis ?? null
    try {
      return this.executeCall(node, callbackMethod, state, scope, {
        callArgs: this.buildCallArgs(node, methodArgs, callbackMethod),
        callsiteNode: node,
      })
    } finally {
      callbackMethod._this = oldThis
    }
  }

  /**
   *
   * @param node
   * @param fclos
   * @param argvalues
   * @param state
   * @param scope
   * @param alreadyDispatched
   * @param primaryFclosExecuted
   */
  private dispatchReceiverCallbackMethod(
    node: CallExpression,
    fclos: Value,
    argvalues: unknown[],
    state: State,
    scope: Scope,
    alreadyDispatched: Set<SymbolValueType>,
    primaryFclosExecuted: boolean
  ): Value | undefined {
    if (primaryFclosExecuted) return undefined
    if (!this.isExecutableAnonymousCallbackMethod(fclos)) return undefined
    if (!this.isReceiverCallbackBridgeMethod(node, fclos)) return undefined
    if (alreadyDispatched.has(fclos)) return undefined
    const methodArgs = this.selectReceiverCallbackMethodArgs(fclos, argvalues)
    if (!methodArgs) return undefined
    const callbackThis = this.getCallbackMethodReceiver(fclos)
    return this.executeCallbackMethodWithArgs(node, state, scope, fclos, methodArgs, callbackThis)
  }

  /**
   *
   * @param callbackMethod
   * @param argvalues
   */
  private selectReceiverCallbackMethodArgs(
    callbackMethod: SymbolValueType,
    argvalues: unknown[]
  ): unknown[] | undefined {
    const params = (callbackMethod.ast?.fdef as FunctionDefinition | undefined)?.parameters
    if (!Array.isArray(params)) return []
    if (params.length === 0) return []
    if (params.length === argvalues.length) {
      const matched = this.findStrongTypedCallbackArgs(params, argvalues)
      return matched ?? undefined
    }
    if (params.length === 1) {
      const matched = this.findStrongTypedCallbackArg(params[0], argvalues)
      if (matched) return [matched]
    }
    return undefined
  }

  /**
   *
   * @param callbackMethod
   */
  private getCallbackMethodReceiver(callbackMethod: SymbolValueType): Unit | null | undefined {
    return callbackMethod.getThisObj?.() ?? callbackMethod._this ?? callbackMethod.parent
  }

  /**
   *
   * @param node
   * @param fclos
   */
  private isReceiverCallbackBridgeMethod(node: CallExpression, fclos: Value): boolean {
    const methodName = this.getCalledMethodName(node, fclos)
    if (methodName !== 'execute') return false
    const params = (fclos.ast?.fdef as FunctionDefinition | undefined)?.parameters
    return Array.isArray(params) && params.length === 1 && (node.arguments?.length ?? 0) >= 1
  }

  /**
   *
   * @param node
   * @param fclos
   */
  private isJavaBeanGetterCall(node: CallExpression, fclos?: Value): boolean {
    const methodName = this.getCalledMethodName(node, fclos)
    if (!methodName || methodName === 'getClass') return false
    return /^get[A-Z]/.test(methodName) || /^is[A-Z]/.test(methodName)
  }

  /**
   *
   * @param node
   * @param fclos
   */
  private isJavaBeanSetterCall(node: CallExpression, fclos?: Value): boolean {
    const methodName = this.getCalledMethodName(node, fclos)
    return Boolean(methodName && /^set[A-Z]/.test(methodName) && (node.arguments?.length ?? 0) === 1)
  }

  /**
   *
   * @param left
   */
  private isJavaThisMemberFieldWrite(left: unknown): boolean {
    if (!left || typeof left !== 'object') return false
    const node = left as { type?: string; object?: { type?: string }; property?: unknown }
    return node.type === 'MemberAccess' && node.object?.type === 'ThisExpression' && Boolean(node.property)
  }

  /**
   *
   * @param callbackMethod
   * @param argvalues
   * @param callback
   */
  private selectCallbackMethodArgs(
    callbackMethod: SymbolValueType,
    argvalues: unknown[],
    callback: SymbolValueType
  ): unknown[] | undefined {
    const params = (callbackMethod.ast?.fdef as FunctionDefinition | undefined)?.parameters
    if (!Array.isArray(params)) return []
    const candidateArgs = argvalues.filter((argvalue) => argvalue !== callback)
    if (params.length === 0) return []
    if (params.length === candidateArgs.length) return candidateArgs
    if (params.length === 1 && candidateArgs.length > 0) {
      const matched = this.findStrongTypedCallbackArg(params[0], candidateArgs)
      if (matched) return [matched]
      return undefined
    }
    return undefined
  }

  /**
   *
   * @param params
   * @param candidates
   */
  private findStrongTypedCallbackArgs(params: unknown[], candidates: unknown[]): unknown[] | undefined {
    if (params.length !== candidates.length) return undefined
    const matched: unknown[] = []
    for (let i = 0; i < params.length; i++) {
      if (!this.isStrongTypedCallbackArgMatch(params[i], candidates[i])) return undefined
      matched.push(candidates[i])
    }
    return matched
  }

  /**
   *
   * @param param
   * @param candidates
   */
  private findStrongTypedCallbackArg(param: unknown, candidates: unknown[]): unknown | undefined {
    for (const candidate of candidates) {
      if (this.isStrongTypedCallbackArgMatch(param, candidate)) return candidate
    }
    return undefined
  }

  /**
   *
   * @param param
   * @param candidate
   */
  private isStrongTypedCallbackArgMatch(param: unknown, candidate: unknown): boolean {
    const paramType = this.getCallbackParameterTypeName(param)
    if (!paramType) return false
    const normalizedParamType = this.eraseGenericType(this.normalizeQid(paramType))
    if (!normalizedParamType || !isJavaObjectCarrier(candidate)) return false
    const candidateType = this.eraseGenericType(this.getDefiniteTypeText(candidate))
    return Boolean(candidateType && this.isCallbackTypeMatch(normalizedParamType, candidateType))
  }

  /**
   *
   * @param param
   */
  private getCallbackParameterTypeName(param: unknown): string | undefined {
    const varType = (param as { varType?: { id?: unknown } } | undefined)?.varType?.id
    if (!varType) return undefined
    return AstUtil.prettyPrint(varType)
  }

  /**
   *
   * @param paramType
   * @param candidateType
   */
  private isCallbackTypeMatch(paramType: string, candidateType: string): boolean {
    return (
      paramType === candidateType ||
      (!this.hasPackageQualifier(paramType) && this.getShortTypeName(candidateType) === paramType) ||
      (!this.hasPackageQualifier(candidateType) && this.getShortTypeName(paramType) === candidateType)
    )
  }

  /**
   * 处理 new 表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} new 表达式结果
   */
  override processNewExpression(scope: Scope, node: NewExpression, state: State): SymbolValueType {
    if (node._meta && node._meta.isEnumImpl) {
      return this.processInstruction(scope, node.callee, state)
    }
    return super.processNewExpression(scope, node, state)
  }

  /**
   * 处理一元表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 一元表达式结果
   */
  override processUnaryExpression(scope: Scope, node: UnaryExpression, state: State): UnaryExprValue {
    let res = super.processUnaryExpression(scope, node, state)

    if (res.argument?.vtype === 'primitive' && res.argument?.literalType === 'number') {
      const argValueNum = Number(res.argument.value)
      if (node.operator === '++') {
        res = new PrimitiveValue(
          scope.qid,
          `<operatorExp_${node.operator}_${node.loc.start?.line}_${node.loc.start?.column}_${node.loc.end?.line}_${node.loc.end?.column}>`,
          argValueNum + 1,
          null,
          'Literal',
          node.loc
        )
        this.saveVarInScope(scope, node.argument, res, state)
      } else if (node.operator === '--') {
        res = new PrimitiveValue(
          scope.qid,
          `<operatorExp_${node.operator}_${node.loc.start?.line}_${node.loc.start?.column}_${node.loc.end?.line}_${node.loc.end?.column}>`,
          argValueNum - 1,
          null,
          'Literal',
          node.loc
        )
        this.saveVarInScope(scope, node.argument, res, state)
      }
    }

    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processTryStatement(scope: Scope, node: TryStatement, state: State): VoidValueType {
    state.throwstack = state.throwstack ?? []

    this.processInstruction(scope, node.body, state)

    const { handlers } = node
    if (handlers) {
      for (const clause of handlers) {
        const subScope = ScopeClass.createSubScope(
          `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
          scope
        )
        if (clause && state?.throwstack?.length > 0) {
          const throw_value = state.throwstack[0]
          for (const param of clause.parameter) {
            if (param && param.type === 'VariableDeclaration' && param.init === null) {
              param._meta.isCatchParam = true
              param.init = {
                type: 'Identifier',
                name: throw_value.sid,
                _meta: param._meta,
                loc: param.loc,
                parent: param.parent,
              } as any
            }
          }
        }
        if (clause) {
          clause.parameter.forEach((param: any) => this.processInstruction(subScope, param, state))
          this.processInstruction(subScope, clause.body, state)
        }
      }
    }

    if (node.finalizer) {
      this.processInstruction(scope, node.finalizer, state)
    }

    if (state?.throwstack?.length === 0) {
      delete state.throwstack
    }

    return new UndefinedValue()
  }

  // 隔离互斥分支的执行预算：consequent 和 alternative 不应共享累计时间；
  // 同时清除分支内部设置的 EP timeout，让三目之后语句有机会执行
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processConditionalExpression(scope: any, node: any, state: any): any {
    const timeoutBefore = !!this.globalState.entryPointTimeout

    const test = this.processInstruction(scope, node.test, state)
    const rscope = MemState.cloneScope(scope, state)
    const substates = MemState.forkStates(state)
    const lstate = substates[0]
    const rstate = substates[1]
    this.processLRScopeInternal(lstate, rstate, state, test)

    const res = new UnionValue(
      undefined,
      undefined,
      `${scope.qid}.<union@cond:${node.loc?.start?.line}:${node.loc?.start?.column}>`,
      node
    )

    const budgetSnapshot = this.snapshotMethodBudgets()
    const consequentVal = this.processInstruction(scope, node.consequent, lstate)
    const consequentFinal = this.snapshotMethodBudgets()

    this.restoreMethodBudgets(budgetSnapshot)
    const alternativeVal = this.processInstruction(rscope, node.alternative, rstate)
    const alternativeFinal = this.snapshotMethodBudgets()

    this.mergeMethodBudgets(consequentFinal, alternativeFinal)

    res.appendValue(consequentVal)
    res.appendValue(alternativeVal)

    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processRangeStatement(scope: Scope, node: RangeStatement, state: State): any {
    const { key, value, right, body } = node
    scope = ScopeClass.createSubScope(
      `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
      scope
    )
    const rightVal = this.processInstruction(scope, right, state)
    let executed = false
    if (
      !Array.isArray(rightVal) &&
      (this.inRange ||
        rightVal?.vtype === 'primitive' ||
        Object.keys(rightVal.getRawValue()).filter((key) => !key.startsWith('__yasa')).length === 0 ||
        rightVal?.vtype === 'union' ||
        !rightVal?.getMisc('precise'))
    ) {
      if (value) {
        if (value.type === 'VariableDeclaration') {
          this.saveVarInCurrentScope(scope, value.id, rightVal, state)
        } else if (value.type === 'TupleExpression') {
          for (const ele of value.elements) {
            const eleName = ele && ele.type === 'Identifier' ? ele.name : ele?.name || 'unknown'
            this.saveVarInCurrentScope(scope, eleName, rightVal, state)
          }
        } else {
          this.saveVarInScope(scope, value, rightVal, state)
        }
      }
      if (key) {
        // TODO js存到value，go存到key。且需要考虑既有key 又有value的场景
        this.saveVarInScope(scope, key, rightVal, state)
      }
      this.processInstruction(scope, body, state)
      executed = true
    } else {
      this.inRange = true
      if (this.isNullLiteral(rightVal)) {
        this.inRange = false
        return undefined
      }
      const itr = this.getValueIterator(rightVal, filterDataFromScope)
      let countLimit = 30
      for (let { value: field, done } = itr.next(); !done; { value: field, done } = itr.next()) {
        if (countLimit-- === 0) {
          break
        }
        if (!field) continue
        let { k, v } = field
        if (key) {
          if (key.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, key.id, k, state)
          } else {
            // 如果是string，将其构造出符号值再存储
            // TODO 250731 将符号的字面量(而非符号值)作为key存储是否合适，有待商榷。
            if (_.isString(k)) k = new PrimitiveValue(scope.qid, k, k, undefined, key.type, key.loc, key)
            this.saveVarInScope(scope, key, k, state)
          }
        }
        if (value) {
          if (value.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, value.id, v, state)
          } else {
            this.saveVarInScope(scope, value, v, state)
          }
        }
        this.processInstruction(scope, body, state)
        executed = true
      }
      this.inRange = false
    }

    if (!executed && rightVal?._this?.vtype === 'class' && this.thisFClos && this.thisFClos.vtype === 'symbol') {
      this.inRange = true
      this.processInstruction(scope, body, state)
      this.inRange = false
    }
    return new VoidValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processCastExpression(scope: any, node: any, state: any) {
    const exprVal = this.processInstruction(scope, node.expression, state)
    if (exprVal?.vtype === 'fclos' && node?.expression?.type === 'FunctionDefinition') {
      this.processAndCallFuncDef(scope, node.expression, exprVal, state, undefined, node)
    }
    return exprVal
  }

  /**
   * 预处理项目目录
   * @param dir - 项目目录
   */
  // eslint-disable-next-line complexity
  async preProcess(dir: any) {
    JavaInitializer.initGlobalScope(this.topScope)
    JavaInitializer.initPackageScope(this.topScope.context.packages)

    await this.scanPackages(dir)
    if (!Config.miniSaveContextEnvironment) {
      this.assembleClassMap(this.topScope.context.packages)
      if (!Config.loadContextEnvironment) {
        JavaInitializer.addClassProto(this.classMap, this.topScope.context.packages, this)
      }
    }
  }

  /**
   * 加载缓存后的初始化阶段，会创建一些全局builtin
   */
  initAfterUsingCache() {
    JavaInitializer.initGlobalScope(this.topScope)
    JavaInitializer.initPackageScope(this.topScope.context.packages)
    this.assembleClassMap(this.topScope.context.packages)
  }

  /**
   *
   */
  override startAnalyze() {
    super.startAnalyze()
    FullCallGraphFileEntryPoint.makeFullCallGraphByType(this, this.typeResolver)
  }

  /**
   * 符号解释
   * @returns {boolean} 是否成功
   */
  // eslint-disable-next-line complexity
  async symbolInterpret(): Promise<boolean> {
    const entryPoints = (this as { entryPoints?: JavaEntryPointShape[] }).entryPoints ?? []
    const state = this.initState(this.topScope) as State & { entryPointStartTimestamp?: number | null }
    if (_.isEmpty(entryPoints)) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }

    for (const entryPoint of entryPoints) {
      this.entryPointSymValArray.push(entryPoint.entryPointSymVal)
    }

    this.pruneInfoMap.sinkArray = this.loadAllSink()
    this.pruneInfoMap.funcCallSourceSinkSanitizerArray.push(...this.pruneInfoMap.sinkArray)

    const allSources = this.loadAllSource()
    this.pruneInfoMap.funcCallSourceSinkSanitizerArray.push(...allSources[0])
    this.pruneInfoMap.otherSourceArray = allSources[1]

    const allSanitizers = this.loadAllSanitizer()
    this.pruneInfoMap.funcCallSourceSinkSanitizerArray.push(...allSanitizers[0])
    this.pruneInfoMap.otherSanitizerArray = allSanitizers[1]

    const pruneSupported = this.checkPruneSupported(entryPoints.length, this.pruneInfoMap.sinkArray.length)
    if (pruneSupported) {
      yasaLog('EntryPoint pruning is enabled', 'symbolInterpret')
    }

    const oldEntryPointTimeoutMs = Config.entryPointTimeoutMs
    const oldAggressiveMode = this.pruneInfoMap.aggressiveMode
    let deadlinePlan: ReturnType<typeof createDeadlinePlan> | undefined
    const checkpointWriter = new FindingsCheckpointWriter({
      filePath: require('path').join(Config.reportDir || './report', 'findings-checkpoint.json'),
      reason: 'timeout',
    })
    let mandatoryCheckpointAttempted = false
    const persistMandatoryCheckpoint = async (): Promise<void> => {
      if (mandatoryCheckpointAttempted) return
      mandatoryCheckpointAttempted = true
      if (deadlinePlan && !deadlinePlan.canFinalize()) {
        logger.warn('Final result checkpoint exceeded finalization deadline; attempting bounded persistence')
      }
      try {
        await this.outputAnalyzerExistResult(undefined, 'timeout', checkpointWriter)
      } catch (persistenceError) {
        logger.error('Mandatory result persistence failed after scheduling error', persistenceError)
      }
    }
    try {
      Config.entryPointTimeoutMs = Config.entryPointTimeoutQuickMs
      const scanTimeoutMs = Config.scanTimeoutMs ?? 0
      const remainingScanBudgetMs = Math.max(0, scanTimeoutMs - (Date.now() - this.scanStartTimestamp))
      const monotonicClock = (): number => performance.now()
      const monotonicNow = monotonicClock()
      deadlinePlan = createDeadlinePlan(
        {
          outerDeadline: monotonicNow + remainingScanBudgetMs,
          finalizationReserveMs: 30_000,
          exitReserveMs: 5_000,
        },
        monotonicClock
      )
      const activeDeadlinePlan = deadlinePlan
      const hasAnalysised = new Set<string>()
      // 自定义 source 入口方式，并根据入口自主加载 source。
      let epIdx = 0
      for (const entryPoint of entryPoints) {
        epIdx++
        const metricStartTime = Date.now()
        const findingsBefore = this.countFindings()
        let skipped = false
        let skipReason: string | undefined
        let overloadCount = 0
        try {
          if (!activeDeadlinePlan.canStartAnalysis()) {
            skipped = true
            skipReason = 'analysis-deadline'
            continue
          }
          this.symbolTable.clear()
          entryPoint.entryPointSymVal = this.tmpSymbolTable.tmpTableCopyUnit(entryPoint.entryPointSymVal)
          entryPoint.scopeVal = this.tmpSymbolTable.tmpTableCopyUnit(entryPoint.scopeVal)
          const symVal = entryPoint.entryPointSymVal
          if (entryPoint.type !== Constant.ENGIN_START_FUNCALL) {
            skipped = true
            skipReason = 'unsupported'
            continue
          }
          if (!symVal?.ast?.node) {
            skipped = true
            skipReason = 'unsupported'
            continue
          }
          const entryPointMark = this.markEntryPointForAnalysis(entryPoint, hasAnalysised)
          if (entryPointMark.skipped) {
            skipped = true
            skipReason = entryPointMark.skipReason
            continue
          }

          if (pruneSupported) {
            const entrypointCanPrune = this.checkFclosCanPrune(symVal)
            if (entrypointCanPrune) {
              const pruneFilePath =
                typeof entryPoint.filePath === 'string'
                  ? entryPoint.filePath.substring(0, entryPoint.filePath.lastIndexOf('.'))
                  : undefined
              const pruneFuncName =
                entryPoint.functionName ||
                `<anonymousFunc_${symVal.ast.node.loc?.start?.line}_${symVal.ast.node.loc?.end?.line}>`
              yasaLog(`EntryPoint [${pruneFilePath}.${pruneFuncName}] is pruned`, 'symbolInterpret')
              skipped = true
              skipReason = 'unsupported'
              continue
            }
          }

          CurrentEntryPoint.setCurrentEntryPoint(entryPoint)

          const overloadedList = symVal.overloaded
          if (!overloadedList?.length) {
            skipped = true
            skipReason = 'no-overloads'
            continue
          }

          const overloads = overloadedList.filter((item): item is FunctionDefinition => !!item)
          for (let overloadIdx = 0; overloadIdx < overloads.length; overloadIdx++) {
            const overloadFuncDef = overloads[overloadIdx]
            const attemptBudget = activeDeadlinePlan.allocateAttempt(overloads.length - overloadIdx, {
              configuredCapMs: Config.entryPointTimeoutMs ?? 0,
            })
            if (!attemptBudget) {
              skipped = true
              skipReason = 'analysis-deadline'
              break
            }
            executeViaEntryPointExecutor(
              {
                analyzer: this,
                entryPoint,
                metricStartTime,
                findingsBefore,
                executionState: state,
                overloadCount,
                epIndex: epIdx,
                epTotal: entryPoints.length,
              },
              {
                language: 'java',
                classify: () => 'function',
                execute: () => {
                  let beforeCalled = false
                  state.entryPointStartTimestamp = Date.now()
                  state.entryPointDeadline = attemptBudget.deadline
                  state.entryPointClock = activeDeadlinePlan.now
                  state.entryPointTimeoutLatch = createTimeoutLatch()
                  this.globalState.entryPointTimeout = false
                  this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
                  beforeCalled = true
                  try {
                    this.callsiteInterpretCount.clear()
                    this.methodCumulativeTime.clear()
                    overloadCount++
                    const argValues: Value[] = []
                    try {
                      for (const param of overloadFuncDef.parameters ?? []) {
                        if (!param?.id) continue
                        let argValue = this.processInstruction(symVal, param.id, state)
                        if (argValue.vtype !== 'symbol') {
                          argValue.taint.sanitize()
                          const sid = param.id.type === 'Identifier' ? param.id.name : undefined
                          const tmpVal = new SymbolValue(symVal.qid, { sid, parent: symVal })
                          if (symVal.value && tmpVal.sid) {
                            symVal.value[tmpVal.sid] = tmpVal
                          }
                          argValue = this.processInstruction(symVal, param.id, state)
                        }
                        if (param.varType?.id) {
                          const val = this.getMemberValueNoCreate(symVal, param.varType.id, state)
                          if (val?.vtype === 'class') {
                            argValue.rtype.definiteType = UastSpec.identifier(val.logicalQid)
                          } else {
                            argValue.rtype.definiteType = param.varType.id
                          }
                        }
                        argValues.push(argValue)
                      }
                    } catch (e) {
                      handleException(
                        e,
                        'Error occurred in JavaAnalyzer.symbolInterpret: process argValue err',
                        'Error occurred in JavaAnalyzer.symbolInterpret: process argValue err'
                      )
                    }

                    this.currentFanoutOverloadIdentity = this.buildFanoutOverloadIdentity(overloadFuncDef)
                    try {
                      this.executeCall(overloadFuncDef, symVal, state, entryPoint.scopeVal, {
                        callArgs: this.buildCallArgs(overloadFuncDef, argValues, symVal),
                      })
                    } catch (e) {
                      handleException(
                        e,
                        `[${overloadFuncDef?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
                        `[${overloadFuncDef?.id?.name} symbolInterpret failed. Exception message saved in error log file`
                      )
                      if (this.globalState.meetOtherEntryPoint) {
                        delete this.globalState.meetOtherEntryPoint
                      }
                    }

                    this.currentFanoutOverloadIdentity = ''

                    if (this.globalState.meetOtherEntryPoint) {
                      logger.info(
                        'EntryPoint [%s.%s] is interrupted because encountered other entrypoint during execution',
                        typeof entryPoint.filePath === 'string'
                          ? entryPoint.filePath.substring(0, entryPoint.filePath.lastIndexOf('.'))
                          : undefined,
                        entryPoint.functionName ||
                          `<anonymousFunc_${overloadFuncDef.loc.start.line}_$${overloadFuncDef.loc.end.line}>`
                      )
                      delete this.globalState.meetOtherEntryPoint
                    }
                    if (this.globalState.entryPointTimeout) {
                      logger.info(
                        'EntryPoint [%s.%s] is interrupted because timeout',
                        typeof entryPoint.filePath === 'string'
                          ? entryPoint.filePath.substring(0, entryPoint.filePath.lastIndexOf('.'))
                          : undefined,
                        entryPoint.functionName ||
                          `<anonymousFunc_${overloadFuncDef.loc.start.line}_$${overloadFuncDef.loc.end.line}>`
                      )
                      // 首遍超时的入口点入队重跑（无论 finding 是否增长，超时本身就意味着可能有未遍历路径）
                      this.timeoutEntryPoints.push({ entryPoint, overloadFuncDef, argValues })
                    }
                  } finally {
                    this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
                  }
                },
              },
              this.checkerManager?.resultManagerProxy
            )
          }
        } finally {
          state.entryPointDeadline = undefined
          state.entryPointClock = undefined
          state.entryPointTimeoutLatch = undefined
          this.globalState.entryPointTimeout = false
          this.recordEntryPointLoopMetric(
            entryPoint,
            metricStartTime,
            findingsBefore,
            skipped,
            skipReason,
            overloadCount
          )
        }
      }
      // 基于全局时间预算的超时入口点重跑
      if (this.timeoutEntryPoints.length > 0) {
        const remainingScanBudget = Math.max(0, activeDeadlinePlan.outerDeadline - activeDeadlinePlan.now())
        const remaining = Math.max(0, activeDeadlinePlan.analysisDeadline - activeDeadlinePlan.now())
        if (remaining > 0) {
          const perEpTimeout = Math.min(
            Math.floor(remaining / this.timeoutEntryPoints.length),
            oldEntryPointTimeoutMs ?? 0
          )
          Config.entryPointTimeoutMs = perEpTimeout
          const initialAttempts = this.timeoutEntryPoints.length
          const initialRemaining = formatBudgetMs(remaining)
          const initialAllocation = formatBudgetMs(Math.min(perEpTimeout, remaining / initialAttempts))
          logger.info(
            'Rerun %d timeout entrypoints with aggressive prune mode, configuredCapMs=%d, remaining=%dms, initialAllocationMs=%d, initialRemainingAttempts=%d',
            initialAttempts,
            formatBudgetMs(oldEntryPointTimeoutMs ?? 0),
            initialRemaining,
            initialAllocation,
            initialAttempts
          )
          this.pruneInfoMap.aggressiveMode = true
          try {
            let rerunIdx = 0
            for (const timeoutEntryPoint of this.timeoutEntryPoints) {
              rerunIdx++
              const metricStartTime = Date.now()
              const findingsBefore = this.countFindings()
              let skipped = false
              let skipReason: string | undefined
              let overloadCount = 0
              try {
                const remainingAttempts = this.timeoutEntryPoints.length - rerunIdx + 1
                const attemptBudget = activeDeadlinePlan.allocateAttempt(remainingAttempts, {
                  configuredCapMs: Config.entryPointTimeoutMs ?? 0,
                })
                if (!attemptBudget) {
                  skipped = true
                  skipReason = 'analysis-deadline'
                  continue
                }
                logger.info(
                  'Aggressive rerun attempt %d/%d allocatedMs=%d, remainingAttempts=%d',
                  rerunIdx,
                  initialAttempts,
                  formatBudgetMs(attemptBudget.allocationMs),
                  attemptBudget.remainingAttempts
                )
                this.symbolTable.clear()
                overloadCount = 1

                executeViaEntryPointExecutor(
                  {
                    analyzer: this,
                    entryPoint: timeoutEntryPoint.entryPoint,
                    metricStartTime,
                    findingsBefore,
                    executionState: state,
                    overloadCount,
                    epIndex: rerunIdx,
                    epTotal: this.timeoutEntryPoints.length,
                  },
                  {
                    language: 'java',
                    classify: () => 'function',
                    execute: () => {
                      let beforeCalled = false
                      state.entryPointStartTimestamp = Date.now()
                      state.entryPointDeadline = attemptBudget.deadline
                      state.entryPointClock = activeDeadlinePlan.now
                      state.entryPointTimeoutLatch = createTimeoutLatch()
                      this.globalState.entryPointTimeout = false
                      this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
                      beforeCalled = true
                      try {
                        this.currentFanoutOverloadIdentity = this.buildFanoutOverloadIdentity(
                          timeoutEntryPoint.overloadFuncDef
                        )
                        try {
                          CurrentEntryPoint.setCurrentEntryPoint(timeoutEntryPoint.entryPoint)
                          this.callsiteInterpretCount.clear()
                          this.methodCumulativeTime.clear()
                          this.executeCall(
                            timeoutEntryPoint.overloadFuncDef,
                            timeoutEntryPoint.entryPoint.entryPointSymVal,
                            state,
                            timeoutEntryPoint.entryPoint.scopeVal,
                            {
                              callArgs: this.buildCallArgs(
                                timeoutEntryPoint.overloadFuncDef,
                                timeoutEntryPoint.argValues,
                                timeoutEntryPoint.entryPoint.entryPointSymVal
                              ),
                            }
                          )
                        } catch (e) {
                          handleException(
                            e,
                            `[${timeoutEntryPoint.overloadFuncDef?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
                            `[${timeoutEntryPoint.overloadFuncDef?.id?.name} symbolInterpret failed. Exception message saved in error log file`
                          )
                          if (this.globalState.meetOtherEntryPoint) {
                            delete this.globalState.meetOtherEntryPoint
                          }
                        }

                        this.currentFanoutOverloadIdentity = ''

                        if (this.globalState.meetOtherEntryPoint) {
                          delete this.globalState.meetOtherEntryPoint
                        }
                        if (this.globalState.entryPointTimeout) {
                          logger.info(
                            'EntryPoint [%s.%s] is interrupted because timeout (aggressive rerun)',
                            timeoutEntryPoint.entryPoint.filePath?.substring(
                              0,
                              timeoutEntryPoint.entryPoint.filePath?.lastIndexOf('.')
                            ),
                            timeoutEntryPoint.entryPoint.functionName ||
                              `<anonymousFunc_${timeoutEntryPoint.overloadFuncDef.loc.start.line}_$${timeoutEntryPoint.overloadFuncDef.loc.end.line}>`
                          )
                          skipped = true
                          skipReason = 'timeout'
                          logger.debug(
                            'Intermediate timeout result output deferred; mandatory persistence is deferred to final checkpoint'
                          )
                        }
                      } finally {
                        this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
                      }
                    },
                  },
                  this.checkerManager?.resultManagerProxy
                )
              } finally {
                state.entryPointDeadline = undefined
                state.entryPointClock = undefined
                state.entryPointTimeoutLatch = undefined
                this.globalState.entryPointTimeout = false
                this.recordEntryPointLoopMetric(
                  timeoutEntryPoint.entryPoint,
                  metricStartTime,
                  findingsBefore,
                  skipped,
                  skipReason,
                  overloadCount
                )
              }
            }
          } finally {
            this.pruneInfoMap.aggressiveMode = false
            Config.entryPointTimeoutMs = oldEntryPointTimeoutMs
          }
        } else {
          logger.info(
            'Skip rerun of %d timeout entrypoints: scan budget exhausted (remaining=%dms, budget=%dms)',
            this.timeoutEntryPoints.length,
            remainingScanBudget,
            Config.scanTimeoutMs
          )
        }
        // 清空，避免重复重跑
        this.timeoutEntryPoints = []
      }
      await persistMandatoryCheckpoint()
      this.clearFanoutContinuationState()

      return true
    } catch (schedulingError) {
      let persistenceError: unknown
      try {
        await persistMandatoryCheckpoint()
      } catch (error) {
        persistenceError = error
      }
      const combined = combineFindingsFinalizationErrors(
        {
          code: 'unknown',
          message: schedulingError instanceof Error ? schedulingError.message : String(schedulingError),
          retriable: false,
        },
        persistenceError instanceof Error
          ? { code: 'unknown', message: persistenceError.message, retriable: true }
          : undefined
      )
      const finalizationError = new Error('Analysis finalization failed')
      Object.assign(finalizationError, { schedulingError, persistenceError, combined })
      throw finalizationError
    } finally {
      Config.entryPointTimeoutMs = oldEntryPointTimeoutMs
      this.pruneInfoMap.aggressiveMode = oldAggressiveMode
    }
  }

  /**
   * 判断值是否为 null 字面量
   * @param val - 值
   * @returns {boolean} 是否为 null 字面量
   */
  override isNullLiteral(val: any) {
    return val.getRawValue() === 'null' && val.type === 'Literal'
  }

  /**
   * 从模块作用域获取导出作用域
   * @param scope - 作用域
   * @returns {any[]} 导出作用域数组
   */
  override getExportsScope(scope: any) {
    return [scope.scope.exports, scope]
  }

  /**
   * Java lambda 表达式体隐式返回值：匿名函数的 ScopedStatement 无 ReturnStatement 时，取最后一个表达式的值
   * @param fscope
   * @param fdecl
   * @param fname
   * @param state
   */
  override postProcessFunctionBody(fscope: any, fdecl: any, fname: any, state: any): void {
    if (this.lastReturnValue) return
    if (fdecl?.body?.type !== 'ScopedStatement') return
    if (!fname?.includes('<anonymous')) return
    const stmts = fdecl.body.body
    if (!stmts || stmts.length === 0) return
    const lastStmt = stmts[stmts.length - 1]
    const hasReturn = stmts.some((s: any) => s.type === 'ReturnStatement')
    if (!hasReturn && lastStmt.type !== 'ReturnStatement') {
      this.lastReturnValue = this.processInstruction(fscope, lastStmt, state)
    }
  }

  /**
   * 组装类映射
   * @param obj - 对象
   */
  assembleClassMap(obj: any) {
    if (!obj) {
      return
    }
    if (obj.vtype === 'class' && obj.qid && typeof obj.qid === 'string') {
      this.classMap.set(obj.logicalQid, obj.uuid)
    } else if (obj.members?.size > 0) {
      for (const key of obj.members.keys()) {
        this.assembleClassMap(obj.members.get(key))
      }
    }
  }

  /**
   * 检查字段是否在类中定义
   * @param fieldName - 字段名
   * @param fullClassName - 完整类名
   * @returns {boolean} 是否定义
   */
  checkFieldDefinedInClass(fieldName: string, fullClassName: string) {
    fullClassName = QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(fullClassName)
    if (!fieldName || !fullClassName || !this.classMap.has(fullClassName)) {
      return false
    }

    const classObj = this.symbolTable.get(this.classMap.get(fullClassName))
    if (!classObj.ast.node || !classObj.ast.node.body) {
      return false
    }
    for (const bodyItem of classObj.ast.node.body) {
      if (bodyItem.type !== 'VariableDeclaration') {
        continue
      }
      if (bodyItem.id.name === fieldName) {
        return true
      }
    }

    return false
  }

  /**
   * 根据 qid 获取祖先作用域
   * @param scope - 作用域
   * @param qid - 限定标识符
   * @returns {any} 祖先作用域
   */
  getAncestorScopeByQid(scope: any, qid: string) {
    if (!qid) {
      return null
    }
    while (scope) {
      if (QidUnifyUtil.removeInstanceFromString(scope.qid) === QidUnifyUtil.removeInstanceFromString(qid)) {
        return scope
      }
      scope = scope.parent
    }
    return null
  }

  /**
   * find invocations in scope by node hash
   * @param scope
   * @param node
   * @returns {Invocation[]}
   */
  findNodeInvocations(scope: any, node: any): Invocation[] {
    const resultArray: Invocation[] = []
    const nodeHash = node?._meta?.nodehash
    if (!nodeHash) {
      return resultArray
    }

    let targetScope = scope
    while (targetScope) {
      if (targetScope.invocationMap?.has(nodeHash)) {
        resultArray.push(...targetScope.invocationMap.get(nodeHash))
        break
      }
      targetScope = targetScope.parent
    }
    return resultArray
  }

  /**
   * build new object
   * @param fdef
   * @param argvalues
   * @param fclos
   * @param state
   * @param node
   * @param scope
   * @param callInfo
   */
  override buildNewObject(fdef: any, fclos: any, state: any, node: any, scope: any, callInfo: CallInfo) {
    const obj = super.buildNewObject(fdef, fclos, state, node, scope, callInfo)
    this.propagateConstructorArgumentTrace(fclos, obj, callInfo, node)
    if (obj && node.callee?.type === 'MemberAccess' && /^[1-9]\d*$/.test(node.callee.property.name)) {
      obj.length = Number(node.callee.property.name)
    }
    delete obj.value.class
    return obj
  }

  /**
   * load all sink from rule
   */
  loadAllSink() {
    const resultArray = []
    const ruleConfigArray = BasicRuleHandler.getRules()
    for (const ruleConfig of ruleConfigArray) {
      if (!ruleConfig.sinks) {
        continue
      }
      for (const sinkArray of Object.values(ruleConfig.sinks)) {
        if (Array.isArray(sinkArray)) {
          resultArray.push(...sinkArray)
        }
      }
    }
    return resultArray
  }

  /**
   * load all source from rule
   */
  loadAllSource() {
    const funcCallSourceArray = []
    const otherSourceArray = []
    const ruleConfigArray = BasicRuleHandler.getRules()
    for (const ruleConfig of ruleConfigArray) {
      if (!ruleConfig.sources) {
        continue
      }
      for (const key of Object.keys(ruleConfig.sources)) {
        if (key.startsWith('FuncCall')) {
          funcCallSourceArray.push(...ruleConfig.sources[key])
        } else {
          otherSourceArray.push(...ruleConfig.sources[key])
        }
      }
    }
    return [funcCallSourceArray, otherSourceArray]
  }

  /**
   * load all sanitizer from rule
   */
  loadAllSanitizer() {
    const funcCallSanitizerArray = []
    const otherSanitizerArray = []
    const ruleConfigArray = BasicRuleHandler.getRules()
    for (const ruleConfig of ruleConfigArray) {
      if (!ruleConfig.sanitizers) {
        continue
      }
      for (const sanitizer of ruleConfig.sanitizers) {
        if (sanitizer.sanitizerType === 'FunctionCallSanitizer') {
          funcCallSanitizerArray.push(sanitizer)
        } else {
          otherSanitizerArray.push(sanitizer)
        }
      }
    }
    return [funcCallSanitizerArray, otherSanitizerArray]
  }

  /**
   * 粗粒度污点传播判定：入参或 receiver 携带 JAVA_INPUT 污点、且方法体不可达 sink
   * 时，跳过 executeCall 并做 ARG→RET + THIS→RET 近似传播。
   *
   * 两层保守策略：
   * 1. invocationMap 缺失（方法未进入 callgraph）→ 保守不剪
   * 2. invocationMap 存在但 toScope 非 fclos（stdlib/lib 方法）→ 不保守，
   *    因为已通过 invocationMatchSink 检查确认这些调用不匹配 sink 规则，
   *    仅因 toScope 不是 fclos 就视作 may-reach-sink 会导致粗传播对 stdlib-only
   *
   * 返回 undefined 表示不走此路径，由调用方继续原有分派逻辑。
   * @param scope
   * @param node
   * @param state
   * @param fclos
   * @param argvalues
   */
  private tryCoarseTaintPropagation(
    scope: any,
    node: CallExpression,
    state: State,
    fclos: any,
    argvalues: any[]
  ): Value | undefined {
    this._coarsePropTotalChecks = (this._coarsePropTotalChecks || 0) + 1
    if (!Config.enableCoarseTaintPropagation) return undefined
    // 已走 lib fallback 的不重复处理（symbol/Noop/无 ast）
    if (fclos.vtype === 'symbol') {
      this._coarsePropSkips = (this._coarsePropSkips || 0) + 1
      return undefined
    }
    if (fclos.ast?.fdef?.body?.type === 'Noop') {
      this._coarsePropSkips = (this._coarsePropSkips || 0) + 1
      return undefined
    }
    if (!fclos.ast?.fdef) {
      this._coarsePropSkips = (this._coarsePropSkips || 0) + 1
      return undefined
    }

    // fclos 级缓存：同一 fclos 的 sink 可达性不依赖 taint 状态，只算一次
    // _coarsePropEligible: true=可粗传播 / false=不可粗传播 / undefined=未计算
    if (fclos._coarsePropEligible === false) {
      this._coarsePropIneligibleCached = (this._coarsePropIneligibleCached || 0) + 1
      return undefined
    }

    if (fclos._coarsePropEligible === undefined) {
      // invocationMap 前置检查
      const invocationMap = this.resolveInvocationMapForInherited(fclos)
      if (!invocationMap) {
        // JDK/stdlib 方法虽然无 invocationMap（callgraph 不分析 JDK 源码），
        // 但其行为是确定的——不包含业务 sink，直接标记可粗传播；
        // 非 JDK 方法无 invocationMap 时保守拒绝（无法排除可达 sink 的可能性）
        const qid: string = fclos?.logicalQid || fclos?.name || ''
        const isJdkMethod = qid.startsWith('java.') || qid.startsWith('javax.') || qid.startsWith('sun.') || qid.startsWith('com.sun.')
        if (isJdkMethod) {
          this._coarsePropJdkEligible = (this._coarsePropJdkEligible || 0) + 1
          fclos._coarsePropEligible = true
          // JDK 方法不可能是业务 source/sink，跳过后续规则匹配和 sink 检查
          // 直接进入下方 taint 参数检查
        } else {
          this._coarsePropNoInvocation = (this._coarsePropNoInvocation || 0) + 1
          fclos._coarsePropEligible = false
          return undefined
        }
      } else {
        // 有 invocationMap 时才需要检查规则和 sink 可达性
        // 方法自身匹配 source/sink/sanitizer 规则时不跳过（必须正常执行）
        const matchSourceSinkSanitizer = this.checkFclosMatchSink(
          fclos,
          [],
          this.pruneInfoMap.funcCallSourceSinkSanitizerArray,
          this.pruneInfoMap.matchFuncCallSourceSinkSanitizerCacheMap,
          true,
          false
        )
        if (matchSourceSinkSanitizer) {
          this._coarsePropMatchRule = (this._coarsePropMatchRule || 0) + 1
          fclos._coarsePropEligible = false
          return undefined
        }

        // 方法体可达 sink 时不跳过（必须正常执行以检出 sink）
        // 两层检查，与 entrypoint pruning 一致（L2154 + L2231）：
        // 1. 严格检查（false）：CHA 静态可达 sink
        // 2. 保守检查（true）：非 fclos 分派（接口/多态/stdlib 转发）保守不剪
        // 只有两层都说"不可达"才跳过方法体
        const matchSinkStrict = this.checkFclosMatchSink(
          fclos,
          [],
          this.pruneInfoMap.sinkArray,
          this.pruneInfoMap.matchSinkCacheMap,
          true,
          false
        )
        if (matchSinkStrict) {
          this._coarsePropStrictSink = (this._coarsePropStrictSink || 0) + 1
          fclos._coarsePropEligible = false
          return undefined
        }
        // 保守检查用独立缓存：matchSinkCacheMap 已缓存 strict(false) 的结果，
        // conservative(true) 读到缓存会直接返回 false，等于白查
        if (!this._coarsePropConservativeCache) {
          this._coarsePropConservativeCache = new Map()
        }
        const matchSinkConservative = this.checkFclosMatchSink(
          fclos,
          [],
          this.pruneInfoMap.sinkArray,
          this._coarsePropConservativeCache,
          true,
          true
        )
        if (matchSinkConservative) {
          this._coarsePropConservativeSink = (this._coarsePropConservativeSink || 0) + 1
          fclos._coarsePropEligible = false
          return undefined
        }

        fclos._coarsePropEligible = true
      }
    }

    // 仅当参数含 JAVA_INPUT taint 时才触发粗传播
    // 不做 THIS→RET：receiver taint 传到返回值会导致下游 taint 扩散雪崩，
    // 且 THIS→RET 能覆盖的链路极少（大部分是 ARG→RET 即可连接 sink）
    const TAINT_TAG = 'JAVA_INPUT'
    const hasTaintedArg =
      Array.isArray(argvalues) &&
      argvalues.some((a: any) => a?.taint?.isTaintedRec === true && a.taint.tagTraces?.has(TAINT_TAG))
    if (!hasTaintedArg) {
      this._coarsePropEligibleNoTaint = (this._coarsePropEligibleNoTaint || 0) + 1
      // 无 taint 输入时不跳过方法体：虽然不会产出 finding，
      // 但方法返回值会被调用方使用（field access / 下游运算），
      // 返回 nil 会破坏调用方的值语义；必须正常执行以生成正确的返回值
      return undefined
    }

    // 粗传播命中计数
    this._coarsePropHits = (this._coarsePropHits || 0) + 1
    logger.trace(
      '[COARSE-PROP] #%d %s.%s',
      this._coarsePropHits,
      fclos?.parent?.logicalQid || '',
      fclos?.ast?.fdef?.id?.name || fclos?.name || ''
    )

    // 粗传播跳过方法体，返回值缺失 CALL trace；
    // 与 executeFdeclOrExecute 中对参数 addSrcLineInfo('CALL: ') 对称补记
    const callsiteFile = node?.loc?.sourcefile
    const fname = this.getCalledMethodName(node, fclos) || fclos?.ast?.fdef?.id?.name || fclos?.name
    if (callsiteFile && Array.isArray(argvalues)) {
      for (let i = 0; i < argvalues.length; i++) {
        if (argvalues[i]?.taint?.isTaintedRec) {
          argvalues[i] = SourceLine.addSrcLineInfo(argvalues[i], node, callsiteFile, 'CALL: ', fname)
        }
      }
    }

    const res = this.processLibArgToRet(node, fclos, argvalues, scope, state, {
      callArgs: this.buildCallArgs(node, argvalues, fclos),
    })
    // 返回值自身补 CALL trace：下游经 mergeTracesFrom 等非 buffer 路径传播时
    // 不含 source-line CALL 信息，用 addTraceToTag 写入 JAVA_INPUT tagTrace
    if (res && callsiteFile && typeof (res as any).taint?.addTraceToTag === 'function') {
      const _startLine = node.loc?.start?.line ?? 0
      const _endLine = node.loc?.end?.line ?? _startLine
      const _tline = _startLine === _endLine ? _startLine : _.range(_startLine, _endLine + 1)
      ;(res as any).taint.addTraceToTag('JAVA_INPUT', {
        file: callsiteFile,
        line: _tline,
        node,
        tag: 'CALL: ',
        affectedNodeName: fname,
      })
    }
    return res
  }

  /**
   *
   */
  override endAnalyze() {
    super.endAnalyze()
    if (!Config.enableCoarseTaintPropagation) return
    const total = this._coarsePropTotalChecks || 0
    const hits = this._coarsePropHits || 0
    const skips = this._coarsePropSkips || 0
    const ineligibleCached = this._coarsePropIneligibleCached || 0
    const noInvocation = this._coarsePropNoInvocation || 0
    const matchRule = this._coarsePropMatchRule || 0
    const strictSink = this._coarsePropStrictSink || 0
    const conservativeSink = this._coarsePropConservativeSink || 0
    const eligibleNoTaint = this._coarsePropEligibleNoTaint || 0
    const eligibleCached = this._coarsePropEligibleCached || 0
    const jdkEligible = this._coarsePropJdkEligible || 0
    logger.warn(
      '[COARSE-PROP] totalChecks=%d hits=%d(%.1f%%) | skip_symbol/noop=%d ineligible_cached=%d | no_invocation=%d jdk_eligible=%d match_rule=%d strict_sink=%d conservative_sink=%d eligible_no_taint=%d',
      total,
      hits,
      total > 0 ? (hits / total) * 100 : 0,
      skips,
      ineligibleCached,
      noInvocation,
      jdkEligible,
      matchRule,
      strictSink,
      conservativeSink,
      eligibleNoTaint
    )
  }

  /**
   * check if prune is supported
   * @param entryPointNum
   * @param sinkNum
   */
  checkPruneSupported(entryPointNum: number, sinkNum: number) {
    if (sinkNum <= 0 || Config.makeAllCG) {
      return false
    }
    return !!(this.typeResolver.resolveFinish && this.ainfo?.callgraph)
  }

  /**
   * check if prune is supported during symbol interpret
   * @param sinkNum
   * @param otherSanitizerNum
   */
  checkPruneSupportedDuringInterpret(sinkNum: number, otherSanitizerNum: number) {
    if (sinkNum <= 0 || otherSanitizerNum > 0 || Config.makeAllCG) {
      return false
    }
    return !!(this.typeResolver.resolveFinish && this.ainfo?.callgraph)
  }

  /**
   * check if fclos can be pruned
   * @param fclos
   */
  checkFclosCanPrune(fclos: any) {
    if (!fclos) {
      return false
    }
    /* EntryPoint Pruning 阶段对 callgraph 不完备保守不剪：
       接口/抽象方法分派未解析（invocation.toScope=undefined）以及 fclos 自身
       invocationMap 缺失（lambda、内联匿名、未进入 prepass 的 fclos）都视作
       may-reach-sink。把"漏 entry"代价转为"保留 entry 让符号解释器精确分派"。 */
    const matchSink = this.checkFclosMatchSink(
      fclos,
      [],
      this.pruneInfoMap.sinkArray,
      this.pruneInfoMap.matchSinkCacheMap,
      true,
      true
    )
    return !matchSink
  }

  // 同一 callsite 解释次数超限判定（同时递增计数）
  /**
   *
   * @param node
   */
  private incrementAndCheckCallsiteLimit(node: any): boolean {
    const loc = node.loc?.start
    const key = (node as any)._meta?.nodehash || (loc ? `${loc.line}:${loc.column}` : '')
    if (!key) return false
    const count = (this.callsiteInterpretCount.get(key) || 0) + 1
    this.callsiteInterpretCount.set(key, count)
    return count > JavaAnalyzer.CALLSITE_INTERPRET_LIMIT
  }

  // 检查方法累计执行时间是否超限（入口点级别）
  /**
   *
   * @param fclos
   */
  private checkMethodCumulativeTimeLimit(fclos: any): boolean {
    const methodKey = fclos?.qid || fclos?.sid
    if (!methodKey) return false
    const cumulativeTime = this.methodCumulativeTime.get(methodKey) || 0
    return cumulativeTime > JavaAnalyzer.METHOD_CUMULATIVE_TIME_LIMIT_MS
  }

  // 累加方法执行时间
  /**
   *
   * @param fclos
   * @param elapsedMs
   */
  private accumulateMethodTime(fclos: any, elapsedMs: number): void {
    const methodKey = fclos?.qid || fclos?.sid
    if (!methodKey || elapsedMs <= 0) return
    const current = this.methodCumulativeTime.get(methodKey) || 0
    this.methodCumulativeTime.set(methodKey, current + elapsedMs)
  }

  // 快照方法执行预算
  /**
   *
   */
  private snapshotMethodBudgets(): { methodTime: Map<string, number>; callsiteCount: Map<string, number> } {
    return {
      methodTime: new Map(this.methodCumulativeTime),
      callsiteCount: new Map(this.callsiteInterpretCount),
    }
  }

  // 恢复方法执行预算到指定快照
  /**
   *
   * @param snapshot
   * @param snapshot.methodTime
   * @param snapshot.callsiteCount
   */
  private restoreMethodBudgets(snapshot: {
    methodTime: Map<string, number>
    callsiteCount: Map<string, number>
  }): void {
    this.methodCumulativeTime = new Map(snapshot.methodTime)
    this.callsiteInterpretCount = new Map(snapshot.callsiteCount)
  }

  // 合并互斥分支的执行预算：取每 key 两分支的 max
  /**
   *
   * @param consequentFinal
   * @param consequentFinal.methodTime
   * @param consequentFinal.callsiteCount
   * @param alternativeFinal
   * @param alternativeFinal.methodTime
   * @param alternativeFinal.callsiteCount
   */
  private mergeMethodBudgets(
    consequentFinal: { methodTime: Map<string, number>; callsiteCount: Map<string, number> },
    alternativeFinal: { methodTime: Map<string, number>; callsiteCount: Map<string, number> }
  ): void {
    for (const key of new Set([...consequentFinal.methodTime.keys(), ...alternativeFinal.methodTime.keys()])) {
      this.methodCumulativeTime.set(
        key,
        Math.max(consequentFinal.methodTime.get(key) || 0, alternativeFinal.methodTime.get(key) || 0)
      )
    }
    for (const key of new Set([...consequentFinal.callsiteCount.keys(), ...alternativeFinal.callsiteCount.keys()])) {
      this.callsiteInterpretCount.set(
        key,
        Math.max(consequentFinal.callsiteCount.get(key) || 0, alternativeFinal.callsiteCount.get(key) || 0)
      )
    }
  }

  /**
   * check if fclos can be pruned during executing
   * @param fclos
   * @param node
   * @param argvalues
   * @param state
   * @param fromCallGraph
   */
  checkFclosCanPruneDuringInterpret(fclos: any, node: any, argvalues: any, state: any, fromCallGraph: boolean) {
    if (this.pruneInfoMap.aggressiveMode && state?.callstack?.length >= Config.maxCallstackDepth) {
      return true
    }

    if (Array.isArray(node.arguments)) {
      for (const argument of node.arguments) {
        if (argument.type === 'Sequence' || argument.type === 'FunctionDefinition') {
          return false
        }
      }
    }
    if (Array.isArray(argvalues)) {
      for (const argvalue of argvalues) {
        if (argvalue.vtype === 'class' || argvalue.vtype === 'fclos') {
          return false
        }
      }
    }

    if (
      !this.enablePruneDuringInterpret ||
      !fclos ||
      !fclos.ast.fdef ||
      !this.checkPruneSupportedDuringInterpret(
        this.pruneInfoMap.sinkArray.length,
        this.pruneInfoMap.otherSanitizerArray.length
      )
    ) {
      return false
    }
    const matchSourceSinkSanitizer = this.checkFclosMatchSink(
      fclos,
      [],
      this.pruneInfoMap.funcCallSourceSinkSanitizerArray,
      this.pruneInfoMap.matchFuncCallSourceSinkSanitizerCacheMap,
      true
    )
    if (matchSourceSinkSanitizer) {
      return false
    }

    if (fromCallGraph) {
      // callgraph 路径的剪枝：原逻辑只看"自身是否含 sink"来剪枝，
      // 但方法体可能是到达真实 sink 的必经路径（如 Facade→Service→Mapper），
      // 过早剪枝会断链。改进：调用栈较浅（<=4）时放行，给中间层方法体执行机会；
      // 调用栈较深时恢复剪枝，防止路径爆炸。
      const callDepth = state?.callstack?.length ?? 0
      if (callDepth <= 4) {
        return false
      }
      return !matchSourceSinkSanitizer
    }
    return false
  }

  /**
   * check if fclos match any sink, ignore sub fclos
   * @param fclos
   * @param sinkArray
   * @param matchSinkCacheMap
   * @param checkUseDynamicFeature
   */
  checkFclosMatchSinkNoRecurse(
    fclos: any,
    sinkArray: any[],
    matchSinkCacheMap: Map<any, any>,
    checkUseDynamicFeature: boolean
  ) {
    if (!fclos || !sinkArray) {
      matchSinkCacheMap.set(fclos, false)
      return false
    }
    const invocationMap = this.resolveInvocationMapForInherited(fclos)
    if (!invocationMap) {
      matchSinkCacheMap.set(fclos, false)
      return false
    }

    if (matchSinkCacheMap.has(fclos)) {
      return matchSinkCacheMap.get(fclos)
    }

    for (const invocationArray of invocationMap.values()) {
      for (const invocation of invocationArray) {
        if (checkUseDynamicFeature) {
          for (const dynamicClass of this.pruneInfoMap.dynamicClassArray) {
            if (dynamicClass === invocation.calleeType || invocation.calleeType?.endsWith(`.${dynamicClass}`)) {
              matchSinkCacheMap.set(fclos, true)
              return true
            }
          }
          for (const dynamicPackage of this.pruneInfoMap.dynamicPackageArray) {
            if (invocation.calleeType?.startsWith(`${dynamicPackage}.`)) {
              matchSinkCacheMap.set(fclos, true)
              return true
            }
          }
        }

        for (const sink of sinkArray) {
          const invocationMatchSink: boolean = checkInvocationMatchSink(invocation, sink, this.typeResolver)
          if (invocationMatchSink) {
            matchSinkCacheMap.set(fclos, true)
            return true
          }
        }
      }
    }

    matchSinkCacheMap.set(fclos, false)
    return false
  }

  /**
   * 对 inherited fclos 做 invocationMap fallback：
   * 子类 inherited 方法的 fclos 是 cloneAlias 克隆版，clone 时 super 的 invocationMap 可能还未填充，
   * 导致克隆版 invocationMap 为空，剪枝递归断链。
   * 通过 logicalQid 反查原始 class 的原始 fclos，取其 invocationMap。
   * @param fclos
   */
  private resolveInvocationMapForInherited(fclos: any): Map<any, any> | undefined {
    if (fclos?.invocationMap instanceof Map) {
      return fclos.invocationMap
    }
    if (!fclos?.func?.inherited || typeof fclos.logicalQid !== 'string') {
      return undefined
    }
    const dotIdx = fclos.logicalQid.lastIndexOf('.')
    if (dotIdx <= 0) return undefined
    const ownerQid = fclos.logicalQid.slice(0, dotIdx)
    const methodSid = fclos.logicalQid.slice(dotIdx + 1)
    const classUuid = this.classMap?.get(ownerQid)
    if (!classUuid) return undefined
    const classVal = this.symbolTable.get(classUuid)
    const originalFclos = classVal?.members?.get(methodSid) || classVal?.value?.[methodSid]
    if (originalFclos?.invocationMap instanceof Map) {
      return originalFclos.invocationMap
    }
    return undefined
  }

  /**
   * check if fclos match any sink
   * @param fclos
   * @param fclosStack
   * @param sinkArray
   * @param matchSinkCacheMap
   * @param checkUseDynamicFeature
   * @param conservativeOnIncomplete callgraph 不完备时（invocationMap 缺失 / invocation.toScope 未解析）
   *   保守视作 may-reach-sink；专供 EntryPoint Pruning 阶段使用，确保接口 dispatch /
   *   lambda / 库方法分派盲点不被等同于 no-sink-reach
   */
  checkFclosMatchSink(
    fclos: any,
    fclosStack: any[],
    sinkArray: any[],
    matchSinkCacheMap: Map<any, any>,
    checkUseDynamicFeature: boolean,
    conservativeOnIncomplete = false
  ) {
    if (!fclos || !sinkArray) {
      matchSinkCacheMap.set(fclos, false)
      return false
    }
    const invocationMap = this.resolveInvocationMapForInherited(fclos)
    if (!invocationMap) {
      /* callgraph 不完备：invocationMap 缺失视作 may-reach-sink，避免被等同 no-sink-reach */
      const fallback = conservativeOnIncomplete
      matchSinkCacheMap.set(fclos, fallback)
      return fallback
    }

    if (matchSinkCacheMap.has(fclos)) {
      return matchSinkCacheMap.get(fclos)
    }

    // if (checkUseDynamicFeature) {
    //   const innerFuncDefVisitor = new InnerFuncDefVisitor()
    //   if (Array.isArray(fclos.overloaded)) {
    //     for (const funcDef of fclos.overloaded) {
    //       innerFuncDefVisitor.matchFuncDefCount = 0
    //       AstUtil.visit(funcDef, innerFuncDefVisitor)
    //       if (innerFuncDefVisitor.matchFuncDefCount > 1) {
    //         matchSinkCacheMap.set(fclos, true)
    //         return true
    //       }
    //     }
    //   }
    // }

    const toScopeArray = []
    for (const invocationArray of invocationMap.values()) {
      for (const invocation of invocationArray) {
        if (checkUseDynamicFeature) {
          for (const dynamicClass of this.pruneInfoMap.dynamicClassArray) {
            if (dynamicClass === invocation.calleeType || invocation.calleeType?.endsWith(`.${dynamicClass}`)) {
              matchSinkCacheMap.set(fclos, true)
              return true
            }
          }
          for (const dynamicPackage of this.pruneInfoMap.dynamicPackageArray) {
            if (invocation.calleeType?.startsWith(`${dynamicPackage}.`)) {
              matchSinkCacheMap.set(fclos, true)
              return true
            }
          }
        }

        for (const sink of sinkArray) {
          const invocationMatchSink: boolean = checkInvocationMatchSink(invocation, sink, this.typeResolver)
          if (invocationMatchSink) {
            matchSinkCacheMap.set(fclos, true)
            return true
          }
        }

        if (invocation.toScope?.vtype === 'fclos') {
          toScopeArray.push(invocation.toScope)
        } else if (conservativeOnIncomplete) {
          /* invocation.toScope 未解析（接口 / 抽象方法 / 库方法 / 动态符号）→ 保守判定
           *
           * 当 invocation 有 calleeType（已知调用目标）且 invocationMatchSink
           * 对所有 sink 规则都不匹配时，说明此调用点自身不匹配 sink，
           * 不可因 toScope 不是 fclos 就一刀切 may-reach-sink——
           *
           * 仅当 calleeType 未知（无法排除间接可达 sink 的可能性）时保守返回 true。
           */
          if (invocation.calleeType) {
            // 已知调用目标且不匹配 sink → 跳过此 invocation，继续检查下一个
          } else {
            matchSinkCacheMap.set(fclos, true)
            return true
          }
        }
      }
    }

    fclosStack.push(fclos)
    const analysedScopeArray: any[] = []
    for (const toScope of toScopeArray) {
      if (analysedScopeArray.includes(toScope) || fclosStack.includes(toScope)) {
        continue
      }
      analysedScopeArray.push(toScope)
      const subResult = this.checkFclosMatchSink(
        toScope,
        fclosStack,
        sinkArray,
        matchSinkCacheMap,
        checkUseDynamicFeature,
        conservativeOnIncomplete
      )
      if (subResult) {
        matchSinkCacheMap.set(fclos, true)
        return true
      }
    }
    fclosStack.pop()

    matchSinkCacheMap.set(fclos, false)
    return false
  }

  /**
   * Resolve UUID-backed values before mutating them during transitional storage migration.
   * @param value
   */
  private resolveRuntimeValueRef(value: unknown): unknown {
    if (typeof value === 'string' && value.startsWith('symuuid_')) {
      return this.symbolTable.get(value) ?? value
    }
    return value
  }

  /**
   *
   * @param res
   * @param fclos
   */
  private mergeJavaCallResultType(res: JavaRuntimeValue, fclos: JavaRuntimeValue): void {
    if (!res || typeof res !== 'object') return
    if (fclos?.runtime?.execute && !fclos?.rtype) return
    const existingType = this.getDefiniteTypeText(res)
    const fclosType = this.getDefiniteTypeText(fclos)
    if (!existingType) {
      res.rtype = fclos?.rtype
      return
    }
    if (!fclosType || existingType === fclosType) return
    if (this.isSameOrSubtype(existingType, fclosType)) return
    if (this.isSameOrSubtype(fclosType, existingType)) {
      res.rtype = fclos?.rtype
    }
  }

  /**
   *
   * @param fclos
   * @param res
   */
  private propagateBodyReturnFieldReceiverTaint(fclos: JavaRuntimeValue, res: unknown): void {
    if (!res || typeof res !== 'object' || hasJavaInputSourceTrace(res)) return
    if (fclos?.runtime?.execute) return
    const receiver = typeof fclos?.getThisObj === 'function' ? fclos.getThisObj() : fclos?._this
    if (!receiver || receiver === res) return
    const returnValue = res as JavaRuntimeValue
    if (!this.isBodyReturnFieldOwnedByReceiver(fclos, returnValue, receiver)) return
    const donor = this.findBodyReturnFieldDonor(fclos, returnValue, receiver)
    if (donor) attachJavaInputTraceFromDonor(res, donor)
  }

  /**
   *
   * @param fclos
   * @param res
   * @param receiver
   */
  private isBodyReturnFieldOwnedByReceiver(fclos: JavaRuntimeValue, res: JavaRuntimeValue, receiver: unknown): boolean {
    if (
      res.object === receiver ||
      res.parent === receiver ||
      res._this === receiver ||
      res.getThisObj?.() === receiver
    ) {
      return true
    }
    const methodOwner = fclos?.parent
    if (!methodOwner) return false
    const fieldOwners = [res.object, res.parent, res._this, res.getThisObj?.()].filter(Boolean)
    return fieldOwners.some((owner: unknown) => this.isJavaSameRuntimeOwner(methodOwner, owner))
  }

  /**
   *
   * @param fclos
   * @param res
   * @param receiver
   */
  private findBodyReturnFieldDonor(
    fclos: JavaRuntimeValue,
    res: JavaRuntimeValue,
    receiver: unknown
  ): JavaTraceCarrier | null {
    const candidates = [
      receiver,
      fclos?._this,
      fclos?.getThisObj?.(),
      res.object,
      res.parent,
      res._this,
      res.getThisObj?.(),
    ]
    for (const candidate of candidates) {
      const donor = findJavaInputTraceDonor(candidate)
      if (donor && donor !== res) return donor
    }
    return null
  }

  /**
   *
   * @param expectedOwner
   * @param actualOwner
   */
  private isJavaSameRuntimeOwner(expectedOwner: unknown, actualOwner: unknown): boolean {
    if (!expectedOwner || !actualOwner) return false
    if (expectedOwner === actualOwner) return true
    const expectedNames = this.collectJavaOwnerNames(expectedOwner)
    if (expectedNames.size === 0) return false
    for (const actualName of this.collectJavaOwnerNames(actualOwner)) {
      if (expectedNames.has(actualName)) return true
    }
    return false
  }

  /**
   *
   * @param owner
   */
  private collectJavaOwnerNames(owner: unknown): Set<string> {
    const names = new Set<string>()
    for (const key of ['logicalQid', 'qid', 'sid']) {
      const value = (owner as Record<string, unknown> | null | undefined)?.[key]
      if (typeof value === 'string' && value.length > 0) names.add(value)
    }
    const ownerType = this.getDefiniteTypeText(owner)
    if (ownerType) names.add(ownerType)
    return names
  }

  /**
   *
   * @param fclos
   * @param node
   * @param argvalues
   */

  /**
   *
   * @param invocation
   * @param node
   * @param argvalues
   * @param state
   */
  private isExecutableInvocationCandidate(
    invocation: Invocation,
    node: CallExpression,
    argvalues: unknown[],
    state: State
  ): boolean {
    return (
      invocation.toScope?.vtype === 'fclos' &&
      !!(invocation.toScopeAst || invocation.toScope.runtime?.execute) &&
      invocation.toScopeAst?.body?.type !== 'Noop' &&
      !this.checkFclosCanPruneDuringInterpret(invocation.toScope, node, argvalues, state, true)
    )
  }

  /**
   *
   * @param candidate
   * @param memberValue
   * @param method
   */
  private isValidConcreteDispatchReceiver(
    candidate: Unit | null | undefined,
    memberValue: Value,
    method: Value
  ): boolean {
    if (candidate === memberValue) {
      return false
    }
    if (
      !this.isStableConcreteObjectOwner(candidate) &&
      !this.isConcreteCollectionElementSymbolOwner(candidate, memberValue, method)
    ) {
      return false
    }
    const declReceiver = method.getThisObj?.() ?? method._this
    if (declReceiver?.vtype === 'object' && !this.isStableConcreteObjectOwner(declReceiver)) {
      return false
    }
    return true
  }

  /**
   *
   * @param candidate
   * @param memberValue
   * @param method
   */
  private isConcreteCollectionElementSymbolOwner(
    candidate: Unit | null | undefined,
    memberValue: Value,
    method: Value
  ): boolean {
    if (!candidate || candidate.vtype !== 'symbol') return false
    if (memberValue?.vtype !== 'symbol') return false
    if ((memberValue.getThisObj?.() ?? memberValue._this) !== candidate) return false
    const receiverType = this.getDefiniteTypeText(memberValue) ?? this.getDefiniteTypeText(candidate)
    if (!receiverType) return false
    const hierarchy: ClassHierarchy | undefined = this.typeResolver?.classHierarchyMap?.get(receiverType)
    if (!this.isConcreteDispatchRootType(receiverType, hierarchy)) return false
    return this.isConcreteMethodDeclaredOnType(method, receiverType)
  }

  /**
   *
   * @param method
   * @param receiverType
   */
  private isConcreteMethodDeclaredOnType(method: Value, receiverType: string): boolean {
    const methodQid = typeof method.qid === 'string' ? method.qid : ''
    const methodLogicalQid =
      typeof (method as { logicalQid?: unknown }).logicalQid === 'string'
        ? (method as { logicalQid: string }).logicalQid
        : ''
    return (
      methodQid.startsWith(`<global>.packageManager.${receiverType}.`) ||
      methodQid.startsWith(`${receiverType}.`) ||
      methodLogicalQid.startsWith(`${receiverType}.`)
    )
  }

  /**
   *
   * @param value
   */
  private isStableConcreteObjectOwner(value: Unit | null | undefined): value is Unit {
    if (!value || value.vtype !== 'object') {
      return false
    }
    const resolvedThis = value.getThisObj?.()
    return !resolvedThis || resolvedThis === value
  }

  /**
   *
   * @param fclos
   * @param node
   * @param argvalues
   */
  private resolveConcreteReceiverMethod(
    fclos: unknown,
    node: CallExpression,
    argvalues: unknown[]
  ): SymbolValueType | undefined {
    if (!fclos || typeof fclos !== 'object') return undefined

    const symbolFclos = fclos as { vtype?: string; sid?: string; rtype?: { definiteType?: unknown } }
    if (symbolFclos.vtype === 'fclos') return undefined

    const methodName = this.getCalledMethodName(node)
    const receiverType = this.getDefiniteTypeText(symbolFclos)
    if (!methodName || !receiverType) return undefined
    const classHierarchy: ClassHierarchy | undefined = this.typeResolver?.classHierarchyMap?.get(receiverType)
    if (!classHierarchy || !this.isConcreteDispatchRootType(receiverType, classHierarchy)) {
      return undefined
    }

    const candidates: string[] = [receiverType]
    for (const superClass of classHierarchy.extends) {
      candidates.push(...this.collectConcreteSuperClassTypes(superClass))
    }

    for (const candidateType of candidates) {
      const candidateHierarchy: ClassHierarchy | undefined = this.typeResolver?.classHierarchyMap?.get(candidateType)
      if (!this.isConcreteDispatchRootType(candidateType, candidateHierarchy)) continue
      const method = this.getValidConcreteMethod(candidateType, methodName, argvalues)
      if (method) return method
    }
    return undefined
  }

  /**
   * 接口/抽象类虚分派 exhaustive 降级：当 receiver 静态类型为接口或抽象类、无法解析唯一具体实现时，
   * 按 ClassHierarchy 收集所有"实现了同名可执行方法"的具体子类型，返回候选 fclos 列表供 fan-out 执行。
   * 超过 fan-out 上限时返回空数组，由调用方保留 lib fallback 防止执行爆炸。
   * @param fclos - 调用 receiver 解析得到的 fclos（可为 symbol 或接口/抽象类下的 fclos）
   * @param node - 调用表达式
   * @param argvalues - 实参值列表
   * @param typeName
   * @param hierarchy
   */
  private isConcreteDispatchRootType(typeName: string, hierarchy: ClassHierarchy | undefined): boolean {
    if (!hierarchy || hierarchy.typeDeclaration !== 'class') return false
    if (this.isNonConcreteHierarchy(hierarchy)) return false
    if ((hierarchy.implementedBy?.length ?? 0) > 0) return false
    const classUuid = this.classMap?.get(typeName)
    if (!classUuid) return false
    const classScope = this.symbolTable.get(classUuid) as
      { ast?: { node?: { _meta?: { isAbstract?: boolean; isInterface?: boolean } } } } | undefined
    const meta = classScope?.ast?.node?._meta
    return !meta?.isAbstract && !meta?.isInterface
  }

  /**
   *
   * @param fclos
   * @param node
   * @param argvalues
   * @param calleeTypeFallback
   */
  private resolveInterfaceExhaustiveMethods(
    fclos: unknown,
    node: CallExpression,
    argvalues: unknown[],
    calleeTypeFallback?: string
  ): SymbolValueType[] {
    if (!fclos || typeof fclos !== 'object') return []
    const symbolFclos = fclos as { vtype?: string; parent?: { logicalQid?: unknown; qid?: unknown } }

    const methodName = this.getCalledMethodName(node)
    if (!methodName) return []

    let rootInterfaceType = this.resolveInterfaceRootType(symbolFclos)
    /* union 容器回退：当 receiver 是 union（如 for-each 迭代变量被整体赋值为 list）且
     * resolveInterfaceRootType 解析到容器类型或失败时，从类层级中反查包含 methodName 的接口类型 */
    if (symbolFclos.vtype === 'union') {
      const needFallback =
        !rootInterfaceType ||
        !this.typeResolver?.classHierarchyMap?.get(rootInterfaceType) ||
        ((this.typeResolver?.classHierarchyMap?.get(rootInterfaceType)?.implementedBy?.length ?? 0) === 0 &&
          (this.typeResolver?.classHierarchyMap?.get(rootInterfaceType)?.extendedBy?.length ?? 0) === 0)
      if (needFallback) {
        // 限于 receiver 类型缺失或为容器类型的场景，排除非容器且有明确类型的误匹配
        const shouldFallback = !rootInterfaceType || this.isJavaContainerType(rootInterfaceType)
        if (shouldFallback) {
          const fallbackType = this.inferInterfaceTypeFromHierarchyByMethod(methodName)
          if (fallbackType) rootInterfaceType = fallbackType
        }
      }
    }

    /* calleeType 回退：receiver 的 rtype 可能被覆盖成包路径或丢失；当现有 root
     * 不是可 fan-out 的接口/抽象层级时，使用 invocation.calleeType 重新定位接口根。 */
    const rootHierarchyBeforeCalleeFallback: ClassHierarchy | undefined = rootInterfaceType
      ? this.typeResolver?.classHierarchyMap?.get(rootInterfaceType)
      : undefined
    const shouldUseCalleeTypeFallback =
      !rootInterfaceType ||
      !rootHierarchyBeforeCalleeFallback ||
      ((rootHierarchyBeforeCalleeFallback.implementedBy?.length ?? 0) === 0 &&
        (rootHierarchyBeforeCalleeFallback.extendedBy?.length ?? 0) === 0)
    if (shouldUseCalleeTypeFallback && calleeTypeFallback) {
      const normalizedCallee = this.normalizeQid(calleeTypeFallback)
      const erasedCallee = normalizedCallee ? this.eraseGenericType(normalizedCallee) : undefined
      if (erasedCallee) {
        /* 精确匹配：calleeType 就是接口全限定名 */
        const calleeHierarchy = this.typeResolver?.classHierarchyMap?.get(erasedCallee)
        if (
          calleeHierarchy &&
          ((calleeHierarchy.implementedBy?.length ?? 0) > 0 || (calleeHierarchy.extendedBy?.length ?? 0) > 0)
        ) {
          rootInterfaceType = erasedCallee
        }
      }
      /* 包前缀匹配：calleeType 可能是包路径（如 `com.example.spi.handler`）而非完整类名
       * （如 `com.example.spi.handler.IHandler`），在 classHierarchyMap 中搜索以 calleeType
       * 为前缀的接口类型 */
      if (calleeTypeFallback.includes('.')) {
        const packagePrefix = `${calleeTypeFallback}.`
        let matchedType: string | undefined
        let matchedImplCount = 0
        for (const [typeName, hierarchy] of this.typeResolver?.classHierarchyMap ?? []) {
          if (!typeName.startsWith(packagePrefix)) continue
          if (!this.isNonConcreteHierarchy(hierarchy)) continue
          const implCount = (hierarchy.implementedBy?.length ?? 0) + (hierarchy.extendedBy?.length ?? 0)
          if (implCount === 0) continue
          /* 检查该接口是否包含 methodName */
          const classUuid = this.classMap?.get(typeName)
          if (!classUuid) continue
          const classScope = this.symbolTable.get(classUuid) as
            { members?: Map<string, unknown>; value?: Record<string, unknown> } | undefined
          if (!classScope) continue
          const hasMethod = classScope.members?.has(methodName) || (classScope.value && methodName in classScope.value)
          if (!hasMethod) continue
          /* 唯一匹配时取此接口；多匹配时选实现类最多的（最具体的接口） */
          if (!matchedType || implCount > matchedImplCount) {
            matchedType = typeName
            matchedImplCount = implCount
          }
        }
        if (matchedType && matchedImplCount <= INTERFACE_EXHAUSTIVE_FAN_OUT_LIMIT) {
          rootInterfaceType = matchedType
        }
      }
    }

    if (!rootInterfaceType) {
      return []
    }

    const rootHierarchy: ClassHierarchy | undefined = this.typeResolver?.classHierarchyMap?.get(rootInterfaceType)
    if (!rootHierarchy) return []
    /* 仅当 hierarchy 存在子类型分支时才有 fan-out 价值；否则与 lib fallback 等价。
     * 不依赖 typeDeclaration 区分 interface/abstract/class——typeResolver 对接口默认填 'class'，
     * 用 implementedBy / extendedBy 是否有子节点作为统一信号更稳健。 */
    if ((rootHierarchy.implementedBy?.length ?? 0) === 0 && (rootHierarchy.extendedBy?.length ?? 0) === 0) {
      return this.findConcreteImplementorsByAstSuper(rootInterfaceType, methodName, argvalues)
    }

    const concreteTypes = this.collectConcreteImplementorTypes(rootHierarchy)
    if (concreteTypes.length === 0) return []
    const hintedConcreteTypes = this.filterConcreteTypesByReceiverHints(symbolFclos, concreteTypes)
    const dispatchConcreteTypes = hintedConcreteTypes.length > 0 ? hintedConcreteTypes : concreteTypes
    if (dispatchConcreteTypes.length > INTERFACE_EXHAUSTIVE_FAN_OUT_LIMIT) return []

    const methods: SymbolValueType[] = []
    const seenQid = new Set<string>()
    for (const candidateType of dispatchConcreteTypes) {
      const method = this.getValidConcreteMethod(candidateType, methodName, argvalues)
      if (!method) continue
      const dedupKey = (method as { qid?: string; uuid?: string }).qid ?? (method as { uuid?: string }).uuid
      if (dedupKey && seenQid.has(dedupKey)) continue
      if (dedupKey) seenQid.add(dedupKey)
      methods.push(method)
    }
    return methods
  }

  /**
   *
   * @param fclos
   * @param node
   * @param calleeTypeFallback
   */
  private buildFanoutContinuationCallsiteKey(
    fclos: unknown,
    node: JavaFanoutCallsiteNodeShape,
    calleeTypeFallback?: string
  ): string {
    const entryPoint = CurrentEntryPoint.getCurrentEntryPoint() as JavaEntryPointShape
    const entryPointId = [
      typeof entryPoint.filePath === 'string' ? entryPoint.filePath : '',
      typeof entryPoint.functionName === 'string' ? entryPoint.functionName : '',
      typeof entryPoint.entryPointSymVal?.qid === 'string' ? entryPoint.entryPointSymVal.qid : '',
    ]
      .filter(Boolean)
      .join('#')
    const callsiteLoc = this.formatFanoutLocation(node.loc)
    const overloadIdentity = this.currentFanoutOverloadIdentity
    const methodName = this.getCalledMethodName(node) ?? ''
    const rootType = this.getFanoutRootTypeText(fclos, calleeTypeFallback)
    return [entryPointId, overloadIdentity, callsiteLoc, methodName, rootType].join('|')
  }

  /**
   *
   * @param fclos
   * @param calleeTypeFallback
   */
  private getFanoutRootTypeText(fclos: unknown, calleeTypeFallback?: string): string {
    const symbolFclos = fclos as { vtype?: string; parent?: { logicalQid?: unknown; qid?: unknown } }
    const rootInterfaceType =
      fclos && typeof fclos === 'object' ? this.resolveInterfaceRootType(symbolFclos) : undefined
    return rootInterfaceType ?? this.normalizeQid(calleeTypeFallback ?? '') ?? this.getDefiniteTypeText(fclos) ?? ''
  }

  /**
   *
   * @param interfaceType
   * @param methodName
   * @param argvalues
   */
  private findConcreteImplementorsByAstSuper(
    interfaceType: string,
    methodName: string,
    argvalues: unknown[]
  ): SymbolValueType[] {
    const interfaceShortName = this.getShortTypeName(interfaceType)
    const methods: SymbolValueType[] = []
    const seenQid = new Set<string>()
    for (const [className, classUuid] of this.classMap ?? []) {
      const classScope = this.symbolTable.get(classUuid) as JavaClassScopeRecord | undefined
      if (!classScope?.ast?.node) continue
      const { supers } = classScope.ast.node
      if (!Array.isArray(supers)) continue
      const implementsInterface = supers.some((superAst) => {
        const superName = getJavaAstIdentifierName(superAst)
        return superName === interfaceShortName || superName === interfaceType
      })
      if (!implementsInterface) continue
      const method = this.getValidConcreteMethod(className, methodName, argvalues)
      if (!method) continue
      const dedupKey = (method as { qid?: string; uuid?: string }).qid ?? (method as { uuid?: string }).uuid
      if (dedupKey && seenQid.has(dedupKey)) continue
      if (dedupKey) seenQid.add(dedupKey)
      methods.push(method)
      if (methods.length > INTERFACE_EXHAUSTIVE_FAN_OUT_LIMIT) return []
    }
    return methods
  }

  /**
   *
   * @param methods
   * @param callsiteKey
   */
  private prioritizeFanoutMethodsForTimeoutRerun(methods: SymbolValueType[], callsiteKey: string): SymbolValueType[] {
    if (!this.pruneInfoMap.aggressiveMode || methods.length <= 1) return methods
    const completed = this.completedFanoutImplementations.get(callsiteKey)
    if (!completed || completed.size === 0) return methods
    const unseen: SymbolValueType[] = []
    const seen: SymbolValueType[] = []
    for (const method of methods) {
      const identity = this.getFanoutImplementationIdentity(method)
      if (identity && completed.has(identity)) seen.push(method)
      else unseen.push(method)
    }
    return unseen.length === methods.length ? methods : [...unseen, ...seen]
  }

  /**
   *
   * @param callsiteKey
   * @param method
   */
  private markFanoutImplementationCompleted(callsiteKey: string, method: SymbolValueType): void {
    const identity = this.getFanoutImplementationIdentity(method)
    if (!identity) return
    let completed = this.completedFanoutImplementations.get(callsiteKey)
    if (!completed) {
      completed = new Set<string>()
      this.completedFanoutImplementations.set(callsiteKey, completed)
    }
    completed.add(identity)
  }

  /**
   *
   * @param method
   */
  private getFanoutImplementationIdentity(method: SymbolValueType): string | undefined {
    const fanoutMethod = method as JavaFanoutMethodShape
    const methodNode = fanoutMethod.ast?.node ?? fanoutMethod.ast?.fdef
    const methodId = fanoutMethod.qid ?? fanoutMethod.uuid
    const loc = this.formatFanoutLocation(methodNode?.loc ?? fanoutMethod.loc)
    const sourceFile = methodNode?.loc?.sourcefile ?? fanoutMethod.loc?.sourcefile ?? ''
    const nodeHash = methodNode?._meta?.nodehash ?? ''
    if (!methodId && !loc && !sourceFile && !nodeHash) return undefined
    return [methodId ?? '', sourceFile, loc, nodeHash].join('@')
  }

  /**
   *
   * @param overloadFuncDef
   */
  protected buildFanoutOverloadIdentity(overloadFuncDef: FunctionDefinition | undefined): string {
    if (!overloadFuncDef) return ''
    const node = overloadFuncDef as FunctionDefinition & JavaFunctionNodeShape
    const loc = this.formatFanoutLocation(node.loc)
    const sourceFile = node.loc?.sourcefile ?? ''
    const nodeHash = node._meta?.nodehash ?? ''
    const name = node.id?.type === 'Identifier' ? node.id.name : ''
    const parameterCount = Array.isArray(node.parameters) ? node.parameters.length : 0
    return [name, parameterCount, sourceFile, loc, nodeHash].join('@')
  }

  /**
   *
   */
  protected clearFanoutContinuationState(): void {
    this.completedFanoutImplementations.clear()
    this.currentFanoutOverloadIdentity = ''
  }

  /**
   *
   * @param loc
   */
  private formatFanoutLocation(loc: JavaSourceLocationShape | undefined): string {
    if (!loc?.start) return ''
    const startLine = loc.start.line ?? 0
    const startColumn = loc.start.column ?? 0
    const endLine = loc.end?.line ?? 0
    const endColumn = loc.end?.column ?? 0
    return `${startLine}:${startColumn}-${endLine}:${endColumn}`
  }

  /**
   *
   * @param fclos
   * @param concreteTypes
   */
  private filterConcreteTypesByReceiverHints(fclos: unknown, concreteTypes: string[]): string[] {
    if (!fclos || typeof fclos !== 'object' || concreteTypes.length === 0) return []
    const text = [
      (fclos as { qid?: unknown }).qid,
      (fclos as { logicalQid?: unknown }).logicalQid,
      (fclos as { sid?: unknown }).sid,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n')
    if (!text) return []
    return concreteTypes.filter((typeName) => text.includes(typeName))
  }

  /**
   * 收集 fan-out 循环 trace 截断目标：递归遍历 argvalues + receiver，把每个 Unit 携带的
   * TaintRecord 收集出来。union 的 value 数组、BVT 的 value Map 都向下展开；用 visited Set
   * 防环（self-reference / cycle）。
   *
   * 用途：fan-out 循环对同一 callsite 多次 invoke 时，每次 invoke 都会把 callsite step 推入
   * 这些 TaintRecord 的 tagTraces 数组；调用方用返回的 record 列表 snapshot 长度 + 截断回滚，
   * 抑制单条 finding 内的 N 帧字面相同 trace 累积。
   * @param argvalues - 调用实参值列表
   * @param receiver - this/receiver 对象（可空）
   */
  private collectFanoutTraceTargets(argvalues: unknown[], receiver: unknown): TaintRecord[] {
    const records: TaintRecord[] = []
    const seenRecords = new Set<TaintRecord>()
    const seenValues = new Set<unknown>()
    const visit = (val: unknown, depth: number): void => {
      if (val == null || typeof val !== 'object') return
      if (depth > 6) return
      if (seenValues.has(val)) return
      seenValues.add(val)
      const t = (val as { _taint?: TaintRecord | null })._taint
      if (t && !seenRecords.has(t)) {
        seenRecords.add(t)
        records.push(t)
      }
      const { vtype } = val as { vtype?: string }
      if (vtype === 'union') {
        const arr = (val as { value?: unknown[] }).value
        if (Array.isArray(arr)) {
          for (const child of arr) visit(child, depth + 1)
        }
      } else if (vtype === 'BVT') {
        const obj = (val as { value?: Record<string, unknown> }).value
        if (obj && typeof obj === 'object') {
          for (const k of Object.keys(obj)) visit(obj[k], depth + 1)
        }
      }
    }
    for (const a of argvalues) visit(a, 0)
    visit(receiver, 0)
    return records
  }

  /**
   * 从类层级中反查包含指定方法名的唯一非具体接口/抽象类类型。
   * 用于 union 容器回退场景：for-each 迭代变量被整体赋值为 list 时，无法直接推断元素接口类型，
   * 通过方法名在类层级中唯一匹配的接口类型作为 fan-out 根节点。
   * 多个匹配时返回 undefined 避免歧义。
   * @param methodName
   */
  private inferInterfaceTypeFromHierarchyByMethod(methodName: string): string | undefined {
    if (!this.typeResolver?.classHierarchyMap || !this.classMap) return undefined
    let matchedType: string | undefined
    for (const [typeName, hierarchy] of this.typeResolver.classHierarchyMap) {
      if (!this.isNonConcreteHierarchy(hierarchy)) continue
      if ((hierarchy.implementedBy?.length ?? 0) === 0 && (hierarchy.extendedBy?.length ?? 0) === 0) continue
      const classUuid = this.classMap.get(typeName)
      if (!classUuid) continue
      const classScope = this.symbolTable.get(classUuid) as
        { members?: Map<string, unknown>; value?: Record<string, unknown> } | undefined
      if (!classScope) continue
      const hasMethod = classScope.members?.has(methodName) || (classScope.value && methodName in classScope.value)
      if (!hasMethod) continue
      if (matchedType) return undefined
      matchedType = typeName
    }
    return matchedType
  }

  /**
   * for-each union 回退场景的 Java 容器类型白名单：仅这些类型上的 union 才允许通过 methodName 反查接口类型，避免对任意 union receiver 过宽 fan-out
   * @param typeName
   */
  private isJavaContainerType(typeName: string): boolean {
    const erased = this.eraseGenericType(this.normalizeQid(typeName) ?? typeName) ?? typeName
    return (
      erased === 'java.util.List' ||
      erased === 'java.util.Collection' ||
      erased === 'java.lang.Iterable' ||
      erased === 'java.util.Set' ||
      erased === 'java.util.Queue' ||
      erased === 'java.util.Deque'
    )
  }

  /**
   * 解析 receiver 的"接口/抽象类"根类型 qid：
   * - fclos 自身位于接口或抽象类内：取 fclos.parent.logicalQid
   * - fclos 为 symbol：fallback 到 rtype.definiteType
   * @param fclos - receiver fclos
   */
  private resolveInterfaceRootType(fclos: unknown): string | undefined {
    if (!fclos || typeof fclos !== 'object') return undefined
    const candidate = fclos as {
      vtype?: string
      parent?: { logicalQid?: unknown; qid?: unknown }
    }

    if (candidate.vtype === 'fclos' && this.checkFclosInInterfaceOrAbstractClass(candidate)) {
      const parentQid = candidate.parent?.logicalQid ?? candidate.parent?.qid
      const normalized = typeof parentQid === 'string' ? this.normalizeQid(parentQid) : undefined
      if (normalized) return this.eraseGenericType(normalized) ?? normalized
    }
    const receiverType = this.getDefiniteTypeText(candidate)
    if (!receiverType) return undefined
    return this.eraseGenericType(receiverType) ?? receiverType
  }

  /**
   * 判断 ClassHierarchy 是否非具体类型（抽象类或接口）：依赖 typeResolver 透传的 _meta。
   * typeResolver 对接口默认填 typeDeclaration='class'，因此需同时检测 isInterface。
   * @param hierarchy - 类型层级节点
   */
  private isNonConcreteHierarchy(hierarchy: ClassHierarchy): boolean {
    const meta = (
      hierarchy.value as { ast?: { node?: { _meta?: { isAbstract?: boolean; isInterface?: boolean } } } } | undefined
    )?.ast?.node?._meta
    if (meta?.isAbstract || meta?.isInterface) return true
    /* typeDeclaration 直接声明为 interface 时也视作非具体（fallback 兜底） */
    return hierarchy.typeDeclaration === 'interface'
  }

  /**
   * 自接口/抽象类根节点递归收集所有 typeDeclaration==='class' 的具体子类型 qid。
   * 走 implementedBy（接口→实现类、接口→子接口）+ extendedBy（类→子类）两条边，
   * 仅普适类型层级查询，不依赖字段名/注解/SPI 静态集合。
   * @param root - 起始类型层级节点
   */
  private collectConcreteImplementorTypes(root: ClassHierarchy): string[] {
    const visited = new Set<string>()
    const concrete: string[] = []

    const dfs = (node: ClassHierarchy | undefined): void => {
      if (!node) return
      const key = this.eraseGenericType(this.normalizeQid(node.type)) ?? node.type
      if (!key || visited.has(key)) return
      visited.add(key)

      if (node.typeDeclaration === 'class' && !this.isNonConcreteHierarchy(node)) {
        concrete.push(key)
      }

      for (const sub of node.implementedBy ?? []) {
        dfs(sub)
      }
      for (const sub of node.extendedBy ?? []) {
        dfs(sub)
      }
    }

    dfs(root)
    return concrete
  }

  /**
   *
   * @param classHierarchy
   */
  private collectConcreteSuperClassTypes(classHierarchy: ClassHierarchy | undefined): string[] {
    if (!classHierarchy || classHierarchy.typeDeclaration !== 'class') return []

    const result: string[] = [classHierarchy.type]
    for (const superClass of classHierarchy.extends) {
      result.push(...this.collectConcreteSuperClassTypes(superClass))
    }
    return result
  }

  /**
   *
   * @param className
   * @param methodName
   * @param argvalues
   */
  private getValidConcreteMethod(
    className: string,
    methodName: string,
    argvalues: unknown[]
  ): SymbolValueType | undefined {
    const classHierarchy: ClassHierarchy | undefined = this.typeResolver?.classHierarchyMap?.get(className)
    if (classHierarchy?.typeDeclaration !== 'class') return undefined

    const classUuid = this.classMap?.get(className)
    if (!classUuid) return undefined

    const classScope = this.symbolTable.get(classUuid) as
      { members?: Map<string, SymbolValueType>; value?: Record<string, SymbolValueType> } | undefined
    const method = classScope?.members?.get(methodName) ?? classScope?.value?.[methodName]
    if (!this.isExecutableConcreteMethod(method)) return undefined
    if (!this.isMethodArityCompatible(method, argvalues)) return undefined
    return method
  }

  /**
   *
   * @param method
   */
  private isExecutableConcreteMethod(method: unknown): method is SymbolValueType {
    if (!method || typeof method !== 'object') return false

    const candidate = method as { vtype?: string; ast?: { fdef?: FunctionDefinition }; runtime?: { execute?: unknown } }
    if (candidate.vtype !== 'fclos') return false
    if (this.checkFclosInInterfaceOrAbstractClass(candidate)) return false
    if (candidate.ast?.fdef?.body?.type === 'Noop') return false
    return !!(candidate.ast?.fdef || candidate.runtime?.execute)
  }

  /**
   *
   * @param method
   * @param argvalues
   */
  private isMethodArityCompatible(method: SymbolValueType, argvalues: unknown[]): boolean {
    const fdef = method.ast?.fdef as unknown as { parameters?: unknown[] } | undefined
    const params = fdef?.parameters
    if (!Array.isArray(params)) return true
    return params.length === argvalues.length
  }

  /**
   *
   * @param node
   * @param fclos
   */
  private getCalledMethodName(node: CallExpression, fclos?: Value): string | undefined {
    const { callee } = node
    if (callee?.type === 'MemberAccess') {
      const { property } = callee
      if (property?.type === 'Identifier') return property.name
      if (property?.type === 'Literal' && typeof property.value === 'string') return property.value
    }
    if (callee?.type === 'Identifier') return callee.name
    const sid = fclos?.sid
    return typeof sid === 'string' && sid.length > 0 ? sid : undefined
  }

  /**
   *
   * @param value
   */
  private getConcreteClassLiteralTarget(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined

    const classValue = value as Record<string, unknown> & { getThisObj?: () => unknown }
    if (!this.isSameQid(classValue.logicalQid, 'java.lang.Class')) return undefined

    const thisObj = classValue.getThisObj?.() ?? classValue._this
    if (!thisObj || typeof thisObj !== 'object') return undefined

    const targetQid = (thisObj as Record<string, unknown>).logicalQid
    if (typeof targetQid !== 'string' || targetQid === '' || this.isSameQid(targetQid, 'java.lang.Class')) {
      return undefined
    }
    return targetQid
  }

  /**
   *
   * @param left
   * @param right
   */
  private isSameQid(left: unknown, right: string): boolean {
    if (typeof left !== 'string') return false
    return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(left) === QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(right)
  }

  /**
   *
   * @param value
   */
  private normalizeQid(value: unknown): string | undefined {
    if (typeof value !== 'string' || value === '') return undefined
    return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(value)
  }

  /**
   *
   * @param typeName
   */
  private eraseGenericType(typeName: string | undefined): string | undefined {
    if (!typeName) return undefined
    const genericStart = typeName.indexOf('<')
    return genericStart === -1 ? typeName : typeName.slice(0, genericStart)
  }

  /**
   *
   * @param typeName
   */
  private getShortTypeName(typeName: string): string {
    const segments = typeName.split('.')
    return segments[segments.length - 1]
  }

  /**
   *
   * @param typeName
   */
  private hasPackageQualifier(typeName: string): boolean {
    return typeName.includes('.')
  }

  /**
   *
   * @param shortName
   */
  private findUniqueHierarchyTypeByShortName(shortName: string): string | undefined {
    const matchedTypes: Set<string> = new Set()
    for (const typeName of this.typeResolver?.classHierarchyMap?.keys() ?? []) {
      const normalizedType = this.eraseGenericType(this.normalizeQid(typeName))
      if (normalizedType && this.getShortTypeName(normalizedType) === shortName) {
        matchedTypes.add(normalizedType)
      }
    }
    return matchedTypes.size === 1 ? [...matchedTypes][0] : undefined
  }

  /**
   *
   * @param resolvedType
   */
  private resolveTypeInDeclarationContext(resolvedType: TypeRelatedInfoResult): string | undefined {
    const normalizedType = this.eraseGenericType(this.normalizeQid(resolvedType.type))
    if (!normalizedType) return undefined
    if (this.hasPackageQualifier(normalizedType)) return normalizedType

    const scopeType = this.eraseGenericType(this.normalizeQid(resolvedType.valueDefScopeType))
    if (scopeType && this.hasPackageQualifier(scopeType)) {
      const packageName = scopeType.split('.').slice(0, -1).join('.')
      const contextCandidate = packageName ? `${packageName}.${normalizedType}` : normalizedType
      if (this.typeResolver?.classHierarchyMap?.has(contextCandidate)) {
        return contextCandidate
      }
    }

    return this.findUniqueHierarchyTypeByShortName(normalizedType)
  }

  /**
   *
   * @param value
   */
  private getDefiniteTypeText(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined
    const { rtype } = value as { rtype?: { definiteType?: unknown } }
    if (!rtype?.definiteType) return undefined
    const printed = AstUtil.prettyPrint(rtype.definiteType)
    return this.normalizeQid(printed)
  }

  /**
   *
   * @param typeName
   * @param baseTypeName
   */
  private isSameOrSubtype(typeName: string, baseTypeName: string): boolean {
    const erasedTypeName = this.eraseGenericType(typeName)
    const erasedBaseTypeName = this.eraseGenericType(baseTypeName)
    if (!erasedTypeName || !erasedBaseTypeName) return false
    if (erasedTypeName === erasedBaseTypeName) return true
    const classHierarchy: ClassHierarchy | undefined = this.typeResolver?.classHierarchyMap?.get(erasedTypeName)
    if (!classHierarchy) return false
    const baseTypes: string[] = this.typeResolver.findBaseTypes(classHierarchy)
    return baseTypes.some(
      (baseType: string) => this.eraseGenericType(this.normalizeQid(baseType)) === erasedBaseTypeName
    )
  }

  /**
   *
   * @param argAst
   * @param value
   * @param resolvedType
   */
  private shouldKeepExistingDefiniteType(
    argAst: unknown,
    value: unknown,
    resolvedType: TypeRelatedInfoResult
  ): boolean {
    if ((argAst as { type?: string } | undefined)?.type !== 'CallExpression') return false
    const existingType = this.getDefiniteTypeText(value)
    const normalizedResolvedType = this.resolveTypeInDeclarationContext(resolvedType)
    if (!existingType || !normalizedResolvedType || existingType === normalizedResolvedType) return false
    return this.isSameOrSubtype(existingType, normalizedResolvedType)
  }

  /**
   *
   * @param receiver
   * @param property
   * @param scope
   */
  private resolveMemberDeclaredTypeFromReceiver(
    receiver: SymbolValueType,
    property: unknown,
    scope: Scope
  ): string | undefined {
    const memberName = this.getResolvedPropName(property)
    if (!memberName) return undefined
    const receiverType = this.getDefiniteTypeText(receiver)
    if (!receiverType) return undefined
    const classBody = this.getClassAstBody(receiverType)
    for (const bodyItem of classBody ?? []) {
      const item = bodyItem as { type?: string; id?: { name?: string } }
      if (item.type !== 'VariableDeclaration' || item.id?.name !== memberName) continue
      const rawType = this.getVariableDeclarationTypeText(bodyItem)
      return rawType ? (this.resolveTypeNameInScope(scope, rawType, receiverType) ?? rawType) : undefined
    }
    return undefined
  }

  /**
   *
   * @param value
   * @param declaredType
   */
  private fillMissingDefiniteType(value: SymbolValueType | undefined, declaredType: string | undefined): void {
    if (!value || !declaredType || this.hasDefiniteReceiverType(value)) return
    if (!value.rtype) value.rtype = { type: undefined }
    value.rtype.definiteType = UastSpec.identifier(declaredType)
  }

  /**
   *
   * @param scope
   * @param fieldName
   * @param fieldValue
   */
  private resolveClassFieldDeclaredType(
    scope: Scope,
    fieldName: string,
    fieldValue: SymbolValueType | undefined
  ): string | undefined {
    const fieldOwnerClass = this.getFieldOwnerClassName(fieldValue)
    const fieldNode =
      this.getVariableDeclarationNode(fieldValue) ?? this.findClassFieldDeclaration(scope, fieldName, fieldOwnerClass)
    if (!fieldNode) return undefined
    const rawType = this.getVariableDeclarationTypeText(fieldNode)
    if (!rawType) return undefined
    return this.resolveTypeNameInScope(scope, rawType, fieldOwnerClass) ?? rawType
  }

  /**
   *
   * @param value
   */
  private getVariableDeclarationNode(value: unknown): unknown | undefined {
    const node = (value as { ast?: { node?: unknown } } | undefined)?.ast?.node
    return (node as { type?: string } | undefined)?.type === 'VariableDeclaration' ? node : undefined
  }

  /**
   *
   * @param value
   */
  private getFieldOwnerClassName(value: unknown): string | undefined {
    let cur = (value as { parent?: unknown } | undefined)?.parent as
      { logicalQid?: unknown; qid?: unknown; parent?: unknown } | undefined
    let guard = 16
    while (cur && guard-- > 0) {
      const logicalQid = typeof cur.logicalQid === 'string' ? cur.logicalQid : undefined
      if (logicalQid && this.classMap?.has(logicalQid)) return logicalQid
      const declaringClass = this.extractDeclaringClassFromQid(typeof cur.qid === 'string' ? cur.qid : '')
      if (declaringClass) return declaringClass
      cur = cur.parent as typeof cur
    }
    return undefined
  }

  /**
   *
   * @param scope
   * @param fieldName
   * @param knownOwnerClass
   */
  private findClassFieldDeclaration(scope: Scope, fieldName: string, knownOwnerClass?: string): unknown | undefined {
    const ownerClass = knownOwnerClass ?? this.findOwnerClassName(scope)
    const classBody = ownerClass ? this.getClassAstBody(ownerClass) : undefined
    for (const bodyItem of classBody ?? []) {
      const item = bodyItem as { type?: string; id?: { name?: string } }
      if (item.type === 'VariableDeclaration' && item.id?.name === fieldName) return bodyItem
    }
    return undefined
  }

  /**
   *
   * @param scope
   */
  private findOwnerClassName(scope: Scope): string | undefined {
    let cur: Scope | undefined = scope
    let guard = 32
    while (cur && guard-- > 0) {
      const logicalQid = typeof cur.logicalQid === 'string' ? cur.logicalQid : undefined
      if (logicalQid && this.classMap?.has(logicalQid)) return logicalQid
      const declaringClass = this.extractDeclaringClassFromQid(typeof cur.qid === 'string' ? cur.qid : '')
      if (declaringClass) return declaringClass
      cur = cur.parent
    }
    const thisQid = typeof this.thisFClos?.logicalQid === 'string' ? this.thisFClos.logicalQid : undefined
    return thisQid && this.classMap?.has(thisQid) ? thisQid : undefined
  }

  /**
   *
   * @param classFqn
   */
  private getClassAstBody(classFqn: string): unknown[] | undefined {
    const classUuid = this.classMap?.get(classFqn)
    if (!classUuid) return undefined
    const classScope = this.symbolTable.get(classUuid) as { ast?: { node?: { body?: unknown[] } } } | undefined
    return Array.isArray(classScope?.ast?.node?.body) ? classScope.ast.node.body : undefined
  }

  /**
   *
   * @param node
   */
  private getVariableDeclarationTypeText(node: unknown): string | undefined {
    const varType = (node as { varType?: unknown } | undefined)?.varType
    const qualifiedName = AstUtil.typeToQualifiedName(varType)
    if (qualifiedName) return this.normalizeQid(qualifiedName)
    const varTypeId = (varType as { id?: unknown } | undefined)?.id
    if (!varTypeId) return undefined
    const idName = (varTypeId as { name?: unknown }).name
    if (typeof idName === 'string' && idName) return this.normalizeQid(idName)
    return this.normalizeQid(AstUtil.prettyPrint(varTypeId))
  }

  /**
   *
   * @param scope
   * @param typeName
   * @param ownerClass
   */
  private resolveTypeNameInScope(scope: Scope, typeName: string, ownerClass?: string): string | undefined {
    const erasedType = this.eraseGenericType(this.normalizeQid(typeName))
    if (!erasedType) return undefined
    if (this.classExists(erasedType)) return erasedType

    const declaringFileBody = ownerClass
      ? (this.getClassFileScopeAstBody(ownerClass) ??
        this.findDeclaringFileAstBody(scope) ??
        this.findFileScopeAstBody(scope))
      : (this.findDeclaringFileAstBody(scope) ?? this.findFileScopeAstBody(scope))
    const shortName = this.getShortTypeName(erasedType)
    for (const statement of declaringFileBody ?? []) {
      const importedClass = this.getImportedClassName(statement, shortName)
      if (importedClass && this.classExists(importedClass)) return importedClass
    }

    const typeOwnerClass = ownerClass ?? this.findOwnerClassName(scope)
    const packageName = typeOwnerClass?.split('.').slice(0, -1).join('.')
    const packageCandidate = packageName ? `${packageName}.${erasedType}` : undefined
    if (packageCandidate && this.classExists(packageCandidate)) return packageCandidate

    return this.findUniqueHierarchyTypeByShortName(erasedType)
  }

  /**
   * 沿 scope 链查找指定标识符的声明类型（local var / formal param 静态类型）。
   * 数据来源：type-related-info-resolver 在 resolveVariableDeclaration 落入 scope.declarationMap。
   * 用于 processMemberAccess 修正链式 builder 场景下被链头静态类污染的 receiver rtype。
   * @param scope - 起始 scope
   * @param name - 标识符名
   * @returns 声明类型 qid 字符串，无声明时返回 undefined
   */
  lookupDeclaredType(scope: Scope, name: string): string | undefined {
    if (!name) return undefined
    let cur: Scope | undefined = scope
    while (cur) {
      const decl = cur.declarationMap?.get?.(name) || cur.scope?.declarationMap?.get?.(name)
      if (decl?.type) return decl.type as string
      cur = cur.parent
    }
    return undefined
  }

  /**
   *
   * @param value
   */
  private hasDefiniteReceiverType(value: SymbolValueType): boolean {
    const definiteType = AstUtil.prettyPrint((value as { rtype?: { definiteType?: unknown } }).rtype?.definiteType)
    return typeof definiteType === 'string' && definiteType !== ''
  }

  /**
   *
   * @param scope
   * @param name
   */
  private resolveImportedClassReceiver(scope: Scope, name: string): string | undefined {
    if (!name) return undefined
    // 调用上下文里，scope 是 caller cloned 的 method/block scope，沿父链可能拿到的是 caller 的 fileScope，
    // 与被调方法源文件的 import 表不一致。要先用 scope.qid 上的真实方法限定名映射回真静态符号所在 fileScope。
    const declaringFileBody = this.findDeclaringFileAstBody(scope)
    if (declaringFileBody) {
      for (const statement of declaringFileBody) {
        const importedClass = this.getImportedClassName(statement, name)
        if (importedClass && this.classExists(importedClass)) {
          return importedClass
        }
      }
    }
    const astBody = this.findFileScopeAstBody(scope)
    if (astBody) {
      for (const statement of astBody) {
        const importedClass = this.getImportedClassName(statement, name)
        if (importedClass && this.classExists(importedClass)) {
          return importedClass
        }
      }
    }
    return undefined
  }

  // 从 scope 出发沿父链找到带 logicalQid 的最近类符号，再用 classMap 取真类作用域，从中拿其 fileScope ast.body。
  // 兼容 cloned wrapper：scope.qid 上记录了真实方法的 FQN（含 <global>.packageManager.<class>.<method>...），
  // 用其前缀按 classMap 中已知 FQN 做最长匹配，找到方法真正所在类的 fileScope。
  /**
   *
   * @param scope
   */
  private findDeclaringFileAstBody(scope: Scope): unknown[] | undefined {
    let cur: any = scope
    let guard = 32
    while (cur && guard-- > 0) {
      const logicalQid = typeof cur.logicalQid === 'string' ? cur.logicalQid : undefined
      if (logicalQid && this.classMap?.has(logicalQid)) {
        const body = this.getClassFileScopeAstBody(logicalQid)
        if (body) return body
      }
      const declaringClass = this.extractDeclaringClassFromQid(typeof cur.qid === 'string' ? cur.qid : '')
      if (declaringClass) {
        const body = this.getClassFileScopeAstBody(declaringClass)
        if (body) return body
      }
      cur = cur.parent
    }
    return undefined
  }

  /**
   *
   * @param classFqn
   */
  private getClassFileScopeAstBody(classFqn: string): unknown[] | undefined {
    const classUuid = this.classMap?.get(classFqn)
    if (!classUuid) return undefined
    const classScope: any = this.symbolTable.get(classUuid)
    const body = classScope?.fileScope?.ast?.node?.body ?? classScope?.scope?.fileScope?.ast?.node?.body
    return Array.isArray(body) ? body : undefined
  }

  // 从 scope.qid 抽取已 register 在 classMap 的最长 FQN 前缀。
  // 形如 `<global>.packageManager.com.x.Y.method<cloned>...` → `com.x.Y`，前提是 `com.x.Y` ∈ classMap。
  /**
   *
   * @param qid
   */
  private extractDeclaringClassFromQid(qid: string): string | undefined {
    if (!qid || !this.classMap) return undefined
    const cleaned = qid.replace('<global>.packageManager.', '')
    const segments = cleaned.split('.')
    for (let len = segments.length; len >= 1; len--) {
      const candidate = segments.slice(0, len).join('.')
      // 截断尾部含尖括号 / 块名 的段
      if (candidate.includes('<') || candidate.includes('_scope')) continue
      if (this.classMap.has(candidate)) return candidate
    }
    return undefined
  }

  // fileScope 只挂在外层 class 作用域且通过 ScopeCtx 持有；
  // 嵌套块/克隆 scope 出发需沿 parent 链回溯，并兼顾旧路径直接读 cur.fileScope 与新路径 cur.scope?.fileScope。
  /**
   *
   * @param scope
   */
  private findFileScopeAstBody(scope: Scope): unknown[] | undefined {
    let cur: any = scope
    let guard = 32
    while (cur && guard-- > 0) {
      const body = cur.fileScope?.ast?.node?.body ?? cur.scope?.fileScope?.ast?.node?.body
      if (Array.isArray(body)) return body
      cur = cur.parent
    }
    return undefined
  }

  /**
   *
   * @param className
   */
  private classExists(className: string): boolean {
    if (this.classMap?.has(className)) return true
    return Boolean(this.getPackageValueByQid(className))
  }

  /**
   *
   * @param qid
   */
  private getPackageValueByQid(qid: string): unknown {
    const segments = qid.split('.').filter(Boolean)
    let current = this.topScope.context.packages
    for (const segment of segments) {
      current = current?.members?.get(segment) ?? current?.getMemberValue?.(segment)
      if (!current) return undefined
    }
    return current
  }

  /**
   *
   * @param statement
   * @param name
   */
  private getImportedClassName(statement: unknown, name: string): string | undefined {
    const node = statement as {
      type?: string
      id?: { name?: string }
      varType?: { id?: { name?: string } }
      init?: { type?: string; from?: { value?: unknown }; imported?: { name?: string } }
    }
    if (node.type !== 'VariableDeclaration' || node.init?.type !== 'ImportExpression') return undefined
    if (node.id?.name !== name && node.init.imported?.name !== name) return undefined
    const importType = node.varType?.id?.name
    const importFrom = typeof node.init.from?.value === 'string' ? node.init.from.value : undefined
    const candidate =
      importType && importType.includes('.') ? importType : importFrom ? `${importFrom}.${name}` : undefined
    return this.normalizeQid(candidate)
  }

  // 判定当前 res 是否缺少真实可执行函数体：
  // - 不是 fclos（symbol / undefined）→ 缺
  // - 是 fclos 但 ast.fdef 缺失 / 函数体为 Noop / undefined → 缺
  // - 有 runtime.execute 内建实现 → 不缺
  /**
   *
   * @param value
   */
  private isMissingBodyFclos(value: unknown): boolean {
    if (!value || typeof value !== 'object') return true
    const candidate = value as {
      vtype?: string
      ast?: { fdef?: { body?: { type?: string } } }
      runtime?: { execute?: unknown }
    }
    if (candidate.runtime?.execute) return false
    if (candidate.vtype !== 'fclos') return true
    const fdef = candidate.ast?.fdef
    if (!fdef) return true
    const bodyType = fdef.body?.type
    return !bodyType || bodyType === 'Noop'
  }

  /**
   *
   * @param resolvedProp
   */
  private getResolvedPropName(resolvedProp: unknown): string | undefined {
    if (!resolvedProp || typeof resolvedProp !== 'object') return undefined
    const node = resolvedProp as { type?: string; name?: string; value?: unknown }
    if (node.type === 'Identifier' && typeof node.name === 'string') return node.name
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value
    return undefined
  }

  // 在 classMap 中按 FQN 取出类作用域，并从 members / value 里取出名为 memberName 的真实可执行方法符号。
  // 仅当目标本身是带函数体的 fclos 时返回；否则返回 undefined 让上游保留原 res。
  /**
   *
   * @param className
   * @param memberName
   */
  private findStaticClassMember(className: string, memberName: string): SymbolValueType | undefined {
    const classUuid = this.classMap?.get(className)
    if (!classUuid) return undefined
    const classScope = this.symbolTable.get(classUuid) as
      { members?: Map<string, SymbolValueType>; value?: Record<string, SymbolValueType> } | undefined
    if (!classScope) return undefined
    const member = classScope.members?.get(memberName) ?? classScope.value?.[memberName]
    if (!member || typeof member !== 'object') return undefined
    const candidate = member as {
      vtype?: string
      ast?: { fdef?: { body?: { type?: string } } }
      runtime?: { execute?: unknown }
    }
    if (candidate.vtype !== 'fclos') return undefined
    if (this.checkFclosInInterfaceOrAbstractClass(candidate)) return undefined
    const hasBody = !!candidate.ast?.fdef && candidate.ast.fdef.body?.type !== 'Noop'
    if (!hasBody && !candidate.runtime?.execute) return undefined
    return member
  }

  /**
   * add rtype to arg
   * @param argAst
   * @param argValue
   */
  addRtypeToArg(argAst: any, argValue: any) {
    const resolvedArgValue = this.resolveRuntimeValueRef(argValue) as JavaRuntimeValue | undefined
    if (
      !argAst ||
      !argAst._meta ||
      !argAst._meta.nodehash ||
      !resolvedArgValue ||
      typeof resolvedArgValue !== 'object' ||
      (resolvedArgValue.rtype?.definiteType && !resolvedArgValue.rtype.vagueType) ||
      !(this.typeResolver?.typeResultCacheMap instanceof Map) ||
      !this.typeResolver.typeResultCacheMap.has(argAst._meta.nodehash)
    ) {
      return
    }

    const classLiteralTarget = this.getConcreteClassLiteralTarget(resolvedArgValue)
    const resolvedTypeArray = this.typeResolver.typeResultCacheMap.get(argAst._meta.nodehash)
    for (const resolvedType of resolvedTypeArray) {
      if (resolvedType?.type !== '') {
        if (
          classLiteralTarget &&
          (this.isSameQid(resolvedType.type, 'java.lang.Class') || /(^|\.)Class$/.test(resolvedType.type))
        ) {
          if (!resolvedArgValue.rtype) {
            resolvedArgValue.rtype = { type: undefined }
          }
          resolvedArgValue.rtype.definiteType = UastSpec.identifier(classLiteralTarget)
          return
        }
        if (this.shouldKeepExistingDefiniteType(argAst, resolvedArgValue, resolvedType)) {
          return
        }
        if (!resolvedArgValue.rtype) {
          resolvedArgValue.rtype = { type: undefined }
        }
        resolvedArgValue.rtype.definiteType = UastSpec.identifier(resolvedType.type)
        return
      }
    }
  }

  /**
   * check if fclos in interface or abstract class
   * @param fclos
   */
  checkFclosInInterfaceOrAbstractClass(fclos: any) {
    return !!(
      (fclos?.parent?.vtype === 'class' &&
        (fclos.parent.ast?.node?._meta?.isAbstract || fclos.parent.ast?.node?._meta?.isInterface)) ||
      (fclos?.ast.fdef?.parent?.type === 'ClassDefinition' &&
        (fclos.ast.fdef.parent._meta?.isAbstract || fclos.ast.fdef.parent._meta?.isInterface))
    )
  }

  /**
   *
   * @param className
   * @param baseClassName
   */
  addExtraClassHierarchyByName(className: string, baseClassName: string) {
    if (!this.extraClassHierarchyByNameMap.has(className)) {
      this.extraClassHierarchyByNameMap.set(className, [])
    }
    if (!this.extraClassHierarchyByNameMap.get(className).includes(baseClassName)) {
      this.extraClassHierarchyByNameMap.get(className).push(baseClassName)
    }
  }
}

;(JavaAnalyzer as any).prototype.initFileScope = JavaInitializer.initFileScope

// 结构化判定：MemberAccess + callee 未被注册为 runtime 模型 + 首参可解析为 callable 容器。
// 内置/已建模 API 由 java-initializer 注册了 runtime.execute，自动出局；不依赖任何方法名或业务符号。
// 不强制 callee 缺少自身 body：业务自定义线程池 wrapper（如 ThreadPoolManager.submit）
// 自身可能有源码 body 转交给底层 Executor，仍需要从调用点抽取 lambda body 单独解释，
// 以恢复 lambda 闭包捕获的污点。
/**
 *
 * @param fclos
 * @param node
 * @param argvalues
 */
function isAsyncTaskSubmitCall(fclos: Value, node: CallExpression, argvalues: Value[]): boolean {
  if (node.callee?.type !== 'MemberAccess') return false
  if (fclos?.runtime?.execute) return false
  if (!argvalues || argvalues.length === 0) return false
  // 方法名必须暗示异步提交语义，避免 report/error/info/format 等误判
  const calleeMember = node.callee as MemberAccess
  const calleeName = String((calleeMember?.property as any)?.name ?? (calleeMember?.property as any)?.qid ?? '')
  if (
    !/(?:^|sub|re|async|schedule|fork|dispatch|batch|spark)(run|execute|submit|invoke|call|apply|start|launch)/i.test(
      calleeName
    ) &&
    !/(?:run|execute|submit|invoke|call|apply|start|launch)(?:async|later|delayed|batch|all|any|and|or|each)?$/i.test(
      calleeName
    )
  ) {
    return false
  }
  // 扫描全部参数找 callable，兼容 asyncRun(executor, callable) 等 callable 不在首参的场景
  for (const arg of argvalues) {
    if (collectCallableTasks(arg).length > 0) return true
  }
  return false
}

/**
 *
 * @param taskContainer
 */
function collectCallableTasks(taskContainer: Value): Value[] {
  if (!taskContainer) return []

  let funcs: Value[] = []
  if (getCallableExecutable(taskContainer)) {
    funcs = [taskContainer]
  }

  if (funcs.length === 0 && _.isFunction((taskContainer as any).getMisc) && (taskContainer as any).getMisc('buffer')) {
    funcs = getAllElementFromBuffer(taskContainer)
  }
  if (funcs.length === 0) {
    const satisfyResult = AstUtil.satisfy(
      taskContainer,
      (n: Value) =>
        (n as any)?.members?.get('execTask')?.vtype === 'fclos' ||
        (n as any)?.members?.get('call')?.vtype === 'fclos' ||
        (n as any)?.members?.get('doCall')?.vtype === 'fclos' ||
        (n as any)?.members?.get('doRun')?.vtype === 'fclos' ||
        (n as any)?.members?.get('runInner')?.vtype === 'fclos' ||
        (n?.vtype === 'fclos' && n?.sid?.includes('<anonymous')),
      null,
      null,
      true
    )
    if (satisfyResult) funcs = Array.isArray(satisfyResult) ? satisfyResult : [satisfyResult]
  }

  return funcs
}

/**
 * 从路径敏感 BVT 中递归取出带方法体的 fclos 叶子。
 * BVT 在分支汇合点合并同一方法的不同分支值，匿名类方法体（fclos 带 fdef）
 * 可能与抽象声明（symbol 无 fdef）共同存在于 BVT 叶子中，取首个带 fdef 的 fclos。
 * @param bvt
 */
function findFclosLeafWithFdef(bvt: Value): Value | undefined {
  const seen = new Set<Value>()
  const walk = (v: Value): Value | undefined => {
    if (!v || seen.has(v)) return undefined
    seen.add(v)
    const vAny = v as {
      vtype?: string
      ast?: { fdef?: unknown }
      getRawValue?: () => unknown[]
      children?: Record<string, unknown>
    }
    if (vAny.vtype === 'BVT') {
      let raw: unknown[] = []
      if (typeof vAny.getRawValue === 'function') raw = vAny.getRawValue()
      else if (vAny.children && typeof vAny.children === 'object') raw = Object.values(vAny.children)
      if (Array.isArray(raw)) {
        for (const child of raw) {
          const found = walk(child as Value)
          if (found) return found
        }
      }
      return undefined
    }
    if (vAny.vtype === 'fclos' && vAny.ast?.fdef) return v
    return undefined
  }
  return walk(bvt)
}

/**
 *
 * @param func
 */
function getCallableExecutable(func: Value): Value | undefined {
  const members = (func as { members?: Map<string, Value> } | undefined)?.members
  for (const methodName of ['execTask', 'call', 'doCall', 'run']) {
    const method = members?.get(methodName)
    if (method?.vtype === 'fclos') return method
    // 路径敏感分析会把同一方法在不同分支的值折叠成 BVT，匿名类 run/call 方法体
    // （fclos 带 fdef）会作为 BVT 叶子存在，需展开 BVT 取带方法体的 fclos 作为可执行目标。
    if (method?.vtype === 'BVT') {
      const leaf = findFclosLeafWithFdef(method)
      if (leaf) return leaf
    }
  }
  // run 无 fdef 时 fallback 到 doRun/runInner 委托链（继承模式：TracerRunnable.run→doRun→runInner）
  // TODO: SofaTracerRunnable 组合模式（run()→wrappedRunnable.run()）待单独处理
  const runMethod = members?.get('run')
  if (runMethod && runMethod.vtype !== 'fclos') {
    for (const methodName of ['doRun', 'runInner']) {
      const method = members?.get(methodName)
      if (method?.vtype === 'fclos') return method
      if (method?.vtype === 'BVT') {
        const leaf = findFclosLeafWithFdef(method)
        if (leaf) return leaf
      }
    }
  }
  if (func?.vtype === 'fclos') return func as Value
  return undefined
}

// 形参标识符兼容 `{ id: { name } }` 与扁平 `{ name }` 两种 AST 形态。
/**
 *
 * @param param
 */
function getCallableParamName(param: unknown): string | undefined {
  return (
    (param as { id?: { name?: string }; name?: string } | undefined)?.id?.name ??
    (param as { name?: string } | undefined)?.name
  )
}

// 沿父作用域按形参名查找闭包捕获实参；未捕获则返回 undefined，由调用方截断 callArgs。
/**
 *
 * @param analyzer
 * @param executable
 * @param param
 * @param state
 */
function readClosureArgument(
  analyzer: JavaAnalyzer,
  executable: Value,
  param: unknown,
  state: State
): Value | undefined {
  const paramName = getCallableParamName(param)
  if (!paramName || !executable?.parent) return undefined

  const parentScope = executable.parent as Scope
  const resolved = analyzer.getMemberValueNoCreate(parentScope, UastSpec.identifier(paramName), state, 20)
  if (resolved && resolved.constructor?.name !== 'UndefinedValue') return resolved

  const parentValue = parentScope.value
  if (parentValue && typeof parentValue === 'object') {
    return (parentValue as Record<string, Value | undefined>)[paramName]
  }
  return undefined
}

// 将 callable 形参映射到父作用域已绑定的同名实参，未绑定到的形参之后全部丢弃，避免误注 undefined。
/**
 *
 * @param analyzer
 * @param executable
 * @param state
 */
function buildCallableExecution(analyzer: JavaAnalyzer, executable: Value, state: State): JavaCallableExecution {
  const executableFdef = (executable as unknown as { ast?: { fdef?: FunctionDefinition } }).ast?.fdef
  const params = Array.isArray(executableFdef?.parameters) ? (executableFdef!.parameters as unknown[]) : []
  const callArgs: Value[] = []
  for (const param of params) {
    const resolved = readClosureArgument(analyzer, executable, param, state)
    if (!resolved) break
    callArgs.push(resolved)
  }
  return { executable, callArgs }
}

/**
 *
 * @param analyzer
 * @param func
 * @param state
 */
function getCallableExecution(analyzer: JavaAnalyzer, func: Value, state: State): JavaCallableExecution | undefined {
  const executable = getCallableExecutable(func)
  return executable ? buildCallableExecution(analyzer, executable, state) : undefined
}

/**
 *
 * @param analyzer
 * @param func
 */
function callableMayReachSink(analyzer: JavaAnalyzer, func: Value): boolean {
  const executable = getCallableExecutable(func)
  if (!executable || !_.isFunction((analyzer as any).checkFclosMatchSink)) return false

  const sinkArray = (analyzer as any).pruneInfoMap?.sinkArray
  if (!Array.isArray(sinkArray) || sinkArray.length === 0) return true
  return (analyzer as any).checkFclosMatchSink(executable, [], sinkArray, new Map(), true)
}

/**
 * 判定 callable 是否为提交点内联声明的匿名内部类实例。
 * 匿名类方法体的 fdef 源位置落在提交调用实参（new X(){...} 表达式）的源位置区间内，
 * 具名类（new Foo()）方法体定义在类自身源文件、变量传递的 Runnable 实体不在实参区间，
 * 二者均不满足该包含关系，故仅内联匿名类命中，避免对具名类误注入外层局部变量。
 * @param func
 * @param node
 */
function isInlineAnonymousClassCallable(func: Value, node: CallExpression): boolean {
  if (!func || (func as { vtype?: string }).vtype === 'fclos') return false
  const executable = getCallableExecutable(func)
  if (!executable) return false
  const fdef = (executable as { ast?: { fdef?: { loc?: { start?: { line?: number }; end?: { line?: number } } } } }).ast
    ?.fdef
  const fLoc = fdef?.loc
  const mStart = fLoc?.start?.line
  const mEnd = fLoc?.end?.line
  if (!mStart || !mEnd) return false
  const args = (node as { arguments?: Array<{ loc?: { start?: { line?: number }; end?: { line?: number } } }> })
    .arguments
  if (!Array.isArray(args)) return false
  for (const arg of args) {
    const aLoc = arg?.loc
    const aStart = aLoc?.start?.line
    const aEnd = aLoc?.end?.line
    if (!aStart || !aEnd) continue
    if (mStart >= aStart && mEnd <= aEnd) return true
  }
  return false
}

/**
 *
 * @param analyzer
 * @param node
 * @param func
 * @param state
 * @param scope
 */
function executeCallableTask(
  analyzer: JavaAnalyzer,
  node: CallExpression,
  func: Value,
  state: State,
  scope: Scope
): void {
  const execution = getCallableExecution(analyzer, func, state)
  if (!execution) return
  const { executable, callArgs } = execution

  const isolatedState = _.clone(state)
  isolatedState.callstack = state.callstack ? [...state.callstack] : []
  isolatedState.callsites = state.callsites ? [...state.callsites] : []

  const shouldBindThis = func && func.vtype !== 'fclos' && getCallableExecutable(func) === executable
  const oldThis = executable._this
  const oldThisRef = (executable as any)._thisRef
  if (shouldBindThis) {
    if (func.uuid) executable._this = func
    else (executable as any)._thisRef = (executable as any)._makeValueRefDirect?.(func) ?? oldThisRef
  }
  try {
    // 闭包 taint 传播：与 Executor.execute builtin 对称，确保 callable 内闭包变量可解析
    if (func.vtype === 'fclos') {
      // fclos 无 <anonymous sid，propagateClosureTaint 的 isAnonymous 守卫不匹配，需内联传播
      let _curScope: any = scope
      let _depth = 0
      while (_curScope && _depth < 3) {
        const _vals = _curScope.value
        if (_vals && typeof _vals === 'object') {
          for (const _key of Object.keys(_vals)) {
            if (_key.startsWith('__') || _key === '_CTOR_') continue
            const _val = _vals[_key]
            if (!_val || typeof _val !== 'object') continue
            if (!_val.taint?.isTaintedRec) continue
            if (!func.value[_key]) {
              func.value[_key] = _val
            }
            // 写入 fclos._fclos.value（标识符解析的关键路径）
            const _fclos = func._fclos || func
            if (_fclos.value && !_fclos.value[_key]) {
              _fclos.value[_key] = _val
            }
            // 传播 taint 到 fclos 实例本身
            if (typeof func.taint?.markSource === 'function') {
              func.taint.markSource()
            }
            if (typeof func.taint?.mergeTracesFrom === 'function' && _val.taint) {
              func.taint.mergeTracesFrom(_val.taint)
            }
            if (typeof func.setMisc === 'function') {
              const _buf = func.getMisc('buffer')
              if (!Array.isArray(_buf) || !_buf.includes(_val)) {
                func.setMisc('buffer', [...(_buf || []), _val])
              }
            }
          }
        }
        _curScope = _curScope.parent
        _depth++
      }
      // 传播外部类成员（lambda 共享 enclosing this，与 propagateEnclosingMembers 对称）
      _curScope = scope
      _depth = 0
      while (_curScope && _depth < 5) {
        const _thisObj = _curScope._this
        if (_thisObj && _thisObj !== func && _thisObj.members) {
          _thisObj.members.forEach((_mVal: any, _mName: string) => {
            if (_mName.startsWith('__') || _mName === '_CTOR_' || _mName === 'super') return
            if (_mVal?.vtype !== 'fclos') return
            if (func.members && typeof func.members.has === 'function' && !func.members.has(_mName)) {
              func.members.set(_mName, _mVal)
            }
            if (func.value && typeof func.value === 'object' && !func.value[_mName]) {
              func.value[_mName] = _mVal
            }
            // 注入到 _fclos.members/value（影响 thisFClos 标识符解析与 getDefScopeRec 作用域链）
            const _fclos = func._fclos || func
            if (_fclos.members && typeof _fclos.members.has === 'function' && !_fclos.members.has(_mName)) {
              _fclos.members.set(_mName, _mVal)
            }
            if (_fclos.value && typeof _fclos.value === 'object' && !_fclos.value[_mName]) {
              _fclos.value[_mName] = _mVal
            }
          })
        }
        _curScope = _curScope.parent
        _depth++
      }
    } else if (isInlineAnonymousClassCallable(func, node)) {
      // 匿名内部类闭包传播：匿名类通过合成字段捕获外层局部变量，引擎不模拟该机制，
      // 需显式注入外层 scope 的 taint 变量与外部类成员。仅对提交点内联声明的匿名类生效，
      // 避免对具名类实例注入外层局部变量造成实例字段被覆盖的误报。
      // 匿名类实例 sid 为 <ClassName><instance_...> 不含 <anonymous，原 sid 守卫恒 false，
      // 故此处用内联声明位置判定并通过 forcePropagate 绕过 Executor 内的 sid 守卫。
      const Executor = require('./builtins/executor-builtins')
      Executor.propagateClosureTaint(func, scope, 3, true)
      Executor.propagateEnclosingMembers(func, scope, 5, true)
    }
    // 通过 buildCallArgs 注入闭包捕获形参，确保 lambda body 内形参不再 unbound。
    analyzer.executeCall(node, executable, isolatedState, scope, {
      callArgs: analyzer.buildCallArgs(node, callArgs, executable),
      callsiteNode: node,
    })
  } finally {
    if (shouldBindThis) {
      if (oldThis) executable._this = oldThis
      else (executable as any)._thisRef = oldThisRef
    }
  }
}

/**
 *
 * @param analyzer
 * @param fclos
 * @param argvalues
 * @param node
 * @param state
 * @param scope
 */
function executeAsyncBatchSubmitTasks(
  analyzer: JavaAnalyzer,
  fclos: Value,
  argvalues: Value[],
  node: CallExpression,
  state: State,
  scope: Scope
): void {
  if (!isAsyncTaskSubmitCall(fclos, node, argvalues)) return

  // 找到包含 callable 的参数（兼容 callable 不在首参的场景，如 asyncRun(executor, callable)）
  let callableArg: Value | undefined
  for (const arg of argvalues) {
    if (collectCallableTasks(arg).length > 0) {
      callableArg = arg
      break
    }
  }
  if (!callableArg) return
  const funcs = collectCallableTasks(callableArg)
  if (funcs.length === 0) return
  const executableFuncs = funcs.filter((func) => callableMayReachSink(analyzer, func))
  const selectedFuncs = executableFuncs.length > 0 ? executableFuncs : funcs.slice(0, 1)
  for (const func of selectedFuncs) {
    executeCallableTask(analyzer, node, func, state, scope)
  }
}

;(JavaAnalyzer as any).prototype.executeAsyncBatchSubmitTasks = function (
  fclos: Value,
  argvalues: Value[],
  node: CallExpression,
  state: State,
  scope: Scope
): void {
  executeAsyncBatchSubmitTasks(this, fclos, argvalues, node, state, scope)
}

const javaAnalyzerTestHooks = {
  attachJavaInputTraceToReturnGraph,
  findJavaInputArgumentDonor,
  javaReturnExpressionReferencesParameter,
  javaReturnExpressionReferencesExternalQueryResult,
}
;(
  JavaAnalyzer as typeof JavaAnalyzer & { __javaAnalyzerTestHooks: typeof javaAnalyzerTestHooks }
).__javaAnalyzerTestHooks = javaAnalyzerTestHooks
export = JavaAnalyzer

/**
 * 将字符串首字母转为大写
 * @param str - 输入字符串
 * @returns {string} 首字母大写的字符串
 */
function getUpperCase(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
