import type { State } from '../../../../types/analyzer'
import type {
  EntryPointExecutionContext,
  EntryPointExecutionAdapter,
} from './entrypoint-execution-isolation'
import { executeIsolatedEntryPoint } from './entrypoint-execution-isolation'
import type { CallsiteContext } from './current-entrypoint'
import type { LocalResultBuffer } from '../local-result-buffer'
import { createEmptyLocalResultBuffer } from '../local-result-buffer'
import type { ResultManagerProxy } from '../result-manager-proxy'
import { DataflowWriterContext } from '../dataflow-writer-context'
import type { AnalyzerMemoryOverlay } from '../analyzer-memory-overlay'
import { createAnalyzerMemoryOverlay } from '../analyzer-memory-overlay'
import type { ISymbolTableManager } from '../symbol-table-interface'
import type { MonotonicClock } from './deadline-scheduler'

export interface EntryPointExecutorOptions {
  readonly monotonicClock?: MonotonicClock
}

const defaultMonotonicClock: MonotonicClock = (): number => performance.now()

const { AsyncLocalStorage } = require('async_hooks') as typeof import('async_hooks')
const { getGlobalSymbolTable, setGlobalSymbolTable } = require('../../../../util/global-registry') as {
  getGlobalSymbolTable(): ISymbolTableManager | undefined
  setGlobalSymbolTable(symbolTable: ISymbolTableManager | undefined): void
}
const { yasaLog } = require('../../../../util/format-util') as { yasaLog(message: string, stages?: string | string[]): void }
const { describeEntryPointForLog } = require('../../../../util/entrypoint-metrics') as { describeEntryPointForLog(entryPoint: unknown): string }

function countFindings(findings: Record<string, unknown[]>): number {
  let count = 0
  for (const bucket of Object.values(findings)) {
    if (Array.isArray(bucket)) count += bucket.length
  }
  return count
}

// EP-owned 指标 bucket，executor 执行前后记录时间与 finding 计数。
export interface EntryPointMetricsBucket {
  startTimeMs: number
  endTimeMs?: number
  findingsBefore: number
  findingsAfter?: number
  matchedSinkCount?: number
}

// callsite context handle：携带 executor 绑定的 context-local CallsiteContext。
// executor 进入 ALS scope 时绑定，analyzer push/pop 调用点自动落到该 context。
export interface EntryPointCallsiteContextHandle {
  readonly ownerKey: string | undefined
  readonly callsiteContext: CallsiteContext
}

// 执行状态 handle 占位：当前直接引用 adapter 上下文里的 State，后续切片才会切到 executor-local overlay。
export interface EntryPointExecutionStateHandle {
  readonly state?: State
}

interface AnalyzerWithSymbolTable {
  symbolTable?: ISymbolTableManager
  topScope?: { context?: { symbols?: ISymbolTableManager; packages?: unknown } }
}

interface AnalyzerMemorySnapshot {
  readonly analyzerSymbolTable?: ISymbolTableManager
  readonly topScopeSymbols?: ISymbolTableManager
  readonly topScopePackages?: unknown
  readonly globalSymbolTable?: ISymbolTableManager
}

/**
 * EntryPointExecutor 上下文：在现有 `EntryPointExecutionContext` 之上额外携带 owner key、
 * callsite/execution state handle、result buffer、writer context 与 metrics bucket。
 */
export interface EntryPointExecutorContext<TEntryPoint>
  extends EntryPointExecutionContext<TEntryPoint> {
  ownerKey: string | undefined
  // executor 层 handle，封装 ownerKey 与底层 CallsiteContext。
  // 基类 callsiteContext: CallsiteContext 由 isolation 层在 ALS 绑定时使用。
  callsiteContextHandle: EntryPointCallsiteContextHandle
  executionStateHandle: EntryPointExecutionStateHandle
  // EP-owned 兼容 buffer，保留给仍通过 executor scope 读取 buffer 的内部接口。
  resultBuffer: LocalResultBuffer
  // per-executor 数据流写入上下文
  writerContext: DataflowWriterContext
  // executor 本地 analyzer memory overlay，当前只承载符号表 overlay。
  memoryOverlay?: AnalyzerMemoryOverlay
  metricsBucket: EntryPointMetricsBucket
}

// executor context ALS。仅在走 EntryPointExecutor.execute 时绑定；
// CheckerManager.getResultBufferForCurrentExecutor 通过该 ALS 拿到当前 executor 的 LocalResultBuffer。
const executorContextStorage = new AsyncLocalStorage<EntryPointExecutorContext<unknown>>()

