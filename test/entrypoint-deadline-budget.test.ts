import * as assert from 'assert'
import { describe, it } from 'mocha'
import type { State } from '../src/types/analyzer'
import { executeViaEntryPointExecutor } from '../src/engine/analyzer/common/entrypoint/entrypoint-executor'

interface FakeAnalyzer {
  executeCall(name: string): void
}

function isFakeAnalyzer(value: unknown): value is FakeAnalyzer {
  return typeof value === 'object' && value !== null && 'executeCall' in value && typeof value.executeCall === 'function'
}

import {
  createDeadlinePlan,
  createTimeoutLatch,
  type DeadlinePlan,
  type MonotonicClock,
} from '../src/engine/analyzer/common/entrypoint/deadline-scheduler'

interface AttemptRun {
  started: number[]
  skipped: number
}

function runAttempts(
  plan: DeadlinePlan,
  totalAttempts: number,
  now: MonotonicClock,
  configuredCapMs: number,
): AttemptRun {
  const started: number[] = []
  let skipped = 0
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const remainingAttempts = totalAttempts - attempt
    const currentTime = now()
    const budget = plan.allocateAttempt(remainingAttempts, { configuredCapMs, now: currentTime })
    if (budget === null) {
      skipped += totalAttempts - attempt
      break
    }
    started.push(budget.allocationMs)
  }
  return { started, skipped }
}

