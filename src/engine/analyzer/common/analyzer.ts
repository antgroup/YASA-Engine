import { primitiveToString } from '../../../util/variable-util'
import { AstRefList } from './value/ast-ref-list'
import type { ISymbolTableManager } from './symbol-table-interface'
import type { Invocation } from '../../../resolver/common/value/invocation'
import type { TraceItem } from '../../../util/finding-util'
import type {
  Identifier,
  Literal,
  CompileUnit,
  IfStatement,
  SwitchStatement,
  ForStatement,
  WhileStatement,
  RangeStatement,
  ReturnStatement,
  BreakStatement,
  ContinueStatement,
  ThrowStatement,
  TryStatement,
  ExpressionStatement,
  ScopedStatement,
  BinaryExpression,
  UnaryExpression,
  AssignmentExpression,
  ConditionalExpression,
  SuperExpression,
  ThisExpression,
  MemberAccess,
  SliceExpression,
  TupleExpression,
  ObjectExpression,
  CallExpression,
  CastExpression,
  NewExpression,
  FunctionDefinition,
  ClassDefinition,
  VariableDeclaration,
  ImportExpression,
  SpreadElement,
  YieldExpression,
  ExportStatement,
  Node,
  BaseNode,
} from '../../../types/uast'
import type {
  Scope as ScopeType,
  State,
  Value,
  SymbolValue as SymbolValueType,
  VoidValue as VoidValueType,
  SpreadValue as SpreadValueType,
} from '../../../types/analyzer'
import { BaseAnalyzer } from './base-analyzer'
import { FindingsCheckpointWriter, writeFindingsCheckpoint, type FindingsCheckpointReason } from './findings-checkpoint'
import { BinaryExprValue } from './value/binary-expr'
import { UnaryExprValue } from './value/unary-expr'
import { CallExprValue } from './value/call-expr'
import { AnalysisContext } from './analysis-context'
import {
  buildEntryPointAnalysisKey,
  buildEntryPointMetricDiagnostics,
  EntryPointMetricsCollector,
  getEntryPointMetricType,
  markEntryPointForAnalysis,
  type EntryPointMetric,
} from '../../../util/entrypoint-metrics'
import type { CallArg, CallArgs, CallInfo, BoundCall, BoundParam } from './call-args'
import { getLegacyArgValues, INTERNAL_CALL } from './call-args'
import {
  createDefaultCallSummarySessions,
  executeWithCallSummary,
  type CallSummaryReturnLike,
  type CallSummaryRiskContext,
} from './call-summary'
import { defaultCallSummaryPolicy } from './call-summary/language/default'
import type { CallSummaryLanguagePolicy, CallSummaryLanguagePolicyContext } from './call-summary/language/types'
import {
  applyCallSummaryReplayDelta,
  buildCallSummaryReplayReturn,
  buildHitReturn,
  captureCallSummarySideEffectSnapshot,
} from './call-summary/adapter'

const _ = require('lodash')
const Uuid = require('node-uuid')
const logger = require('../../../util/logger')(__filename)
const Config = require('../../../config')

function isDataflowInstrumentationEnabled(): boolean {
  return Config.dataflowDb
}
const constValue = require('../../../util/constant')
const Initializer = require('./initializer')
const NativeResolver = require('./native-resolver')
const MemState = require('./memState')
const Scope = require('./scope')
const SourceLine = require('./source-line')
const AstUtil = require('../../../util/ast-util')
const StateUtil = require('../../util/state-util')
const SymAddress = require('./sym-address')
const { unionAllValues } = require('./memStateBVT')
const { shallowCopyValue, buildNewValueInstance, buildNewCopiedWithTag, lodashCloneWithTag } = require('../../../util/clone-util')
const { handleException } = require('./exception-handler')
const {
  ValueUtil: {
    ObjectValue,
    Scoped,
    PrimitiveValue,
    UndefinedValue,
    UnionValue,
    SymbolValue,
    PackageValue,
    VoidValue,
  },
} = require('../../util/value-util')

const { filterDataFromScope, shallowEqual } = require('../../../util/common-util')
const Rules = require('../../../checker/common/rules-basic-handler')
const { getAbsolutePath, loadJSONfile } = require('../../../util/file-util')
const { saveAnalyzerCache, loadAnalyzerCache, generateCacheId } = require('./analyzer-cache')
const { matchSinkAtFuncCallWithCalleeType } = require('../../../checker/taint/common-kit/sink-util')
const { moveExistElementsToBuffer, addElementToBuffer } = require('../java/common/builtins/buffer')
const { performanceTracker } = require('../../../util/performance-tracker')
const { checkInvocationMatchSink } = require('../../../checker/taint/common-kit/sink-util')
const OutputStrategyAutoRegister = require('./output-strategy-auto-register')
// 单入口内存护栏：基类 hook + Python override 写状态；状态由子类持有
import type { MemoryGuardState } from './memory-guard/entrypoint-memory-guard'
const { logDiagnostics } = require('../../../util/diagnostics-log-util')
type IncrementalManagerModule = typeof import('../../../incremental/incremental-manager')

function loadIncrementalManager(): IncrementalManagerModule {
  return require('../../../incremental/incremental-manager') as IncrementalManagerModule
}

const ASTManager = require('./ast-manager')
const SymbolTableManager = require('./symbol-table-manager')
const { setGlobalASTManager, setGlobalSymbolTable, getGlobalSymbolTable } = require('../../../util/global-registry')
const { prettyPrint } = require('../../../util/ast-util')

type TaintLike = {
  isTaintedRec?: boolean
  getTags?: () => string[]
  getTagTracesMap?: () => Map<string, TraceItem[]>
  getTrace?: (tag: string) => TraceItem[] | null
  mergeTracesFrom?: (source: TaintLike) => void
  mergeTracesDedup?: (source: TaintLike) => void
  containsTag?: (tag: string) => boolean
  markSource?: () => void
  addTag?: (tag: string) => void
  materializeTagTrace?: (tag: string, trace: TraceItem[]) => void
  tagTraces?: Map<string, TraceItem[]>
}

type ValueLike = {
  taint?: TaintLike
  hasTagRec?: boolean
  misc_?: {
    buffer?: unknown[]
    'pass-in'?: unknown[]
  }
  _field?: Record<string, unknown>
  value?: unknown
}

/**
 * wrapper-return 候选：方法体返回 UndefinedValue 时，从 fscope 中收集仍带 taint 的载体值，
 * 让 wrapper 类方法（filterValidActivityByConsult 等）仍能把 taint 透传给调用者。
 */
type WrapperReturnCandidate = {
  value: any
  score: number
}

/** Java 集合/数组类型 qid 关键字（lowercase 匹配）：用于在 carrier scorer 中加权识别真实集合载体。 */
const COLLECTION_QID_PATTERNS = [
  'arraylist',
  'linkedlist',
  'copyonwritearraylist',
  'hashset',
  'linkedhashset',
  'treeset',
  'hashmap',
  'linkedhashmap',
  'treemap',
  'concurrenthashmap',
  'collections',
  'arrays',
  'list',
  'set',
  'map',
]

function getAstTypeName(node: any): string {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (typeof node.name === 'string') return node.name
  if (typeof node.value === 'string') return node.value
  if (node.id) return getAstTypeName(node.id)
  if (node.elementType) return getAstTypeName(node.elementType)
  if (node.base) return getAstTypeName(node.base)
  if (node.object) return getAstTypeName(node.object)
  if (Array.isArray(node.typeParameters) && node.typeParameters.length > 0) return getAstTypeName(node.typeParameters[0])
  return ''
}

function getDeclaredReturnTypeName(fdecl: any): string {
  const returnType = fdecl?.returnType || fdecl?._meta?.returnType
  return getAstTypeName(returnType).toLowerCase()
}

/**
 * 判断方法返回类型是否属于"可被 wrapper-return 兜底"的容器/复合类型。
 * 仅这类返回 UndefinedValue 时才会触发 candidate 兜底，
 * 避免误把基本类型方法返回值替换为对象。
 * 白名单机制：只对已知可恢复类型生效，防止过宽匹配覆盖 fallbackCallbackTraceTarget 路径。
 */
function isRecoverableDeclaredReturn(fdecl: any): boolean {
  const declaredType = getDeclaredReturnTypeName(fdecl)
  if (!declaredType || declaredType === 'void') return false
  return declaredType.includes('list') || declaredType.includes('collection') || declaredType.includes('set') || declaredType.includes('map') ||
    declaredType.includes('array') || declaredType.includes('object') || declaredType.includes('response') || declaredType.includes('result') ||
    declaredType.includes('dto') || declaredType.includes('vo') || declaredType.includes('bo') ||
    declaredType === 'string' || declaredType.includes('prompt')
}

/** 检查 value.qid（或 vtype 字符串）是否命中 Java collection-like 关键字。 */
function isCollectionLikeQid(value: any): boolean {
  const qid = typeof value?.qid === 'string' ? value.qid.toLowerCase() : ''
  if (!qid) return false
  for (const pattern of COLLECTION_QID_PATTERNS) {
    if (qid.includes(pattern)) return true
  }
  return false
}

function collectWrapperReturnCandidates(value: any, candidates: WrapperReturnCandidate[], seen: WeakSet<object>, depth: number = 0): void {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) return
  seen.add(value)
  const tainted = !!value.taint?.isTaintedRec
  const buffer = typeof value.getMisc === 'function' ? value.getMisc('buffer') : value.misc_?.buffer
  const passIn = typeof value.getMisc === 'function' ? value.getMisc('pass-in') : value.misc_?.['pass-in']
  if (tainted && value.vtype !== 'undefine' && value.vtype !== 'void') {
    // collection 载体（如 ArrayList）应优先于通用 DTO（如 PrizeReceiveRecordQuery）
    // 让 wrapper 方法把 taint 透传给后续真正消费集合元素的下游
    const bufferScore = Array.isArray(buffer) ? Math.min(buffer.length, 20) : 0
    const typeScore = value.vtype === 'object' || value.vtype === 'symbol' || value.vtype === 'union' ? 8 : 0
    const collectionBonus = isCollectionLikeQid(value) ? 6 : 0
    // collection 元素层级（list-element）不应被深度重罚，改为半价
    const depthPenalty = Math.floor(depth * 0.5)
    candidates.push({ value, score: 10 + typeScore + bufferScore + collectionBonus - depthPenalty })
  }
  if (Array.isArray(buffer)) {
    for (const item of buffer) collectWrapperReturnCandidates(item, candidates, seen, depth + 1)
  }
  if (Array.isArray(passIn)) {
    for (const item of passIn) collectWrapperReturnCandidates(item, candidates, seen, depth + 1)
  }
  if (value.vtype === 'union' && Array.isArray(value.value)) {
    for (const item of value.value) collectWrapperReturnCandidates(item, candidates, seen, depth + 1)
  }
  const fields = value.value && typeof value.value === 'object' ? value.value : value._field
  if (fields && typeof fields === 'object' && depth < 2) {
    for (const item of Object.values(fields)) collectWrapperReturnCandidates(item, candidates, seen, depth + 1)
  }
}

type LibFuncTagPropagationRule = {
  applyWithBody?: boolean
  func?: {
    calleeType?: string
    fsig?: string
    argNum?: number
  }
  source?: {
    type?: string
    index?: number | number[]
  }
  target?: {
    type?: string
    index?: number
    propagateToOwner?: boolean
    returnThis?: boolean
    tripleWrite?: boolean
  }
}

/**
 * 临时符号表管理器：包装原始符号表，在执行 symbolInterpretFn 期间自动拷贝符号值
 * 实现 ISymbolTableManager 接口，与 SymbolTableManager 具有相同的接口
 */
class TemporarySymbolTableManager {
  private originalSymbolTable: InstanceType<typeof SymbolTableManager> // SymbolTableManager 实例

  private tmpSymbolTableManager: InstanceType<typeof SymbolTableManager> // SymbolTableManager 实例，其 symbolMap 作为临时符号表存储，同时提供 UUID 引用管理功能

  private copiedUnits: Map<string, any> // 记录已拷贝的 Unit 对象，避免重复拷贝

  /**
   *
   * @param originalSymbolTable SymbolTableManager 实例
   */
  constructor(originalSymbolTable: InstanceType<typeof SymbolTableManager>) {
    this.originalSymbolTable = originalSymbolTable
    // 使用 tmpSymbolTableManager 的 symbolMap 作为临时符号表存储，同时使用其 UUID 引用管理功能
    this.tmpSymbolTableManager = new SymbolTableManager()
    this.copiedUnits = new Map()
  }

  /**
   * 获取临时符号表的 symbolMap（直接访问私有属性）
   * @private
   */
  private getTmpSymbolMap(): Map<string, any> {
    // 通过反射访问私有属性 symbolMap
    return (this.tmpSymbolTableManager as any).symbolMap
  }

  /**
   * 拷贝 Unit 对象（按需拷贝，只拷贝当前对象，不递归拷贝 parent 和 field 中的引用）
   * _parentRef 和 field 中的 uuid 保持原样，当真正访问时再按需拷贝
   * 直接复制内存中的属性值，不触发 getter/setter，避免循环调用
   * @param unit
   */
  private tmpTableCopyUnit(unit: any): any {
    if (!unit || typeof unit !== 'object') {
      return unit
    }

    // 如果已经拷贝过，直接返回
    if (unit.uuid && this.copiedUnits.has(unit.uuid)) {
      return this.copiedUnits.get(unit.uuid)
    }

    // 创建新对象，保持原型链
    const copiedUnit = shallowCopyValue(unit)

    // 确保 _parentRef 被正确拷贝（ValueRef 不可变，可安全共享引用）
    const originalParentRef = unit._parentRef
    if (originalParentRef && !copiedUnit._parentRef) {
      copiedUnit._parentRef = originalParentRef
    }

    // 注册到临时符号表（直接存储到 tmpSymbolTableManager 的 symbolMap）
    if (copiedUnit.uuid) {
      this.getTmpSymbolMap().set(copiedUnit.uuid, copiedUnit)
      this.copiedUnits.set(copiedUnit.uuid, copiedUnit)
    }

    return copiedUnit
  }

  /**
   * 获取 Unit 对象：如果存在于临时符号表，直接返回；否则从原始符号表获取并拷贝
   * 如果临时符号表中的符号值没有 parent，但从原始符号表查有 parent，则重新完整拷贝
   * @param uuid
   */
  get(uuid: string | null | undefined): any {
    if (!uuid) {
      return null
    }

    // 先检查临时符号表（使用 tmpSymbolTableManager 的 symbolMap）
    const tmpUnit = this.getTmpSymbolMap().get(uuid) || null
    if (tmpUnit) {
      // 检查临时符号表中的符号值是否有 parent（通过 _parentRef 判断）
      if (!tmpUnit._parentRef) {
        // 临时符号表中没有 parent，检查原始符号表中是否有
        const originalUnit = this.originalSymbolTable.get(uuid)
        if (originalUnit?._parentRef) {
          // 从临时符号表中删除旧的拷贝
          this.getTmpSymbolMap().delete(uuid)
          this.copiedUnits.delete(uuid)
          // 重新完整拷贝（包括 _parentRef）
          return this.tmpTableCopyUnit(originalUnit)
        }
      }
      return tmpUnit
    }

    // 从原始符号表获取
    const originalUnit = this.originalSymbolTable.get(uuid)
    if (!originalUnit) {
      return null
    }

    // 深拷贝并注册到临时符号表
    return this.tmpTableCopyUnit(originalUnit)
  }

  /**
   * 注册 Unit 对象到临时符号表
   * 当 UUID 变化时，自动更新所有引用该 UUID 的地方
   * @param unit
   */
  register(unit: any): string | null {
    if (!unit || typeof unit !== 'object') {
      return null
    }

    // 使用临时符号表管理器计算 UUID
    const uuid = this.tmpSymbolTableManager.calculateUUID(unit)
    if (!uuid) {
      return null
    }

    // 设置 UUID
    unit.uuid = uuid

    // 直接存储到 tmpSymbolTableManager 的 symbolMap（而不是调用 register，因为 register 会重新计算 UUID）
    if (uuid) {
      this.getTmpSymbolMap().set(uuid, unit)
    }

    return uuid
  }

  /**
   * 检查 UUID 是否存在
   * @param uuid
   */
  has(uuid: string | null | undefined): boolean {
    if (!uuid) {
      return false
    }
    return this.getTmpSymbolMap().has(uuid) || this.originalSymbolTable.has(uuid)
  }

  /**
   * 计算 UUID
   * @param unit
   * @param qidSuffix
   */
  calculateUUID(unit: any, qidSuffix?: any): string | null {
    return this.tmpSymbolTableManager.calculateUUID(unit, qidSuffix)
  }

  /**
   * 删除 Unit 对象
   * @param uuid
   */
  delete(uuid: string | null | undefined): void {
    if (uuid) {
      this.getTmpSymbolMap().delete(uuid)
    }
  }

  /**
   * 清空临时符号表
   */
  clear(): void {
    this.getTmpSymbolMap().clear()
    this.copiedUnits.clear()
  }

  /**
   * 获取临时符号表大小
   */
  size(): number {
    return this.getTmpSymbolMap().size
  }

  /**
   * 获取临时符号表
   */
  getMap(): Map<string, any> {
    return this.tmpSymbolTableManager.getMap()
  }
}

/**
 * The main AST analyzer with checker invoking
 * @param checker
 * @constructor
 */

type IteratorAnalyzerValue = {
  vtype?: string
  value?: IteratorAnalyzerValue[]
  rtype?: { type?: unknown; definiteType?: unknown; vagueType?: unknown }
  qid?: string
  uuid?: string | null
  members?: { get: (key: string) => IteratorAnalyzerValue | undefined }
  getRawValue?: () => Record<string, IteratorAnalyzerValue | string | undefined>
  cloneAlias?: () => IteratorAnalyzerValue
}

type ValueIteratorFilter = (value: IteratorAnalyzerValue | string | undefined) => boolean

type DecoratedCallInfoCarrier = Record<string, unknown> & {
  __decoratedOriginalCallInfo?: CallInfo
  value?: { value?: unknown }
}

type EstimatedInstructionNode = Record<string, unknown> & { type?: string }

type CallsiteFrame = {
  code: string
  nodeHash?: string
  loc?: unknown
}

class Analyzer extends BaseAnalyzer {
  options: any

  checkerManager: any

  enablePerformanceLogging: boolean

  lastReturnValue: any

  _thisFClos: any // 内部存储，通过 getter/setter 访问

  _entry_fclos: any // 内部存储，通过 getter/setter 访问

  // analyzeProject 启动时间戳，用于计算超时 entrypoint 重跑的时间预算
  scanStartTimestamp: number = 0

  inRange: boolean

  ainfo: Record<string, any>

  sourceCodeCache: Map<string, string[]>

  enableNestedSourceLineIsolation: boolean

  // 仅在 Python analyzer 上启用跨 addSrcLineInfo 调用 visited memo（卡点 A Step A）。
  crossCallVisitedEnabled: boolean = false

  // 分析器实例持有默认会话配置，具体阶段在执行入口重新开启边界。
  protected readonly callSummarySessions = createDefaultCallSummarySessions(Config.callSummaryStageStrategies)

  protected readonly callSummaryLanguagePolicy?: CallSummaryLanguagePolicy

  protected readonly entryPointMetrics = new EntryPointMetricsCollector()

  private readonly estimatedInstructionCountCache: WeakMap<object, number> = new WeakMap()

  _lastProcessedNode: any // 内部存储，通过 getter/setter 访问

  thisIterationTime: number

  prevIterationTime: number

  statistics: { numProcessedInstructions: number }

  entryPoints: any[]

  libFuncTagPropagationRuleArray: any[]

  context!: AnalysisContext

  libArgToThisSidBlacklistKeywords: string[]

  fileManager!: Record<string, any>

  funcSymbolTable!: Record<string, any>

  topScope: any

  astManager: any

  // 操作符号表：基于analyzer中使用this.symbolTable，基于符号值使用getSymbolTable()
  symbolTable!: ISymbolTableManager

  preprocessState: boolean | undefined

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  private getRecordProperty(value: unknown, key: string): unknown {
    return this.isRecord(value) ? value[key] : undefined
  }

  private getNodeType(value: unknown): string | undefined {
    const nodeType = this.getRecordProperty(value, 'type')
    return typeof nodeType === 'string' ? nodeType : undefined
  }

  rememberDecoratorForwardedCallInfo(target: unknown, callInfo: CallInfo): void {
    if (!this.isDecoratorCallInfoCarrier(target)) return
    const originalCallInfo = this.cloneDecoratorCallInfo(callInfo)
    target.__decoratedOriginalCallInfo = originalCallInfo
    const wrapped = target.value?.value
    if (this.isDecoratorCallInfoCarrier(wrapped)) {
      wrapped.__decoratedOriginalCallInfo = originalCallInfo
    }
  }

  private shouldUseDecoratorForwardedCallInfo(callInfo: CallInfo): boolean {
    const args = callInfo.callArgs?.args ?? []
    return args.length === 0 || args.some((arg: CallArg) => arg.kind === 'spread' || arg.kind === 'kwspread')
  }

  getDecoratorForwardedCallInfo(fclos: unknown, callInfo: CallInfo): CallInfo {
    if (!this.shouldUseDecoratorForwardedCallInfo(callInfo) || !this.isDecoratorCallInfoCarrier(fclos)) {
      return callInfo
    }
    const originalCallInfo = fclos.__decoratedOriginalCallInfo
    if (!originalCallInfo) return callInfo
    return this.mergeDecoratorForwardedKeywords(this.cloneDecoratorCallInfo(originalCallInfo), callInfo)
  }

  private mergeDecoratorForwardedKeywords(restoredCallInfo: CallInfo, forwardedCallInfo: CallInfo): CallInfo {
    const restoredArgs = restoredCallInfo.callArgs?.args
    const forwardedArgs = forwardedCallInfo.callArgs?.args ?? []
    if (!restoredArgs) return restoredCallInfo
    for (const arg of forwardedArgs) {
      if (arg.kind === 'keyword' && arg.name) {
        restoredArgs.push({ ...arg })
      } else if (arg.kind === 'kwspread') {
        for (const [name, value] of this.resolveKwSpreadEntries(arg.value)) {
          restoredArgs.push({ index: arg.index, value, name, kind: 'keyword' })
        }
      }
    }
    return restoredCallInfo
  }

  private isDecoratorCallInfoCarrier(value: unknown): value is DecoratedCallInfoCarrier {
    return this.isRecord(value)
  }

  private cloneDecoratorCallInfo(callInfo: CallInfo): CallInfo {
    return {
      callArgs: callInfo.callArgs
        ? {
            receiver: callInfo.callArgs.receiver,
            args: callInfo.callArgs.args.map((arg: CallArg) => ({ ...arg })),
          }
        : undefined,
      callsiteNode: callInfo.callsiteNode,
    }
  }

  private estimateInstructionCount(node: unknown, depth: number = 0): number {
    if (!node || typeof node !== 'object') return 0
    const record = node as EstimatedInstructionNode
    const cached = this.estimatedInstructionCountCache.get(record)
    if (cached !== undefined) return cached
    if (depth >= 12) return record.type ? 1 : 0

    let count = record.type ? 1 : 0
    for (const [key, value] of Object.entries(record)) {
      if (key === 'parent' || key === 'loc' || key === '_meta') continue
      if (Array.isArray(value)) {
        for (const child of value) {
          count += this.estimateInstructionCount(child, depth + 1)
        }
      } else if (value && typeof value === 'object') {
        count += this.estimateInstructionCount(value, depth + 1)
      }
    }
    // 估算只用于日志，缓存避免 summary hit 路径反复递归同一函数体。
    this.estimatedInstructionCountCache.set(record, count)
    return count
  }

  private estimateFunctionBodyInstructionCount(fclos: unknown): number {
    const fdef = this.getRecordProperty(this.getRecordProperty(fclos, 'ast'), 'fdef')
    const body = this.getRecordProperty(fdef, 'body')
    return this.estimateInstructionCount(body)
  }

  private getCallReturnUsed(node: unknown): boolean | 'unknown' {
    const parent = this.getRecordProperty(node, 'parent')
    if (!this.isRecord(parent)) return 'unknown'

    const parentType = this.getNodeType(parent)
    if (parentType === 'MemberAccess' && this.getRecordProperty(parent, 'object') === node) return true
    if (parentType === 'AssignmentExpression' && this.getRecordProperty(parent, 'right') === node) return true
    if (parentType === 'VariableDeclaration' && this.getRecordProperty(parent, 'init') === node) return true
    if (parentType === 'ReturnStatement' && this.getRecordProperty(parent, 'argument') === node) return true
    if (parentType === 'ExpressionStatement') return false
    if (parentType === 'ScopedStatement' || parentType === 'CompileUnit') return false
    return 'unknown'
  }

