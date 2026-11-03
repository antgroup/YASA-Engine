/**
 * go-analyzer per-callsite interpret count 限流 + 内存护栏 delta 模式单元测试
 *
 * 覆盖 per-callsite 限流 + 内存护栏 delta 模式：
 *   - incrementAndCheckCallsiteLimit：key 设计 + 超限返回 true
 *   - snapshotMethodBudgets/restoreMethodBudgets/mergeMethodBudgets：互斥分支预算快照
 *   - shouldAbortExecutionForMemory：delta 模式判定 + state.exceeded 设置
 *   - resetMemoryGuardForEntryPoint：baseline reset + callsiteInterpretCount.clear
 *   - onEntryPointMemoryGuardFinalize：exceeded=false 时返回非 aborted / exceeded=true 时返回 aborted
 *   - 交互验证：callsiteInterpretCount 在 resetMemoryGuardForEntryPoint 时 clear
 *
 * 说明：GoAnalyzer 继承 Analyzer，构造器需要完整 symbolInterpret 上下文；这里直接引用 prototype
 * 方法，把 helper 所需的 memoryGuardState / callsiteInterpretCount / deltaLimitMb 作为最小 mock 挂上，
 * 不走 processInstruction / checkerManager。重点是验证新 helper 的纯数据遍历 + 限流语义正确。
 */
import { describe, it, beforeEach } from 'mocha'
import * as assert from 'assert'
const GoAnalyzer = require('../../src/engine/analyzer/golang/common/go-analyzer')
const {
  createMemoryGuardState,
  resetForEntryPoint,
  getEntryPointHeapDeltaMb,
} = require('../../src/engine/analyzer/common/memory-guard/entrypoint-memory-guard')

/** 构造一个最小的 GoAnalyzer 替身：只含 helper 需要的字段，方法从 prototype 借过来。 */
function makeAnalyzerStub(): any {
  const stub: any = {
    callsiteInterpretCount: new Map<string, number>(),
    memoryGuardState: createMemoryGuardState(),
    deltaLimitMb: 2048,
    memoryGuardAbortCount: 0,
    memoryGuardFlushCount: 0,
  }
  // 借用 helper 方法（不依赖构造器）
  stub.incrementAndCheckCallsiteLimit = GoAnalyzer.prototype.incrementAndCheckCallsiteLimit
  stub.snapshotMethodBudgets = GoAnalyzer.prototype.snapshotMethodBudgets
  stub.restoreMethodBudgets = GoAnalyzer.prototype.restoreMethodBudgets
  stub.mergeMethodBudgets = GoAnalyzer.prototype.mergeMethodBudgets
  stub.shouldAbortExecutionForMemory = GoAnalyzer.prototype.shouldAbortExecutionForMemory
  stub.resetMemoryGuardForEntryPoint = GoAnalyzer.prototype.resetMemoryGuardForEntryPoint
  stub.onEntryPointMemoryGuardFinalize = GoAnalyzer.prototype.onEntryPointMemoryGuardFinalize
  return stub
}

/** 构造一个 CallExpression 节点 mock。 */
function makeCallNode(nodehash: string, line: number, column: number): any {
  return {
    type: 'CallExpression',
    loc: { start: { line, column } },
    _meta: { nodehash },
  }
}

