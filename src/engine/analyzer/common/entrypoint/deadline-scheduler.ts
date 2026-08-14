/** 单调时钟驱动的 EntryPoint 生命周期预算与超时锁存。 */
export type MonotonicClock = () => number

export interface DeadlinePlanOptions {
  outerDeadline: number
  finalizationReserveMs: number
  exitReserveMs: number
}

export interface AttemptBudgetOptions {
  configuredCapMs: number | null | undefined
  now?: number
}

export interface ConcreteWorkCandidate<T> {
  readonly value: T
  readonly supported: boolean
  readonly pruned: boolean
  readonly hasAst: boolean
  readonly concreteOverloads: number
}

export function countEligibleConcreteWork<T>(candidates: readonly ConcreteWorkCandidate<T>[]): number {
  return candidates.reduce((total, candidate) => {
    if (!candidate.supported || candidate.pruned || !candidate.hasAst) return total
    return total + Math.max(0, Math.floor(candidate.concreteOverloads))
  }, 0)
}

export interface AttemptBudget {
  readonly deadline: number
  readonly allocationMs: number
  readonly remainingAttempts: number
}

export function formatBudgetMs(value: number): number {
  return Math.max(0, Math.round(value))
}

export interface DeadlinePlan {
  readonly outerDeadline: number
  readonly analysisDeadline: number
  readonly finalizationDeadline: number
  readonly finalizationReserveMs: number
  readonly exitReserveMs: number
  now(): number
  canStartAnalysis(now?: number): boolean
  canFinalize(now?: number): boolean
  allocateAttempt(remainingAttempts: number, options: AttemptBudgetOptions): AttemptBudget | null
}

export interface TimeoutLatch {
  readonly timedOut: boolean
  trip(): boolean
  reset(): void
}

const defaultClock: MonotonicClock = (): number => {
  return performance.now()
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function createTimeoutLatch(): TimeoutLatch {
  let timedOut = false
  return {
    get timedOut(): boolean { return timedOut },
    trip(): boolean {
      if (timedOut) return false
      timedOut = true
      return true
    },
    reset(): void { timedOut = false },
  }
}

export function createDeadlinePlan(options: DeadlinePlanOptions, clock: MonotonicClock = defaultClock): DeadlinePlan {
  const now = clock()
  const availableBudget = Math.max(0, options.outerDeadline - now)
  const exitReserveMs = Math.min(nonNegative(options.exitReserveMs), availableBudget)
  const finalizationReserveMs = Math.min(
    nonNegative(options.finalizationReserveMs),
    Math.max(0, availableBudget - exitReserveMs)
  )
  const finalizationDeadline = Math.min(options.outerDeadline, options.outerDeadline - exitReserveMs)
  const analysisDeadline = Math.min(finalizationDeadline, options.outerDeadline - finalizationReserveMs - exitReserveMs)
  return {
    outerDeadline: options.outerDeadline,
    analysisDeadline,
    finalizationDeadline,
    finalizationReserveMs,
    exitReserveMs,
    now: clock,
    canStartAnalysis(now = clock()): boolean { return now < analysisDeadline },
    canFinalize(now = clock()): boolean { return now < finalizationDeadline },
    allocateAttempt(remainingAttempts: number, attemptOptions: AttemptBudgetOptions): AttemptBudget | null {
      const now = attemptOptions.now ?? clock()
      const attempts = Math.max(0, Math.floor(remainingAttempts))
      if (attempts === 0 || now >= analysisDeadline) return null
      const remainingUsable = Math.max(0, analysisDeadline - now)
      const fairShare = remainingUsable / attempts
      const configuredCapMs = nonNegative(attemptOptions.configuredCapMs ?? 0)
      const allocationMs = Math.min(configuredCapMs, fairShare, remainingUsable)
      if (allocationMs <= 0) return null
      return { deadline: now + allocationMs, allocationMs, remainingAttempts: attempts }
    },
  }
}