  private getPrettyRtype(value: unknown): string | null {
    if (!value) return null
    try {
      return AstUtil.prettyPrintAST(value)
    } catch (_error) {
      if (this.isRecord(value)) {
        const definiteType = this.getRecordProperty(value, 'definiteType')
        if (definiteType && definiteType !== value) return this.getPrettyRtype(definiteType)
        const type = this.getNodeType(value)
        if (type) return type
      }
      return String(value)
    }
  }

  private getLibCallDiagnosticName(fclos: unknown): string {
    const qid = this.getRecordProperty(fclos, 'qid')
    if (typeof qid === 'string' && qid.length > 0) return qid
    const sid = this.getRecordProperty(fclos, 'sid')
    if (typeof sid === 'string' && sid.length > 0) return sid
    return 'unknown'
  }

  private getLibCallSemanticClass(calleeName: string): string {
    const lowerName = calleeName.toLowerCase()
    if (/\.(len|cap)$/.test(calleeName) || /(^|\.)len$/.test(calleeName)) return 'noise'
    if (lowerName.includes('log') || lowerName.includes('.debug') || lowerName.includes('.error')) return 'noise'
    if (/\.(exec|query|post|json|do|run)$/.test(calleeName) || lowerName.includes('net/http.post')) return 'sink_like'
    if (/\.(write|encode|bind|scan)$/.test(calleeName)) return 'out_receiver'
    if (/\.(append|make)$/.test(calleeName)) return 'container'
    if (
      lowerName.includes('gorm.io/gorm') ||
      lowerName.includes('k8s.io/client-go') ||
      calleeName.includes('CoreV1') ||
      calleeName.includes('RESTClient') ||
      calleeName.includes('Resource') ||
      calleeName.includes('Namespace') ||
      calleeName.includes('Pods') ||
      calleeName.includes('BuildConfigFromFlags') ||
      calleeName.includes('NewForConfig')
    ) {
      return 'receiver_rtype'
    }
    if (
      calleeName.includes('fmt.Sprintf') ||
      calleeName.includes('fmt.Errorf') ||
      calleeName.includes('strings.Split') ||
      calleeName.includes('strings.Contains') ||
      calleeName.includes('strings.Replace') ||
      calleeName.includes('strconv.Atoi') ||
      calleeName.includes('strconv.Itoa') ||
      calleeName.includes('strconv.FormatInt') ||
      calleeName.includes('encoding/json.Marshal') ||
      calleeName.includes('json-iterator/go.Marshal') ||
      calleeName.includes('gjson.Get') ||
      calleeName.includes('net/url.ParseQuery')
    ) {
      return 'arg_to_ret_likely'
    }
    return 'manual'
  }

  private getLibCallSemanticClassCode(semanticClass: string): number {
    const codes: Record<string, number> = {
      arg_to_ret_likely: 1,
      out_receiver: 2,
      container: 3,
      sink_like: 4,
      receiver_rtype: 5,
      noise: 6,
      manual: 7,
    }
    return codes[semanticClass] ?? 0
  }

  private buildLibCallDiagnosticsSnapshot(node: unknown, fclos: unknown, argCount: number) {
    const callee = this.getRecordProperty(node, 'callee')
    const receiver = this.getNodeType(callee) === 'MemberAccess' ? this.getRecordProperty(callee, 'object') : undefined
    const fclosRtype = this.getRecordProperty(fclos, 'rtype')
    const fclosRtypePresent = fclosRtype !== undefined && fclosRtype !== null
    const fclosObject = this.getRecordProperty(fclos, 'object')
    const objectRtype = this.getRecordProperty(fclosObject, 'rtype')
    const receiverRtype = this.getRecordProperty(receiver, 'rtype') ?? objectRtype
    const calleeName = this.getLibCallDiagnosticName(fclos)
    const semanticClass = this.getLibCallSemanticClass(calleeName)
    const returnUsed = this.getCallReturnUsed(node)
    const hasReceiver = receiver !== undefined || fclosObject !== undefined
    const receiverRtypePresent = receiverRtype !== undefined && receiverRtype !== null
    return {
      arg_count: argCount,
      return_used: returnUsed,
      has_receiver: hasReceiver,
      call_kind: hasReceiver ? 'member_call' : 'function_call',
      receiver_rtype_present: receiverRtypePresent,
      receiver_rtype: this.getPrettyRtype(receiverRtype),
      fclos_rtype_present: fclosRtypePresent,
      fclos_rtype_pretty: this.getPrettyRtype(fclosRtype),
      semantic_class: semanticClass,
      semantic_class_code: this.getLibCallSemanticClassCode(semanticClass),
      project: this.options?.maindir ?? null,
    }
  }

  private emitLibCallDiagnostics(
    logKey: 'lib_call_matched_rule' | 'lib_call_no_rule',
    node: unknown,
    fclos: unknown,
    snapshot: ReturnType<Analyzer['buildLibCallDiagnosticsSnapshot']>
  ): void {
    const loc = this.getRecordProperty(node, 'loc')
    const start = this.getRecordProperty(loc, 'start')
    const line = this.getRecordProperty(start, 'line')
    logDiagnostics(logKey, {
      string1: this.getLibCallDiagnosticName(fclos),
      string2: typeof line === 'number' ? `line:${line}` : null,
      string3: JSON.stringify(snapshot),
      number1: snapshot.arg_count,
      number2: snapshot.semantic_class_code,
      number3: snapshot.fclos_rtype_present ? 1 : 0,
    })
  }

  performanceTracker: import('../../../util/performance-tracker').IPerformanceTracker

  backUpSymbolTable: any

  tmpSymbolTable: any

  isTmpSymbolTableOpen: boolean

  /**
   *
   * @param checkerManager
   * @param options
   */
  constructor(checkerManager: any, options?: any) {
    super()
    this.options = options || {}
    this.isTmpSymbolTableOpen = false
    this.checkerManager = checkerManager // 关联的检查器管理器
    this.performanceTracker = performanceTracker // 使用单例
    this.enablePerformanceLogging = this.options.enablePerformanceLogging || false // 默认关闭
    // 启用详细指令统计（如果启用了性能日志，输出 top 信息）
    this.performanceTracker.setEnableDetailedInstructionStats(this.enablePerformanceLogging)
    this.lastReturnValue = null // 记录最后一次函数调用的返回值
    this._thisFClos = null // 当前分析函数的闭包（存储 UUID）
    this._entry_fclos = null // 最外层函数的闭包（存储 UUID）
    this.inRange = false // 范围语句标志
    this.ainfo = {} // 整个分析过程中的信息
    this.sourceCodeCache = new Map<string, string[]>() // 缓存的源代码（文件路径 -> 代码行数组）
    this.enableNestedSourceLineIsolation = false
    // 设置全局 analyzer 引用，使 source-line.ts 可以访问 sourceCodeCache
    SourceLine.setGlobalAnalyzer(this)
    this._lastProcessedNode = null // 最后处理的节点（存储 UUID 或 AST 节点）
    // 超时控制
    this.thisIterationTime = 0
    this.prevIterationTime = 0
    this.statistics = {
      numProcessedInstructions: 0,
    }

    this.initValTreeStruct()
    this.entryPoints = []
    this.libFuncTagPropagationRuleArray = this.loadLibFuncTagPropagationRule()
    this.libArgToThisSidBlacklistKeywords = this.loadLibArgToThisSidBlacklistKeywords()
  }

  /**
   * thisFClos getter: 如果存储的是 UUID，从符号表中获取对象
   */
  get thisFClos() {
    if (this._thisFClos === null || this._thisFClos === undefined) {
      return null
    }
    // 如果是 UUID，从符号表中获取对象
    if (typeof this._thisFClos === 'string' && this._thisFClos.startsWith('symuuid_')) {
      const unit = this.symbolTable.get(this._thisFClos)
      return unit || null
    }
    // 如果不是 UUID，直接返回（向后兼容）
    return this._thisFClos
  }

  /**
   * thisFClos setter: 如果值是符号值对象，转换为 UUID 存储
   */
  set thisFClos(val) {
    if (val === null || val === undefined) {
      this._thisFClos = null
      return
    }
    // 如果是符号值对象，转换为 UUID 存储
    if (val && typeof val === 'object' && val.vtype && val.qid) {
      const uuid = this.symbolTable.register(val)
      this._thisFClos = uuid
    } else {
      // 如果不是符号值对象，直接存储（向后兼容）
      this._thisFClos = val
    }
  }

  /**
   * entry_fclos getter: 如果存储的是 UUID，从符号表中获取对象
   */
  get entry_fclos() {
    if (this._entry_fclos === null || this._entry_fclos === undefined) {
      return null
    }
    // 如果是 UUID，从符号表中获取对象
    if (typeof this._entry_fclos === 'string' && this._entry_fclos.startsWith('symuuid_')) {
      const unit = this.symbolTable.get(this._entry_fclos)
      return unit || null
    }
    // 如果不是 UUID，直接返回（向后兼容）
    return this._entry_fclos
  }

  /**
   * entry_fclos setter: 如果值是符号值对象，转换为 UUID 存储
   */
  set entry_fclos(val) {
    if (val === null || val === undefined) {
      this._entry_fclos = null
      return
    }
    // 如果是符号值对象，转换为 UUID 存储
    if (val && typeof val === 'object' && val.vtype && val.qid) {
      const uuid = this.symbolTable.register(val)
      this._entry_fclos = uuid
    } else {
      // 如果不是符号值对象，直接存储（向后兼容）
      this._entry_fclos = val
    }
  }

  /**
   * lastProcessedNode getter: 如果存储的是 nodehash，从 AST 管理器中获取 AST 节点
   */
  get lastProcessedNode() {
    if (this._lastProcessedNode === null || this._lastProcessedNode === undefined) {
      return null
    }
    // 如果是字符串，尝试从 AST 管理器中获取 AST 节点（可能是 nodehash）
    if (typeof this._lastProcessedNode === 'string') {
      const astNode = this.astManager?.get(this._lastProcessedNode)
      if (astNode) {
        return astNode
      }
      // 如果获取不到，可能是其他字符串，直接返回（向后兼容）
      return this._lastProcessedNode
    }
    // 如果不是字符串，直接返回（向后兼容）
    return this._lastProcessedNode
  }

  /**
   * lastProcessedNode setter: 如果值是 AST 节点，转换为 nodehash 存储
   */
  set lastProcessedNode(val) {
    if (val === null || val === undefined) {
      this._lastProcessedNode = null
      return
    }
    // 如果是 AST 节点（有 type 属性），注册并存储 nodehash
    if (val && typeof val === 'object' && val.type && this.astManager) {
      const nodehash = this.astManager.register(val)
      this._lastProcessedNode = nodehash
    } else {
      // 如果不是 AST 节点，直接存储（向后兼容）
      this._lastProcessedNode = val
    }
  }

  /**
   * return checkerManager
   */
  getCheckerManager() {
    return this.checkerManager
  }

  /**
   * 基于位置和类型生成指令的唯一键
   * @param node - 正在处理的AST节点
   * @param instructionType - 指令类型
   * @returns 唯一键字符串
   */
  getLocationKey(node: any, instructionType: string): string {
    if (!node || !node.loc) {
      return `${instructionType}:unknown_location`
    }

    let sourceFile = node.loc.sourcefile || 'unknown_file'

    // 如果存在项目路径前缀，则移除
    if (this.options && this.options.maindir) {
      const projectPath = this.options.maindir
      if (sourceFile.startsWith(projectPath)) {
        sourceFile = sourceFile.substring(projectPath.length)
        // 移除可能存在的开头斜杠
        if (sourceFile.startsWith('/')) {
          sourceFile = sourceFile.substring(1)
        }
      }
    }

    const startLine = node.loc.start?.line || 0
    const startColumn = node.loc.start?.column || 0
    const endLine = node.loc.end?.line || 0
    const endColumn = node.loc.end?.column || 0

    return `${instructionType}:${sourceFile}:${startLine}:${startColumn}:${endLine}:${endColumn}`
  }

  /**
   *
   * 初始化符号值树
   */
  initValTreeStruct() {
    this.astManager = new ASTManager()
    this.symbolTable = new SymbolTableManager()
    setGlobalASTManager(this.astManager)
    setGlobalSymbolTable(this.symbolTable)

    const moduleManager = new Scoped('<global>', {
      sid: 'moduleManager',
    })

    const packageManager = new PackageValue('<global>', {
      parent: null,
      sid: 'packageManager',
      name: 'packageManager',
    })

    this.fileManager = {}

    const funcSymbolTableTarget: Record<string, any> = {}
    const { symbolTable } = this
    this.funcSymbolTable = new Proxy(funcSymbolTableTarget, {
      get: (target, prop: string | symbol) => {
        if (typeof prop === 'symbol') {
          return (target as any)[prop]
        }
        if (prop === 'toString' || prop === 'valueOf' || prop === 'constructor') {
          return (target as any)[prop]
        }
        const value = target[prop]
        if (value && typeof value === 'string' && value.startsWith('symuuid_')) {
          const unit = symbolTable.get(value)
          return unit || null
        }
        return value
      },
      set: (target, prop: string, value: any) => {
        if (value && typeof value === 'object' && value.vtype && value.qid) {
          const uuid = symbolTable.register(value)
          target[prop] = uuid
          ;(symbolTable as any).addFuncSymbolTableRef?.(uuid, prop)
        } else {
          target[prop] = value
        }
        return true
      },
      deleteProperty: (target, prop: string) => {
        delete target[prop]
        return true
      },
      ownKeys: (target) => {
        return Reflect.ownKeys(target)
      },
      has: (target, prop) => {
        return prop in target
      },
    }) as Record<string, any>

    this.topScope = new Scoped('', {
      sid: '<global>',
      qid: '<global>',
      parent: null,
    })

    this.context = new AnalysisContext()
    this.context.ast = this.astManager
    this.context.symbols = this.symbolTable
    this.context.modules = moduleManager
    this.context.packages = packageManager
    this.context.files = this.fileManager
    this.context.funcs = this.funcSymbolTable
    this.topScope.context = this.context

    moduleManager.parent = this.topScope
    packageManager.parent = this.topScope

    this.thisFClos = this.topScope
  }

  /**
   * 切换到临时符号表，在执行 symbolInterpretFn 期间自动拷贝符号值
   */
  protected switchToTemporarySymbolTable(): void {
    // 确保当前 symbolTable 是 SymbolTableManager，不是 TemporarySymbolTableManager
    // 如果已经是 TemporarySymbolTableManager，说明存在嵌套调用，这是不支持的
    if (this.symbolTable instanceof TemporarySymbolTableManager) {
      throw new Error(
        'Nested TemporarySymbolTableManager is not supported. symbolInterpretFn should not be called recursively.'
      )
    }

    // 创建临时符号表，在执行 symbolInterpretFn 期间自动拷贝符号值
    const tmpSymbolTable = new TemporarySymbolTableManager(this.symbolTable as InstanceType<typeof SymbolTableManager>)
    const originalGlobalSymbolTable = getGlobalSymbolTable()
    const originalAnalyzerSymbolTable = this.symbolTable
    const originalTopScopeSymbolTable = (this.topScope?.context?.symbols as ISymbolTableManager | null) || null

    setGlobalSymbolTable(tmpSymbolTable)
    this.symbolTable = tmpSymbolTable
    if (this.topScope?.context) {
      this.topScope.context.symbols = tmpSymbolTable
    }
    this.isTmpSymbolTableOpen = true
    this.tmpSymbolTable = tmpSymbolTable
    this.backUpSymbolTable = {
      originalGlobalSymbolTable,
      originalAnalyzerSymbolTable,
      originalTopScopeSymbolTable,
    }
  }

  /**
   * 恢复原始符号表引用，并清理临时符号表
   */
  protected restoreSymbolTable(): void {
    // 恢复所有符号表引用
    setGlobalSymbolTable(this.backUpSymbolTable.originalGlobalSymbolTable)
    this.symbolTable = this.backUpSymbolTable.originalAnalyzerSymbolTable
    if (this.topScope?.context) {
      this.topScope.context.symbols = this.backUpSymbolTable.originalTopScopeSymbolTable
    }
    this.isTmpSymbolTableOpen = false
    // 清理临时符号表
    this.tmpSymbolTable.clear()
  }

  /**
   * 执行分析流程的通用方法，统一处理性能追踪
   * @param initAfterUsingCache
   * @param preProcessFn - 执行同步 preProcess 的函数（必须返回 void，不能返回 Promise）
   * @returns {Promise<any>} 分析结果
   */
  private async executeAnalysisPipeline(
    initAfterUsingCache: () => void,
    preProcessFn: () => void | Promise<void>
  ): Promise<any> {
    // 开始整体性能追踪
    this.performanceTracker.start()
    this.performanceTracker.start('preProcess')

    Rules.setPreprocessReady(false)
    // 启用指令级别的性能监控（如果已启用性能日志）
    this.performanceTracker.startInstructionMonitor()

    // 尝试加载缓存
    let cacheLoaded = false
    let shouldPreProcess = true
    if (Config.loadContextEnvironment) {
      shouldPreProcess = false
      this.performanceTracker.start('loadContextEnvironment')
      try {
        // 根据源路径查找缓存文件夹（基于 repoName 和 hashPrefix）
        const sourcePath = this.options?.maindir || Config.prefixPath || process.cwd()
        cacheLoaded = loadAnalyzerCache(this, Config.loadContextEnvironmentId, sourcePath)
        if (cacheLoaded) {
          logger.info('Analyzer cache loaded successfully')
        }
        if (cacheLoaded && Config.maindirPrefix) {
          const name = Config.maindirPrefix.split('/').pop() || Config.maindirPrefix
          if (!Config.loadContextEnvironmentId || !Config.loadContextEnvironmentId.startsWith(`${name}_`)) {
            shouldPreProcess = true
          }
        }
        if (!shouldPreProcess && typeof initAfterUsingCache === 'function') {
          initAfterUsingCache()
        }
      } catch (err: any) {
        logger.warn(`Failed to load analyzer cache: ${err.message}`)
      }
      this.performanceTracker.end('loadContextEnvironment')
    }

    if (shouldPreProcess) {
      const result = preProcessFn()
      if (result instanceof Promise) {
        await result
      }
    }

    this.performanceTracker.end('preProcess')

    // 保存缓存（在 startAnalyze 之前）
    if (Config.saveContextEnvironment || Config.miniSaveContextEnvironment) {
      try {
        this.performanceTracker.start('saveContextEnvironment')
        const sourcePath = this.options?.maindir
        const cacheId = generateCacheId(sourcePath)
        saveAnalyzerCache(this, cacheId)
        logger.info('Analyzer cache saved successfully')
        // 保存完成后结束分析
        this.performanceTracker.end('saveContextEnvironment')
        return
      } catch (err: any) {
        logger.warn(`Failed to save analyzer cache: ${err.message}`)
      }
    }

    this.performanceTracker.start('startAnalyze')

    this.startAnalyze()

    this.performanceTracker.end('startAnalyze')

    if (Config.incrementalRuntime?.cacheDir) {
      const { applyIncrementalEntrypointAllowlist } = loadIncrementalManager()
      this.entryPoints = applyIncrementalEntrypointAllowlist(
        this.entryPoints,
        Config.incrementalRuntime,
        this.options?.maindir || Config.maindir || '',
        Config.reportDir
      )
    }

    // dumpEntrypoint：收集完入口点后输出 entrypoints.json
    if (Config.dumpEntrypoint && Config.reportDir) {
      const fs = require('fs')
      const path = require('path')
      const sourceRoot = this.options?.maindir || Config.maindirPrefix || ''
      const entryPointData = {
        entryPoints: (this.entryPoints || []).map((ep: any) => {
          const loc = ep.entryPointSymVal?.ast?.node?.loc
          const location = loc
            ? {
                start: loc.start,
                end: loc.end,
                sourcefile:
                  loc.sourcefile && sourceRoot && loc.sourcefile.startsWith(sourceRoot)
                    ? loc.sourcefile.substring(sourceRoot.length)
                    : loc.sourcefile || '',
              }
            : null
          return {
            filePath: ep.filePath || '',
            functionName: ep.functionName || '',
            type: ep.type || '',
            attribute: ep.attribute || '',
            funcLocStart: ep.funcLocStart ?? loc?.start?.line ?? 0,
            funcLocEnd: ep.funcLocEnd ?? loc?.end?.line ?? 0,
            location,
          }
        }),
      }
      const outPath = path.join(Config.reportDir, 'entrypoints.json')
      fs.writeFileSync(outPath, JSON.stringify(entryPointData, null, 2))
      logger.info(`EntryPoints dumped to ${outPath} (${entryPointData.entryPoints.length} entries)`)
    }

    // dumpEntrypoint 模式跳过符号解释，但保留 endAnalyze 以兼容 dumpAllCG 等输出
    if (!Config.dumpEntrypoint) {
      Rules.setPreprocessReady(true)

      this.performanceTracker.start('symbolInterpret')

      this.beginCallSummarySession(this.callSummarySessions[1])
      // 切换到临时符号表
      this.switchToTemporarySymbolTable()

      try {
        await this.symbolInterpret()
      } finally {
        this.restoreSymbolTable()
        this.callSummarySessions[1].finish()
      }
      this.performanceTracker.end('symbolInterpret')
    }
    this.endAnalyze()

    // 记录性能数据并输出摘要（会自动输出指令统计）
    performanceTracker.collectAnalysisData(this)

    return this.recordCheckerFindings()
  }

  /**
   * 分析单个文件
   * @param source - 源代码内容
   * @param fileName - 文件名
   * @returns 分析结果
   */
  async analyzeSingleFile(source: any, fileName: any) {
    try {
      // 单文件就不要用缓存了
      Config.loadContextEnvironment = false
      Config.saveContextEnvironment = false
      Config.miniSaveContextEnvironment = false
      if (typeof this.preProcess4SingleFile === 'function' && typeof this.symbolInterpret === 'function') {
        return await this.executeAnalysisPipeline(
          () => {},
          () => this.preProcess4SingleFile(source, fileName)
        )
      }
      logger.info(`this analyzer has not support analyzeSingleFile yet`)
      return this.recordCheckerFindings()
    } catch (e) {
      handleException(e, 'Error occurred in analyzer analyzeSingleFile', 'Error occurred in analyzer analyzeSingleFile')
      return false
    }
  }

  /**
   * 分析项目
   * @param processingDir - 要分析的项目目录
   * @returns 分析结果
   */
  async analyzeProject(processingDir: any) {
    this.scanStartTimestamp = Date.now()
    try {
      if (typeof this.preProcess === 'function' && typeof this.symbolInterpret === 'function') {
        if (typeof this.initAfterUsingCache !== 'function') {
          this.initAfterUsingCache = () => {}
        }
        return await this.executeAnalysisPipeline(
          () => this.initAfterUsingCache(),
          () => this.preProcess(processingDir)
        )
      }
      return this.recordCheckerFindings()
    } catch (e: any) {
      const errorMsg = e?.message || String(e)
      const errorStack = e?.stack || ''
      handleException(
        e,
        `Error occurred in analyzer analyzeProject: ${errorMsg}\n${errorStack}`,
        `Error occurred in analyzer analyzeProject: ${errorMsg}`
      )
      return false
    }
  }

  /**
   *
   */
  recordCheckerFindings() {
    const resultManager = this.checkerManager.getResultManager()
    if (resultManager) {
      return resultManager.getFindings()
    }
    return null
  }


  getEntryPointMetrics(): EntryPointMetric[] {
    return this.entryPointMetrics.snapshot()
  }

  protected recordEntryPointLoopMetric(
    entryPoint: unknown,
    metricStartTime: number,
    findingsBefore: number,
    skipped: boolean,
    skipReason: string | undefined,
    overloadCount: number
  ): void {
    const durationMs = Date.now() - metricStartTime
    const findingsAfter = this.countFindings()
    const findingDelta = findingsAfter - findingsBefore
    const diagnostics = buildEntryPointMetricDiagnostics(entryPoint, constValue.ENGIN_START_FUNCALL, constValue.ENGIN_START_FILE_BEGIN)
    this.entryPointMetrics.record({
      type: getEntryPointMetricType(entryPoint, constValue.ENGIN_START_FILE_BEGIN),
      entryPoint,
      durationMs,
      skipped,
      skipReason,
      overloadCount: skipped ? 0 : overloadCount,
      findingDelta,
      diagnostics,
    })
    // skip 属 runtime EP 去重的内部细节，metrics 已在上方记录，不再逐条刷 stdout
    if (skipped) {
      return
    }
  }

