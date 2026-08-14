import assert from 'assert'
import { describe, it } from 'mocha'
import { createDeadlinePlan, countEligibleConcreteWork } from '../src/engine/analyzer/common/entrypoint/deadline-scheduler'
import { runAllocatedAttempt } from '../src/engine/analyzer/common/entrypoint/attempt-runner'

describe('shared allocated attempt runner', () => {
  it('does no work when allocation is unavailable', () => {
    const state: { entryPointDeadline?: number; entryPointClock?: () => number; entryPointTimeoutLatch?: ReturnType<typeof import('../src/engine/analyzer/common/entrypoint/deadline-scheduler').createTimeoutLatch> } = {}
    const plan = createDeadlinePlan({ outerDeadline: 0, finalizationReserveMs: 0, exitReserveMs: 0 }, () => 0)
    let calls = 0
    const result = runAllocatedAttempt({ plan, remainingAttempts: 1, configuredCapMs: 1, state, clock: () => 0, before: () => { calls++ }, execute: () => { calls++ }, enqueueTimeout: () => { calls++ }, overload: 'java', args: [], entryPoint: 'ep' })
    assert.deepStrictEqual(result, { allocated: false, timedOut: false })
    assert.strictEqual(calls, 0)
  })

  it('enqueues once on timeout and exception and restores state', () => {
    const original = { entryPointDeadline: 9, entryPointClock: () => 9 }
    const state = { ...original }
    let queued = 0
    assert.throws(() => runAllocatedAttempt({ plan: createDeadlinePlan({ outerDeadline: 20, finalizationReserveMs: 0, exitReserveMs: 0 }, () => 10), remainingAttempts: 1, configuredCapMs: 5, state, clock: () => 10, execute: () => { state.entryPointTimeoutLatch?.trip(); throw new Error('boom') }, enqueueTimeout: () => { queued++ }, overload: 'spring', args: ['a'], entryPoint: 'ep' }))
    assert.strictEqual(queued, 1)
    assert.strictEqual(state.entryPointDeadline, 9)
    assert.strictEqual(state.entryPointClock?.(), 9)
  })

  it('counts only eligible concrete work', () => {
    assert.strictEqual(countEligibleConcreteWork([{ value: 'a', supported: true, pruned: false, hasAst: true, concreteOverloads: 2 }, { value: 'b', supported: false, pruned: false, hasAst: true, concreteOverloads: 4 }, { value: 'c', supported: true, pruned: true, hasAst: true, concreteOverloads: 3 }]), 2)
  })

  it('caps quick and retry attempts while respecting smaller fair shares', () => {
    const quickPlan = createDeadlinePlan({ outerDeadline: 100, finalizationReserveMs: 0, exitReserveMs: 0 }, () => 0)
    const retryPlan = createDeadlinePlan({ outerDeadline: 1_000_000, finalizationReserveMs: 0, exitReserveMs: 0 }, () => 0)
    assert.strictEqual(quickPlan.allocateAttempt(1, { configuredCapMs: 120_000 })?.allocationMs, 100)
    assert.strictEqual(retryPlan.allocateAttempt(1, { configuredCapMs: 600_000 })?.allocationMs, 600_000)
    assert.strictEqual(retryPlan.allocateAttempt(2, { configuredCapMs: 600_000 })?.allocationMs, 500_000)
  })

  it('enqueues the final argument object identity and metadata', () => {
    const state = {}
    const initial: { taint: string } = { taint: 'runtime' }
    let queued: unknown
    const context = { args: [] as typeof initial[], setArgs: (_args: typeof initial[]): void => {} }
    runAllocatedAttempt({
      plan: createDeadlinePlan({ outerDeadline: 10, finalizationReserveMs: 0, exitReserveMs: 0 }, () => 0),
      remainingAttempts: 1,
      configuredCapMs: 10,
      state,
      clock: () => 0,
      attemptContext: context,
      execute: () => { const finalArgs = [initial]; context.setArgs(finalArgs); state.entryPointTimeoutLatch?.trip() },
      enqueueTimeout: (_overload, args): void => { queued = args[0] },
      overload: 'java',
      args: context.args,
      entryPoint: 'ep',
    })
    assert.strictEqual(queued, initial)
    assert.deepStrictEqual((queued as typeof initial).taint, 'runtime')
  })
})