describe('entrypoint retry deadline budget contract', () => {
  it('uses monotonic elapsed time even when wall clock rolls back', () => {
    let wallClockNow = 10_000
    let wallClockReads = 0
    const monotonicValues = [100, 112.6]
    let monotonicIndex = 0
    const originalDateNow = Date.now
    const originalStdoutWrite = process.stdout.write
    const output: string[] = []
    Date.now = (): number => {
      wallClockReads += 1
      const current = wallClockNow
      wallClockNow -= 1_000
      return current
    }
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stdout.write
    try {
      executeViaEntryPointExecutor(
        { analyzer: {}, entryPoint: { name: 'clock-test' }, metricStartTime: 0, findingsBefore: 0, executionState: undefined },
        { language: 'java', classify: () => 'function', execute: () => undefined },
        undefined,
        { monotonicClock: (): number => monotonicValues[monotonicIndex++] ?? monotonicValues[monotonicValues.length - 1] },
      )
      assert.strictEqual(monotonicIndex, 2)
      assert.ok(wallClockReads >= 2)
      assert.ok(output.some((line) => line.includes('Find 0 findings, cost: 13ms,')))
    } finally {
      Date.now = originalDateNow
      process.stdout.write = originalStdoutWrite
    }
  })
  it('does not start analysis after a short global budget expires', () => {
    const plan = createDeadlinePlan(
      { outerDeadline: 120, finalizationReserveMs: 20, exitReserveMs: 5 },
      () => 100,
    )

    assert.strictEqual(plan.analysisDeadline, 100)
    assert.strictEqual(plan.canStartAnalysis(99), true)
    assert.strictEqual(plan.canStartAnalysis(100), false)
    assert.strictEqual(plan.allocateAttempt(1, { configuredCapMs: 50, now: 100 }), null)
  })

  it('uses fair-share allocation for each remaining overload attempt', () => {
    const plan = createDeadlinePlan(
      { outerDeadline: 1_000, finalizationReserveMs: 100, exitReserveMs: 0 },
      () => 0,
    )

    const allocations = [4, 3, 2, 1].map((remainingAttempts) =>
      plan.allocateAttempt(remainingAttempts, { configuredCapMs: 1_000, now: 100 }),
    )

    assert.deepStrictEqual(allocations.map((budget) => budget?.allocationMs), [800 / 4, 800 / 3, 800 / 2, 800])
    assert.deepStrictEqual(allocations.map((budget) => budget?.remainingAttempts), [4, 3, 2, 1])
  })

  it('returns no allocation when the configured cap is zero', () => {
    const plan = createDeadlinePlan(
      { outerDeadline: 1_000, finalizationReserveMs: 100, exitReserveMs: 0 },
      () => 0,
    )

    assert.strictEqual(plan.allocateAttempt(3, { configuredCapMs: 0, now: 100 }), null)
    assert.strictEqual(plan.allocateAttempt(3, { configuredCapMs: -1, now: 100 }), null)
    const allocateAttemptAtRuntime = (...args: unknown[]): unknown => Reflect.apply(plan.allocateAttempt, plan, args)
    const invalidCaps: ReadonlyArray<unknown> = [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]
    for (const configuredCapMs of invalidCaps) {
      assert.strictEqual(allocateAttemptAtRuntime(3, { configuredCapMs, now: 100 }), null)
    }
  })

  it('shrinks retry allocation as elapsed time increases', () => {
    const plan = createDeadlinePlan(
      { outerDeadline: 1_000, finalizationReserveMs: 100, exitReserveMs: 0 },
      () => 0,
    )

    const first = plan.allocateAttempt(3, { configuredCapMs: 1_000, now: 100 })
    const later = plan.allocateAttempt(2, { configuredCapMs: 1_000, now: 700 })

    assert.ok(first)
    assert.ok(later)
    assert.ok(Math.abs(first.allocationMs - (800 / 3)) < 1e-9)
    assert.strictEqual(later.allocationMs, 100)
    assert.ok(later.allocationMs < first.allocationMs)
  })

  it('stops starting retries at the analysis deadline and reports skipped attempts', () => {
    let currentTime = 100
    const plan = createDeadlinePlan(
      { outerDeadline: 200, finalizationReserveMs: 20, exitReserveMs: 5 },
      () => currentTime,
    )

    const first = plan.allocateAttempt(3, { configuredCapMs: 100, now: currentTime })
    assert.ok(first)
    currentTime = 180

    const result = runAttempts(plan, 3, () => currentTime, 100)
    assert.deepStrictEqual(result.started, [])
    assert.strictEqual(result.skipped, 3)
    assert.strictEqual(plan.canStartAnalysis(currentTime), false)
  })

  it('preserves all attempts when the configured budget is sufficient', () => {
    const plan = createDeadlinePlan(
      { outerDeadline: 1_000, finalizationReserveMs: 100, exitReserveMs: 20 },
      () => 0,
    )
    const result = runAttempts(plan, 3, () => 100, 100)

    assert.strictEqual(result.started.length, 3)
    assert.strictEqual(result.skipped, 0)
    assert.deepStrictEqual(result.started, [100, 100, 100])
  })

  it('reserves finalization and stops analysis before the outer deadline', () => {
    const plan = createDeadlinePlan(
      { outerDeadline: 1_000, finalizationReserveMs: 100, exitReserveMs: 25 },
      () => 0,
    )

    assert.strictEqual(plan.analysisDeadline, 875)
    assert.strictEqual(plan.finalizationDeadline, 975)
    assert.strictEqual(plan.canStartAnalysis(874), true)
    assert.strictEqual(plan.canStartAnalysis(875), false)
    assert.strictEqual(plan.canStartAnalysis(974), false)
    assert.strictEqual(plan.canFinalize(974), true)
    assert.strictEqual(plan.canFinalize(975), false)
  })

  it('keeps timeout latched through errors and permits only post-attempt reset', () => {
    const latch = createTimeoutLatch()
    let executorCalls = 0
    let cleanupCalls = 0

    try {
      executorCalls += 1
      latch.trip()
      throw new Error('attempt timeout')
    } catch {
      cleanupCalls += 1
      assert.strictEqual(latch.timedOut, true)
      assert.strictEqual(latch.trip(), false)
    } finally {
      assert.strictEqual(latch.timedOut, true)
    }

    assert.strictEqual(executorCalls, 1)
    assert.strictEqual(cleanupCalls, 1)
    latch.reset()
    assert.strictEqual(latch.timedOut, false)
  })

  it('propagates timeout through branch and callback candidate checks', () => {
    const latch = createTimeoutLatch()
    const executed: string[] = []
    const runCandidate = (name: string): boolean => {
      if (latch.timedOut) return false
      executed.push(name)
      return true
    }

    assert.strictEqual(runCandidate('executeCall'), true)
    latch.trip()
    assert.strictEqual(runCandidate('alternative-branch'), false)
    assert.strictEqual(runCandidate('callback'), false)
    assert.deepStrictEqual(executed, ['executeCall'])
  })

  it('keeps timeout latched until the attempt is reset', () => {
    const latch = createTimeoutLatch()

    assert.strictEqual(latch.trip(), true)
    assert.strictEqual(latch.timedOut, true)
    assert.strictEqual(latch.trip(), false)
    assert.strictEqual(latch.timedOut, true)
    latch.reset()
    assert.strictEqual(latch.timedOut, false)
  })

  it('stops executeCall, branch, callback, and overload candidates after timeout', () => {
    const latch = createTimeoutLatch()
    const executed: string[] = []
    const runAnalysis = (name: string): boolean => {
      if (latch.timedOut) return false
      executed.push(name)
      return true
    }

    assert.strictEqual(runAnalysis('executeCall'), true)
    assert.strictEqual(runAnalysis('consequent-branch'), true)
    assert.strictEqual(latch.trip(), true)
    for (const candidate of ['alternative-branch', 'callback', 'overload-2', 'overload-3']) {
      assert.strictEqual(runAnalysis(candidate), false)
    }
    assert.deepStrictEqual(executed, ['executeCall', 'consequent-branch'])
  })


  it('runs Java analyzer executeCall through the entrypoint executor and resets context on failure', () => {
    const calls: string[] = []
    const analyzer = {
      executeCall: (name: string): void => { calls.push(name) },
    }
    const state: State = {
      pcond: [],
      callstack: [],
      brs: '',
      binfo: {},
      einfo: {},
      callsites: [],
    }
    const entryPoint = { name: 'java-overload' }

    executeViaEntryPointExecutor(
      { analyzer, entryPoint, metricStartTime: 0, findingsBefore: 0, executionState: state },
      {
        language: 'java',
        classify: () => 'function',
        execute: ({ analyzer: currentAnalyzer }: { analyzer: unknown }) => {
          assert.strictEqual(isFakeAnalyzer(currentAnalyzer), true)
          if (!isFakeAnalyzer(currentAnalyzer)) return
          currentAnalyzer.executeCall('executeCall')
          currentAnalyzer.executeCall('branch')
          currentAnalyzer.executeCall('callback')
          currentAnalyzer.executeCall('overload')
          throw new Error('retry cutoff')
        },
        onError: () => 'handled',
      },
    )

    assert.deepStrictEqual(calls, ['executeCall', 'branch', 'callback', 'overload'])
    assert.deepStrictEqual(state.pcond, [])
    assert.deepStrictEqual(state.callsites, [])
  })

  it('allows bounded finalization while refusing new analysis at the reserve boundary', () => {
    const plan = createDeadlinePlan(
      { outerDeadline: 500, finalizationReserveMs: 100, exitReserveMs: 25 },
      () => 0,
    )
    let analysisCalls = 0
    let finalizationCalls = 0
    const now = 400

    if (plan.canStartAnalysis(now)) analysisCalls += 1
    if (plan.canFinalize(now)) finalizationCalls += 1
    assert.strictEqual(analysisCalls, 0)
    assert.strictEqual(finalizationCalls, 1)
    assert.strictEqual(plan.canFinalize(475), false)
  })
})
