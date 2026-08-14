import * as assert from 'assert'
import { describe, it } from 'mocha'
import { createDeadlinePlan, createTimeoutLatch } from '../src/engine/analyzer/common/entrypoint/deadline-scheduler'

describe('entrypoint deadline scheduler', () => {
  it('reserves finalization and exit time', () => {
    const plan = createDeadlinePlan({ outerDeadline: 1000, finalizationReserveMs: 100, exitReserveMs: 25 }, () => 400)
    assert.strictEqual(plan.analysisDeadline, 875)
    assert.strictEqual(plan.finalizationDeadline, 975)
    assert.strictEqual(plan.canStartAnalysis(874), true)
    assert.strictEqual(plan.canStartAnalysis(875), false)
    assert.strictEqual(plan.canFinalize(974), true)
    assert.strictEqual(plan.canFinalize(975), false)
  })

  it('allocates from actual remaining analysis budget', () => {
    const plan = createDeadlinePlan({ outerDeadline: 1000, finalizationReserveMs: 100, exitReserveMs: 0 })
    assert.deepStrictEqual(plan.allocateAttempt(2, { configuredCapMs: 1000, now: 400 }), { deadline: 650, allocationMs: 250, remainingAttempts: 2 })
    assert.deepStrictEqual(plan.allocateAttempt(2, { configuredCapMs: 1000, now: 700 }), { deadline: 800, allocationMs: 100, remainingAttempts: 2 })
    assert.strictEqual(plan.allocateAttempt(1, { configuredCapMs: 1000, now: 900 }), null)
  })

  it('rounds budget values consistently for logs', () => {
    const { formatBudgetMs } = require('../src/engine/analyzer/common/entrypoint/deadline-scheduler') as typeof import('../src/engine/analyzer/common/entrypoint/deadline-scheduler')
    assert.strictEqual(formatBudgetMs(19247526.861334 / 47), 409522)
    assert.strictEqual(formatBudgetMs(1234.56), 1235)
    assert.strictEqual(formatBudgetMs(0), 0)
  })

  it('latches timeout monotonically until the scheduler resets it', () => {
    const latch = createTimeoutLatch()
    assert.strictEqual(latch.trip(), true)
    assert.strictEqual(latch.trip(), false)
    assert.strictEqual(latch.timedOut, true)
    latch.reset()
    assert.strictEqual(latch.timedOut, false)
  })

  it('does not create zero-length attempts for null or zero caps', () => {
    const plan = createDeadlinePlan({ outerDeadline: 1000, finalizationReserveMs: 100, exitReserveMs: 25 })
    assert.strictEqual(plan.allocateAttempt(1, { configuredCapMs: 0, now: 400 }), null)
    assert.strictEqual(plan.allocateAttempt(1, { configuredCapMs: null, now: 400 }), null)
  })

  it('keeps deadline comparisons in the injected monotonic domain across wall-clock jumps', () => {
    let monotonic = 100
    const plan = createDeadlinePlan({ outerDeadline: 1000, finalizationReserveMs: 0, exitReserveMs: 0 }, () => monotonic)
    const first = plan.allocateAttempt(1, { configuredCapMs: 500 })
    assert.ok(first)
    monotonic = 200
    assert.strictEqual(plan.canStartAnalysis(), true)
    monotonic = 1000
    assert.strictEqual(plan.canStartAnalysis(), false)
    assert.strictEqual(first?.allocationMs, 500)
    assert.strictEqual(first?.deadline, 600)
  })
})