  protected countFindings(): number {
    const findings = this.recordCheckerFindings()
    if (!findings) return 0
    let total = 0
    for (const key of Object.keys(findings)) {
      const findingList = findings[key]
      if (Array.isArray(findingList)) total += findingList.length
    }
    return total
  }

  protected markEntryPointForAnalysis(
    entryPoint: unknown,
    analyzedEntryPointKeys: Set<string>
  ): { analysisKey: string; skipped: boolean; skipReason?: string } {
    return markEntryPointForAnalysis(
      entryPoint,
      analyzedEntryPointKeys,
      constValue.ENGIN_START_FUNCALL,
      constValue.ENGIN_START_FILE_BEGIN
    )
  }

  protected buildEntryPointAnalysisKey(entryPoint: unknown): string {
    return buildEntryPointAnalysisKey(entryPoint, constValue.ENGIN_START_FUNCALL, constValue.ENGIN_START_FILE_BEGIN)
  }

  /**
   *
   */
  initTopScope() {}

  /**
   *
   * @param uast
   * @param fileName
   */
  initModuleScope(uast: any, fileName: any) {}

  /**
   *
   */
  startAnalyze() {
    if (this.checkerManager && this.checkerManager.checkAtStartOfAnalyze) {
      this.checkerManager.checkAtStartOfAnalyze(this, null, null, null, null)
    }
  }

  /**
   *
   */
  endAnalyze() {
    if (this.checkerManager && this.checkerManager.checkAtEndOfAnalyze) {
      this.checkerManager.checkAtEndOfAnalyze(this, null, null, null, null)
    }
  }

  /**
   *
   * @param instructionType
   */
  loadInstruction(instructionType: any) {
    /**
     *
     * @param obj
     */
    function load(obj: any) {
      if (!obj) return
      // 使用 hasOwnProperty 方法检查 obj 是否拥有名为 instructionType 的属性。如果有，返回该属性的值
      if (obj.hasOwnProperty(instructionType)) {
        return obj[instructionType]
      }
      // 如果当前对象没有该属性，则调用 Object.getPrototypeOf 获取 obj 的原型对象
      // 并在该原型对象上递归调用 load 函数。
      return load(Object.getPrototypeOf(obj))
    }

    return load(this)
  }

  // prePostFlag
  /**
   *
   * @param scope
   * @param node
   * @param state
   * @param prePostFlag
   */
  processInstruction(scope: any, node: any, state: any, prePostFlag?: any): any {
    if (!node || !scope) {
      return new UndefinedValue()
    }
    if (node.vtype) {
      return node
    }
    // 单入口内存护栏：在指令边界提前退出当前入口（与 Java 超时 hook 同位点）
    if (this.shouldAbortExecutionForMemory(state)) {
      return new UndefinedValue()
    }
    this.lastProcessedNode = node

    if (scope.vtype === 'union') {
      const res = new UnionValue(
        undefined,
        undefined,
        `${scope.qid}.<union@PI:${node.loc?.start?.line}:${node.loc?.start?.column}>`,
        node
      )
      for (const scp of scope.value) {
        const val = this.processInstruction(scp, node, state, prePostFlag)
        res.appendValue(val)
      }
      return res
    }

    if (Array.isArray(node)) {
      let res
      for (const s of node) {
        res = this.processInstruction(scope, s, state, prePostFlag)
      }
      return res
    }
    const action = prePostFlag ? `${prePostFlag}Process` : 'process'
    const inst = this.loadInstruction(action + node.type)
    if (!inst) {
      if (Config.saveContextEnvironment || Config.miniSaveContextEnvironment) {
        return new SymbolValue(scope.qid, { sid: '<unknownProcessTypeNode>' })
      }
      return new SymbolValue(scope.qid, { ...node, sid: '<unknownProcessTypeNode>' })
    }
    // TODO 添加判断，后续指令是否是跟在return或throw后且在同一个scope内无法执行的指令 4+
    this.statistics.numProcessedInstructions++
    if (this.callSummarySessions[1].keys) {
      this.callSummarySessions[1].instructionTotal++
    }

    // 如果启用了性能日志（enablePerformanceLogging），会自动记录指令执行时间和次数
    this.performanceTracker.startInstruction()

    let val
    try {
      val = inst.call(this, scope, node, state)
    } catch (e) {
      const locInfo = node.loc
        ? `${node.loc.sourcefile}::${node.loc.start?.line}_${node.loc.end?.line}`
        : '<unknown location>'
      handleException(e, '', `process${node.type} error! loc is${locInfo}`)
      val = new UndefinedValue()
    }

    // 性能追踪：结束指令执行并更新统计（内部会检查是否启用）
    this.performanceTracker.endInstructionAndUpdateStats(node, (node: any, instructionType: string) =>
      this.getLocationKey(node, instructionType)
    )
    if (!this.preprocessState && val?.__preprocess) {
      delete val.__preprocess
      this.processPre(val, state)
    }
    if (this.checkerManager && this.checkerManager.checkAtEndOfNode)
      this.checkerManager.checkAtEndOfNode(this, scope, node, state, { val })
    return val
  }

