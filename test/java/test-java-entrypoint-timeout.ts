import * as assert from 'assert'
import { describe, it } from 'mocha'
import type { State, Value, Scope } from '../../src/types/analyzer'
import { createTimeoutLatch } from '../../src/engine/analyzer/common/entrypoint/deadline-scheduler'

const JavaAnalyzerModule = require('../../src/engine/analyzer/java/common/java-analyzer') as { prototype: JavaAnalyzerPrototype }

type TimedState = State & { entryPointDeadline?: number; entryPointClock?: () => number; entryPointTimeoutLatch?: ReturnType<typeof createTimeoutLatch> }
type ConditionalNode = { test: unknown; consequent: unknown; alternative: unknown; loc?: { start?: { line?: number; column?: number } } }
type JavaAnalyzerPrototype = { shouldAbortExecutionForTimeout(state: State): boolean; processConditionalExpression(scope: Scope, node: ConditionalNode, state: State): Value }
type ConditionalHarness = JavaAnalyzerPrototype & { globalState: { entryPointTimeout?: boolean }; processInstruction(scope: Scope, node: unknown, state: State): Value; processLRScopeInternal(left: State, right: State, state: State, test: Value): void; snapshotMethodBudgets(): { methodTime: Map<string, number>; callsiteCount: Map<string, number> }; restoreMethodBudgets(snapshot: { methodTime: Map<string, number>; callsiteCount: Map<string, number> }): void; mergeMethodBudgets(left: { methodTime: Map<string, number>; callsiteCount: Map<string, number> }, right: { methodTime: Map<string, number>; callsiteCount: Map<string, number> }): void }
const createState = (): State => ({ pcond: [], callstack: [], brs: '', binfo: {}, einfo: {}, callsites: [] })
describe('Java entrypoint timeout and conditional execution', () => {
  it('aborts at the injected monotonic deadline and latches timeout state', () => {
    let monotonicNow = 99
    const latch = createTimeoutLatch()
    const state: TimedState = { ...createState(), entryPointDeadline: 100, entryPointClock: () => monotonicNow, entryPointTimeoutLatch: latch }
    const analyzer = { globalState: {} } as unknown as JavaAnalyzerPrototype & { globalState: { entryPointTimeout?: boolean } }
    assert.strictEqual(JavaAnalyzerModule.prototype.shouldAbortExecutionForTimeout.call(analyzer, state), false)
    monotonicNow = 100
    assert.strictEqual(JavaAnalyzerModule.prototype.shouldAbortExecutionForTimeout.call(analyzer, state), true)
    assert.strictEqual(latch.timedOut, true)
    assert.strictEqual(analyzer.globalState.entryPointTimeout, true)
  })
  it('does not process the alternative after the consequent trips the attempt latch', () => {
    const state = createState(); const scope = { qid: 'java-test-scope' } as unknown as Scope
    const node: ConditionalNode = { test: 'test', consequent: 'consequent', alternative: 'alternative' }; const calls: string[] = []; const latch = createTimeoutLatch()
    const analyzer = Object.create(JavaAnalyzerModule.prototype) as ConditionalHarness
    analyzer.globalState = {}; analyzer.processLRScopeInternal = () => undefined; analyzer.snapshotMethodBudgets = () => ({ methodTime: new Map(), callsiteCount: new Map() }); analyzer.restoreMethodBudgets = () => undefined; analyzer.mergeMethodBudgets = () => undefined
    analyzer.processInstruction = (_scope, instruction, instructionState) => { if (instruction === node.test) return {} as Value; if (latch.timedOut) return {} as Value; calls.push(String(instruction)); if (instruction === node.consequent) { instructionState.entryPointTimeoutLatch = latch; latch.trip(); analyzer.globalState.entryPointTimeout = true }; return {} as Value }
    JavaAnalyzerModule.prototype.processConditionalExpression.call(analyzer, scope, node, state)
    assert.deepStrictEqual(calls, ['consequent']); assert.strictEqual(latch.timedOut, true)
  })
})