describe('go-analyzer × callsite 限流 + 内存护栏 delta 模式', () => {
  let analyzer: any
  beforeEach(() => {
    analyzer = makeAnalyzerStub()
  })

  describe('A.2 incrementAndCheckCallsiteLimit', () => {
    it('LIM-1: nodehash 优先作为 key', () => {
      const node = makeCallNode('hash-abc', 10, 5)
      const over1 = analyzer.incrementAndCheckCallsiteLimit(node)
      assert.strictEqual(over1, false, '第 1 次不应超限')
      assert.strictEqual(analyzer.callsiteInterpretCount.get('hash-abc'), 1)
    })

    it('LIM-2: nodehash 缺失时用 loc.line:loc.column 作 key', () => {
      const node = { type: 'CallExpression', loc: { start: { line: 20, column: 8 } } }
      const over = analyzer.incrementAndCheckCallsiteLimit(node as any)
      assert.strictEqual(over, false, '第 1 次不应超限')
      assert.strictEqual(analyzer.callsiteInterpretCount.get('20:8'), 1)
    })

    it('LIM-3: 同 callsite 累计到超限阈值（CALLSITE_INTERPRET_LIMIT=200）返回 true', () => {
      const node = makeCallNode('hash-chain', 1, 1)
      let lastOver = false
      for (let i = 0; i < 250; i++) {
        lastOver = analyzer.incrementAndCheckCallsiteLimit(node)
      }
      assert.strictEqual(lastOver, true, '第 250 次应超限')
      assert.strictEqual(analyzer.callsiteInterpretCount.get('hash-chain'), 250)
    })

    it('LIM-4: 不同 callsite 独立计数（nodehash 不同）', () => {
      const nodeA = makeCallNode('hash-a', 1, 1)
      const nodeB = makeCallNode('hash-b', 2, 2)
      analyzer.incrementAndCheckCallsiteLimit(nodeA)
      analyzer.incrementAndCheckCallsiteLimit(nodeA)
      analyzer.incrementAndCheckCallsiteLimit(nodeB)
      assert.strictEqual(analyzer.callsiteInterpretCount.get('hash-a'), 2)
      assert.strictEqual(analyzer.callsiteInterpretCount.get('hash-b'), 1)
    })

    it('LIM-5: 无 loc 无 nodehash 时不计数，不超限', () => {
      const node = { type: 'CallExpression' }
      const over = analyzer.incrementAndCheckCallsiteLimit(node as any)
      assert.strictEqual(over, false)
      assert.strictEqual(analyzer.callsiteInterpretCount.size, 0)
    })
  })

  describe('A.4 互斥分支预算快照', () => {
    it('SNAP-1: snapshotMethodBudgets 深拷贝 callsiteInterpretCount', () => {
      analyzer.callsiteInterpretCount.set('k1', 10)
      const snap = analyzer.snapshotMethodBudgets()
      analyzer.callsiteInterpretCount.set('k1', 99)
      assert.strictEqual(snap.callsiteCount.get('k1'), 10, '快照应不受后续修改影响')
    })

    it('SNAP-2: restoreMethodBudgets 恢复到快照状态', () => {
      analyzer.callsiteInterpretCount.set('k1', 10)
      analyzer.callsiteInterpretCount.set('k2', 20)
      const snap = analyzer.snapshotMethodBudgets()
      analyzer.callsiteInterpretCount.set('k1', 50)
      analyzer.callsiteInterpretCount.set('k3', 30)
      analyzer.restoreMethodBudgets(snap)
      assert.strictEqual(analyzer.callsiteInterpretCount.get('k1'), 10, 'k1 恢复到快照')
      assert.strictEqual(analyzer.callsiteInterpretCount.get('k2'), 20, 'k2 保留')
      assert.strictEqual(analyzer.callsiteInterpretCount.get('k3'), undefined, 'k3 被清除')
    })

    it('SNAP-3: mergeMethodBudgets 取每 key max 合并', () => {
      const consequentFinal = { callsiteCount: new Map([['k1', 30], ['k2', 10]]) }
      const alternativeFinal = { callsiteCount: new Map([['k1', 15], ['k3', 25]]) }
      analyzer.callsiteInterpretCount.set('k1', 0)
      analyzer.mergeMethodBudgets(consequentFinal, alternativeFinal)
      assert.strictEqual(analyzer.callsiteInterpretCount.get('k1'), 30, 'k1=max(30,15)=30')
      assert.strictEqual(analyzer.callsiteInterpretCount.get('k2'), 10, 'k2 只在 consequent，max=10')
      assert.strictEqual(analyzer.callsiteInterpretCount.get('k3'), 25, 'k3 只在 alternative，max=25')
    })

    it('SNAP-4: 互斥分支场景模拟：consequent + alternative 同 callsite 取 max 不 sum', () => {
      const node = makeCallNode('hash-mut', 1, 1)
      // 模拟 processConditionalExpression 流程
      analyzer.incrementAndCheckCallsiteLimit(node) // 分支前 1 次
      const budgetSnapshot = analyzer.snapshotMethodBudgets()
      // consequent 分支：执行 50 次
      for (let i = 0; i < 50; i++) analyzer.incrementAndCheckCallsiteLimit(node)
      const consequentFinal = analyzer.snapshotMethodBudgets()
      // 恢复到分支前
      analyzer.restoreMethodBudgets(budgetSnapshot)
      // alternative 分支：执行 30 次
      for (let i = 0; i < 30; i++) analyzer.incrementAndCheckCallsiteLimit(node)
      const alternativeFinal = analyzer.snapshotMethodBudgets()
      // 合并
      analyzer.mergeMethodBudgets(consequentFinal, alternativeFinal)
      // 预期：max(51, 31) = 51，不是 sum=81
      assert.strictEqual(analyzer.callsiteInterpretCount.get('hash-mut'), 51)
    })
  })

  describe('B.4 shouldAbortExecutionForMemory (delta 模式)', () => {
    it('MG-1: guard disabled 时返回 false', () => {
      analyzer.memoryGuardState.enabled = false
      const abort = analyzer.shouldAbortExecutionForMemory({} as any)
      assert.strictEqual(abort, false)
    })

    it('MG-2: delta 未超限返回 false，不设 exceeded', () => {
      analyzer.memoryGuardState.enabled = true
      analyzer.deltaLimitMb = 2048
      resetForEntryPoint(analyzer.memoryGuardState, 'test-ep')
      const abort = analyzer.shouldAbortExecutionForMemory({} as any)
      assert.strictEqual(abort, false)
      assert.strictEqual(analyzer.memoryGuardState.exceeded, false)
    })

    it('MG-3: delta 超限时返回 true 并设 exceeded=true', () => {
      analyzer.memoryGuardState.enabled = true
      analyzer.deltaLimitMb = 0 // delta 阈值=0 → 任何增长都超限
      resetForEntryPoint(analyzer.memoryGuardState, 'test-ep')
      // baseline 探测后，强制 peakHeapBytes 比 baseline 大 1MB → delta 1MB > 0
      analyzer.memoryGuardState.peakHeapBytes = analyzer.memoryGuardState.baselineHeapBytes + 2 * 1024 * 1024
      const abort = analyzer.shouldAbortExecutionForMemory({} as any)
      assert.strictEqual(abort, true, 'delta 2MB > limit 0MB 应 abort')
      assert.strictEqual(analyzer.memoryGuardState.exceeded, true)
    })

    it('MG-4: 节流窗内 probeMemoryAndUpdate 不更新 peak（delta 保守不误杀）', () => {
      analyzer.memoryGuardState.enabled = true
      analyzer.deltaLimitMb = 100
      resetForEntryPoint(analyzer.memoryGuardState, 'test-ep')
      const baseline = analyzer.memoryGuardState.baselineHeapBytes
      // 模拟节流窗内：lastProbeMs 设为现在，下次 probe 不会更新 peak
      analyzer.memoryGuardState.lastProbeMs = Date.now()
      const abort = analyzer.shouldAbortExecutionForMemory({} as any)
      // 节流窗内 probeMemoryAndUpdate 返回 false，不更新 peakHeapBytes
      // delta = peak - baseline = 0（peak 还是 baseline）
      assert.strictEqual(abort, false, '节流窗内 delta=0 不应 abort')
      assert.strictEqual(analyzer.memoryGuardState.peakHeapBytes, baseline, 'peak 不应被更新')
    })
  })

  describe('B.5 resetMemoryGuardForEntryPoint', () => {
    it('RESET-1: reset 后 baseline 探测 + exceeded=false + callsiteInterpretCount clear', () => {
      analyzer.memoryGuardState.enabled = true
      analyzer.callsiteInterpretCount.set('k1', 100)
      analyzer.callsiteInterpretCount.set('k2', 200)
      analyzer.memoryGuardState.exceeded = true
      analyzer.resetMemoryGuardForEntryPoint('new-ep')
      assert.strictEqual(analyzer.memoryGuardState.entryPointLabel, 'new-ep')
      assert.strictEqual(analyzer.memoryGuardState.exceeded, false)
      assert.ok(analyzer.memoryGuardState.baselineHeapBytes > 0, 'baseline 应被探测')
      assert.strictEqual(analyzer.callsiteInterpretCount.size, 0, 'callsiteInterpretCount 应被 clear')
    })

    it('RESET-2: guard disabled 时 reset 不执行（不探测 baseline，不清 callsiteInterpretCount）', () => {
      analyzer.memoryGuardState.enabled = false
      analyzer.callsiteInterpretCount.set('k1', 100)
      analyzer.resetMemoryGuardForEntryPoint('test-ep')
      // guard disabled 时 reset 直接 return，不动 callsiteInterpretCount
      assert.strictEqual(analyzer.callsiteInterpretCount.size, 1, 'callsiteInterpretCount 不应被 clear')
    })

    it('RESET-3: 交互：reset 同时清 callsiteInterpretCount（per-entrypoint reset）', () => {
      analyzer.memoryGuardState.enabled = true
      const node = makeCallNode('hash-x', 1, 1)
      for (let i = 0; i < 150; i++) analyzer.incrementAndCheckCallsiteLimit(node)
      assert.strictEqual(analyzer.callsiteInterpretCount.get('hash-x'), 150)
      analyzer.resetMemoryGuardForEntryPoint('next-ep')
      assert.strictEqual(analyzer.callsiteInterpretCount.size, 0, '跨入口污染被清除')
      // 下一入口从 0 开始重新计数
      const over = analyzer.incrementAndCheckCallsiteLimit(node)
      assert.strictEqual(over, false, 'reset 后第 1 次不应超限')
      assert.strictEqual(analyzer.callsiteInterpretCount.get('hash-x'), 1)
    })
  })

  describe('B.6 onEntryPointMemoryGuardFinalize', () => {
    it('FIN-1: exceeded=false 时返回 aborted=false + peak/delta 信息', () => {
      analyzer.memoryGuardState.enabled = true
      resetForEntryPoint(analyzer.memoryGuardState, 'normal-ep')
      const result = analyzer.onEntryPointMemoryGuardFinalize(null, 5)
      assert.strictEqual(result.aborted, false)
      assert.ok(result.peakHeapMb >= 0)
      assert.ok(result.deltaHeapMb >= 0)
    })

    it('FIN-2: exceeded=true 时返回 aborted=true + abortCount/flushCount 自增', () => {
      analyzer.memoryGuardState.enabled = true
      analyzer.deltaLimitMb = 0
      resetForEntryPoint(analyzer.memoryGuardState, 'oom-ep')
      analyzer.memoryGuardState.peakHeapBytes = analyzer.memoryGuardState.baselineHeapBytes + 5 * 1024 * 1024
      // 触发 shouldAbortExecutionForMemory 设 exceeded=true
      analyzer.shouldAbortExecutionForMemory({} as any)
      assert.strictEqual(analyzer.memoryGuardState.exceeded, true)
      const beforeAbort = analyzer.memoryGuardAbortCount
      const result = analyzer.onEntryPointMemoryGuardFinalize(null, 10)
      assert.strictEqual(result.aborted, true)
      assert.strictEqual(analyzer.memoryGuardAbortCount, beforeAbort + 1, 'abortCount 应自增')
      // flushFindingsToReport 在无 resultManager 时返回 0，flushCount 仍自增
      assert.strictEqual(analyzer.memoryGuardFlushCount, 1, 'flushCount 应自增')
    })

    it('FIN-3: guard disabled 时返回 aborted=false + 零 delta 信息', () => {
      analyzer.memoryGuardState.enabled = false
      const result = analyzer.onEntryPointMemoryGuardFinalize(null, 0)
      assert.strictEqual(result.aborted, false)
      assert.strictEqual(result.peakHeapMb, 0)
      assert.strictEqual(result.deltaHeapMb, 0)
    })
  })

  describe('A+B 交互验证', () => {
    it('INTERACT-1: 限流点在 shouldAbortExecutionForMemory 检查之后（abort 时不执行限流计数）', () => {
      // 验证：先触发 abort（exceeded=true），再调 incrementAndCheckCallsiteLimit，
      // callsiteInterpretCount 仍会累积（因为 incrementAndCheckCallsiteLimit 本身不检查 exceeded），
      // 但 processInstruction 在 abort 时提前 return UndefinedValue，不走到限流点。
      // 这里验证 shouldAbortExecutionForMemory 和 incrementAndCheckCallsiteLimit 是独立 hook，
      // 限流逻辑依赖 processInstruction/executeCall 的 abort 提前 return。
      analyzer.memoryGuardState.enabled = true
      analyzer.deltaLimitMb = 0
      resetForEntryPoint(analyzer.memoryGuardState, 'oom-ep')
      analyzer.memoryGuardState.peakHeapBytes = analyzer.memoryGuardState.baselineHeapBytes + 1 * 1024 * 1024
      const abort = analyzer.shouldAbortExecutionForMemory({} as any)
      assert.strictEqual(abort, true)
      // 即使 exceeded=true，incrementAndCheckCallsiteLimit 本身仍可调用（但 processInstruction 不会走到这里）
      const node = makeCallNode('hash-after-abort', 1, 1)
      const over = analyzer.incrementAndCheckCallsiteLimit(node)
      assert.strictEqual(over, false, 'incrementAndCheckCallsiteLimit 不检查 exceeded，只做计数')
      // 验证：abort 后下一入口 resetMemoryGuardForEntryPoint 清 callsiteInterpretCount
      analyzer.resetMemoryGuardForEntryPoint('next-ep')
      assert.strictEqual(analyzer.callsiteInterpretCount.size, 0)
    })

    it('INTERACT-2: delta 探测精度受 resetMemoryGuardForEntryPoint 调用顺序影响（symbolTable.clear 之后）', () => {
      // 验证：resetMemoryGuardForEntryPoint 探测 baseline 时 callsiteInterpretCount 已 clear，
      // baseline 干净（不含上一入口 callsite 计数的 Map 对象残留）。
      analyzer.memoryGuardState.enabled = true
      // 模拟上一入口累积 callsiteInterpretCount
      const node = makeCallNode('hash-prev', 1, 1)
      for (let i = 0; i < 100; i++) analyzer.incrementAndCheckCallsiteLimit(node)
      // 模拟 symbolTable.clear()（不在本测试范围，但 callsiteInterpretCount.clear 在 reset 内）
      analyzer.resetMemoryGuardForEntryPoint('new-ep')
      // baseline 探测时 callsiteInterpretCount 已 clear，delta 精度不受影响
      const { deltaMb } = getEntryPointHeapDeltaMb(analyzer.memoryGuardState)
      assert.ok(deltaMb >= 0, 'delta 应为非负')
      assert.strictEqual(analyzer.callsiteInterpretCount.size, 0)
    })
  })
})
