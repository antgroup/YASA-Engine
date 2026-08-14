import type { State } from '../../../../types/analyzer'
import type { CallsiteContext } from './current-entrypoint'
import type { DataflowWriterContext } from '../dataflow-writer-context'

type EntryPointKind = 'function' | 'file' | 'preprocess' | 'unsupported'
type ErrorDisposition = 'handled' | 'rethrow'

interface ExecutionStateSnapshot {
  pcond: State['pcond']
  callsites?: State['callsites']
}

export interface EntryPointExecutionContext<TEntryPoint> {
  analyzer: unknown
  entryPoint: TEntryPoint
  metricStartTime: number
  findingsBefore: number
  executionState?: State
  skipReason?: string
  overloadCount?: number
  // 当前 EP 在本批中的序号（1-based）与总数，用于日志显示进度
  epIndex?: number
  epTotal?: number
  // 可选携带 context-local callsite context；executor 进入 ALS scope 时绑定。
  // 缺省时 executeIsolatedEntryPoint 自行创建并写回，保证 caller 在 scope 内可见。
  callsiteContext?: CallsiteContext
  // per-executor 数据流写入上下文（节点缓存、边缓冲、去重、计数器）
  writerContext?: DataflowWriterContext
}

export interface EntryPointExecutionAdapter<TEntryPoint, TContext extends EntryPointExecutionContext<TEntryPoint>> {
  language: string
  classify(entryPoint: TEntryPoint): EntryPointKind
  before?(context: TContext): void
  execute(context: TContext): void
  after?(context: TContext): void
  dispose?(context: TContext): void
  onError?(context: TContext, error: unknown): ErrorDisposition
}

interface CurrentEntryPointModule {
  resetCallsiteStack(): void
  runWithEntryPointContext<T>(entryPoint: unknown, callback: () => T): T
  createCallsiteContext(): CallsiteContext
  runWithCallsiteContext<T>(context: CallsiteContext, callback: () => T): T
}

function getCurrentEntryPointModule(): CurrentEntryPointModule {
  return require('./current-entrypoint') as CurrentEntryPointModule
}

function resetCallsiteStack(): void {
  getCurrentEntryPointModule().resetCallsiteStack()
}

function snapshotExecutionState(state: State | undefined): ExecutionStateSnapshot | undefined {
  if (!state) return undefined
  return {
    pcond: state.pcond.slice(0),
    callsites: state.callsites?.slice(0),
  }
}

function restoreExecutionState(state: State | undefined, snapshot: ExecutionStateSnapshot | undefined): void {
  if (!state || !snapshot) return
  state.pcond = snapshot.pcond
  if (snapshot.callsites) {
    state.callsites = snapshot.callsites
  } else {
    delete state.callsites
  }
}

export function executeIsolatedEntryPoint<
  TEntryPoint,
  TContext extends EntryPointExecutionContext<TEntryPoint>,
>(context: TContext, adapter: EntryPointExecutionAdapter<TEntryPoint, TContext>): void {
  const executionStateSnapshot = snapshotExecutionState(context.executionState)
  const mod = getCurrentEntryPointModule()
  // executor 内路径走 context-local callsite stack；fresh context 进入 ALS scope，
  // 与 entryPointContext 一起隔离。caller 不再依赖 module-global fallback，
  // module-global 仅服务于 serial 兼容路径（pre-scan、未走 executor 的旧路径）。
  const callsiteContext = context.callsiteContext ?? mod.createCallsiteContext()
  context.callsiteContext = callsiteContext
  try {
    mod.runWithEntryPointContext(context.entryPoint, () => {
      mod.runWithCallsiteContext(callsiteContext, () => {
        let beforeCompleted = false
        try {
          adapter.before?.(context)
          beforeCompleted = true
          adapter.execute(context)
        } finally {
          // Before 成功后必须配对 After，即使执行阶段抛出异常也要完成收尾。
          if (beforeCompleted) adapter.after?.(context)
        }
      })
    })
  } catch (error) {
    const disposition = adapter.onError?.(context, error) ?? 'rethrow'
    if (disposition === 'rethrow') {
      throw error
    }
  } finally {
    try {
      adapter.dispose?.(context)
    } finally {
      restoreExecutionState(context.executionState, executionStateSnapshot)
      // dispose / 异常路径：清理 context-local 栈并复位 module-global，避免污染下一次 serial fallback。
      callsiteContext.stack.length = 0
      callsiteContext.cachedId = null
      callsiteContext.cacheValid = true
      resetCallsiteStack()
    }
  }
}
