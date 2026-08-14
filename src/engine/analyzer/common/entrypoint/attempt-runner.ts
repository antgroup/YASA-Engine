import { createTimeoutLatch } from './deadline-scheduler'
import type { AttemptBudget, DeadlinePlan, TimeoutLatch } from './deadline-scheduler'

export interface AttemptRuntimeState {
  entryPointDeadline?: number
  entryPointClock?: () => number
  entryPointTimeoutLatch?: TimeoutLatch
}

export interface AttemptRunnerOptions<TState extends AttemptRuntimeState, TOverload, TEntryPoint, TArgs> {
  plan: DeadlinePlan
  remainingAttempts: number
  configuredCapMs?: number
  state: TState
  clock: () => number
  allocate?(budget: AttemptBudget): void
  before?(): void
  execute(): void
  after?(): void
  enqueueTimeout(overload: TOverload, args: TArgs, entryPoint: TEntryPoint): void
  overload: TOverload
  args?: TArgs
  prepareArgs?(): TArgs
  setArgs?(args: TArgs): void
  attemptContext?: { args?: TArgs; setArgs(args: TArgs): void }
  entryPoint: TEntryPoint
  onAttemptStart?(): void
  onAttemptEnd?(): void
}

export interface AttemptRunResult {
  allocated: boolean
  timedOut: boolean
}

/** 在安装尝试状态前完成单调预算分配，并统一保证清理与超时入队。 */
export function runAllocatedAttempt<TState extends AttemptRuntimeState, TOverload, TEntryPoint, TArgs>(
  options: AttemptRunnerOptions<TState, TOverload, TEntryPoint, TArgs>
): AttemptRunResult {
  const budget = options.plan.allocateAttempt(options.remainingAttempts, { configuredCapMs: options.configuredCapMs })
  if (!budget) return { allocated: false, timedOut: false }
  let attemptArgs = options.args
  const oldDeadline = options.state.entryPointDeadline
  const oldClock = options.state.entryPointClock
  const oldLatch = options.state.entryPointTimeoutLatch
  let timedOut = false
  const latch: TimeoutLatch = createTimeoutLatch()
  options.state.entryPointDeadline = budget.deadline
  options.state.entryPointClock = options.clock
  options.state.entryPointTimeoutLatch = latch
  options.allocate?.(budget)
  try {
    options.onAttemptStart?.()
    const setAttemptArgs = (args: TArgs): void => {
      attemptArgs = args
      if (options.attemptContext) options.attemptContext.args = args
      options.setArgs?.(args)
    }
    if (options.attemptContext) {
      options.attemptContext.setArgs = setAttemptArgs
      options.attemptContext.args = attemptArgs
    }
    if (options.prepareArgs) setAttemptArgs(options.prepareArgs())
    options.before?.()
    options.execute()
    options.after?.()
  } finally {
    timedOut = latch.timedOut
    try {
      if (timedOut) {
        const timeoutArgs = options.attemptContext?.args ?? attemptArgs
        if (timeoutArgs !== undefined) options.enqueueTimeout(options.overload, timeoutArgs, options.entryPoint)
      }
    } finally {
      options.onAttemptEnd?.()
      if (oldDeadline === undefined) delete options.state.entryPointDeadline
      else options.state.entryPointDeadline = oldDeadline
      if (oldClock === undefined) delete options.state.entryPointClock
      else options.state.entryPointClock = oldClock
      if (oldLatch === undefined) delete options.state.entryPointTimeoutLatch
      else options.state.entryPointTimeoutLatch = oldLatch
    }
  }
  return { allocated: true, timedOut }
}