  /**
   *
   * @param val
   * @param state
   */
  processPre(val: any, state: any) {
    switch (val?.vtype) {
      case 'class':
        this.processClassDefinition(val.parent, val.ast.cdef, state)
        break
      case 'fclos':
        this.processFunctionDefinition(val.parent, val.ast.fdef, state)
        break
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processNoop(scope: any, node: any, state: any) {
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processLiteral(scope: ScopeType, node: Literal, state: State): SymbolValueType {
    return new PrimitiveValue(
      scope.qid,
      primitiveToString(node.value),
      node.value,
      node.literalType,
      node.type,
      node.loc,
      node
    )
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processIdentifier(scope: ScopeType, node: Identifier, state: State): SymbolValueType {
    if (node.name === 'undefined') {
      return new PrimitiveValue(scope.qid, 'undefined', undefined, null, 'Literal')
    }
    let res
    if (state?.findIdInCurScope) {
      res = this.getMemberValueInCurrentScope(scope, node, state)
    } else {
      res = this.getMemberValue(scope, node, state)
    }
    if (res.vtype === 'fclos') {
      res._this = this.topScope
    }
    if (res.vtype === 'undefine' || res.vtype === 'uninitialized' || res.vtype === 'symbol') {
      res.sid = node.name
    }
    const info = { res }
    this.checkerManager.checkAtIdentifier(this, scope, node, state, info)
    if (isDataflowInstrumentationEnabled()) {
      const { tryGetExistingNodeId, updateNodeMetadata } = require('./dataflow-edge-stats')
      const nodeId = tryGetExistingNodeId(info.res)
      if (nodeId !== null) updateNodeMetadata(nodeId, { astName: node.name })
    }
    return info.res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCompileUnit(scope: ScopeType, node: CompileUnit, state: State): Value {
    if (this.checkerManager && this.checkerManager.checkAtCompileUnit) {
      this.checkerManager.checkAtCompileUnit(this, scope, node, state, {
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
      })
    }

    // node.body.forEach(n => this.processInstruction(scope, n, state));
    this.preprocessState = true
    node.body
      .filter((n: any) => needCompileFirst(n.type))
      .forEach((n: any) => this.processInstruction(scope, n, state, 'pre'))
    delete this.preprocessState
    // node.body.filter(n => !needCompileFirst(n.type)).forEach(n => this.processInstruction(scope, n, state));
    // node.body.filter(n => needCompileFirst(n.type)).forEach(n => this.processInstruction(scope, n, state));
    // process Compile First twice in order to handle elements which can't be correctly compiled once first
    node.body.forEach((n: any) => this.processInstruction(scope, n, state))
    return new VoidValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processExportStatement(scope: ScopeType, node: ExportStatement, state: State): VoidValueType {
    // locate exports
    const exports = this.getExportsScope(scope)
    const val = this.processInstruction(scope, node.argument, state)
    if (Array.isArray(exports)) {
      exports.forEach((exp) => this.saveVarInCurrentScope(exp, node.alias, val, state))
    } else if (exports) {
      this.saveVarInCurrentScope(exports, node.alias, val, state)
    }
    return new VoidValue()
  }

  /**
   *
   * @param lstate
   * @param rstate
   * @param state
   * @param test
   */
  processLRScopeInternal(lstate: any, rstate: any, state: any, test: any) {
    if (test) lstate.pcond.push(test)
    const { binfo } = state
    lstate.binfo = _.clone(binfo)
    if (test) {
      const rtest = _.clone(test)
      rtest.is_neg = true
      rstate.pcond.push(rtest)
    }
    rstate.binfo = _.clone(binfo)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processIfStatement(scope: ScopeType, node: IfStatement, state: State): VoidValueType {
    /*
      { test,
        consequent,
        alternative
      }
      */
    const test = this.processInstruction(scope, node.test, state)
    if (this.checkerManager && this.checkerManager.checkAtIfCondition) {
      this.checkerManager.checkAtIfCondition(this, scope, node.test, state, {
        nvalue: test,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
      })
    }

    let b: string = 'U' // abstraction.evaluate(test, state.pcond);
    if (test?.type === 'Literal' && test.value === true) {
      b = 'T'
    } else if (test?.type === 'Literal' && test.value === false) {
      b = 'F'
    }

    switch (b) {
      case 'T':
        this.processInstruction(scope, node.consequent, state)
        break
      case 'F':
        if (node.alternative) this.processInstruction(scope, node.alternative, state)
        break
      default: {
        if (node.alternative && node.alternative.type != 'Noop') {
          // two branches

          const rscope = MemState.cloneScope(scope, state)
          const substates = MemState.forkStates(state)
          const lstate = substates[0]
          const rstate = substates[1]
          this.processLRScopeInternal(lstate, rstate, state, test)

          this.processInstruction(scope, node.consequent, lstate)
          this.processInstruction(rscope, node.alternative, rstate)

          MemState.unionValues([scope, rscope], substates, state.brs)

          // union branch related information
          this.postBranchProcessing(node, test, state, lstate, rstate)
        } else {
          // only one branch
          const substates = MemState.forkStates(state, 1)
          const lstate = substates[0]
          const { pcond } = state
          lstate.pcond = pcond.slice(0)
          lstate.parent = state
          if (test) lstate.pcond.push(test)
          lstate.binfo = _.clone(state.binfo)

          this.processInstruction(scope, node.consequent, lstate)

          MemState.unionValues([scope, scope], substates, lstate.brs)

          this.postBranchProcessing(node, test, state, lstate)
        }
      }
    }
    return new VoidValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSwitchStatement(scope: ScopeType, node: SwitchStatement, state: State): VoidValueType {
    // cases: [ SwitchCase ]
    const test = this.processInstruction(scope, node.discriminant, state)
    if (test && test.type === 'Literal') {
      const testValue = (test as any as Literal).value
      for (const caseClause of node.cases) {
        if (
          !caseClause.test || // FIXME
          (caseClause.test.type === 'Literal' && (caseClause.test as any as Literal).value === testValue)
        ) {
          return this.processInstruction(scope, caseClause.body, state)
        }
      }
      return new UndefinedValue()
    }

    const scopes = []
    const n = node.cases.length
    const substates = MemState.forkStates(state, n)
    let i = 0
    for (const caseClause of node.cases) {
      const scope1 = MemState.cloneScope(scope, state)
      scopes.push(scope1)
      const st = substates[i++] || substates[0]
      this.processInstruction(scope1, caseClause.body, st)
    }
    MemState.unionValues(scopes, substates, state.brs)
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processForStatement(scope: ScopeType, node: ForStatement, state: State): VoidValueType {
    StateUtil.pushLoopInfo(state, node)
    if (node.init) {
      this.processInstruction(scope, node.init, state)
    }

    let test = node.test ? this.processInstruction(scope, node.test, state) : null
    if (test && test.type === 'Literal') {
      if (test.value) {
        this.processInstruction(scope, node.body, state)
      }
    } else {
      this.processInstruction(scope, node.body, state)
    }
    if (node.update) {
      this.processInstruction(scope, node.update, state)
    }
    test = this.processInstruction(scope, node.test, state)
    if (test && test.type === 'Literal') {
      if (test.value) this.processInstruction(scope, node.body, state)
    } else this.processInstruction(scope, node.body, state)

    StateUtil.popLoopInfo(state)
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processWhileStatement(scope: ScopeType, node: WhileStatement, state: State): VoidValueType {
    /*
    { test,
     body,
     isPostTest
    }
    */
    StateUtil.pushLoopInfo(state, node)
    // TODO node.isPostTest
    let test = this.processInstruction(scope, node.test, state)
    if (test && test.type === 'Literal') {
      if (test.value) this.processInstruction(scope, node.body, state)
    } else this.processInstruction(scope, node.body, state)

    // unroll one more time
    test = this.processInstruction(scope, node.test, state)
    if (test && test.type === 'Literal') {
      if (test.value) this.processInstruction(scope, node.body, state)
    } else this.processInstruction(scope, node.body, state)

    StateUtil.popLoopInfo(state)
    // // fixed-point on values (with scopes) for data-flow calculation
    // scope.value = MemState.computeValueFixedPoint(scope).value;

    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processRangeStatement(scope: ScopeType, node: RangeStatement, state: State): any {
    const { key, value, right, body } = node
    scope = Scope.createSubScope(
      `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
      scope
    )
    const rightVal = this.processInstruction(scope, right, state)
    if (
      !Array.isArray(rightVal) &&
      (this.inRange ||
        rightVal?.vtype === 'primitive' ||
        Object.keys(rightVal.getRawValue()).filter((key) => !key.startsWith('__yasa')).length === 0)
    ) {
      if (value) {
        if (value.type === 'VariableDeclaration') {
          this.saveVarInCurrentScope(scope, value.id, rightVal, state)
        } else if (value.type === 'TupleExpression') {
          for (const ele of value.elements) {
            // Runtime may have 'name' property even if not in type definition
            this.saveVarInCurrentScope(scope, ele.name, rightVal, state)
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
    } else {
      this.inRange = true
      if (this.isNullLiteral(rightVal)) {
        this.inRange = false
        return undefined as any // 保持历史行为（25282dbd）
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
            if (_.isString(k)) k = new PrimitiveValue(scope.qid, k, k, null, key.type, key.loc, key)
            this.saveVarInCurrentScope(scope, key, k, state)
          }
        }
        if (value) {
          if (value.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, value.id, v, state)
          } else if (value.type === 'TupleExpression') {
            for (let i = 0; i < value.elements.length; i++) {
              const eleVal = v?.members?.get(String(i)) ?? v
              this.saveVarInCurrentScope(scope, value.elements[i].name, eleVal, state)
            }
          } else {
            this.saveVarInCurrentScope(scope, value, v, state)
          }
        }
        this.processInstruction(scope, body, state)
      }
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
  processReturnStatement(scope: ScopeType, node: ReturnStatement, state: State): VoidValueType {
    // { expression }
    // lastReturnValue should be treated as union since there are multi return points in one func
    if (node.argument) {
      const returnValue = this.processInstruction(scope, node.argument, state)

      if (isDataflowInstrumentationEnabled()) {
        const { recordEdge, recordNodeTag } = require('./dataflow-edge-stats')
        recordEdge(returnValue, scope, 'return', { targetKind: 'function_return', producerKind: 'return_expr', provenance: 'common.processReturnStatement' })
        recordNodeTag(returnValue, 'return_expr', '1', 'common.processReturnStatement')
        recordNodeTag(scope, 'function_return', '1', 'common.processReturnStatement')
      }
      if (!node.isYield) {
        if (!this.lastReturnValue) {
          this.lastReturnValue = returnValue
        } else if (this.lastReturnValue.vtype === 'union' && !this.lastReturnValue.isTuple) {
          if (returnValue === this.lastReturnValue || returnValue.value === this.lastReturnValue.value) {
            const newReturnValue = buildNewValueInstance(
              this,
              returnValue,
              node,
              scope,
              () => {
                return false
              },
              (v: any) => {
                return !v
              }
            )
            this.lastReturnValue.appendValue(newReturnValue, false)
          } else {
            this.lastReturnValue.appendValue(returnValue, false)
          }
        } else {
          const tmp = new UnionValue(undefined, undefined, `${scope.qid}.<union@ret:${node.loc?.start?.line}>`, node)
          tmp.appendValue(this.lastReturnValue)
          tmp.appendValue(returnValue)
          this.lastReturnValue = tmp
        }
        if (node.loc && this.lastReturnValue)
          this.lastReturnValue = SourceLine.addSrcLineInfo(
            this.lastReturnValue,
            node,
            node.loc.sourcefile,
            'Return Value: ',
            '[return value]'
          )
      }
      return returnValue
    }
    return new PrimitiveValue(scope.qid, 'undefined', null, null, 'Literal', node.loc)
  }

  // TODO break statement
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processBreakStatement(scope: ScopeType, node: BreakStatement, state: State): VoidValueType {
    return new UndefinedValue()
  }

  // TODO continue statement
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processContinueStatement(scope: ScopeType, node: ContinueStatement, state: State): VoidValueType {
    return new UndefinedValue()
  }

  // TODO throw
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processThrowStatement(scope: ScopeType, node: ThrowStatement, state: State): VoidValueType {
    // 原本是注释的，打开了，throw和return 还是有很大区别的
    // throw会沿着调用栈传递，return 只会传到调用层 没处理就结束了
    // const ret = this.processReturnStatement(scope, node, state);
    // ret.throwed = true;
    // return ret;
    let throw_value
    if (node.argument) {
      throw_value = this.processInstruction(scope, node.argument, state)
      if (throw_value && state.throwstack) {
        throw_value = SourceLine.addSrcLineInfo(
          throw_value,
          node,
          node.loc && node.loc.sourcefile,
          'Var Pass: ',
          (node.argument.type === 'Identifier' ? node.argument.name : null) ||
            AstUtil.prettyPrintAST(node.argument).slice(0, 50)
        )
        // 没有被try处理的异常
        state.throwstack = state.throwstack ?? []
        state.throwstack.push(throw_value)
        return throw_value
      }
      state.throwstackScopeAndState = state.throwstackScopeAndState ?? []
      state.throwstackScopeAndState.push({ scope, state })
    }
    return new PrimitiveValue(
      scope.qid,
      `<throwVariable_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
      node.argument,
      null,
      'Literal',
      node.loc
    )
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processTryStatement(scope: ScopeType, node: TryStatement, state: State): VoidValueType {
    // 初始化 throwstack，使 processThrowStatement 可将抛出值 push 进来
    state.throwstack = state.throwstack ?? []
    this.processInstruction(scope, node.body, state)
    const { handlers } = node
    if (handlers) {
      for (const clause of handlers) {
        if (!clause) continue
        scope = Scope.createSubScope(
          `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
          scope
        )
        clause.parameter.forEach((param: any) => this.processInstruction(scope, param, state))
        this.processInstruction(scope, clause.body, state)
      }
    }
    if (node.finalizer) this.processInstruction(scope, node.finalizer, state)
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processExpressionStatement(scope: ScopeType, node: ExpressionStatement, state: State): VoidValueType {
    // { expression }
    return this.processInstruction(scope, node.expression, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processScopedStatement(scope: ScopeType, node: ScopedStatement, state: State): any {
    /*
    { statements }
    */
    const { loc } = node
    let scopeName
    if (loc) {
      if (!scope.qid) {
        const prefix = loc.sourcefile?.substring(Config.maindirPrefix.length)
        const lastDotIndex = prefix?.lastIndexOf('.') ?? -1
        const relateFileName = lastDotIndex >= 0 ? prefix?.substring(0, lastDotIndex) : prefix
        scopeName = `${relateFileName}<block_${loc.start?.line}_${loc.start?.column}_${loc.end?.line}_${loc.end?.column}>`
      } else {
        scopeName = `<block_${loc.start?.line}_${loc.start?.column}_${loc.end?.line}_${loc.end?.column}>`
      }
    } else {
      scopeName = `<block_${Uuid.v4()}>`
    }
    const block_scope = Scope.createSubScope(scopeName, scope, 'scope')
    // definition hoisting handle definion first
    node.body
      .filter((n: any) => needCompileFirst(n.type))
      .forEach((s: any) => {
        this.processInstruction(block_scope, s, state)
      })
    node.body
      .filter((n: any) => !needCompileFirst(n.type))
      .forEach((s: any) => {
        this.processInstruction(block_scope, s, state)
      })

    if (this.checkerManager && this.checkerManager.checkAtEndOfBlock) {
      this.checkerManager.checkAtEndOfBlock(this, scope, node, state, {})
    }
    return new VoidValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processBinaryExpression(scope: ScopeType, node: BinaryExpression, state: State): BinaryExprValue {
    const new_left = this.processInstruction(scope, node.left, state)
    const new_right = this.processInstruction(scope, node.right, state)

    const has_tag = (new_left && new_left.taint?.isTaintedRec) || (new_right && new_right.taint?.isTaintedRec)

    // checkerManager 需要 newNode 兼容对象
    const newNode: any = { ...node, ast: node, left: new_left, right: new_right, isTainted: has_tag || null }
    if (this.checkerManager && this.checkerManager.checkAtBinaryOperation)
      this.checkerManager.checkAtBinaryOperation(this, scope, node, state, { newNode })

    const result = new BinaryExprValue(scope.qid, node.operator, new_left, new_right, node, node.loc)
    if (has_tag) {
      result.taint?.mergeFrom([new_left, new_right])
    }
    return result
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processUnaryExpression(scope: ScopeType, node: UnaryExpression, state: State): UnaryExprValue {
    const unaryArg = this.processInstruction(scope, node.argument, state)
    const result = new UnaryExprValue(scope.qid, node.operator, unaryArg, node, node.loc, node.isSuffix)
    const hasTags = unaryArg && unaryArg.taint?.isTaintedRec
    if (hasTags) result.taint?.mergeFrom([unaryArg])
    return result
  }

  /**
   * "left = right", "left *= right", etc.
   * @param scope
   * @param node
   * @param state
   */
  processAssignmentExpression(scope: ScopeType, node: AssignmentExpression, state: State): any {
    /*
    { operator,
      left,
      right,
      cloned
    }
    */
    switch (node.operator) {
      case '=': {
        const { left } = node
        const { right } = node
        let tmpVal = this.processInstruction(scope, right, state)
        const oldVal = this.processInstruction(scope, left, state)

        // TODO: clean the following up
        if (left.type === 'TupleExpression') {
          for (let k = 0; k < left.elements.length; k++) {
            const x = left.elements[k]
            if (!x) continue
            const xName = x.type === 'Identifier' ? x.name : undefined
            if (xName === '_') continue

            let val = tmpVal && tmpVal.type === 'TupleExpression' ? tmpVal.elements[k] : tmpVal
            const oldV = oldVal && oldVal.type === 'TupleExpression' ? oldVal.elements[k] : oldVal
            val = SourceLine.addSrcLineInfo(val, node, node.loc && node.loc.sourcefile, 'Var Pass:', val.name)
            this.saveVarInScope(scope, x, val, state, oldV)

            if (this.checkerManager && this.checkerManager.checkAtAssignment) {
              const lscope = this.getDefScope(scope, x)
              this.checkerManager.checkAtAssignment(this, scope, node, state, {
                lscope,
                lvalue: oldVal,
                rvalue: val,
                pcond: state.pcond,
                binfo: state.binfo,
                entry_fclos: this.entry_fclos,
                einfo: state.einfo,
                state,
              })
            }
          }
        } else {
          if (!tmpVal) {
            tmpVal = new PrimitiveValue(scope.qid, 'undefined', null, null, 'Literal', right.loc)
          }
          if (typeof tmpVal !== 'object') {
            tmpVal = new PrimitiveValue(scope.qid, `<literal_${tmpVal}>`, tmpVal, null, 'Literal', right.loc)
          }
          const sid = SymAddress.toStringID(node.left)
          if (
            tmpVal.sid === undefined ||
            tmpVal.sid === null ||
            (typeof tmpVal.sid === 'string' && tmpVal.sid.includes('<object'))
          ) {
            tmpVal.sid = sid
          }
          if (this.checkerManager && this.checkerManager.checkAtAssignment) {
            const lscope = this.getDefScope(scope, left)
            this.checkerManager.checkAtAssignment(this, scope, node, state, {
              lscope,
              lvalue: oldVal,
              rvalue: tmpVal,
              pcond: state.pcond,
              binfo: state.binfo,
              entry_fclos: this.entry_fclos,
              einfo: state.einfo,
              state,
              ainfo: this.ainfo,
            })
          }
          // Runtime may have 'name' property even if not in type definition
          const leftAsAny = left as any
          if (!leftAsAny.name && sid) {
            leftAsAny.name = sid
          }
          tmpVal = SourceLine.addSrcLineInfo(tmpVal, node, node.loc && node.loc.sourcefile, 'Var Pass:', leftAsAny.name)
          this.saveVarInScope(scope, left, tmpVal, state, oldVal)

        }
        return tmpVal
      }
      case '&=':
      case '^=':
      case '<<=':
      case '>>=':
      case '+=':
      case '-=':
      case '*=':
      case '/=':
      case '%=': {
        const binLeft = this.processInstruction(scope, node.left, state)
        const binRight = this.processInstruction(scope, node.right, state)
        const val = new BinaryExprValue(
          scope.qid,
          node.operator.substring(0, node.operator.length - 1),
          binLeft,
          binRight,
          node,
          node.loc,
          true
        )
        if (node.cloned) {
          const clonedValue = lodashCloneWithTag(val.right!.value)
          val.right = lodashCloneWithTag(val.right)
          val.right!.value = clonedValue
        }
        const { left } = node
        const oldVal = this.getMemberValueNoCreate(scope, left, state)

        const hasTags = (val.left && val.left.taint?.isTaintedRec) || (val.right && val.right.taint?.isTaintedRec)
        if (hasTags) val.taint?.mergeFrom([val.left, val.right])

        this.saveVarInScope(scope, node.left, val, state)

        if (this.checkerManager && this.checkerManager.checkAtAssignment) {
          const lscope = this.getDefScope(scope, node.left)
          this.checkerManager.checkAtAssignment(this, scope, node, state, {
            lscope,
            lvalue: oldVal,
            rvalue: val,
            pcond: state.pcond,
            binfo: state.binfo,
            entry_fclos: this.entry_fclos,
            einfo: state.einfo,
            state,
            ainfo: this.ainfo,
          })
          // this.recordSideEffect(lscope, node.left, val.left);
        }
        return val
      }
      default: {
        // 其他操作符暂不支持，返回 UndefinedValue
        return new UndefinedValue()
      }
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSequence(scope: any, node: any, state: any) {
    let val
    for (const i in node.expressions) {
      const expr = node.expressions[i]
      val = this.processInstruction(scope, expr, state)
    }
    return val
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processConditionalExpression(scope: ScopeType, node: ConditionalExpression, state: State): SymbolValueType {
    /*
    { test,
      consequent,
      alternative
    }
     */
    const test = this.processInstruction(scope, node.test, state)
    // const rscope = scope;
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
    const consequentVal = this.processInstruction(scope, node.consequent, lstate)

    const alternativeVal = this.processInstruction(rscope, node.alternative, rstate)

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
  processSuperExpression(scope: ScopeType, node: SuperExpression, state: State): SymbolValueType {
    return this.getMemberValue(scope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processThisExpression(scope: ScopeType, node: ThisExpression, state: State): SymbolValueType {
    return this.thisFClos
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processMemberAccess(scope: ScopeType, node: MemberAccess, state: State): SymbolValueType {
    /**
     object,
     property,
     computed
     */
    const defscope = this.processInstruction(scope, node.object, state)
    const prop = node.property
    let resolved_prop = prop
    if (node.computed) {
      resolved_prop = this.processInstruction(scope, prop, state) // important, prop should be eval by scope rather than defscope
    } else {
      // non-computed indicates node.property must be identifier
      if (prop.type !== 'Identifier' && prop.type !== 'Literal') {
        // Errors.UnexpectedValue('type should be Identifier when property is non computed', { no_throw: true })
        // try to solve prop in this case though
        resolved_prop = this.processInstruction(scope, prop, state)
      }
    }
    const res = this.getMemberValue(defscope, resolved_prop, state)
    if (node.object.type !== 'SuperExpression' && (res.vtype !== 'union' || !Array.isArray(res.value))) {
      res._this = defscope
    }
    if (this.checkerManager && this.checkerManager.checkAtMemberAccess) {
      this.checkerManager.checkAtMemberAccess(this, defscope, node, state, { res })
    }
    return res
  }

  // TODO slice
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSliceExpression(scope: ScopeType, node: SliceExpression, state: State): SymbolValueType {
    // 返回 undefined 保持历史行为（25282dbd）
    return undefined as any // TODO: 实现 SliceExpression 处理
  }

  // TODO tuple
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processTupleExpression(scope: ScopeType, node: TupleExpression, state: State): SymbolValueType {
    const values = node.elements.map((ele: any) => {
      return this.processInstruction(scope, ele, state)
    })
    const result = unionAllValues(values, state)
    // 非数组的 tuple（如 Python tuple、Go 多返回值）标记 isTuple，防止 return 合并时丢失元素
    if (!(node as any).isArray) {
      result.isTuple = true
    }
    return result
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processObjectExpression(scope: ScopeType, node: ObjectExpression, state: State): SymbolValueType {
    // FIXME
    const objSid = `<object_${node.loc?.start?.line}_${node.loc?.end?.line}>`
    let res = new Scoped(scope.qid, {
      sid: objSid,
      parent: scope,
      ast: node,
      _skipRegister: true,
    })
    if (node.properties) {
      for (const property of node.properties) {
        let name
        let fvalue
        // ObjectMethod may exist in runtime but not in UAST type definition
        const propertyType = (property as any).type
        switch (propertyType) {
          case 'ObjectMethod': {
            // ObjectMethod is not in UAST definition, but may exist in runtime
            const objectMethod = property as any
            name = objectMethod.key?.name
            fvalue = this.createFuncScope(objectMethod, scope)
            fvalue.ast.fdef = _.clone(fvalue.ast.fdef)
            if (fvalue.ast.fdef) {
              fvalue.ast.fdef.type = 'FunctionDefinition'
            }
            if (fvalue.ast?.node) {
              fvalue.ast.node.type = 'FunctionDefinition'
            }
            break
          }
          case 'SpreadElement': {
            this.processInstruction(res, property, state)
            continue
          }
          case 'ObjectProperty':
          default: {
            if (property.type !== 'ObjectProperty') continue
            let { key } = property
            switch (key.type) {
              // FIXME  process ObjectMethod
              case 'Literal':
                name = key.value
                break
              case 'Identifier':
                name = key.name
                break
              default:
                key = this.processInstruction(res, key, state)
                name = key.type === 'Literal' ? key.value : key.type === 'Identifier' ? key.name : undefined
                break
            }
            fvalue = this.processInstruction(res, property.value, state)
            if (fvalue?.taint?.isTaintedRec) res.taint?.propagateFrom(fvalue)
            // FunctionDefinition is both Decl and Expr (double inheritance)
            if (property.value && property.value.type === 'FunctionDefinition') fvalue.parent = res
            break
          }
        }
        res.value[name] = fvalue
        // // call-back
        // if (expressionCallBack) {
        //     expressionCallBack(node, [name, fvalue], this.currentFunction);
        // }
        // if (triggers)
        // //triggers.checkObjectValue(node, property, fvalue, this.currentFunction.sourcefile);
        //     triggers.checkExpression(property, fvalue);
      }
      res.length = node.properties.length
    }
    res = new ObjectValue(scope.qid, { ...res, sid: objSid })
    res.vtype = 'object'
    res._this = res

    if (isDataflowInstrumentationEnabled() && res?.value) {
      const { recordEdge } = require('./dataflow-edge-stats')
      for (const k of Object.keys(res.value)) {
        const fv = res.value[k]
        if (fv && typeof fv === 'object' && fv !== res) {
          recordEdge(fv, res, 'field_write')
        }
      }
    }

    return res
  }

  // ==================== CallArgs methods (Step 2) ====================

  /**
   * Build CallArgs from evaluated argvalues and call-site AST node.
   * Base implementation: all args are positional, keyword determined by node.names.
   * Language-specific analyzers can override (e.g. Python buildPythonCallArgs).
   * @param node
   * @param argvalues
   * @param fclos
   */
  buildCallArgs(node: BaseNode & { arguments?: BaseNode[] }, argvalues: any[], fclos: any): CallArgs {
    const args: CallArg[] = []
    for (let i = 0; i < argvalues.length; i++) {
      const name = this.getCallArgName(node, i)
      args.push({
        index: i,
        value: argvalues[i],
        node: node.arguments?.[i],
        name,
        kind: name ? 'keyword' : 'positional',
      })
    }
    const receiver = this.getCallReceiver(fclos, node)
    return { receiver, args, node }
  }

  /**
   * Get the keyword name for argument at given index from node.names.
   * @param node
   * @param index
   */
  getCallArgName(node: BaseNode & { names?: string[] }, index: number): string | undefined {
    if (node.names && Array.isArray(node.names) && index < node.names.length) {
      const name = node.names[index]
      if (name && typeof name === 'string') return name
    }
    return undefined
  }

  /**
   * Get the receiver (this/self) from fclos for MemberAccess calls.
   * @param fclos
   * @param node
   */
  getCallReceiver(fclos: any, node: BaseNode & { callee?: Node }): any {
    if (node?.callee?.type === 'MemberAccess') {
      return fclos?._this || fclos?.getThisObj?.()
    }
    return undefined
  }

  /**
   * 确保 callInfo 有效：缺失时创建空对象，callArgs 缺失时构建空 callArgs。
   * @param node
   * @param fclos
   * @param callInfo
   */
  ensureCallInfo(node: any, fclos: any, callInfo?: CallInfo): CallInfo {
    const activeCallInfo: CallInfo = callInfo || ({ callArgs: { args: [] } } as CallInfo)
    if (!activeCallInfo.callArgs) {
      activeCallInfo.callArgs = this.buildCallArgs(node, [], fclos)
    }
    return activeCallInfo
  }

  protected canUseCallSummary(
    scope: ScopeType,
    fclos: Value | undefined,
    callInfo: CallInfo | undefined,
    state?: State
  ): boolean {
    if (!scope || !fclos || !callInfo?.callArgs) return false
    if (!state) return true
    const policy = this.callSummaryLanguagePolicy
    if (!policy) return true
    const context = this.buildCallSummaryLanguagePolicyContext(scope, fclos, callInfo, state)
    const callNode = policy.getCallNode?.(context)
    const disabledReason = policy.getDisabledReason?.(context, callNode)
    if (disabledReason) {
      this.setFirstCallSummaryDisabledReason(disabledReason)
      return false
    }
    return true
  }

  protected buildCallSummaryRiskContext(
    scope: ScopeType,
    fclos: Value | undefined,
    callInfo: CallInfo | undefined,
    state: State
  ): CallSummaryRiskContext {
    const context = this.buildCallSummaryLanguagePolicyContext(scope, fclos, callInfo, state)
    return (this.callSummaryLanguagePolicy ?? defaultCallSummaryPolicy).buildRiskContext(context)
  }

  protected buildCallSummaryLanguagePolicyContext(
    scope: ScopeType,
    fclos: Value | undefined,
    callInfo: CallInfo | undefined,
    state: State
  ): CallSummaryLanguagePolicyContext {
    return { scope, fclos, callInfo, state }
  }

  protected buildCallSummaryRiskContextForCall(
    scope: ScopeType,
    fclos: Value | undefined,
    callInfo: CallInfo | undefined,
    state: State
  ): CallSummaryRiskContext {
    return this.buildCallSummaryRiskContext(scope, fclos, callInfo, state)
  }

  protected executeWithSummary(
    scope: ScopeType,
    fclos: Value | undefined,
    callInfo: CallInfo,
    state: State,
    execute: () => Value,
    options?: {
      readonly includeStage?: boolean
      readonly getReplayValue?: (value: Value) => CallSummaryReturnLike
    }
  ): Value {
    return executeWithCallSummary({
      sessions: this.callSummarySessions,
      context: {
        callerQid: scope?.qid,
        callee: fclos,
        callArgs: callInfo.callArgs?.args,
        riskContext: this.buildCallSummaryRiskContextForCall(scope, fclos, callInfo, state),
      },
      canUse: this.canUseCallSummary(scope, fclos, callInfo, state),
      includeStage: options?.includeStage,
      runtime: {
        receiver: callInfo.callArgs?.receiver,
        pcond: state.pcond,
      },
      captureSideEffectSnapshot: () => captureCallSummarySideEffectSnapshot(this),
      getReturnUsed: () => this.getCallReturnUsed(callInfo.callArgs?.node),
      execute,
      getReplayValue: options?.getReplayValue,
      applyReplayDelta: applyCallSummaryReplayDelta,
      buildReplayReturn: (replayDelta) => buildCallSummaryReplayReturn(scope?.qid, replayDelta),
      buildHitReturn: () => buildHitReturn(scope?.qid),
    })
  }

  protected beginCallSummarySession(session: typeof this.callSummarySessions[number]): void {
    session.beginForLanguage(Config.language)
  }

  protected beginPrimaryCallSummarySession(language?: string): void {
    this.callSummarySessions[0].beginForLanguage(language ?? Config.language)
  }

  protected finishPrimaryCallSummarySession(): void {
    this.callSummarySessions[0].finish()
  }

  protected setFirstCallSummaryDisabledReason(reason: string): void {
    for (const session of this.callSummarySessions) {
      if (session.isActive()) session.setFirstDisabledReason(reason)
    }
  }

  /**
   * Bind CallArgs to function parameters, producing BoundCall.
   * 核心绑定逻辑：将 CallArgs 中的实参绑定到 BoundCall 的形参上。
   * 替代旧的 for-loop + node.names.indexOf 方式。
   * @param node
   * @param fclos
   * @param fdecl
   * @param callInfo
   */
  bindCallArgs(node: any, fclos: any, fdecl: any, callInfo: CallInfo): BoundCall {
    const { callArgs } = callInfo
    const params = fdecl?.parameters
    const boundCall: BoundCall = {
      receiver: callArgs?.receiver,
      params: [],
    }
    if (!params || !callArgs) return boundCall

    const paramList: any[] = Array.isArray(params) ? params : params.parameters || []
    for (let i = 0; i < paramList.length; i++) {
      const param = paramList[i]
      boundCall.params.push({
        index: i,
        name: param.name || param.id?.name || `_${i}`,
        value: undefined,
        provided: false,
        argIndexes: [],
      })
    }

    const startIndex = this.bindReceiverParam(boundCall, paramList, callArgs, node)
    this.bindPositionalArgs(boundCall, paramList, callArgs, startIndex)
    this.bindKeywordArgs(boundCall, paramList, callArgs)

    return boundCall
  }

  /**
   * 判定形参类型：vararg（*args/rest）、varkw（**kwargs）、keyword_only、positional_only 或普通
   * @param param
   */
  getParamKind(param: any): string {
    if (param?._meta?.parameterKind) {
      return param._meta.parameterKind
    }
    if (param?._meta?.positional_only) {
      return 'positional_only'
    }
    if (param?._meta?.keyword_only) {
      return 'keyword_only'
    }
    if (param?._meta?.varkw) {
      return 'varkw'
    }
    // isRestElement: JS parser; varType._meta.varargs: Java/Go parser
    if (param?._meta?.isRestElement || param?.varType?._meta?.varargs) {
      return 'vararg'
    }
    return 'positional_or_keyword'
  }

  /**
   * 统一赋值：普通参数直接赋值，vararg 收集为数组，varkw 收集为对象
   * @param boundCall
   * @param params
   * @param paramIndex
   * @param value
   * @param argIndex
   */
  private assignParamValue(
    boundCall: BoundCall,
    params: any[],
    paramIndex: number,
    value: any,
    argIndex: number
  ): void {
    if (paramIndex < 0 || paramIndex >= boundCall.params.length) return
    const target = boundCall.params[paramIndex]
    const paramKind = this.getParamKind(params[paramIndex])
    if (paramKind === 'vararg') {
      if (!target.provided || !Array.isArray(target.value)) {
        target.value = []
        target.provided = true
      }
      target.value.push(value)
      target.argIndexes.push(argIndex)
      return
    }
    if (paramKind === 'varkw') {
      if (!target.provided || !target.value || typeof target.value !== 'object' || Array.isArray(target.value)) {
        target.value = {}
        target.provided = true
      }
    }
    target.value = value
    target.provided = true
    target.argIndexes.push(argIndex)
  }

  /**
   * 展开 *args spread 值为数组
   * @param value
   */
  resolveSpreadValues(value: any): any[] {
    if (Array.isArray(value)) {
      return value
    }
    if (value?._field && Array.isArray(value._field)) {
      return value._field
    }
    if (value?.members && value.members.size > 0) {
      const numericKeys = [...value.members.keys()]
        .filter((key: string) => /^\d+$/.test(key))
        .sort((a: string, b: string) => Number(a) - Number(b))
      if (numericKeys.length > 0) {
        return numericKeys.map((key: string) => value.members.get(key))
      }
    }
    if (value?._field && typeof value._field === 'object') {
      const numericKeys = Object.keys(value._field)
        .filter((key: string) => /^\d+$/.test(key))
        .sort((a: string, b: string) => Number(a) - Number(b))
      if (numericKeys.length > 0) {
        return numericKeys.map((key: string) => value._field[key])
      }
    }
    return [value]
  }

  /**
   * 展开 **kwargs kwspread 值为 [name, value] 对
   * @param value
   */
  resolveKwSpreadEntries(value: any): Array<[string, any]> {
    if (!value) return []
    const entries: Array<[string, any]> = []
    if (value.members && value.members.size > 0) {
      for (const key of value.members.keys()) {
        entries.push([key, value.members.get(key)])
      }
    } else {
      const source = value._field && typeof value._field === 'object' ? value._field : value
      if (source && typeof source === 'object') {
        for (const [key, val] of Object.entries(source)) {
          if (typeof key === 'string') {
            entries.push([key, val])
          }
        }
      }
    }
    return entries
  }

  /**
   * receiver（self/cls/this）绑定到第一个形参，返回 positional 绑定的起始索引
   * @param boundCall
   * @param params
   * @param callArgs
   * @param node
   */
  bindReceiverParam(boundCall: BoundCall, params: any[], callArgs: CallArgs, node: any): number {
    if (!callArgs.receiver || params.length === 0) return 0
    const firstParam = params[0]
    const firstName = firstParam.name || firstParam.id?.name || ''
    if (['self', 'cls', 'this'].includes(firstName)) {
      const bp = boundCall.params[0]
      if (bp) {
        bp.value = callArgs.receiver
        bp.provided = true
      }
      return 1
    }
    return 0
  }

  /**
   * positional/spread 实参绑定到形参，溢出部分收集到 vararg
   * @param boundCall
   * @param params
   * @param callArgs
   * @param startIndex
   */
  bindPositionalArgs(boundCall: BoundCall, params: any[], callArgs: CallArgs, startIndex: number): void {
    let nextPositionalIndex = startIndex
    const findNext = (): number => {
      while (nextPositionalIndex < params.length) {
        const kind = this.getParamKind(params[nextPositionalIndex])
        if (kind === 'keyword_only' || kind === 'varkw') {
          nextPositionalIndex++
          continue
        }
        return nextPositionalIndex
      }
      return -1
    }

    for (const arg of callArgs?.args || []) {
      if (arg.kind === 'keyword' || arg.kind === 'kwspread') continue
      const values = arg.kind === 'spread' ? this.resolveSpreadValues(arg.value) : [arg.value]
      for (const value of values) {
        const paramIndex = findNext()
        if (paramIndex === -1) {
          // 溢出：收集到 vararg 形参
          const varargIndex = params.findIndex((p: any) => this.getParamKind(p) === 'vararg')
          if (varargIndex !== -1) {
            this.assignParamValue(boundCall, params, varargIndex, value, arg.index)
          }
          continue
        }
        this.assignParamValue(boundCall, params, paramIndex, value, arg.index)
        if (this.getParamKind(params[paramIndex]) !== 'vararg') {
          nextPositionalIndex = paramIndex + 1
        }
      }
    }
  }

  /**
   * keyword/kwspread 实参按名称匹配形参，未匹配的收集到 varkw（**kwargs）
   * @param boundCall
   * @param params
   * @param callArgs
   */
  bindKeywordArgs(boundCall: BoundCall, params: any[], callArgs: CallArgs): void {
    const keywordEntries: Array<{ name: string; value: any; argIndex: number }> = []
    for (const arg of callArgs?.args || []) {
      if (arg.kind === 'keyword' && arg.name) {
        keywordEntries.push({ name: arg.name, value: arg.value, argIndex: arg.index })
      } else if (arg.kind === 'kwspread') {
        for (const [name, value] of this.resolveKwSpreadEntries(arg.value)) {
          keywordEntries.push({ name, value, argIndex: arg.index })
        }
      }
    }

    const varkwIndex = params.findIndex((p: any) => this.getParamKind(p) === 'varkw')
    for (const entry of keywordEntries) {
      const paramIndex = params.findIndex((p: any) => (p?.id?.name || p?.name) === entry.name)
      if (paramIndex === -1) {
        // 未匹配的 keyword → **kwargs
        if (varkwIndex !== -1) {
          const target = boundCall.params[varkwIndex]
          if (!target.provided || !target.value || typeof target.value !== 'object' || Array.isArray(target.value)) {
            target.value = {}
            target.provided = true
          }
          target.value[entry.name] = entry.value
          target.argIndexes.push(entry.argIndex)
        }
        continue
      }
      if (this.getParamKind(params[paramIndex]) === 'positional_only') continue
      this.assignParamValue(boundCall, params, paramIndex, entry.value, entry.argIndex)
    }
  }

  // ==================== End CallArgs methods ====================

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCallExpression(scope: ScopeType, node: CallExpression, state: State): any {
    /* { callee,
        arguments,
      }
   */
    if (this.checkerManager && this.checkerManager.checkAtFuncCallSyntax)
      this.checkerManager.checkAtFuncCallSyntax(this, scope, node, state, {
        pcond: state.pcond,
        einfo: state.einfo,
      })

    const fclos = this.processInstruction(scope, node.callee, state)
    if (!fclos) return new UndefinedValue()

    // 类型转换去污：数值/布尔类型转换不携带注入载荷（如 (int)"1 OR 1=1" → 1）
    const numericCastTypes = ['int', 'integer', 'float', 'double', 'bool', 'boolean']
    if (node._meta?.isCast && node.callee?.name && numericCastTypes.includes(node.callee.name)) {
      for (const arg of node.arguments) {
        this.processInstruction(scope, arg, state)
      }
      return new PrimitiveValue(scope.qid, `<cast_${node.callee.name}>`, node, null, 'Literal', node.loc)
    }

    // prepare the function arguments
    let argvalues = []
    let same_args = true // minor optimization to save memory
    for (const arg of node.arguments) {
      let argv = this.processInstruction(scope, arg, state)
      // 处理参数是 箭头函数或匿名函数
      // 参数类型必须是函数定义,且fclos找不到定义或未建模适配
      // 如果参数适配建模，则会进入相应的逻辑模拟执行，例如array.push
      if (arg.type === 'FunctionDefinition' && !fclos?.ast.fdef && !fclos?.runtime?.execute) {
        const funcDef = arg as FunctionDefinition & { name?: string }
        // 无名函数（Java lambda 的 FunctionDefinition.name 在 AST 阶段为 undefined）或匿名函数（JS/TS）都进入 inline 分析
        if (!funcDef.name || funcDef.name.includes('<anonymous')) {
          // let subscope = Scope.createSubScope(argv.sid + '_scope', scope,'scope')
          argv = this.processAndCallFuncDef(scope, funcDef, argv, state)
        }
      }
      if (argv !== arg) same_args = false
      if (logger.isTraceEnabled()) logger.trace(`arg: ${this.formatScope(argv)}`)
      if (Array.isArray(argv)) {
        argvalues.push(...argv)
      } else {
        argvalues.push(argv)
      }
    }
    if (same_args) argvalues = node.arguments

    // build structured call info
    const callInfo: CallInfo = { callArgs: this.buildCallArgs(node, argvalues, fclos), callsiteNode: node }
    // analyze the resolved function closure and the function arguments
    const res = this.executeWithSummary(scope, fclos, callInfo, state, () => this.executeCall(node, fclos, state, scope, callInfo))

    // function definition not found, examine possible call-back functions in the arguments
    if (fclos.vtype !== 'fclos' && Config.invokeCallbackOnUnknownFunction) {
      this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
    }

    if (res && this.checkerManager?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        callInfo,
        fclos,
        ret: res,
        pcond: state.pcond,
        einfo: state.einfo,
        callstack: state.callstack,
      })
    }

    return res
  }

  /**
   *
   * @param scope
   * @param fDef
   * @param fClos
   * @param state
   * @param argValues
   */
  processAndCallFuncDef(
    scope: ScopeType,
    fDef: FunctionDefinition,
    fClos: Value,
    state: State,
    argValues?: Value[],
    traceCallNode?: Node
  ): Value {
    if (fDef?.type !== 'FunctionDefinition' || fClos?.vtype !== 'fclos') return fClos

    try {
      const parameters = Array.isArray(fDef.parameters) ? fDef.parameters : []
      if (!argValues) {
        // process FuncDef的参数
        argValues = []
        for (const para of parameters) {
          const argv = this.processInstruction(scope, para, state)
          if (Array.isArray(argv)) {
            argValues.push(...argv)
          } else {
            argValues.push(argv)
          }
        }
      }

      const callInfo: CallInfo = { callArgs: this.buildCallArgs(fDef, argValues, fClos) }
      if (traceCallNode) callInfo.callsiteNode = traceCallNode
      return this.executeCall(fDef, fClos, state, scope, callInfo)
    } catch (e) {
      handleException(
        e,
        '',
        `YASA Simulation Execution Error in processAndCallFuncDef. Loc is ${fDef?.loc?.sourcefile} line:${fDef?.loc?.start?.line}`
      )
      return new UndefinedValue()
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCastExpression(scope: ScopeType, node: CastExpression, state: State): SymbolValueType {
    return this.processInstruction(scope, node.expression, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processNewExpression(scope: ScopeType, node: NewExpression, state: State): SymbolValueType {
    /*
  { typeName }
  */
    if (this.checkerManager && this.checkerManager.checkAtNewExpr)
      this.checkerManager.checkAtNewExpr(this, scope, node, state, null)
    return this.processNewObject(scope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  preProcessFunctionDefinition(scope: any, node: any, state: any) {
    if (node.body) {
      // TODO: handle function declaration better
      const ret = this.createFuncScope(node, scope)
      ret.__preprocess = true
      return ret
    }
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processFunctionDefinition(scope: ScopeType, node: FunctionDefinition, state: State): SymbolValueType {
    let fclos
    if (node.body) {
      // TODO: handle function declaration better
      fclos = this.createFuncScope(node, scope)
      const nodeBody = node.body as any
      if (nodeBody?.body && Array.isArray(nodeBody.body)) {
        for (const body of nodeBody.body) {
          if (body.type === 'FunctionDefinition') {
            this.processInstruction(fclos, body, state)
          }
        }
      }
    } else {
      fclos = new UndefinedValue()
    }
    if (this.checkerManager && this.checkerManager.checkAtFunctionDefinition) {
      this.checkerManager.checkAtFunctionDefinition(this, scope, node, state, { fclos })
    }
    this.postProcessFunctionDefinition(fclos, node, scope, state)
    return fclos
  }

  /**
   *
   * @param fclos
   * @param node
   * @param scope
   * @param state
   */
  postProcessFunctionDefinition(fclos: any, node: any, scope: any, state: any) {
    /** build decorator clos * */
    if (node.type === 'FunctionDefinition') {
      const decoratorsNode = node._meta.decorators
      if (decoratorsNode) {
        // notice in this case, scope is class clos, and the decorator clos should be subject to the parent of the class clos
        const parant_scope = scope.parent ?? scope
        const decorators: any[] = []
        decoratorsNode.forEach((d: any) => {
          decorators.push(this.processInstruction(parant_scope, d, state))
        })
        fclos.decorators = decorators
      }
    }
  }

  /**
   *
   * @param scope
   * @param cdef
   * @param state
   */
  preProcessClassDefinition(scope: any, cdef: any, state: any) {
    if (!(cdef && cdef.body)) return new UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = Scope.createSubScope(fname, scope, 'class') // class scope
    cscope.ast = cdef
    cscope.ast.cdef = cdef
    cscope.ast.fdef = cdef
    cscope.__preprocess = true
    return cscope
  }

  /**
   *
   * @param scope
   * @param cdef
   * @param state
   */
  processClassDefinition(scope: ScopeType, cdef: ClassDefinition, state: State): SymbolValueType {
    if (!(cdef && cdef.body)) return new UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = Scope.createSubScope(fname, scope, 'class') // class scope
    cscope.ast = cdef
    cscope.ast.fdef = cdef
    cscope.ast.cdef = cdef
    cscope.modifier = {}
    cscope.inits = new Set() // for storing the variables initialized in the constructor
    this.resolveClassInheritance(cscope, state) // inherit base classes

    if (!cscope.fdata) cscope.fdata = {} // for class-level analysis data

    if (cdef) {
      const oldThisFClos = this.thisFClos
      this.entry_fclos = this.thisFClos = cscope
      // process variable/method declarations and so forth
      this.processInstruction(cscope, cdef.body, state)
      for (const x in cscope.value) {
        const v = cscope.value[x]
        v._this = cscope
      }
      cscope._this = cscope
      this.thisFClos = oldThisFClos
    }

    // post-processing
    // logger.log('Done with class: ', fname);
    return cscope
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processVariableDeclaration(scope: ScopeType, node: VariableDeclaration, state: State): SymbolValueType {
    const initialNode = node.init
    const { id } = node
    const idName = id?.type === 'Identifier' ? id.name : undefined
    if (!id || idName === '_') return new UndefinedValue() // e.g. in Go

    let initVal
    if (node?.parent?.type === 'CatchClause' && node?._meta?.isCatchParam && (state?.throwstack?.length ?? 0) > 0) {
      // throw 传递到 catch：从 throwstack 取出抛出值赋给 catch 参数
      initVal = state?.throwstack && state?.throwstack.shift()
      initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', idName || '')
      delete node._meta.isCatchParm
    } else if (!initialNode) {
      initVal = this.createVarDeclarationScope(id, scope)
      initVal.uninit = !initialNode
      initVal = SourceLine.addSrcLineInfo(initVal, id, id.loc && id.loc.sourcefile, 'Var Pass: ', idName || '')
    } else {
      initVal = this.processInstruction(scope, initialNode, state)
      if (initialNode.type === 'ImportExpression') {
        if (initVal?.sid === 'module.exports' && _.keys(initVal?.value).length === 0) {
          initVal = this.processInstruction(scope, initialNode, state)
        }
      }
      initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', idName || '')
    }

    if (this.checkerManager && this.checkerManager.checkAtPreDeclaration)
      this.checkerManager.checkAtPreDeclaration(this, scope, node, state, {
        lnode: id,
        rvalue: null,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        fdef: state.callstack && state.callstack[state.callstack.length - 1],
      })

    this.saveVarInCurrentScope(scope, id, initVal, state)

    // set alias name if val itself has no identifier
    if (initVal && !Array.isArray(initVal) && !(initVal.name || initVal.sid) && idName) {
      initVal.sid = idName
    }

    if (idName) {
      scope.ast.setDecl(idName, id)
    }

    const typeQualifiedName = AstUtil.typeToQualifiedName(node.varType)
    let declTypeVal
    if (typeQualifiedName) {
      declTypeVal = this.getMemberValueNoCreate(scope, typeQualifiedName, state)
    }

    return initVal
  }

  // TODO
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processDereferenceExpression(scope: any, node: any, state: any) {
    const ret = this.processInstruction(scope, node.argument, state)
    if (ret && ret.runtime?.refCount) {
      ret.runtime.refCount--
      if (ret.runtime.refCount === 0) {
        delete ret.runtime.refCount
      }
    }
    return ret
  }

  // TODO
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processReferenceExpression(scope: any, node: any, state: any) {
    const val = this.processInstruction(scope, node.argument, state)
    if (val) {
      if (!val.runtime) val.runtime = {}
      val.runtime.refCount = val.runtime.refCount || 0
      val.runtime.refCount++
    }
    return val
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processImportExpression(scope: ScopeType, node: ImportExpression, state: State): SymbolValueType {
    /* {
        from,
        local,
        imported
    } */
    // const { imported, local, from } = node
    // const importedVal = this.getMemberValue(importScope, imported, state);
    // if (importedVal) {
    //     this.saveVarInCurrentScope(scope, local, importedVal, state);
    // }
    return this.processImportDirect(this.topScope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSpreadElement(scope: ScopeType, node: SpreadElement, state: State): SpreadValueType {
    const val = this.processInstruction(scope, node.argument, state)
    if (!val) {
      return val
    }
    const res = new Set()
    const self = this
    const fields = Array.isArray(val) ? val : val.scope.exports ? val.scope.exports.getRawValue() : val.getRawValue()
    if (Array.isArray(fields)) {
      for (const f of fields) {
        handler(f)
      }
    } else {
      handler(fields)
    }

    /**
     *
     * @param flds
     */
    function handler(flds: any) {
      if (flds?.vtype === 'union' || flds?.vtype === 'bvt') {
        handler(flds.getRawValue())
      } else if (Array.isArray(flds)) {
        for (const f of flds) {
          handler(f)
        }
      } else if (flds.vtype === 'primitive') {
        // do nothing
      } else if (flds.vtype) {
        handler(flds.value)
      } else {
        // 偏移量不是简单当前数组的长度，而是排除内置函数以后当前解构运算符之前元素的长度
        // eg arr1= [1,2,3] arr2=[10,...arr1,...arr1]
        // 第一个...arr1应该加上的偏移量是1，第二个arr1应该加上的偏移量是4
        // TODO 未来数组表达式的ast从ObjectExpression换成ArrayExpression 在这里需要做相应修改
        const offset = scope.members.size
        const isArray = (node.parent as any)?._meta?.isArray
        for (let fname in flds) {
          const fVal = flds[fname]
          // 解构变量field中undefine的值不应该被保存到scope的field中，会清除有污点的变量
          if (!fVal || fVal?.vtype === 'undefine') continue
          res.add(fVal)
          // 当前object expression实际上是数组对象 且key能转换成数字
          if (isArray && Number.isFinite(parseInt(fname))) {
            // 获取历史已有数据长度，避免数组的历史数据被覆盖
            fname = (parseInt(fname) + offset).toString()
            self.saveVarInCurrentScope(scope, fname, fVal, state)
          } else {
            self.saveVarInCurrentScope(scope, fname, fVal, state)
          }
        }
      }
    }

    // 创建 SpreadValue - 返回增强数组（保持向后兼容）
    // 注意：不预先计算 isTainted，让后续逻辑（如 js-analyzer）按需处理
    const spreadValue: any = Array.from(res)
    spreadValue.vtype = 'spread'
    spreadValue.elements = spreadValue // elements 指向自身（因为本身就是数组）
    spreadValue.sid = '<spread>'
    spreadValue.qid = '<spread>'

    return spreadValue as SpreadValueType
  }

  // TODO YieldExpression
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processYieldExpression(scope: ScopeType, node: YieldExpression, state: State): VoidValueType {
    // 保持历史行为（25282dbd）：转换为 ReturnStatement 处理
    // YieldExpression has 'argument' field, not 'expression'
    const returnLike = {
      ...node,
      expression: node.argument,
    } as any as ReturnStatement
    return this.processReturnStatement(scope, returnLike, state)
  }

  /**
   * after a branch is executed: merge branch information and so on
   * @param node
   * @param test
   * @param state
   * @param lstate
   * @param rstate
   */
  postBranchProcessing(node: any, test: any, state: any, lstate: any, rstate?: any): any {
    const terminate_at_left = AstUtil.satisfy(node.consequent, (x: any) => {
      return x.type === 'ReturnStatement' || x.type === 'ThrowStatement'
    })
    if (!rstate) {
      // adopt the condition of the left branch
      if (terminate_at_left && test) {
        // this branch has been terminated
        const rtest = _.clone(test)
        rtest.is_neg = true
        state.pcond.push(rtest)
      }
    }

    // union branch related information
    const { binfo } = state
    if (binfo) {
      const terminate_at_right = AstUtil.satisfy(node.consequent, (x: any) => {
        return (
          x.type === 'ReturnStatement' ||
          x.type === 'ThrowStatement' ||
          (x.type === 'FunctionCall' && x.expression.name === 'revert')
        )
      })
      if (!terminate_at_left) {
        for (const x in lstate.binfo) {
          if (!binfo.hasOwnProperty(x)) {
            binfo[x] = lstate.binfo[x]
          }
        }
      }
      if (rstate && !terminate_at_right) {
        for (const x in rstate.binfo) {
          if (!binfo.hasOwnProperty(x)) {
            binfo[x] = rstate.binfo[x]
          }
        }
      }
    }
  }

  private shouldApplyLibPropagationForCallableWithBody(node: CallExpression, fclos: SymbolValueType, callInfo: CallInfo | undefined, scope: ScopeType): boolean {
    if (!fclos?.ast?.fdef || fclos?.runtime?.execute) {
      return false
    }
    if (this.hasEmptyCallableBody(fclos)) {
      return true
    }
    return this.isExplicitLibDslWrapperCall(node, fclos, callInfo, scope)
  }

  private hasEmptyCallableBody(fclos: SymbolValueType): boolean {
    const body = (fclos?.ast?.fdef as { body?: unknown } | undefined)?.body
    if (!body) return true
    const statements = Array.isArray(body) ? body : Array.isArray((body as { body?: unknown }).body) ? (body as { body: unknown[] }).body : []
    return statements.length === 0
  }

  private isExplicitLibDslWrapperCall(node: CallExpression, fclos: SymbolValueType, callInfo: CallInfo | undefined, scope: ScopeType): boolean {
    return this.loadLibFuncTagPropagationRule().some((rule: LibFuncTagPropagationRule) => {
      if (rule.applyWithBody !== true || rule?.source?.type !== 'ARG' || rule?.target?.type !== 'THIS' || rule?.target?.tripleWrite !== true) {
        return false
      }
      if (!rule.func) {
        return false
      }
      return matchSinkAtFuncCallWithCalleeType(node, fclos, [rule.func], scope, callInfo)?.length > 0
    })
  }

  /**
   * 子类可在长函数调用边界中断执行，例如 Java 入口点超时。
   */
  protected shouldAbortExecutionForTimeout(_state: State): boolean {
    return false
  }

  /**
   * 单入口内存护栏 hook：子类 override 在 processInstruction/executeCall 边界检查 heapUsed，
   * 超阈返回 true 提前退出当前入口。基类默认 false（护栏 disabled 或子类未实装）。
   */
  protected shouldAbortExecutionForMemory(_state: State): boolean {
    return false
  }

  /**
   * 内存护栏状态：子类（如 Python）override 时持有，基类默认 undefined。
   * symbolInterpret 主循环每入口开始前通过 resetMemoryGuardForEntryPoint 重置。
   */
  protected memoryGuardState: MemoryGuardState | undefined

  /**
   * 入口开始前重置护栏状态。子类 override 写入具体 state（基类 noop）。
   * 默认实现确保未实装护栏的语言不会崩溃。
   */
  protected resetMemoryGuardForEntryPoint(_entryPointLabel: string): void {
    // 基类 noop，子类可 override
  }

  /**
   * 入口结束后处理护栏 diagnostics + flush。子类 override 写入具体行为。
   * 返回是否触发了 abort（用于上层 recordEntryPointLoopMetric skipReason）。
   */
  protected onEntryPointMemoryGuardFinalize(_entryPoint: unknown, _findingsBefore: number): {
    aborted: boolean
    peakHeapMb: number
    deltaHeapMb: number
  } {
    return { aborted: false, peakHeapMb: 0, deltaHeapMb: 0 }
  }

  /**
   * process function calls; handle function unions
   * @param node: AST function call node
   * @param fclos: function closure
   * @param argvalues: the arguments
   * @param node
   * @param fclos
   * @param argvalues
   * @param state
   * @param scope
   * @param callInfo
   * @returns {*}
   */
  executeCall(node: any, fclos: any, state: State, scope: any, callInfo: CallInfo): any {
    if (this.shouldAbortExecutionForTimeout(state)) return new UndefinedValue()
    if (this.shouldAbortExecutionForMemory(state)) return new UndefinedValue()
    callInfo = this.ensureCallInfo(node, fclos, callInfo)
    callInfo = this.getDecoratorForwardedCallInfo(fclos, callInfo)
    const argvalues = getLegacyArgValues(callInfo)
    if (Config.miniSaveContextEnvironment) {
      return new CallExprValue(scope.qid, fclos, argvalues, node, node?.loc, fclos)
    }
    if (
      Config.makeAllCG &&
      state.callstack?.length > 0 &&
      fclos?.ast.fdef?.type === 'FunctionDefinition' &&
      this.ainfo?.callgraph?.nodes
    ) {
      for (const callgraphnode of this.ainfo?.callgraph?.nodes.values()) {
        // 从 nodehash 还原 funcDef
        let callgraphFuncDef = callgraphnode.opts?.funcDef
        if (callgraphnode.opts?.funcDefNodehash && this.astManager) {
          callgraphFuncDef = this.astManager.get(callgraphnode.opts.funcDefNodehash)
        }
        if (
          callgraphFuncDef?.loc?.start?.line &&
          callgraphFuncDef?.loc?.end?.line &&
          callgraphFuncDef?.loc?.sourcefile === fclos.ast.fdef?.loc?.sourcefile &&
          callgraphFuncDef?.loc?.start?.line === fclos.ast.fdef?.loc?.start?.line &&
          callgraphFuncDef?.loc?.end?.line === fclos.ast.fdef?.loc?.end?.line
        ) {
          this.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
            callInfo,
            fclos,
            pcond: state.pcond,
            entry_fclos: this.entry_fclos,
            einfo: state.einfo,
            state,
            analyzer: this,
            ainfo: this.ainfo,
          })
          return new CallExprValue(scope.qid, fclos, argvalues, node, node?.loc, fclos)
        }
      }
    }

    // process the function body
    if (fclos.ast.fdef || fclos.runtime?.execute) {
      const shouldApplyLibPropagation = this.shouldApplyLibPropagationForCallableWithBody(node, fclos, callInfo, scope)
      const libPropagationResult = shouldApplyLibPropagation
        ? this.processLibFuncTagPropagation(node, fclos, callInfo, scope, state)
        : undefined
      const { decorators } = fclos
      // const decorators = fclos.ast && fclos.ast.decorators;
      const bodyResult = decorators && decorators.length > 0
        ? this.executeCallWithDecorators(_.clone(decorators), fclos, state, node, scope, callInfo)
        : this.executeSingleCall(fclos, state, node, scope, callInfo)
      return bodyResult ?? libPropagationResult?.res
    }
    if (fclos.vtype === 'union') {
      const res: any[] = []
      for (const f of fclos.value) {
        if (!f) continue
        node = node || f.ast?.node
        const v = this.executeCall(node, f, state, scope, callInfo)
        if (v) res.push(v)
      }
      const len = res.length
      if (len === 0) {
      } else if (len === 1) return res[0]
      else
        return new UnionValue(
          res,
          undefined,
          `${scope.qid}.<union@call:${node?.loc?.start?.line}:${node?.loc?.start?.column}>`,
          node
        )
    }

    // now for the function without body
    if (this.checkerManager) {
      this.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        callInfo,
        fclos,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        analyzer: this,
        ainfo: this.ainfo,
      })
    }
    // a native function is built-in with semantics
    const native = NativeResolver.processNativeFunction.call(this, node, fclos, argvalues, state)
    if (native) return native

    const shouldLogLibCallDiagnostics = Config.enableLibCallDiagnostics === true
    const libCallDiagnosticsSnapshot = shouldLogLibCallDiagnostics
      ? this.buildLibCallDiagnosticsSnapshot(node, fclos, argvalues.length)
      : null
    const libPropagationResult = this.processLibFuncTagPropagation(node, fclos, callInfo, scope, state)
    if (shouldLogLibCallDiagnostics && libCallDiagnosticsSnapshot) {
      this.emitLibCallDiagnostics(
        libPropagationResult.matched ? 'lib_call_matched_rule' : 'lib_call_no_rule',
        node,
        fclos,
        libCallDiagnosticsSnapshot
      )
    }
    if (!libPropagationResult.matched) {
      // 没有配置的库函数，采用默认处理方式：arg->ret
      const res = this.processLibArgToRet(node, fclos, argvalues, scope, state, callInfo)
      if (this.enableLibArgToThis) {
        this.processLibArgToThis(node, fclos, argvalues, -1, scope, state, false, { preserveElements: true, mergeTraces: true, receiver: callInfo?.callArgs?.receiver })
      }
      return res
    }
    // ARG→RET schema 显式声明时，由 lib rule 构造的 res 必须返回，使下游 `request = JSON.parseObject(...)` 类赋值能拿到带 buffer 的返回值
    if (libPropagationResult.res !== undefined) {
      return libPropagationResult.res
    }
  }

  /**
   *
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   * @param state
   * @param callInfo
   */
  processLibArgToRet(node: any, fclos: any, argvalues: any, scope: any, state: any, callInfo: CallInfo) {
    // the case without function body, still process the call, e.g. perform taint propagation
    let res = _.clone(node)
    res.expression = fclos
    res.arguments = argvalues
    res.ast = node
    const argsSignature = this.buildLibCallArgsSignature(node.arguments)
    res.sid = `${fclos?.sid}(${argsSignature})`
    res.qid = `${fclos?.qid}(${argsSignature})`
    // res.field = {}
    let isTainted = false
    if (fclos.taint?.isTaintedRec) {
      isTainted = true
    }

    // 检查参数是否携带污点
    for (const arg of argvalues) {
      if (arg) {
        if (arg.taint?.isTaintedRec) {
          isTainted = true
          break
        }
      }
    }

    // e.g. XXInterface token = XXInterface(id) where id is ctorInit
    for (const arg of argvalues) {
      if (arg && arg.runtime?.ctorInit && node.expression && node.expression.value) {
        let top_scope = scope
        while (top_scope.parent) {
          top_scope = top_scope.parent
        }
        if (top_scope.value && top_scope.value[node.expression.value]) {
          if (!res.runtime) res.runtime = {}
          res.runtime.ctorInit = true
        }
      }
    }
    if (node.callee.type === 'MemberAccess') {
      if (fclos?.object?.taint?.isTaintedRec) {
        isTainted = true
      } else {
        /*
          first invoke: JSONObject.toJSONString();
          second invoke: JSONObject obj = new JSONObject(); obj.toJSONString();
         */
        const thisVal = fclos.getThisObj()
        if (
          thisVal &&
          ['symbol', 'object', 'uninitialized'].includes(thisVal.vtype) &&
          res.expression &&
          !res.expression.object &&
          thisVal.taint?.isTaintedRec
        ) {
          if (!res.expression.object) {
            res.expression.object = thisVal
          }
          isTainted = true
        }
      }
    }

    // return { type : 'FunctionCall', expression: fclos, arguments: argvalues,
    //          ast: node };
    res = new SymbolValue('', { sid: res.sid, qid: res.qid, ...res }) // esp. for member getter function
    if (isTainted) {
      res.taint?.markSource()
      // 参数影响返回值时，把参数挂到返回值 buffer，保留参数到返回值的传播关系。
      // 不直接复制参数 trace 到返回值自身，否则会绕过中间传播节点，改变 trace 形态并产生重复路径。
      for (const arg of argvalues) {
        if (arg?.taint?.isTaintedRec && _.isFunction(res.setMisc)) {
          addElementToBuffer(res, arg)
          this.materializeRecursiveInputTags(res, this.collectLibTagSources(arg))
        }
      }
    }

    // 成员方法返回值可能由 receiver 派生；receiver 已污染时，把 receiver 挂到返回值上保留传播关系。
    if (node.callee?.type === 'MemberAccess') {
      const thisObj = fclos.getThisObj?.()
      if (thisObj?.hasTagRec || thisObj?.taint?.isTaintedRec) {
        if (!res?.taint?.isTaintedRec) res?.taint?.markSource?.()
        if (_.isFunction(res.setMisc)) {
          addElementToBuffer(res, thisObj)
          this.materializeRecursiveInputTags(res, this.collectLibTagSources(thisObj))
        }
      }
    }

    // 将传入参数存入 misc_，hasTagRec 迭代 misc_ 时可发现污点参数，实现参数→返回值污点传播
    if (argvalues.length > 0) {
      res.setMisc('pass-in', argvalues)
    }

    // 采集阶段: 记录 arg→ret 边（对应 runtime 的 isTainted→markSource + setMisc 行为）
    // 同时补 receiver→ret 边：MemberAccess lib call（x.foo()）的 receiver 污点也应传到返回值，
    // 对齐上方 L2993-2998 addElementToBuffer(res, thisObj) 的 runtime 语义。
    if (isDataflowInstrumentationEnabled()) {
      const { recordEdge } = require('./dataflow-edge-stats')
      for (const arg of argvalues) {
        if (arg) recordEdge(arg, res, 'lib_arg_to_ret')
      }
      if (node.callee?.type === 'MemberAccess') {
        const thisObj = fclos.getThisObj?.()
        if (thisObj) recordEdge(thisObj, res, 'lib_arg_to_ret')
      }
    }
    return res
  }


  buildLibCallArgsSignature(args: any): string {
    if (!Array.isArray(args) || args.length === 0) return ''
    return args.map((arg: any) => {
      const printed = AstUtil.prettyPrintAST(arg)
      return printed.length > 80 ? `${printed.slice(0, 80)}...` : printed
    }).join(', ')
  }

  /**
   * process lib func tag propagation
   * @param node
   * @param fclos
   * @param argvalues
   * @param callInfo
   * @param scope
   * @param state
   */
  processLibFuncTagPropagation(node: any, fclos: any, callInfo: CallInfo | undefined, scope: any, state: any): { matched: boolean; res?: any } {
    const argvalues = getLegacyArgValues(callInfo)
    let matchRuleFound = false
    let retValue: any
    const libFuncTagPropagationRuleArray = this.loadLibFuncTagPropagationRule()
    for (const libFuncTagPropagationRule of libFuncTagPropagationRuleArray) {
      if (
        matchSinkAtFuncCallWithCalleeType(node, fclos, [libFuncTagPropagationRule.func], scope, callInfo)?.length > 0 ||
        this.findMatchedRuleByCallGraph(node, scope, [libFuncTagPropagationRule.func])?.length > 0
      ) {
        const sourceType = libFuncTagPropagationRule.source?.type
        const targetType = libFuncTagPropagationRule.target?.type
        if (!sourceType || !targetType) {
          continue
        }

        if (sourceType === 'ARG' && targetType === 'ARG') {
          const needsArgToArgTraceMaterialization = libFuncTagPropagationRule.target?.tripleWrite === true
          if (needsArgToArgTraceMaterialization) {
            // 显式三写规则需要 materialize 语言级 tag key，避免仅 buffer 传播被后续识别跳过。
            this.processLibArgToArgWithBuffer(
              node,
              fclos,
              argvalues,
              libFuncTagPropagationRule.source.index,
              libFuncTagPropagationRule.target.index,
              scope,
              state
            )
          } else {
            this.processLibArgToArg(
              node,
              fclos,
              argvalues,
              libFuncTagPropagationRule.source.index,
              libFuncTagPropagationRule.target.index,
              scope,
              state
            )
          }
          matchRuleFound = true
        } else if (sourceType === 'ARG' && targetType === 'THIS') {
          this.processLibArgToThis(
            node,
            fclos,
            argvalues,
            libFuncTagPropagationRule.source.index,
            scope,
            state,
            !!libFuncTagPropagationRule.target?.propagateToOwner,
            { mergeTraces: libFuncTagPropagationRule.target?.tripleWrite === true, receiver: callInfo?.callArgs?.receiver }
          )

          if (libFuncTagPropagationRule.target?.returnThis === true) {
            retValue = callInfo?.callArgs?.receiver ?? (typeof fclos?.getThisObj === 'function' ? fclos.getThisObj() : fclos?._this)
          }
          matchRuleFound = true
        } else if (sourceType === 'THIS' && targetType === 'ARG') {
          this.processLibThisToArg(node, fclos, argvalues, libFuncTagPropagationRule.target.index, scope, state)
          matchRuleFound = true
        } else if (sourceType === 'ARG' && targetType === 'RET') {
          // 显式声明型 ARG→RET 双写：构造 res + markSource + addElementToBuffer(res, arg)。
          // 用于反序列化（如 JSON.parseObject）等返回新对象、需把 arg 端 buffer 的深层 tag 复制到 RET 的 lib 调用

          const sourceIndexes = Array.isArray(libFuncTagPropagationRule.source.index)
            ? libFuncTagPropagationRule.source.index
            : [libFuncTagPropagationRule.source.index]
          for (const sourceIndex of sourceIndexes) {
            retValue = this.processLibArgToRetWithBuffer(node, fclos, argvalues, sourceIndex, scope, state, callInfo, retValue)
          }
          matchRuleFound = true
        } else if (sourceType === 'THIS' && targetType === 'RET') {
          // 显式声明型 THIS→RET 三写：构造 res + markSource + addElementToBuffer(res, _this)。
          // 用于 dict-access 模式（如 JSONObject.getString(key)）等 receiver 携 carrier、key 是字面量且返回字段值的 lib 调用
          retValue = this.processLibThisToRetWithBuffer(node, fclos, argvalues, scope, state, callInfo)
          matchRuleFound = true
        }
      }
    }

    return { matched: matchRuleFound, res: retValue }
  }

  /**
   * lib ARG→RET 双写：构造 res（复用 processLibArgToRet 的语义）后显式 addElementToBuffer(res, arg)，
   * 让 arg 端 buffer 子层语言级 tag（JAVA_INPUT 等）在 res 端可被 satisfy BFS 递归发现
   * @param node
   * @param fclos
   * @param argvalues
   * @param sourceIndex source ARG index
   * @param scope
   * @param state
   * @param callInfo
   */

  processLibArgToRetWithBuffer(
    node: CallExpression,
    fclos: SymbolValueType,
    argvalues: Value[],
    sourceIndex: number,
    scope: ScopeType,
    state: State,
    callInfo: CallInfo | undefined,
    existingRes?: Value
  ): Value {
    const res = existingRes ?? this.processLibArgToRet(node, fclos, argvalues, scope, state, callInfo as CallInfo)
    if (argvalues && sourceIndex !== undefined && sourceIndex !== null && sourceIndex >= 0 && argvalues[sourceIndex] !== undefined) {
      const arg = argvalues[sourceIndex]
      if (arg && _.isFunction(res?.setMisc)) {
        if (!res?.taint?.isTaintedRec && (arg.taint?.isTaintedRec || arg.hasTagRec)) {
          res?.taint?.markSource?.()
        }
        addElementToBuffer(res, arg)
        // 把 arg.tagTraces 合到 res.tagTraces（含语言级 tag key 如 JAVA_INPUT），不依赖 sink-side BFS 深层遍历

        if ((arg.taint?.getTags?.().length ?? 0) > 0 && _.isFunction(res?.taint?.mergeTracesFrom)) {
          res.taint.mergeTracesFrom(arg.taint)
        } else if (arg.taint?.isTaintedRec) {
          // arg 自身 tagTraces 空但递归 tainted（典型：getInput 类 getter 把 invoke 放 buffer）→ 浅扫 arg.misc_.buffer 一层把内层 tag key 复制到 res
          const buf = arg?.misc_?.buffer
          if (Array.isArray(buf)) {
            for (const elem of buf) {

              if ((elem?.taint?.getTags?.().length ?? 0) > 0 && _.isFunction(res?.taint?.mergeTracesFrom)) {
                res.taint.mergeTracesFrom(elem.taint)
              }
            }
          }
        }
      }
    }
    return res
  }

  mergeLibSourceTracesIntoTarget(target: ValueLike, source: ValueLike): void {
    if (!target?.taint || !source?.taint?.isTaintedRec || typeof target.taint.mergeTracesFrom !== 'function') {
      return
    }
    const candidateTagSources = this.collectLibTagSources(source)
    for (const src of candidateTagSources) {
      if (typeof target.taint.mergeTracesDedup === 'function') {
        target.taint.mergeTracesDedup(src)
      } else {
        target.taint.mergeTracesFrom(src)
      }
    }
    this.materializeRecursiveInputTags(target, candidateTagSources)
  }

  materializeRecursiveInputTags(target: ValueLike, candidateTagSources: TaintLike[]): void {
    if (!target?.taint || candidateTagSources.length === 0) return
    const inputTags = ['JAVA_INPUT', 'PYTHON_INPUT', 'GO_INPUT', 'PHP_INPUT', 'JS_INPUT', 'JAVASCRIPT_INPUT']
    for (const sourceTaint of candidateTagSources) {
      const tagTraceMap = typeof sourceTaint.getTagTracesMap === 'function'
        ? sourceTaint.getTagTracesMap()
        : sourceTaint.tagTraces
      if (!(tagTraceMap instanceof Map)) continue
      for (const tag of inputTags) {
        if (!tagTraceMap.has(tag)) continue
        const targetTrace = typeof target.taint.getTrace === 'function' ? target.taint.getTrace(tag) : undefined
        if (Array.isArray(targetTrace) && targetTrace.length > 0) continue
        target.taint.markSource?.()
        const trace = typeof sourceTaint.getTrace === 'function' ? sourceTaint.getTrace(tag) : tagTraceMap.get(tag)
        if (Array.isArray(trace) && trace.length > 0 && typeof target.taint.materializeTagTrace === 'function') {
          target.taint.materializeTagTrace(tag, trace)
        } else if (!target.taint.containsTag?.(tag)) {
          target.taint.addTag?.(tag)
        }
      }
    }
  }

  collectLibTagSources(source: unknown, visited: Set<object> = new Set(), depth: number = 0): TaintLike[] {
    if (!source || typeof source !== 'object' || visited.has(source) || depth > 8) return []
    visited.add(source)
    const sourceValue = source as ValueLike
    const result: TaintLike[] = []
    const sourceTaint = sourceValue.taint
    if (sourceTaint && (sourceTaint.getTags?.().length ?? 0) > 0) {
      result.push(sourceTaint)
    }
    const visitChild = (child: unknown): void => {
      result.push(...this.collectLibTagSources(child, visited, depth + 1))
    }
    const buf = sourceValue.misc_?.buffer
    if (Array.isArray(buf)) {
      for (const child of buf) visitChild(child)
    }
    const passIn = sourceValue.misc_?.['pass-in']
    if (Array.isArray(passIn)) {
      for (const child of passIn) visitChild(child)
    }
    if (sourceValue._field && typeof sourceValue._field === 'object') {
      for (const child of Object.values(sourceValue._field)) visitChild(child)
    }
    if (sourceValue.value && typeof sourceValue.value === 'object') {
      if (Array.isArray(sourceValue.value)) {
        for (const child of sourceValue.value) visitChild(child)
      } else {
        for (const child of Object.values(sourceValue.value as Record<string, unknown>)) visitChild(child)
      }
    }
    return result
  }

  /**
   * lib THIS→RET 三写：构造 res（复用 processLibArgToRet 的语义）后显式 addElementToBuffer(res, _this)，
   * 让 receiver 端 buffer 子层语言级 tag（JAVA_INPUT 等）在 res 端可被 satisfy BFS 递归发现。
   * 适用于 dict-access 模式：receiver 携 carrier、key 是字面量、返回字段值（如 fastjson JSONObject.getString(key)）。
   * 与 processLibArgToRetWithBuffer 对称，区别仅在 source 端从 ARG[index] 改为 fclos._this / fclos.getThisObj()。
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   * @param state
   * @param callInfo
   */
  processLibThisToRetWithBuffer(node: any, fclos: any, argvalues: any, scope: any, state: any, callInfo: CallInfo | undefined) {
    const res = this.processLibArgToRet(node, fclos, argvalues, scope, state, callInfo as CallInfo)
    const thisVal = typeof fclos?.getThisObj === 'function' ? fclos.getThisObj() : fclos?._this
    if (thisVal && _.isFunction(res?.setMisc)) {
      if (!res?.taint?.isTaintedRec && (thisVal.taint?.isTaintedRec || thisVal.hasTagRec)) {
        res?.taint?.markSource?.()
      }
      addElementToBuffer(res, thisVal)
      // 把 receiver.tagTraces 合到 res.tagTraces（含语言级 tag key 如 JAVA_INPUT），不依赖 sink-side BFS 深层遍历
      if (thisVal.taint?.tagTraces instanceof Map && thisVal.taint.tagTraces.size > 0 && _.isFunction(res?.taint?.mergeTracesFrom)) {
        res.taint.mergeTracesFrom(thisVal.taint)
      } else if (thisVal.taint?.isTaintedRec) {
        // receiver 自身 tagTraces 空但递归 tainted（如 parseObject 三写后 receiver 把 carrier 放 buffer 而非自身 tagTraces）→ 浅扫 receiver.misc_.buffer 一层
        const buf = thisVal?.misc_?.buffer
        if (Array.isArray(buf)) {
          for (const elem of buf) {
            if (elem?.taint?.tagTraces instanceof Map && elem.taint.tagTraces.size > 0 && _.isFunction(res?.taint?.mergeTracesFrom)) {
              res.taint.mergeTracesFrom(elem.taint)
            }
          }
        }
      }
    }
    return res
  }

  /**
   * process lib arg to arg
   * @param node
   * @param fclos
   * @param argvalues
   * @param sourceIndex
   * @param targetIndex
   * @param scope
   * @param state
   */
  processLibArgToArg(
    node: any,
    fclos: any,
    argvalues: any,
    sourceIndex: any,
    targetIndex: any,
    scope: any,
    state: any
  ) {
    if (!argvalues || argvalues.length < 2 || !targetIndex || targetIndex >= argvalues.length) {
      return
    }
    let res = argvalues[targetIndex]

    res.setMisc('precise', false)
    moveExistElementsToBuffer(res)

    const passIn = res.getMisc('buffer') || []
    for (const argIndex in argvalues) {
      if (sourceIndex >= 0 && sourceIndex !== Number(argIndex)) {
        continue
      }
      const arg = argvalues[argIndex]
      passIn.push(arg)
      if (arg.taint?.isTaintedRec) {
        res.taint?.markSource()
        // 参数影响目标参数时，只在目标参数上记录当前调用点；原始 source trace 继续留在 buffer 中。
        // 这样 sink 侧仍能沿 buffer 找到 source，同时 trace 保留库调用这个中间传播节点。
        res = SourceLine.addSrcLineInfo(res, node, node.loc && node.loc.sourcefile, 'Var Pass: ', res.sid)
      }
    }

    res.setMisc('buffer', passIn)
  }

  /**
   * lib ARG→ARG 三写（opt-in via schema target.tripleWrite=true）：
   * 复用 processLibArgToArg 的 markSource + buffer push，再显式把 arg.tagTraces 的语言级 tag key 合到 target.taint。
   * 与 processLibArgToRetWithBuffer 的语言级 tag 合并保持对称，让 satisfy BFS 起点过滤 `tagTraces.has(JAVA_INPUT)` 在 target 自身命中，
   * 而不依赖深层 buffer 走 walk（buffer-only 无法满足后续 sink 起点过滤）。
   * 仅显式声明 `target.tripleWrite=true` 的 schema rule 触发，对未声明的 ARG→ARG 默认路径零影响（不污染 BeanUtils.copyProperties / System.arraycopy 等既有 rule 表现）。
   * @param node
   * @param fclos
   * @param argvalues
   * @param sourceIndex
   * @param targetIndex
   * @param scope
   * @param state
   */
  processLibArgToArgWithBuffer(
    node: any,
    fclos: any,
    argvalues: any,
    sourceIndex: any,
    targetIndex: any,
    scope: any,
    state: any
  ) {
    if (!argvalues || argvalues.length < 2 || !targetIndex || targetIndex >= argvalues.length) {
      return
    }
    if (sourceIndex === undefined || sourceIndex === null || sourceIndex < 0 || sourceIndex >= argvalues.length) {
      return
    }
    const target = argvalues[targetIndex]
    const arg = argvalues[sourceIndex]
    if (!arg?.taint?.isTaintedRec || !target?.taint || typeof target.taint.mergeTracesFrom !== 'function') {
      return
    }
    // 收集要合并的 tag key 集合（arg 自身优先；arg 自身 tagTraces 空则浅扫一层 buffer 取深层 key）
    const candidateTagSources: any[] = []
    if (arg.taint?.tagTraces instanceof Map && arg.taint.tagTraces.size > 0) {
      candidateTagSources.push(arg.taint)
    } else {
      const buf = arg?.misc_?.buffer
      if (Array.isArray(buf)) {
        for (const child of buf) {
          if (child?.taint?.tagTraces instanceof Map && child.taint.tagTraces.size > 0) {
            candidateTagSources.push(child.taint)
          }
        }
      }
    }
    if (candidateTagSources.length === 0) {
      return
    }
    // 幂等守卫：若 target.tagTraces 已包含所有候选 tag key，则完全跳过，防止重试或同一调用点多次解释时累积重复 buffer。
    // 典型场景是循环内反复向同一容器写入等价污点，首次染色后后续等价写入可视为无变化。
    const targetTraces = target.taint?.tagTraces
    if (targetTraces instanceof Map && targetTraces.size > 0) {
      let allPresent = true
      for (const src of candidateTagSources) {
        for (const [k] of src.tagTraces) {
          if (!targetTraces.has(k)) { allPresent = false; break }
        }
        if (!allPresent) break
      }
      if (allPresent) {
        return
      }
    }
    // 第一次染：base processLibArgToArg 完成 markSource + buffer push，再做三写 mergeTracesDedup 把 source tag key 拷到 target.taint
    this.processLibArgToArg(node, fclos, argvalues, sourceIndex, targetIndex, scope, state)
    for (const src of candidateTagSources) {
      if (typeof target.taint.mergeTracesDedup === 'function') {
        target.taint.mergeTracesDedup(src)
      } else {
        target.taint.mergeTracesFrom(src)
      }
    }
  }

  /**
   * process lib arg to this
   * @param node
   * @param fclos
   * @param argvalues
   * @param sourceIndex
   * @param scope
   * @param state
   * @param propagateToOwner
   */
  processLibArgToThis(
    node: any,
    fclos: any,
    argvalues: any,
    sourceIndex: any,
    scope: any,
    state: any,
    propagateToOwner: boolean = false,
    options: { preserveElements?: boolean; mergeTraces?: boolean; receiver?: any } = {}
  ) {
    let thisVal = options.receiver ?? fclos.getThisObj()

    if (!argvalues || argvalues.length === 0 || !thisVal || !this.isValidLibArgToThisTarget(thisVal)) {
      return
    }

    thisVal.setMisc('precise', false)
    moveExistElementsToBuffer(thisVal)

    switch (node.callee.type) {
      case 'MemberAccess':
        for (const argIndex in argvalues) {
          if (sourceIndex >= 0 && sourceIndex !== Number(argIndex)) {
            continue
          }
          const arg = argvalues[argIndex]
          const argHasSource = !!(arg?.taint?.isTaintedRec || arg?.hasTagRec)
          if (!argHasSource) {
            continue
          }
          const bufferArg = options.preserveElements ? this.snapshotEscapedElementValue(arg) : arg
          addElementToBuffer(thisVal, bufferArg)
          if (arg.taint?.isTaintedRec) {
            thisVal.taint?.markSource()
            if (node?.parent?.type !== 'AssignmentExpression') {
              thisVal = SourceLine.addSrcLineInfo(
                thisVal,
                node,
                node.loc && node.loc.sourcefile,
                'Var Pass: ',
                node?.callee?.object ? prettyPrint(node.callee.object) : thisVal.sid
              )
            }
            if (options.mergeTraces === true) {
              this.mergeLibSourceTracesIntoTarget(thisVal, arg)
            }
          }
        }
        // C.1b getter-chain 反向染：仅当规则 opt-in `propagateToOwner:true` 且 thisVal 真被染后，
        // 若 thisVal 是 `owner.getter()` 返回的 SymbolValue（带 expression.object 回指），
        // 同跑一套 arg2this 守卫把 taint 反向传到 owner，1 跳不递归。默认 fallback 恒传 false 不触发。
        // 关键：markSource 只置 hasTag 但不填 tagTraces，而 sink 侧走 tagTraceMap.has(attribute) 判断；
        // 必须把 arg 塞进 owner.misc_.buffer，让 sink 侧 satisfy 递归能发现深层语言级 tag（JAVA_INPUT/PYTHON_INPUT 等），
        // 再补 markSource 让 owner.isTaintedRec 短路为 true，与引擎现有 ARG→THIS 的双写口径对齐。
        if (propagateToOwner && thisVal.taint?.isTaintedRec) {
          const owner = thisVal.expression?.object
          if (owner && this.isValidLibArgToThisTarget(owner)) {
            for (const argIndex in argvalues) {
              if (sourceIndex >= 0 && sourceIndex !== Number(argIndex)) continue
              const arg = argvalues[argIndex]
              if (!arg?.taint?.isTaintedRec) continue
              addElementToBuffer(owner, arg)
            }
            owner.taint?.markSource()
            if (node?.parent?.type !== 'AssignmentExpression') {
              SourceLine.addSrcLineInfo(
                owner,
                node,
                node.loc && node.loc.sourcefile,
                'Var Pass: getter-chain reverse',
                owner.sid
              )
            }
          }
        }
        break
      case 'Identifier':
        break
      default:
        break
    }
  }

  /**
   * 判断目标 Value 是否可作为 lib arg→this 的染色目标。
   * processLibArgToThis 头部守卫与 opt-in 反向染 owner 复用同一组条件，
   * 以保证 §7 arg2this 黑名单 + class/constructor 保护 + syslib 注入守卫对两侧一致生效。
   * @param val 被评估的目标 Unit
   */
  isValidLibArgToThisTarget(val: any): boolean {
    if (!val) return false
    if (!['symbol', 'object'].includes(val.vtype)) return false
    if (!_.isFunction(val.setMisc)) return false
    if (this.shouldSkipLibArgToThisPropagation(val)) return false
    if (val.injected) return false
    // 内部类实例（sid 含 <instance）不应被 parentClass guard 阻止
    if (val?.parent?.vtype === 'class' && !val.sid?.includes('<instance')) return false
    if (val?.parent?._isConstructor && !val.sid?.includes('<instance')) return false
    if (val?._this?.vtype === 'class' && !val.sid?.includes('<instance')) return false
    if (val?._this?._isConstructor && !val.sid?.includes('<instance')) return false
    if (val.qid?.startsWith('<global>.syslib_from')) return false
    return true
  }

  /**
   * Check whether lib arg->this propagation should be skipped.
   * @param thisVal
   */
  shouldSkipLibArgToThisPropagation(thisVal: any) {
    if (!thisVal || typeof thisVal.sid !== 'string') {
      return false
    }
    const sid = thisVal.sid.toLowerCase()
    const keywords = this.loadLibArgToThisSidBlacklistKeywords()
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return false
    }
    return keywords.some((keyword) => {
      if (typeof keyword !== 'string') {
        return false
      }
      const normalizedKeyword = keyword.trim().toLowerCase()
      return normalizedKeyword.length > 0 && this.matchesLibArgToThisSidKeyword(sid, normalizedKeyword)
    })
  }

  matchesLibArgToThisSidKeyword(sid: string, keyword: string): boolean {
    if (!sid || !keyword) return false
    return sid.split(/[^a-z0-9_]+/).some((segment) => segment === keyword)
  }

  /**
   * process lib this to arg
   * @param node
   * @param fclos
   * @param argvalues
   * @param targetIndex
   * @param scope
   * @param state
   */
  processLibThisToArg(node: any, fclos: any, argvalues: any, targetIndex: any, scope: any, state: any) {
    if (!argvalues) {
      return
    }

    switch (node.callee.type) {
      case 'MemberAccess':
        const thisVal = this.processInstruction(scope, node.callee.object, state)
        for (const argIndex in argvalues) {
          if (targetIndex >= 0 && targetIndex !== Number(argIndex)) {
            continue
          }
          let arg = argvalues[argIndex]

          arg.setMisc('precise', false)
          moveExistElementsToBuffer(arg)

          if (thisVal && thisVal.taint?.isTaintedRec) {
            arg.setFieldValue(
              thisVal.sid,
              new ObjectValue(arg.qid, {
                sid: thisVal.sid,
                parent: arg,
                value: thisVal,
              })
            )
            arg.taint?.markSource()
            arg = SourceLine.addSrcLineInfo(arg, node, node.loc && node.loc.sourcefile, 'Var Pass: ', arg.sid)
          }
        }
        break
      case 'Identifier':
        break
      default:
        break
    }
  }

  /**
   * decorator will be executed with fclos as its parameter
   * note: decorators will be executed in order
   * @param decorators
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @param callInfo
   */
  executeCallWithDecorators(decorators: any, fclos: any, state: any, node: any, scope: any, callInfo: CallInfo) {
    if (!decorators || decorators.length === 0) {
      return this.executeSingleCall(fclos, state, node, scope, callInfo)
    }

    // The decorator expressions get called top to bottom, and produce decorators,
    // while decorators themselves run in the opposite direction, bottom to top.

    // 同名 shadowing 防御所需：保留本轮处理的全部 decorator sid 集合（pop 会清空 decorators）
    const originalDecoratorSids = new Set<string>(
      (decorators || []).map((d: any) => d?.sid).filter((s: any): s is string => Boolean(s))
    )

    let decorator = decorators.pop()
    let descriptor_fclos = fclos
    const class_obj = fclos.getThisObj() // fclos represents class method, the parent of it is class object

    while (decorator) {
      // preprocess 阶段兄弟 FunctionDefinition 尚未就绪，此处 decorator 可能是 SymbolValue（vtype=symbol）。
      // processInstruction 对已带 vtype 的 Value 会直接 return（analyzer.ts:919），所以必须用 sid 构造 Identifier AST
      // 从 runtime scope 重查 fclos；查不到就保持原 symbol，不阻塞后续 guard（guard 会跳过 executeCall）。
      if (decorator?.vtype !== 'fclos' && decorator?.sid) {
        const lookupNode = { type: 'Identifier', name: decorator.sid, loc: decorator.ast?.node?.loc }
        const resolved = this.getMemberValue(scope, lookupNode, state)
        if (resolved?.vtype === 'fclos') {
          decorator = resolved
        }
      }

      let descriptor = new ObjectValue(descriptor_fclos.qid, { sid: 'descriptor' })
      descriptor.value.value = lodashCloneWithTag(descriptor_fclos)
      const { name } = decorator // both function decl and identifier have name
      // target 应为被装饰函数（descriptor_fclos），而非装饰器本体；Python descriptor 协议下装饰器形参接收被装饰函数。
      // 若 descriptor_fclos 自身带 decorators（只在第一轮：fclos 就是入口函数），要去掉 target 自身的 decorators 再传给装饰器，
      // 避免装饰器 wrapper 内 `return f(*args, **kwargs)` 触发 executeCall(target) 时再次进入 executeCallWithDecorators 递归消耗预算。
      let target: any = descriptor_fclos
      if (descriptor_fclos?.decorators && descriptor_fclos.decorators.length > 0) {
        target = lodashCloneWithTag(descriptor_fclos)
        target.decorators = []
      }
      this.rememberDecoratorForwardedCallInfo(target, callInfo)
      this.rememberDecoratorForwardedCallInfo(descriptor_fclos, callInfo)
      decorator._this = class_obj
      let descriptor_res
      // const decorator_clos = this.getMemberValue(scope, decorator, state);
      const decorator_clos = decorator

      // if decorator is not found, just skip it
      // TODO decorators that can't be found should be summary analyzed
      if (decorator_clos?.vtype === 'fclos' && !shallowEqual(decorator_clos.ast?.node, decorator)) {
// 同名 shadowing 防御：装饰器自身（outer fclos）若挂着与本轮 decorator 链同 sid 的 decorators
        // （例如 view.py 的 `@jiekou_save` 通过 sid 反查关联到 jiekou_save.py 的 outer def，
        // outer def 又因同名被错误归属为「自己装饰自己」），调用它会再次进入 executeCallWithDecorators，
        // 与 executeCall(2822) 形成无门控环。此处把 decorator 自身的 decorators 剥离后再 dispatch
        let decoratorForCall = decorator
        if (
          decoratorForCall?.decorators?.length > 0 &&
          decoratorForCall?.sid &&
          originalDecoratorSids.has(decoratorForCall.sid)
        ) {
          decoratorForCall = lodashCloneWithTag(decoratorForCall)
          decoratorForCall.decorators = []
        }
        const decoratorCallInfo: CallInfo = { callArgs: this.buildCallArgs(node, [target, name, descriptor], decoratorForCall) }
        descriptor_res = this.executeCall(node, decoratorForCall, state, scope, decoratorCallInfo)
      } else {
        descriptor_res = null
      }

      if (descriptor_res && descriptor_res.value.value) {
        descriptor = descriptor_res
      } else if (descriptor_res?.vtype === 'fclos') {
        // 装饰器直接返回 wrapper fclos（未包在 descriptor.value.value 里）：把 wrapper 塞进 descriptor 以便后续 getMemberValue 取到
        descriptor.value.value = descriptor_res
      }

      descriptor_fclos = this.getMemberValue(
        descriptor,
        new PrimitiveValue(scope.qid, '<decoratorValue>', 'value', null, 'Literal'),
        state
      )
      // descriptor_fclos runs with class object as it's [this], which can be located from parent of class method
      descriptor_fclos._this = class_obj
      decorator = decorators.pop()
    }
    // 同名 shadowing 防御：装饰器链回卷得到的 descriptor_fclos 与原 decorator 同 sid（Python 内层 wrapper 与外层 def 同名场景），
    // 若仍携带继承的 decorators 则会在 executeSingleCall→processInstruction→executeCall 再次进入 executeCallWithDecorators 形成无门控环
    if (
      descriptor_fclos?.vtype === 'fclos' &&
      descriptor_fclos.decorators?.length > 0 &&
      descriptor_fclos.sid &&
      originalDecoratorSids.has(descriptor_fclos.sid)
    ) {
      descriptor_fclos = lodashCloneWithTag(descriptor_fclos)
      descriptor_fclos.decorators = []
    }
    return this.executeSingleCall(descriptor_fclos, state, descriptor_fclos.ast?.node, scope, callInfo)
  }

  /**
   * process function calls; go into the function body when it is available
   * @param fclos
   * @param argvalues
   * @param state
   * @param node: for accessing AST information
   * @param node
   * @param scope
   * @param callInfo
   * @returns {undefined|*}
   */
  executeSingleCall(fclos: any, state: State, node: any, scope: any, callInfo: CallInfo) {
    const argvalues = getLegacyArgValues(callInfo)
    let fdecl = fclos.ast.fdef
    let fname // name of the function

    if (fclos && fclos.vtype === 'union') {
      const res = new UnionValue(
        undefined,
        undefined,
        `${scope.qid}.<union@exec:${node?.loc?.start?.line}:${node?.loc?.start?.column}>`,
        node
      )
      for (const fc of fclos.value) {
        node = node || fc.ast?.node
        res.appendValue(this.executeSingleCall(fc, state, node, scope, callInfo))
      }
      return res
    }
    let execute_builtin = false
    if (!fdecl) {
      if (!fclos.runtime?.execute) {
        return new CallExprValue(scope.qid, fclos, argvalues, node, node?.loc)
      }
      // execute prepared builtins function
      execute_builtin = true
    } else {
      fname = fdecl.name
      if (fdecl.type === 'StructDefinition') {
        return this.buildNewObject(fdecl, fclos, state, node, scope, callInfo)
      }
      if (fdecl.type === 'ClassDefinition' && fclos.value?._CTOR_ && fclos.value?._CTOR_.vtype === 'fclos') {
        fdecl = fclos?.value?._CTOR_?.ast.fdef
      }
      if (fdecl.type !== 'FunctionDefinition') {
        return new UndefinedValue()
      }
    }
    fname = fname || fclos.sid || ''
    if (fname.includes('<anonymous')) {
      fname = fclos.sid
    }

    let extraFuncDefs = []
    const overloadedNodes = fclos.overloaded?.filter(() => true) ?? []
    if (overloadedNodes.length > 1) {
      // overloaded functions
      let hasFind = false
      let maxMatchNum = 0
      let maxMatchFdef
      for (const f of overloadedNodes) {
        let matchNum = 0
        let paramLength = 0
        const params = f.parameters
        if (params) {
          paramLength = Array.isArray(params) ? params.length : params.parameters.length
        }
        const literalTypeList = ['String', 'string', 'int', 'Integer', 'Double', 'double', 'float', 'Float']
        let typeMatch = false
        if (paramLength === argvalues.length) {
          typeMatch = true
          for (let i = 0; i < paramLength; i++) {
            const param = params[i]
            if (
              param.varType?.id?.name === argvalues[i].rtype?.definiteType?.name ||
              argvalues[i].rtype?.definiteType?.name?.endsWith(`.${param.varType?.id?.name}`) ||
              (argvalues[i].vtype === 'primitive' && literalTypeList.includes(param.varType?.id?.name))
            ) {
              matchNum++
              continue
            }
            typeMatch = false
          }
          if (matchNum > maxMatchNum) {
            maxMatchNum = matchNum
            maxMatchFdef = f
            extraFuncDefs = []
          } else if (matchNum === maxMatchNum) {
            extraFuncDefs.push(f)
          }
        } else if (
          paramLength < argvalues.length &&
          paramLength > 0 &&
          params[paramLength - 1]?.varType?._meta?.varargs
        ) {
          typeMatch = true
          for (let i = 0; i < argvalues.length; i++) {
            const param = i < paramLength ? params[i] : params[paramLength - 1]
            if (
              param.varType?.id?.name === argvalues[i].rtype?.definiteType?.name ||
              argvalues[i].rtype?.definiteType?.name?.endsWith(`.${param.varType?.id?.name}`) ||
              (argvalues[i].vtype === 'primitive' && literalTypeList.includes(param.varType?.id?.name))
            ) {
              matchNum++
              continue
            }
            typeMatch = false
          }
          if (matchNum > maxMatchNum) {
            maxMatchNum = matchNum
            maxMatchFdef = f
            extraFuncDefs = []
          } else if (matchNum === maxMatchNum) {
            extraFuncDefs.push(f)
          }
        }
        if (typeMatch) {
          hasFind = true
          fclos = lodashCloneWithTag(fclos)
          fdecl = f // adjust to the right function definition
          fclos.ast = fdecl
          fclos.ast.fdef = fdecl
        }
      }
      // 兜底，假设类型完全没匹配到（类型检测没适配好），就走长度匹配
      if (!hasFind) {
        if (maxMatchFdef) {
          fclos = lodashCloneWithTag(fclos)
          fclos.ast = maxMatchFdef
          fclos.ast.fdef = maxMatchFdef
          fdecl = maxMatchFdef
        } else {
          for (const f of overloadedNodes) {
            let paramLength = 0
            const params = f.parameters
            if (params) {
              paramLength = Array.isArray(params) ? params.length : params.parameters.length
            }
            if (
              paramLength === argvalues.length ||
              (paramLength < argvalues.length && paramLength > 0 && params[paramLength - 1]?.varType?._meta?.varargs)
            ) {
              fclos = lodashCloneWithTag(fclos)
              fclos.ast = f
              fclos.ast.fdef = f
              fdecl = f // adjust to the right function definition
              break
            }
          }
        }
      }
    }

    // 在进入 executeFdeclOrExecute 前，预计算形参绑定
    const activeCallInfo = this.getDecoratorForwardedCallInfo(fclos, callInfo)
    if (activeCallInfo) {
      const boundCall = this.bindCallArgs(node, fclos, fdecl, activeCallInfo)
      activeCallInfo.boundCall = boundCall
    }
    const return_value = this.executeFdeclOrExecute(fclos, state, node, scope, fdecl, fname, execute_builtin, activeCallInfo)
    extraFuncDefs = extraFuncDefs.filter((extraFuncDef) => extraFuncDef !== fclos.ast?.node)
    if (extraFuncDefs.length === 0) {
      return return_value
    }
    const union_return_value = new UnionValue(
      undefined,
      undefined,
      `${scope.qid}.<union@overload:${node?.loc?.start?.line}:${node?.loc?.start?.column}>`,
      node
    )
    union_return_value.appendValue(return_value)
    for (const extraFuncDef of extraFuncDefs) {
      fclos = lodashCloneWithTag(fclos)
      fdecl = extraFuncDef
      fclos.ast = extraFuncDef
      fclos.ast.fdef = extraFuncDef
      // 每个 overload 需要独立绑定
      const extraCallInfo: CallInfo = { callArgs: callInfo?.callArgs, callsiteNode: callInfo?.callsiteNode }
      const extraBoundCall = this.bindCallArgs(node, fclos, fdecl, extraCallInfo)
      extraCallInfo.boundCall = extraBoundCall
      const extraReturnValue = this.executeFdeclOrExecute(fclos, state, node, scope, fdecl, fname, false, extraCallInfo)
      union_return_value.appendValue(extraReturnValue)
    }
    return union_return_value
  }

  /**
   *
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @param fdecl
   * @param fname
   * @param execute_builtin
   * @param callInfo
   */

  /**
   * Hook：形参 boundCall 绑定完成、body 执行之前调用。
   * 子类可 override 注入语言专用的形参后处理（例如 Python 装饰器路径下
   * 形参 SOURCE 显式 trigger）。基类默认空实现。
   */
  protected onParamsBound(fscope: any, params: any[], state: State, node: any): void {
    // intentionally empty — language analyzers override as needed
  }

  private shouldEmitAnonymousCallbackEntryTrace(node: Node, callInfo: CallInfo | undefined): boolean {
    const callsiteNode = callInfo?.callsiteNode
    return node?.type === 'FunctionDefinition' && Boolean(callsiteNode?.loc && callsiteNode !== node && callsiteNode.type !== 'FunctionDefinition')
  }

  private addAnonymousCallbackEntryTrace(targetValue: Value, callsiteNode: Node, fdecl: FunctionDefinition, fname: string): Value {
    const callbackNode = fdecl.loc ? fdecl : undefined
    if (!callsiteNode?.loc || !callbackNode?.loc) return targetValue
    const provenance = {
      callbackEdge: true,
      callbackClosureOwnerHash: fdecl?._meta?.nodehash,
    }
    const callTraced = SourceLine.addSrcLineInfo(targetValue, callsiteNode, callsiteNode.loc.sourcefile, 'CALL: ', fname, provenance)
    return SourceLine.addSrcLineInfo(callTraced, callbackNode, callbackNode.loc.sourcefile, 'ARG PASS: ', fname, provenance)
  }

  executeFdeclOrExecute(
    fclos: any,
    state: State,
    node: any,
    scope: any,
    fdecl: any,
    fname: any,
    execute_builtin: any,
    callInfo: CallInfo
  ) {
    const argvalues = getLegacyArgValues(callInfo)
    if (logger.isTraceEnabled()) logger.trace(`\nprocessCall: function: ${this.formatScope(fdecl?.id?.name)}`)

    // 进入函数调用时重置 inRange，避免 for-range body 中调用函数时嵌套 for-range 被错误抑制
    const savedInRange = this.inRange
    this.inRange = false

    // avoid infinite loops,the re-entry should only less than 3
    if (
      fdecl &&
      state.callstack.reduce((previousValue: any, currentValue: any) => {
        return currentValue.ast.fdef === fdecl ? previousValue + 1 : previousValue
      }, 0) > 0
    ) {
      this.inRange = savedInRange
      return new CallExprValue(scope.qid, fclos, argvalues, node, node?.loc, fclos)
    }

    // pre-call processing
    const oldThisFClos = this.thisFClos
    this.thisFClos = fclos.getThisObj()

    let fscope = Scope.createSubScope(`${fname}_scope`, fclos) // this is actually named "activation record" in computer science
    fscope._this = fclos._this
    if (fclos.vtype === 'class' || fclos._isConstructor) {
      // for javascript class ctor function
      fscope = fclos
    }

    // prepare execute state
    const new_state = _.clone(state)
    new_state.parent = state
    new_state.callstack = state.callstack ? state.callstack.concat([fclos]) : [fclos]
    const callsiteNode = callInfo?.callsiteNode || node
    const callsiteFrame: CallsiteFrame = {
      code: AstUtil.getRawCode(callsiteNode).slice(0, 100),
      nodeHash: callsiteNode?._meta?.nodehash,
      loc: callsiteNode?.loc,
    }
    new_state.callsites = state.callsites ? state.callsites.concat([callsiteFrame]) : [callsiteFrame]
    new_state.brs = ''
    // this.recordFunctionDefinitions(fscope, fdecl.body, new_state);

    // 调用点拆分: push 当前调用点到全局 callsite 栈，让进入函数体期间 ensureNode 能拿到完整 callsite_id
    // frame 用 callsite node loc，对齐 N2 SSA 粒度（调用点粒度设计）
    const _csFile = node?.loc?.sourcefile || node?.loc?.start?.sourcefile || ''
    const _csLine = node?.loc?.start?.line ?? (Array.isArray(node?.loc) ? node.loc[0] : 0)
    const _csFrame = `${_csFile}:${_csLine}`
    let _csPushed = false
    if (isDataflowInstrumentationEnabled()) {
      const { pushCallsiteFrame } = require('./entrypoint/current-entrypoint')
      pushCallsiteFrame(_csFrame)
      _csPushed = true
    }
    let return_value
    try {
    if (execute_builtin) {
      this?.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        callInfo,
        fclos,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        analyzer: this,
        ainfo: this.ainfo,
      })

      // this.lastReturnValue =  fclos.runtime.execute.call(this, fclos, argvalues, new_state, node, scope);
      this.lastReturnValue = null
      for (let i = 0; i < argvalues.length; i++) {
        argvalues[i] = SourceLine.addSrcLineInfo(argvalues[i], node, node?.loc && node.loc.sourcefile, 'CALL: ', fname)
      }
      return_value = fclos.runtime!.execute!.call(this, fclos, argvalues, new_state, node, scope, callInfo)
    } else {
      // now go into the function body
      this?.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        callInfo,
        fclos,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        analyzer: this,
        ainfo: this.ainfo,
      })

      // 基于 boundCall 绑定形参（替代旧的 argvalues[i] + node.names.indexOf 逻辑）
      const activeBoundCall = callInfo?.boundCall
      if (!activeBoundCall) {
        logger.warn('executeFdeclOrExecute: boundCall missing from callInfo')
      }

      // process function arguments
      if (!fdecl.parameters) {
        this.inRange = savedInRange
        return new UndefinedValue()
      }
      const params = fdecl.parameters
      // 先执行形参声明（确保 scope 中有位置）
      params?.forEach((param: any) => {
        this.processInstruction(fscope, param, new_state)
      })

      const hasProvidedBoundParam = (activeBoundCall?.params || []).some((param: BoundParam) => param?.provided)

      // 遍历 boundCall.params 绑定实参到形参
      for (const boundParam of activeBoundCall?.params || []) {
        if (!boundParam?.provided) continue
        const param = params[boundParam.index]
        const paramName = param?.id?.name
        if (!paramName) continue
        let val = boundParam.value

        // vararg（*args / rest parameter）→ 收集为 ObjectValue
        if (Array.isArray(val) && this.getParamKind(param) === 'vararg') {
          const restVal: any = {}
          val.forEach((element: any, index: number) => {
            restVal[index.toString()] = element
          })
          val = new ObjectValue(fscope.qid, {
            sid: paramName,
            field: restVal,
          })
        } else if (
          val &&
          !Array.isArray(val) &&
          this.getParamKind(param) === 'varkw' &&
          typeof val === 'object' &&
          !val.vtype
        ) {
          // varkw（**kwargs）→ 收集为 ObjectValue
          val = new ObjectValue(fscope.qid, {
            sid: paramName,
            field: val,
          })
        }
        // SourceLine 信息
        if (param.loc && oldThisFClos && (node.type !== 'FunctionDefinition' || this.shouldEmitAnonymousCallbackEntryTrace(node, callInfo))) {
          const callTraceNode = this.shouldEmitAnonymousCallbackEntryTrace(node, callInfo) ? callsiteNode : node
          const callbackProvenance = this.shouldEmitAnonymousCallbackEntryTrace(node, callInfo)
            ? { callbackEdge: true, callbackClosureOwnerHash: fdecl?._meta?.nodehash }
            : undefined
          val = SourceLine.addSrcLineInfo(
            val,
            callTraceNode,
            callTraceNode.loc && callTraceNode.loc.sourcefile,
            'CALL: ',
            fname,
            callbackProvenance
          )
          const fdeclParam = Array.isArray(fdecl.parameters) ? fdecl.parameters[0] : fdecl.parameters
          if (fdeclParam.loc.end?.line === param.loc.end?.line)
            val = SourceLine.addSrcLineInfo(
              val,
              fdeclParam,
              fdeclParam.loc.sourcefile,
              'ARG PASS: ',
              paramName,
              callbackProvenance
            )
          else
            val = SourceLine.addSrcLineInfo(
              val,
              param,
              param.loc && param.loc.sourcefile,
              'ARG PASS: ',
              paramName,
              callbackProvenance
            )
        }

        // checkpoint function parameter declaration
        if (this.checkerManager && this.checkerManager.checkAtPreDeclaration) {
          this.checkerManager.checkAtPreDeclaration(this, scope, param, state, {
            lnode: param,
            rvalue: val,
            fclos: fscope,
            fdef: fdecl,
          })
        }
        this.saveVarInCurrentScope(fscope, param, val, new_state)
        // actual_arg → param_value：调用方实参直接连接到函数体内参数值（精确仿真，不经过 formal_in）
        if (isDataflowInstrumentationEnabled() && val && boundParam.value && typeof boundParam.value === 'object') {
          const { recordEdge } = require('./dataflow-edge-stats')
          recordEdge(boundParam.value, val, 'arg_to_param')
        }
      }

      // 未绑定的形参初始化为 UndefinedValue
      params?.forEach((param: any) => {
        const val = this._getMemberValueDirect(fscope, param.id, state, false, 0, new Set())
        if (!val) {
          this.saveVarInCurrentScope(fscope, param.id, new UndefinedValue(), state)
        }
      })

      // Hook：boundCall 绑定完成、body 执行前；语言 analyzer 可 override 注入
      // 语言专用的形参后处理（例如 Python 装饰器路径下形参 SOURCE 显式 trigger）
      new_state.callInfo = callInfo
      this.onParamsBound(fscope, params, new_state, node)
      delete new_state.callInfo

      let objectVal
      if (node?.callee?.type === 'MemberAccess') {
        // objectVal = this.processInstruction(scope, node.callee.object, state)
        objectVal = SourceLine.addSrcLineInfo(fclos._this, node, node.loc && node.loc.sourcefile, 'CALL: ', fname)
        objectVal = SourceLine.addSrcLineInfo(
          fclos._this,
          node.callee.object,
          node.callee.object.loc.sourcefile,
          'ARG PASS: ',
          node.callee.object.name || AstUtil.prettyPrintAST(node.callee.object).slice(0, 50)
        )
      }

      // return parameters
      if (fdecl.returnParameters) {
        const val_0 = new PrimitiveValue(scope.qid, '<number_0>', 0, null, 'Literal', fdecl.returnParameters.loc)
        const paras = Array.isArray(fdecl.returnParameters) ? fdecl.returnParameters : fdecl.returnParameters.parameters
        if (paras) {
          for (const param of paras) {
            if (!param.name) continue // unused parameters
            // argument passing
            this.saveVarInCurrentScope(fscope, param, val_0, state)
          }
        }
      }

      // execute the body
      const oldReturnValue = this.lastReturnValue
      this.lastReturnValue = undefined
      // 方法体内 builtin 循环迭代预算计数器初始化：在 builtin（stream/forEach 等）回调循环里累加并校验，
      // 防止 stream pipeline 路径爆炸耗尽 entrypoint timeout
      if ((new_state as any)._methodBodyInstructionCount === undefined) {
        (new_state as any)._methodBodyInstructionCount = 0
      }
      if (!this.shouldAbortExecutionForTimeout(new_state)) {
        this.processInstruction(fscope, fdecl.body, new_state)
      }

      const shouldAddAnonymousCallbackEntryTrace = this.shouldEmitAnonymousCallbackEntryTrace(node, callInfo) && !hasProvidedBoundParam
      const fallbackCallbackTraceTarget = shouldAddAnonymousCallbackEntryTrace ? this.lastReturnValue || fclos.parent || scope : undefined

      // 函数体执行后的语言相关后处理钩子（如 Java lambda 隐式返回值）
      this.postProcessFunctionBody(fscope, fdecl, fname, new_state)

      if (shouldAddAnonymousCallbackEntryTrace) {
        const returnValue = this.lastReturnValue as Value | undefined
        const targetValue = returnValue?.taint?.isTaintedRec ? returnValue : fallbackCallbackTraceTarget
        this.lastReturnValue = this.addAnonymousCallbackEntryTrace(targetValue, callsiteNode, fdecl, fname)
      }

      return_value = this.lastReturnValue || new UndefinedValue()
      this.lastReturnValue = oldReturnValue

      // wrapper-return recovery：方法体跑完但 lastReturnValue 仍是 UndefinedValue
      // （例如 wrapper 方法体内 return 表达式失败、被某些路径裁剪跳过），
      // 而声明返回类型是可恢复的容器/复合类型时，从 fscope 收集仍带 taint 的载体值作为返回，
      // 让 wrapper 类方法仍能把 taint 透传给调用者。
      if (return_value?.vtype === 'undefine' && isRecoverableDeclaredReturn(fdecl)) {
        const candidates: WrapperReturnCandidate[] = []
        collectWrapperReturnCandidates(fscope, candidates, new WeakSet<object>())
        if (candidates.length > 0) {
          candidates.sort((left, right) => right.score - left.score)
          return_value = candidates[0].value
        }
      }

      // Iterator.next() 接收者 taint 传播：当自定义迭代器（有 fdef 方法体的 next/hasNext）的
      // next() 返回值无 taint 但迭代器接收者有 taint 时，将接收者 taint 合并到返回值。
      // 仅对有方法体实现的迭代器生效（排除 java.util.Iterator builtin 和普通集合迭代器），
      // 因为自定义迭代器的 next() 方法体内部可能调用外部 DB 查询（如 MyBatis mapper），
      // 引擎无法追踪 taint 通过查询结果返回，但语义上迭代器由 tainted 数据构造
      // 则 next() 返回值也应为 tainted。
      if (fname === 'next' && return_value && !return_value.taint?.isTaintedRec) {
        const receiverObj = fclos._this || fclos.getThisObj?.()
        const hasNextMethod = receiverObj?.members?.get?.('hasNext')
        const nextMethod = receiverObj?.members?.get?.('next')
        // 仅对自定义迭代器生效：next/hasNext 必须有 fdef（方法体），排除 builtin 迭代器
        const isCustomIterator = receiverObj?.taint?.isTaintedRec
          && receiverObj.members?.has?.('hasNext')
          && (hasNextMethod?.ast?.fdef || nextMethod?.ast?.fdef)
        if (isCustomIterator) {
          if (typeof return_value.taint?.markSource === 'function') {
            return_value.taint.markSource()
          }
          if (typeof return_value.taint?.mergeTracesFrom === 'function' && receiverObj.taint) {
            return_value.taint.mergeTracesFrom(receiverObj.taint)
          }
          if (typeof return_value.setMisc === 'function') {
            const buf = return_value.getMisc('buffer')
            if (!Array.isArray(buf) || !buf.includes(receiverObj)) {
              return_value.setMisc('buffer', [...(buf || []), receiverObj])
            }
          }
        }
      }

      const tag = 'CALL RETURN:' // size ? 'RETURN: ' : null;
      return_value = SourceLine.addSrcLineInfo(return_value, node, node.loc && node.loc.sourcefile, tag, fname)
    }

    // post-call processing
    delete fclos.value[fscope.sid]
    // this.setCurrentFunction(old_function);
    this.thisFClos = oldThisFClos
    // 恢复 inRange，使调用方 for-range 的状态不被嵌套函数调用影响
    this.inRange = savedInRange

    return return_value
    } finally {
      // 调用点拆分: 无论函数体走 builtin / 用户函数 / early-return / 抛异常都要 pop
      if (_csPushed) {
        const { popCallsiteFrame } = require('./entrypoint/current-entrypoint')
        popCallsiteFrame()
      }
    }
  }

  /**
   * 函数体执行完毕后的后处理钩子，供子类覆盖处理语言相关的语义（如 Java lambda 隐式返回值）。
   * 基类默认无操作。
   * @param _fscope
   * @param _fdecl
   * @param _fname
   * @param _state
   */
  postProcessFunctionBody(_fscope: any, _fdecl: any, _fname: any, _state: any): void {
    // no-op by default; language-specific analyzers may override
  }

  /**
   * process object creation. Retrieve the function definition
   * @param scope
   * @param node
   * @param state
   * @returns {*}
   */
  processNewObject(scope: any, node: any, state: any) {
    // if (DEBUG) logger.info("processInstruction: NewExpression " + formatNode(node));
    const call = node

    // try obtaining the class/function definition in the current scope
    let fclos = this.processInstruction(scope, node.callee, state)
    if (fclos.vtype === 'union') {
      fclos = fclos.value[0] // FIXME
    }
    // const native = libraryAPIResolver.processNewObject(fclos, argvalues);
    // if (native) return native;

    let argvalues = []
    if (call.arguments) {
      let same_args = true // minor optimization to save memory
      for (const arg of call.arguments) {
        const argv = this.processInstruction(scope, arg, state)
        if (argv !== arg) same_args = false
        argvalues.push(argv)
      }
      if (same_args) argvalues = call.arguments
    }

    const { fdef } = fclos.ast
    // if (analysisutil.isInCallStack(fdef, state.callstack)) return;

    const newCallInfo: CallInfo = { callArgs: this.buildCallArgs(node, argvalues, fclos) }
    const obj = this.buildNewObject(fdef, fclos, state, node, scope, newCallInfo)
    if (logger.isTraceEnabled()) logger.trace(`new expression: ${this.formatScope(obj)}`)

    if (obj && this.checkerManager?.checkAtNewExprAfter) {
      this.checkerManager.checkAtNewExprAfter(this, scope, node, state, {
        callInfo: newCallInfo,
        fclos,
        ret: obj,
        pcond: state.pcond,
        einfo: state.einfo,
        callstack: state.callstack,
      })
    }

    return obj
  }

  /**
   * Create a new object. Record the fields and initialize their values
   * @param fdef
   * @param argvalues
   * @param fclos
   * @param state
   * @param node
   * @param scope
   * @param callInfo
   * @returns {*}
   */
  buildNewObject(fdef: any, fclos: any, state: State, node: any, scope: any, callInfo: CallInfo) {
    const argvalues = getLegacyArgValues(callInfo)
    if (Config.miniSaveContextEnvironment) {
      return new UndefinedValue()
    }

    const obj = buildNewValueInstance(
      this,
      fclos,
      node,
      scope,
      () => {
        return false
      },
      (v: any) => {
        return !v
      },
      1,
      { forceVtype: 'object' }
    )

    if (_.isFunction(fclos.runtime?.execute)) {
      fclos.runtime!.execute!.call(this, obj, argvalues, state, node, scope)
    }

    if (!argvalues) return obj

    if (!fdef) {
      // function definition not found, examine possible call-back functions in the arguments
      if (Config.invokeCallbackOnUnknownFunction) {
        this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
      }
      if (argvalues.length > 0) {
        if (!obj.arguments || (Array.isArray(obj.arguments) && obj.arguments?.length === 0)) {
          obj.arguments = argvalues
        } else {
          // 将传入参数存入 misc_，hasTagRec 迭代时可发现污点参数
          obj.setMisc('pass-in', argvalues)
        }

        // F1 改动 β：库类 ctor argvalues → instance 的 field_write 边
        // 对齐 runtime hasTagRec 遍历 obj.arguments / obj.misc_['pass-in'] 语义——
        // 库类（无 fdef）实例通过 arguments 间接持有 argv 的 taint，offline 必须显式建边
        if (isDataflowInstrumentationEnabled() && obj && typeof obj === 'object') {
          const { recordEdge } = require('./dataflow-edge-stats')
          for (const argv of argvalues) {
            if (argv && typeof argv === 'object' && argv !== obj) {
              recordEdge(argv, obj, 'field_write')
            }
          }
        }
      }
      return obj
    }

    let body
    switch (fdef.type) {
      case 'ObjectExpression':
        body = fdef.properties
        break
      case 'FunctionDefinition':
        fclos._isConstructor = true
      // fall through
      case 'ClassDefinition':
      default:
        body = fdef.body
    }
    if (!body) return obj

    // TODO: record type information

    // Initialize values, e.g. process the constructor parameters
    let paras
    let fconstructor
    let ctorClos
    switch (fdef.type) {
      case 'StructDefinition':
        paras = fdef.members.map(
          (x: any) => new SymbolValue(obj.qid, { sid: x.name, type: 'Parameter', name: x.name, loc: x.loc })
        )
        break
      // for javascript, ctor is itself
      case 'FunctionDefinition':
        paras = fdef.parameters
        fconstructor = fdef
        ctorClos = obj
        break
      default: {
        fconstructor = Initializer.getConstructor(body, fdef.name)
        if (fconstructor) paras = fconstructor.parameters
        if (obj.value) {
          ctorClos = obj.value._CTOR_
          if (!ctorClos && fconstructor) {
            this.processInstruction(fclos, fconstructor, state)
            ctorClos = obj.value._CTOR_
          }
        }
        // 无 __init__ 时查找 __new__，使 __new__ 中的赋值能传播 taint
        if (!ctorClos && body) {
          let newMethodAst: any
          for (const nd of body) {
            if (nd.type === 'FunctionDefinition' && nd.name === '__new__') {
              newMethodAst = nd
              break
            }
          }
          if (newMethodAst) {
            this.processInstruction(fclos, newMethodAst, state)
            const newClos = obj.value?.__new__
            if (newClos?.vtype === 'fclos') {
              ctorClos = newClos
              paras = newMethodAst.parameters
              // __new__ 返回值需要合并回 obj，与 __init__ 不同
              ctorClos.__isNewMethod = true
            }
          }
        }
      }
    }
    if (paras) {
      if (paras.type === 'ParameterList') paras = paras.parameters
      const len = Math.min(paras.length, argvalues.length)
      for (let i = 0; i < len; i++) {
        const param = paras[i]
        let index = i
        const names = node.names || node.arguments
        if (names?.length > 0) {
          // handle named argument values like "f({value: 2, key: 3})"
          const k = names.indexOf(param.name)
          if (k !== -1) index = k
        }
        let val = argvalues[index]
        // add source line information
        if (param.loc) {
          val = SourceLine.addSrcLineInfo(
            val,
            node,
            param.loc.sourcefile,
            'ARG PASS: ',
            param.name || AstUtil.prettyPrint(param).slice(0, 50)
          )
        }

        if (fdef.type === 'StructDefinition') {
          this.saveVarInCurrentScope(obj, param, val, state)
        }
      }
    }
    // try execute ctor
    if (ctorClos) {
      if (this.checkerManager && this.checkerManager.checkAtNewObject) {
        this.checkerManager.checkAtNewObject(this, scope, fdef, state, {
          callInfo,
          state,
          fclos: ctorClos,
          ainfo: this.ainfo,
        })
      }
      const oldThisFClos = this.thisFClos
      this.thisFClos = obj
      ctorClos._this = obj
      // __new__ 的第一个参数是 cls，需要设置 receiver 使 bindReceiverParam 正确跳过 cls
      let ctorCallInfo = callInfo
      if (ctorClos.__isNewMethod && callInfo?.callArgs) {
        ctorCallInfo = {
          callArgs: {
            ...callInfo.callArgs,
            receiver: obj,
          },
        }
      }
      const ctorReturn = this.executeCall(node, ctorClos, state, scope, ctorCallInfo)
      this.thisFClos = oldThisFClos

      // __new__ 返回值合并：将 __new__ 内部对 instance 的赋值传播到 obj
      if (ctorClos.__isNewMethod && ctorReturn) {
        if (ctorReturn.value && typeof ctorReturn.value === 'object') {
          for (const key of Object.keys(ctorReturn.value)) {
            if (!key.startsWith('__') && obj.value && !obj.value[key]) {
              obj.value[key] = ctorReturn.value[key]
            }
          }
        }
        // 传播 taint
        if (ctorReturn.taint?.isTaintedRec) {
          obj.taint = obj.taint || {}
          if (typeof obj.taint.propagateFrom === 'function') {
            obj.taint.propagateFrom(ctorReturn)
          }
        }
      }
    }

    if (obj.parent) {
      obj.parent.value[obj.qid] = obj
    }
    return obj
  }

  // if function definition is not found, execute function in args
  /**
   *
   * @param scope
   * @param caller
   * @param callsite_node
   * @param argvalues
   * @param state
   */
  executeFunctionInArguments(scope: any, caller: any, callsite_node: any, argvalues: any, state: any) {
    const needInvoke = Config.invokeCallbackOnUnknownFunction
    if (needInvoke !== 1 && needInvoke !== 2) return new UndefinedValue()

    for (let i = 0; i < argvalues.length; i++) {
      const arg = argvalues[i]
      if (arg && arg.vtype === 'fclos') {
        const fclos = lodashCloneWithTag(arg)
        const new_state = _.clone(state)
        new_state.parent = state
        new_state.callstack = state.callstack ? state.callstack.concat([caller]) : [caller]
        new_state.callsites = state.callsites
          ? state.callsites.concat([
              {
                code: AstUtil.getRawCode(callsite_node).slice(0, 100),
                nodeHash: callsite_node._meta?.nodehash,
                loc: callsite_node.loc,
              },
            ])
          : [
              {
                code: AstUtil.getRawCode(callsite_node).slice(0, 100),
                nodeHash: callsite_node._meta?.nodehash,
                loc: callsite_node.loc,
              },
            ]
        // 调用点拆分: callback fork-call 也要 push/pop callsite，frame 取 callsite_node loc
        const _csFile = callsite_node?.loc?.sourcefile || callsite_node?.loc?.start?.sourcefile || ''
        const _csLine = callsite_node?.loc?.start?.line ?? (Array.isArray(callsite_node?.loc) ? callsite_node.loc[0] : 0)
        const _csFrame = `${_csFile}:${_csLine}`
        let _csPushed = false
        if (isDataflowInstrumentationEnabled()) {
          const { pushCallsiteFrame } = require('./entrypoint/current-entrypoint')
          pushCallsiteFrame(_csFrame)
          _csPushed = true
        }
        try {
          this.executeCall(callsite_node, fclos, new_state, scope, INTERNAL_CALL)
        } finally {
          if (_csPushed) {
            const { popCallsiteFrame } = require('./entrypoint/current-entrypoint')
            popCallsiteFrame()
          }
        }
      }
    }
  }

  /**
   * judge if val is nullLiteral,impl in every lang/framework analyzer
   * @param val
   */
  isNullLiteral(val: any) {
    return false
  }

  /**
   *
   * @param scope
   */
  getExportsScope(scope: any) {
    let scp = scope
    while (scp) {
      const _export = scp.getFieldValue('module.exports')
      if (_export) return _export
      scp = scp.parent
    }
    return scp
  }

  // ***

  /**
   * record the writes to shared variables
   * @param scope
   * @param node: destination node
   * @param val: original value of the destination
   * @param fclos
   * @param state
   */
  // this.recordSideEffect = function(scope, node, mindex, val) {
  // const cscope = thisFClos.parent;
  // if (!cscope.fdata) return;
  //
  // var targetv = node.left;
  // while (targetv.type == 'MemberAccess')
  //     targetv = targetv.expression;
  //
  // const targetv_decl = scope.decls[targetv.name];
  // if (!targetv_decl) return;
  //
  // if (!targetv_decl.isStateVar) return;
  //
  // var writes = cscope.fdata.writes;
  // if (!writes) {
  //     writes = cscope.fdata.writes = [];
  // }
  // writes.push(ValueFormatter.normalizeVarAccess(mindex));
  // };

  resolveClassInheritance(fclos: any, state: any) {
    const { fdef } = fclos.ast
    const { supers } = fdef
    if (!supers || supers.length === 0) return

    const scope = fclos.parent

    for (const i in supers) {
      if (supers[i]) {
        _resolveClassInheritance.bind(this)(fclos, supers[i])
      }
    }

    /**
     *
     * @param fclos
     * @param superId
     */
    function _resolveClassInheritance(this: any, fclos: any, superId: any) {
      if (fclos?.sid === superId?.name) {
        // to avoid self-referencing
        return
      }
      const superClos = this.processInstruction(scope, superId, state)
      // const superClos = this.getMemberValue(scope, superId, state);
      if (!superClos) return new UndefinedValue()
      fclos.super = superClos

      // inherit definitions
      // superValue is used to record values of super class, so that we can handle cases like super.xxx() or super()
      const superValue = fclos.value.super || Scope.createSubScope('super', fclos, 'fclos')
      // super's parent should be assigned to base, _this will track on fclos
      superValue.parent = superClos
      for (const fieldName in superClos.value) {
        if (fieldName === 'super') continue
        const v = superClos.value[fieldName]
        if (v.runtime?.readonly) continue
        // const v_copy = _.clone(v)
        const v_copy = lodashCloneWithTag(v)
        if (v_copy) {
          if (!v_copy.func) v_copy.func = {}
          v_copy.func.inherited = true
          v_copy._this = fclos
          v_copy._base = superClos
          fclos.value[fieldName] = v_copy

          superValue.value[fieldName] = v_copy
          if (fieldName === '_CTOR_') {
            superValue.ast.node = v_copy.ast.fdef
            superValue.ast.fdef = v_copy.ast.fdef
            if (!superValue.overloaded) {
              superValue.overloaded = new AstRefList(() => superValue.getASTManager())
            }
            superValue.overloaded.push(fdef)
          }
        }

        // v_copy.parent = fclos;  // Important!
      }

      // inherit declarations
      for (const x of superClos.ast.declKeys) {
        const v = superClos.ast.getDecl(x)
        fclos.ast.setDecl(x, v)
      }
      // inherit modifiers
      for (const x in superClos.modifier) {
        const v = superClos.modifier[x]
        fclos.modifier[x] = v
      }
      // inherit initialized variables
      if (superClos.inits) {
        for (const x of superClos.inits) {
          fclos.inits.add(x)
        }
      }
      // inherit the fdata
      if (superClos.fdata) {
        if (!fclos.fdata) fclos.fdata = {}
        for (const x in superClos.fdata) {
          fclos.fdata[x] = superClos.fdata[x]
        }
      }
    }
  }

  /**
   *
   * @param thisFClos
   */
  initState(thisFClos: any) {
    return {
      callstack: [],
      brs: '',
      pcond: [],
      binfo: {},
      einfo: {},
      this: thisFClos,
    }
  }

  // TODO iterator implementation
  /**
   *
   * @param rightVal
   * @param filter
   */
  private snapshotIteratorValue(value: IteratorAnalyzerValue): IteratorAnalyzerValue {
    return this.snapshotEscapedElementValue(value)
  }

  protected snapshotEscapedElementValue<T extends IteratorAnalyzerValue | undefined>(value: T): T {
    if (!value || typeof value !== 'object') return value
    const snapshot = value.qid ? buildNewCopiedWithTag(this, value, 'element') : (typeof value.cloneAlias === 'function' ? value.cloneAlias() : value)
    if (snapshot?.rtype) {
      snapshot.rtype = { ...snapshot.rtype }
    }
    return snapshot as T
  }

  *getValueIterator(
    rightVal: IteratorAnalyzerValue | undefined,
    filter: ValueIteratorFilter | undefined
  ): Generator<{ k: string; v: IteratorAnalyzerValue }, void, unknown> {
    if (rightVal?.vtype === 'union' && Array.isArray(rightVal.value)) {
      for (const element of rightVal.value) {
        yield* this.getValueIterator(element, filter)
      }
      return
    }
    if (rightVal && typeof rightVal.getRawValue === 'function') {
      const fields = rightVal.getRawValue()
      for (const key in fields) {
        // 过滤原型链
        if (typeof key === 'string' && key.includes('__yasa')) {
          continue
        }
        if (typeof fields.hasOwnProperty === 'function' && fields.hasOwnProperty(key)) {
          let val = fields[key]
          // UUID 字符串解析回实际符号值
          if (val && typeof val === 'string' && val.startsWith('symuuid_')) {
            const resolved = this.symbolTable.get(val)
            if (resolved) {
              val = resolved as IteratorAnalyzerValue
            }
          }
          if (typeof val !== 'string' && val?.vtype === 'union' && Array.isArray(val.value)) {
            for (const element of val.value) {
              if (!filter || filter(element)) yield { k: key, v: this.snapshotIteratorValue(element) }
            }
            continue
          }
          if (typeof val !== 'string' && val !== undefined) {
            if (!filter) yield { k: key, v: this.snapshotIteratorValue(val) }
            else if (filter(val)) yield { k: key, v: this.snapshotIteratorValue(val) }
          }
        }
      }
    }
  }

  /**
   * load lib func tag propag
   */
  loadLibFuncTagPropagationRule() {
    if (this.libFuncTagPropagationRuleArray) {
      return this.libFuncTagPropagationRuleArray
    }

    const ruleArray: any[] = []
    let ruleWithLangArray: any[] = []
    try {
      const rulePath = getAbsolutePath('resource/tag-propagation/lib-func-tag-propagation-rule.json')
      ruleWithLangArray = loadJSONfile(rulePath)
    } catch (e) {
      return ruleArray
    }

    if (!Array.isArray(ruleWithLangArray)) {
      return ruleArray
    }
    for (const ruleWithLang of ruleWithLangArray) {
      if (!Array.isArray(ruleWithLang.rules)) {
        continue
      }
      ruleArray.push(...ruleWithLang.rules)
    }
    return ruleArray
  }

  /**
   * load lib arg to this sid blacklist keywords
   */
  loadLibArgToThisSidBlacklistKeywords() {
    if (Array.isArray(this.libArgToThisSidBlacklistKeywords)) {
      return this.libArgToThisSidBlacklistKeywords
    }

    let sidKeywordArray: any[] = []
    try {
      const rulePath = getAbsolutePath('resource/tag-propagation/lib-arg-to-this-sid-blacklist.json')
      const ruleData = loadJSONfile(rulePath)
      if (Array.isArray(ruleData?.sidKeywords)) {
        sidKeywordArray = ruleData.sidKeywords
      } else if (Array.isArray(ruleData?.keywords)) {
        sidKeywordArray = ruleData.keywords
      }
    } catch (e) {
      return []
    }

    return sidKeywordArray.filter((item) => typeof item === 'string' && item.trim().length > 0)
  }

  /**
   * find matched rule by CallGraph
   * @param node
   * @param scope
   * @param sinkRules
   */
  findMatchedRuleByCallGraph(node: any, scope: any, sinkRules: any[]) {
    const resultArray: any[] = []

    if (!node || !scope || !sinkRules || !this.findNodeInvocations) {
      return resultArray
    }

    const invocations: Invocation[] = this.findNodeInvocations(scope, node)
    if (!invocations) {
      return resultArray
    }

    for (const invocation of invocations) {
      for (const sink of sinkRules) {
        const matchSink: boolean = checkInvocationMatchSink(invocation, sink, this.typeResolver)
        if (matchSink) {
          resultArray.push(sink)
        }
      }
    }

    return resultArray
  }

  /**
   * output all the findings of all registered checker
   * @param {any} printf - Print function for output
   */
  async outputAnalyzerExistResult(printf?: unknown, reason: FindingsCheckpointReason = 'normal', checkpointWriter?: FindingsCheckpointWriter): Promise<void> {
    const { resultManager } = this.getCheckerManager()
    if (!resultManager || !Config.reportDir) return
    if (reason !== 'normal') {
      const writer = checkpointWriter ?? new FindingsCheckpointWriter({
        filePath: require('path').join(Config.reportDir, 'findings-checkpoint.json'),
        reason,
      })
      const checkpoint = writer.writeOnce(resultManager)
      if (checkpoint.status === 'error') {
        throw new Error(`Findings checkpoint persistence failed: ${checkpoint.error?.code}: ${checkpoint.error?.message}`)
      }
      return
    }
    const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
    outputStrategyAutoRegister.autoRegisterAllStrategies()
    const allFindings = resultManager.getFindings()
    for (const outputStrategyId in allFindings) {
      const strategy = outputStrategyAutoRegister.getStrategy(outputStrategyId)
      if (strategy && typeof strategy.outputFindings === 'function') {
        const strategyStartedAt = Date.now()
        const strategyFindings = allFindings[outputStrategyId]
        const rawFindingCount = Array.isArray(strategyFindings) ? strategyFindings.length : 0
        strategy.outputFindings(resultManager, strategy.getOutputFilePath(), Config, printf)
        logger.info(`[outputFindings] strategy=${outputStrategyId} phase=total raw=${rawFindingCount} elapsed=${Date.now() - strategyStartedAt}ms`)
      }
    }
  }
}

/**
 *
 * @param type
 */
function needCompileFirst(type: any) {
  return ['FunctionDefinition', 'ClassDefinition'].indexOf(type) !== -1
}

//* *******************************************

module.exports = Analyzer
export { Analyzer }