export function getCurrentExecutorResultBuffer(): LocalResultBuffer | undefined {
  return executorContextStorage.getStore()?.resultBuffer
}

export function getCurrentExecutorWriterContext(): DataflowWriterContext | undefined {
  return executorContextStorage.getStore()?.writerContext
}

function isAnalyzerWithSymbolTable(value: unknown): value is AnalyzerWithSymbolTable {
  return typeof value === 'object' && value !== null
}

function bindAnalyzerMemoryOverlay<TEntryPoint>(
  context: EntryPointExecutorContext<TEntryPoint>,
): AnalyzerMemorySnapshot | undefined {
  if (!isAnalyzerWithSymbolTable(context.analyzer)) return undefined
  const analyzer = context.analyzer
  const baseSymbolTable = analyzer.symbolTable
  if (!baseSymbolTable) return undefined
  // Go 符号表依赖预扫描阶段的跨入口复用，当前保留全局符号表以维持既有覆盖。
  if (analyzer.constructor?.name === 'GoAnalyzer') return undefined
  if (!context.memoryOverlay) {
    context.memoryOverlay = createAnalyzerMemoryOverlay(baseSymbolTable)
  }
  const snapshot: AnalyzerMemorySnapshot = {
    analyzerSymbolTable: analyzer.symbolTable,
    topScopeSymbols: analyzer.topScope?.context?.symbols,
    topScopePackages: analyzer.topScope?.context?.packages,
    globalSymbolTable: getGlobalSymbolTable(),
  }
  analyzer.symbolTable = context.memoryOverlay.symbolTable
  if (analyzer.topScope?.context) {
    analyzer.topScope.context.symbols = context.memoryOverlay.symbolTable
    analyzer.topScope.context.packages = context.memoryOverlay.clonePackageRoot(analyzer.topScope.context.packages)
  }
  setGlobalSymbolTable(context.memoryOverlay.symbolTable)
  return snapshot
}

function restoreAnalyzerMemoryOverlay(
  context: EntryPointExecutorContext<unknown>,
  snapshot: AnalyzerMemorySnapshot | undefined,
): void {
  if (!snapshot) return
  setGlobalSymbolTable(snapshot.globalSymbolTable)
  if (!isAnalyzerWithSymbolTable(context.analyzer)) return
  context.analyzer.symbolTable = snapshot.analyzerSymbolTable
  if (context.analyzer.topScope?.context) {
    context.analyzer.topScope.context.symbols = snapshot.topScopeSymbols
    context.analyzer.topScope.context.packages = snapshot.topScopePackages
  }
}

/**
 * EntryPointExecutor：EP 执行隔离容器。
 * 构造时绑定 entrypoint + executor context + adapter；`execute()` 进入 ALS scope
 * 后调用 `executeIsolatedEntryPoint`，在 scope 内生效 result buffer、dataflow writer、
 * memory overlay 等隔离面。
 */
export class EntryPointExecutor<
  TEntryPoint,
  TContext extends EntryPointExecutorContext<TEntryPoint>,
