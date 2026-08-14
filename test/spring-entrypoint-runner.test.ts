import assert from 'assert'
import { describe, it } from 'mocha'
import { cloneSpringExecutionState } from '../src/engine/analyzer/java/spring/spring-execution-state'
import { createDeadlinePlan } from '../src/engine/analyzer/common/entrypoint/deadline-scheduler'
import { runAllocatedAttempt } from '../src/engine/analyzer/common/entrypoint/attempt-runner'
import { buildSpringConcreteWorklist, runSpringConcreteWorklist } from '../src/engine/analyzer/java/spring/spring-entrypoint-scheduler'
import type { FunctionDefinition } from '../src/types/uast'

const overload = (name: string): FunctionDefinition => ({ id: { name } }) as FunctionDefinition

type FakeValue = { id: string }
type FakeScope = { id: string }

describe('Spring production entrypoint runner seam', () => {
  it('marks and prunes once per entrypoint, keeps every overload, and uses worklist denominator', () => {
    const callbacks: string[] = []
    const entries = [{ id: 1 }, { id: 2 }]
    const worklist = buildSpringConcreteWorklist({
      entryPoints: entries,
      getSymbol: (entryPoint) => ({ overloads: [overload(`a-${entryPoint.id}`), overload(`b-${entryPoint.id}`)] }),
      getOverloads: (symbol) => symbol.overloads,
      isSupported: () => true,
      mark: (entryPoint) => {
        callbacks.push(`mark-${entryPoint.id}`)
        return { skipped: false }
      },
      canPrune: (symbol) => {
        callbacks.push(`prune-${symbol.overloads[0].id?.name}`)
        return false
      },
    })
    assert.strictEqual(worklist.length, 4)
    assert.deepStrictEqual(callbacks, ['mark-1', 'prune-a-1', 'mark-2', 'prune-a-2'])
    assert.strictEqual(worklist.length, 4)
  })

  it('allocates concrete overloads with N then N-1 and distinct deadlines', () => {
    const plan = createDeadlinePlan({ outerDeadline: 1000, finalizationReserveMs: 0, exitReserveMs: 0 }, () => 0)
    const worklist = [{ entryPoint: { id: 1 }, overload: overload('a') }, { entryPoint: { id: 1 }, overload: overload('b') }]
    const deadlines: number[] = []
    const results = runSpringConcreteWorklist({ plan, worklist, state: {}, clock: () => 0, quickCapMs: 600,
      getArgs: () => [], execute: () => { deadlines.push(plan.now()) }, enqueueTimeout: () => {} })
    assert.deepStrictEqual(results.map(result => result.allocated), [true, true])
    assert.strictEqual(deadlines.length, 2)
    assert.notStrictEqual(plan.allocateAttempt(2, { configuredCapMs: 600, now: 0 })?.deadline, plan.allocateAttempt(1, { configuredCapMs: 600, now: 0 })?.deadline)
  })

  it('passes concrete-attempt progress metadata for every worklist item', () => {
    const plan = createDeadlinePlan({ outerDeadline: 1000, finalizationReserveMs: 0, exitReserveMs: 0 }, () => 0)
    const worklist = [1, 2, 3, 4].map(id => ({ entryPoint: { id }, overload: overload(String(id)) }))
    const progress: Array<{ epIndex: number; epTotal: number }> = []
    runSpringConcreteWorklist({
      plan,
      worklist,
      state: {},
      clock: () => 0,
      quickCapMs: 600,
      getArgs: () => [],
      execute: (_item, _args, metadata) => { progress.push(metadata) },
      enqueueTimeout: () => {},
    })
    assert.deepStrictEqual(progress, [
      { epIndex: 1, epTotal: 4 },
      { epIndex: 2, epTotal: 4 },
      { epIndex: 3, epTotal: 4 },
      { epIndex: 4, epTotal: 4 },
    ])
  })

  it('stops classification at the deadline without touching later callbacks', () => {
    let now = 0
    const callbacks: number[] = []
    const plan = createDeadlinePlan({ outerDeadline: 10, finalizationReserveMs: 0, exitReserveMs: 0 }, () => now)
    const worklist = buildSpringConcreteWorklist({
      entryPoints: [{ id: 1 }, { id: 2 }, { id: 3 }],
      getSymbol: (entryPoint) => ({ overloads: [overload(String(entryPoint.id))] }),
      getOverloads: (symbol) => symbol.overloads,
      isSupported: () => true,
      mark: (entryPoint) => {
        callbacks.push(entryPoint.id)
        now = 10
        return { skipped: false }
      },
      canPrune: () => false,
      deadlinePlan: plan,
    })
    assert.strictEqual(worklist.length, 0)
    assert.deepStrictEqual(callbacks, [1])
  })

  it('excludes the current entry when mark reaches the deadline', () => {
    let now = 0
    let pruned = 0
    let overloads = 0
    const plan = createDeadlinePlan({ outerDeadline: 10, finalizationReserveMs: 0, exitReserveMs: 0 }, () => now)
    const worklist = buildSpringConcreteWorklist({
      entryPoints: [{ id: 1 }],
      getSymbol: () => ({}),
      getOverloads: () => { overloads++; return [overload('late')] },
      isSupported: () => true,
      mark: () => { now = 10; return { skipped: false } },
      canPrune: () => { pruned++; return false },
      deadlinePlan: plan,
    })
    assert.strictEqual(worklist.length, 0)
    assert.strictEqual(pruned, 0)
    assert.strictEqual(overloads, 0)
  })

  it('excludes the current entry when prune reaches the deadline', () => {
    let now = 0
    let overloads = 0
    const plan = createDeadlinePlan({ outerDeadline: 10, finalizationReserveMs: 0, exitReserveMs: 0 }, () => now)
    const worklist = buildSpringConcreteWorklist({
      entryPoints: [{ id: 1 }],
      getSymbol: () => ({}),
      getOverloads: () => { overloads++; return [overload('late')] },
      isSupported: () => true,
      mark: () => ({ skipped: false }),
      canPrune: () => { now = 10; return false },
      deadlinePlan: plan,
    })
    assert.strictEqual(worklist.length, 0)
    assert.strictEqual(overloads, 0)
  })

  it('does not mutate refs or analysis state when budget is zero', () => {
    const entryPoint = { entryPointSymVal: { id: 'sym' }, scopeVal: { id: 'scope' } }
    const before = { ...entryPoint }
    const state = {}
    let refs = 0
    let analyzed = 0
    let pruned = 0
    let checker = 0
    const result = runAllocatedAttempt({
      plan: createDeadlinePlan({ outerDeadline: 0, finalizationReserveMs: 0, exitReserveMs: 0 }, () => 0),
      remainingAttempts: 1,
      state,
      clock: () => 0,
      before: () => {
        refs++
        analyzed++
        pruned++
      },
      execute: () => {
        checker++
      },
      enqueueTimeout: () => {
        checker++
      },
      overload: 'spring',
      args: [],
      entryPoint,
    })
    assert.deepStrictEqual(result, { allocated: false, timedOut: false })
    assert.deepStrictEqual(entryPoint, before)
    assert.strictEqual(refs + analyzed + pruned + checker, 0)
  })

  it('uses one clone identity for symbol and scope, and restores rejected attempts', () => {
    const originalSym: FakeValue = { id: 'sym' }
    const originalScope: FakeScope = { id: 'scope' }
    const entryPoint = { entryPointSymVal: originalSym, scopeVal: originalScope }
    const clones: object[] = []
    let checkerBefore = 0
    let checkerAfter = 0
    let executed = 0
    const clone = <T extends object>(value: T | undefined): T => {
      const copy = { ...(value as T) }
      clones.push(copy)
      return copy
    }
    const attempt = cloneSpringExecutionState(entryPoint, clone)
    assert.notStrictEqual(attempt.entryPointSymVal, originalSym)
    assert.notStrictEqual(attempt.scopeVal, originalScope)
    assert.strictEqual(entryPoint.entryPointSymVal, attempt.entryPointSymVal)
    assert.strictEqual(entryPoint.scopeVal, attempt.scopeVal)
    attempt.restore()
    assert.strictEqual(entryPoint.entryPointSymVal, originalSym)
    assert.strictEqual(entryPoint.scopeVal, originalScope)
    assert.strictEqual(clones.length, 2)

    const plan = createDeadlinePlan({ outerDeadline: 100, finalizationReserveMs: 0, exitReserveMs: 0 }, () => 0)
    const rejected = runAllocatedAttempt({
      plan,
      remainingAttempts: 1,
      configuredCapMs: 50,
      state: {},
      clock: () => 0,
      before: () => {
        checkerBefore++
      },
      execute: () => {
        executed++
      },
      after: () => {
        checkerAfter++
      },
      enqueueTimeout: () => {
        executed++
      },
      overload: 'spring',
      args: [],
      entryPoint,
    })
    assert.strictEqual(rejected.allocated, true)
    assert.strictEqual(checkerBefore, 1)
    assert.strictEqual(checkerAfter, 1)
    assert.strictEqual(executed, 1)
  })

  it('enqueues exactly once for timeout plus exception and retries with capped fair share', () => {
    const originalSym = { id: 'sym' }
    const originalScope = { id: 'scope' }
    const entryPoint = { entryPointSymVal: originalSym, scopeVal: originalScope }
    let queued = 0
    let before = 0
    let after = 0
    const state: { entryPointTimeoutLatch?: { trip(): boolean } } = {}
    const plan = createDeadlinePlan({ outerDeadline: 1_000_000, finalizationReserveMs: 0, exitReserveMs: 0 }, () => 0)
    assert.throws(() =>
      runAllocatedAttempt({
        plan,
        remainingAttempts: 2,
        configuredCapMs: 600_000,
        state,
        clock: () => 0,
        before: () => {
          before++
        },
        execute: () => {
          state.entryPointTimeoutLatch?.trip()
          throw new Error('timeout')
        },
        after: () => {
          after++
        },
        enqueueTimeout: () => {
          queued++
        },
        overload: 'spring',
        args: [],
        entryPoint,
      })
    )
    assert.strictEqual(queued, 1)
    assert.strictEqual(before, 1)
    assert.strictEqual(after, 0)
    assert.strictEqual(entryPoint.entryPointSymVal, originalSym)
    assert.strictEqual(entryPoint.scopeVal, originalScope)
    const budget = plan.allocateAttempt(2, { configuredCapMs: 600_000, now: 0 })
    assert.strictEqual(budget?.allocationMs, 500_000)
  })
})
