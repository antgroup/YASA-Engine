import type { FunctionDefinition } from '../../../../types/uast'
import type { DeadlinePlan, AttemptBudget } from '../../common/entrypoint/deadline-scheduler'
import { runAllocatedAttempt, type AttemptRuntimeState, type AttemptRunResult } from '../../common/entrypoint/attempt-runner'

// 调度分类只做轻量标记与裁剪，不把具体执行尝试计入预算。

export type SpringScheduledEntryPoint<TEntryPoint> = {
  entryPoint: TEntryPoint
  overload: FunctionDefinition
}

export type SpringEntryPointSchedulerOptions<TEntryPoint, TSymbol> = {
  entryPoints: TEntryPoint[]
  getSymbol(entryPoint: TEntryPoint): TSymbol | undefined
  getOverloads(symbol: TSymbol): FunctionDefinition[]
  isSupported(entryPoint: TEntryPoint): boolean
  mark(entryPoint: TEntryPoint): { skipped: boolean }
  canPrune(symbol: TSymbol): boolean
  deadlinePlan?: DeadlinePlan
}

/** 按入口只执行一次去重与裁剪判定，再为该入口保留全部可执行重载。 */
export function buildSpringConcreteWorklist<TEntryPoint, TSymbol>(
  options: SpringEntryPointSchedulerOptions<TEntryPoint, TSymbol>
): SpringScheduledEntryPoint<TEntryPoint>[] {
  const worklist: SpringScheduledEntryPoint<TEntryPoint>[] = []
  for (const entryPoint of options.entryPoints) {
    if (options.deadlinePlan && !options.deadlinePlan.canStartAnalysis()) break
    if (!options.isSupported(entryPoint)) continue
    const symbol = options.getSymbol(entryPoint)
    if (!symbol) continue
    const mark = options.mark(entryPoint)
    if (mark.skipped) continue
    if (options.deadlinePlan && !options.deadlinePlan.canStartAnalysis()) break
    if (options.canPrune(symbol)) {
      if (options.deadlinePlan && !options.deadlinePlan.canStartAnalysis()) break
      continue
    }
    if (options.deadlinePlan && !options.deadlinePlan.canStartAnalysis()) break
    for (const overload of options.getOverloads(symbol)) worklist.push({ entryPoint, overload })
  }
  return worklist
}

export type SpringConcreteAttemptProgress = {
  epIndex: number
  epTotal: number
}

export type SpringConcreteAttemptOptions<TEntryPoint, TArgs, TState extends AttemptRuntimeState> = {
  plan: DeadlinePlan
  worklist: SpringScheduledEntryPoint<TEntryPoint>[]
  state: TState
  clock: () => number
  quickCapMs: number
  getArgs(item: SpringScheduledEntryPoint<TEntryPoint>): TArgs
  execute(item: SpringScheduledEntryPoint<TEntryPoint>, args: TArgs, progress: SpringConcreteAttemptProgress): void
  enqueueTimeout(item: SpringScheduledEntryPoint<TEntryPoint>, args: TArgs): void
}

/** 按具体 overload 消费 Spring worklist；每次尝试独立分配和恢复执行状态。 */
export function runSpringConcreteWorklist<TEntryPoint, TArgs, TState extends AttemptRuntimeState>(
  options: SpringConcreteAttemptOptions<TEntryPoint, TArgs, TState>
): AttemptRunResult[] {
  const results: AttemptRunResult[] = []
  for (let index = 0; index < options.worklist.length; index++) {
    const item = options.worklist[index]
    let args!: TArgs
    results.push(runAllocatedAttempt({
      plan: options.plan,
      remainingAttempts: options.worklist.length - index,
      configuredCapMs: options.quickCapMs,
      state: options.state,
      clock: options.clock,
      prepareArgs: () => { args = options.getArgs(item); return args },
      execute: () => options.execute(item, args, { epIndex: index + 1, epTotal: options.worklist.length }),
      enqueueTimeout: (_overload, timeoutArgs) => options.enqueueTimeout(item, timeoutArgs),
      overload: item.overload,
      args,
      entryPoint: item.entryPoint,
    }))
  }
  return results
}