> {
  private readonly context: TContext

  private readonly adapter: EntryPointExecutionAdapter<TEntryPoint, TContext>

  private readonly resultManagerProxy: ResultManagerProxy | undefined

  private readonly monotonicClock: MonotonicClock

  constructor(
    context: TContext,
    adapter: EntryPointExecutionAdapter<TEntryPoint, TContext>,
    resultManagerProxy?: ResultManagerProxy,
    options: EntryPointExecutorOptions = {},
  ) {
    this.context = context
    this.adapter = adapter
    this.resultManagerProxy = resultManagerProxy
    this.monotonicClock = options.monotonicClock ?? defaultMonotonicClock
  }

  execute(): void {
    const epLabel = describeEntryPointForLog(this.context.entryPoint).replace(/^\[|\]$/g, '')
    const startTime = this.monotonicClock()
    const memBefore = process.memoryUsage()
    const progress = this.context.epIndex && this.context.epTotal
      ? `(${this.context.epIndex}/${this.context.epTotal}): `
      : ''
    yasaLog(`Execute entrypoint ${progress}${epLabel} ...`, 'symbolInterpret')

    // 把 handle 内底层 CallsiteContext 写入基类字段，进入 ALS scope 时绑定。
    this.context.callsiteContext = this.context.callsiteContextHandle.callsiteContext
    // 为本 executor 创建独立的 DataflowWriterContext
    if (!this.context.writerContext) {
      this.context.writerContext = new DataflowWriterContext()
    }
    // 从 module-global 复制 beforeEdgeHook 到 context
    const { getBeforeEdgeHook } = require('../dataflow-edge-stats')
    this.context.writerContext.beforeEdgeHook = getBeforeEdgeHook()
    // 进入 executor context ALS scope，CheckerManager 在 scope 内可定位到本 executor 的 LocalResultBuffer。
    executorContextStorage.run(this.context, () => {
      const memorySnapshot = bindAnalyzerMemoryOverlay(this.context)
      try {
        executeIsolatedEntryPoint<TEntryPoint, TContext>(this.context, this.adapter)
      } finally {
        restoreAnalyzerMemoryOverlay(this.context, memorySnapshot)
        if (this.context.memoryOverlay) {
          this.context.memoryOverlay.resetLocal()
        }
      }
    })
    // executor 结束后 flush context edgeBuffer + 聚合计数器到 module-global。
    const { flushEdgeBufferFrom, aggregateContextStats } = require('../dataflow-edge-stats')
    if (this.context.writerContext) {
      flushEdgeBufferFrom(this.context.writerContext.edgeBuffer)
      aggregateContextStats(this.context.writerContext)
    }

    // per-EP 内存追踪使用全局 finding 增量，匹配当前 ResultManager 直写语义。
    const newFindings = this.resultManagerProxy
      ? Math.max(0, countFindings(this.resultManagerProxy.getFindings()) - this.context.metricsBucket.findingsBefore)
      : 0
    const cost = Math.round(this.monotonicClock() - startTime)
    const memAfterEp = process.memoryUsage()
    if (typeof global.gc === 'function') {
      global.gc()
    }
    const memAfterGc = process.memoryUsage()
    const fmt = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`
    const used = Math.max(0, memAfterEp.heapUsed - memBefore.heapUsed)
    const growth = Math.max(0, memAfterGc.heapUsed - memBefore.heapUsed)
    yasaLog(
      `Find ${newFindings} findings, cost: ${cost}ms, ` +
      `used: ${fmt(used)}, growth: ${fmt(growth)}, cur: ${fmt(memAfterGc.heapUsed)}, rss: ${fmt(memAfterGc.rss)}`,
      'symbolInterpret'
    )
  }

  getContext(): TContext {
    return this.context
  }
}

// 默认 LocalResultBuffer 工厂；调用方走 EntryPointExecutor 时由构造方传入此 buffer。
export function createEmptyResultBuffer(): LocalResultBuffer {
  return createEmptyLocalResultBuffer()
}

export function createInitialMetricsBucket(
  startTimeMs: number,
  findingsBefore: number,
): EntryPointMetricsBucket {
  return {
    startTimeMs,
    findingsBefore,
  }
}

/**
 * 生产路径入口：将现有 executeIsolatedEntryPoint 调用点迁移到 EntryPointExecutor，
 * 使 symbol table overlay、ALS、result buffer、dataflow writer、trace snapshot
 * 等隔离面在串行路径实际生效。不传 resultManagerProxy 时降级为 legacy 路径（不 merge buffer）。
 */
export function executeViaEntryPointExecutor<
  TEntryPoint,
  TContext extends EntryPointExecutionContext<TEntryPoint>,
>(
  context: TContext,
  adapter: EntryPointExecutionAdapter<TEntryPoint, TContext>,
  resultManagerProxy?: ResultManagerProxy,
  options?: EntryPointExecutorOptions,
): void {
  const { createCallsiteContext } = require('./current-entrypoint') as {
    createCallsiteContext(): CallsiteContext
  }
  const executorContext: EntryPointExecutorContext<TEntryPoint> = {
    ...context,
    ownerKey: undefined,
    callsiteContextHandle: {
      ownerKey: undefined,
      callsiteContext: createCallsiteContext(),
    },
    executionStateHandle: {
      state: context.executionState,
    },
    resultBuffer: createEmptyLocalResultBuffer(),
    writerContext: new DataflowWriterContext(),
    metricsBucket: createInitialMetricsBucket(context.metricStartTime, context.findingsBefore),
  }
  const executor = new EntryPointExecutor<TEntryPoint, EntryPointExecutorContext<TEntryPoint>>(
    executorContext,
    adapter as unknown as EntryPointExecutionAdapter<TEntryPoint, EntryPointExecutorContext<TEntryPoint>>,
    resultManagerProxy,
    options,
  )
  executor.execute()
}
