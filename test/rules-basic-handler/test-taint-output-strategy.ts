/**
 * TaintOutputStrategy.isDegenerateSubsequence 单测
 *
 * 覆盖 isNewFinding 新增的子序列退化去重分支：
 * - 正向：短 trace 同 source/sink 且中间节点位置在更长 trace 内 → 判退化
 * - 中间节点位置不在更长 trace 内 → 不去重
 * - 候选 length >= 已有 length → 不去重（只去重更短的）
 * - 长度相等 → 不去重
 * - SOURCE/SINK 不相同 → 不去重
 * - 边界：candidate.length=2 + existing.length>2 同 source/sink → 判退化
 */
import { describe, it } from 'mocha'
import * as assert from 'assert'

const TaintOutputStrategy = require('../../src/checker/common/output/taint-output-strategy')
const { isDegenerateSubsequence } = TaintOutputStrategy

function sourceItem(file: string, line: number, affectedNodeName: string): any {
  return { file, line, tag: 'SOURCE: ', affectedNodeName }
}

function passItem(file: string, line: number, affectedNodeName: string): any {
  return { file, line, tag: 'Var Pass: ', affectedNodeName }
}

function sinkItem(file: string, line: number, affectedNodeName: string): any {
  return { file, line, tag: 'SINK: ', affectedNodeName }
}

function finding(trace: any[], node: any): any {
  return {
    line: 1,
    node,
    issuecause: 'sink',
    entry_fclos: 'entry',
    entrypoint: { attribute: 'HTTP' },
    trace,
  }
}

describe('TaintOutputStrategy.isDegenerateSubsequence', function () {
  const F = '/mixedCase.ts'

  it('正向：短 trace 中间节点位置落在长 trace 范围内 → 判退化', function () {
    const longer = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 259, 'abc'),
      passItem(F, 260, 'params'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    const shorter = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 259, '__tmp10__'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    assert.strictEqual(isDegenerateSubsequence(shorter, longer), true)
  })

  it('长度相等 → 不去重', function () {
    const a = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 259, 'abc'),
      passItem(F, 260, 'params'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    const b = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 259, 'x'),
      passItem(F, 260, 'y'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    assert.strictEqual(isDegenerateSubsequence(a, b), false)
  })

  it('中间节点位置不在长 trace 内 → 不去重', function () {
    const longer = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 259, 'abc'),
      passItem(F, 260, 'params'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    const shorter = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 300, 'foreign'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    assert.strictEqual(isDegenerateSubsequence(shorter, longer), false)
  })

  it('候选 length >= existing length → 不去重', function () {
    const shorter = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 259, 'abc'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    const longer = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 259, 'abc'),
      passItem(F, 260, 'params'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    assert.strictEqual(isDegenerateSubsequence(longer, shorter), false)
  })

  it('SOURCE 不同位置 → 不去重', function () {
    const longer = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 259, 'abc'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    const shorter = [
      sourceItem(F, 999, 'other.source'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    assert.strictEqual(isDegenerateSubsequence(shorter, longer), false)
  })

  it('SINK 不同位置 → 不去重', function () {
    const longer = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 259, 'abc'),
      sinkItem(F, 261, 'this.ctx.service.sinkA.sink1'),
    ]
    const shorter = [
      sourceItem(F, 259, 'this.ctx.query'),
      sinkItem(F, 999, 'other.sink'),
    ]
    assert.strictEqual(isDegenerateSubsequence(shorter, longer), false)
  })

  it('边界：candidate.length=2 同 source/sink 严格短于 existing → 判退化', function () {
    const longer = [
      sourceItem(F, 10, 'src'),
      passItem(F, 11, 'a'),
      passItem(F, 12, 'b'),
      sinkItem(F, 13, 'sink'),
    ]
    const candidate = [sourceItem(F, 10, 'src'), sinkItem(F, 13, 'sink')]
    assert.strictEqual(isDegenerateSubsequence(candidate, longer), true)
  })

  it('非数组输入 → false', function () {
    assert.strictEqual(isDegenerateSubsequence(undefined, undefined), false)
    assert.strictEqual(isDegenerateSubsequence([sourceItem(F, 1, 's')] as any, undefined), false)
  })

  it('trace 首项非 SOURCE 或末项非 SINK → 不去重', function () {
    const longer = [
      sourceItem(F, 259, 'this.ctx.query'),
      passItem(F, 259, 'abc'),
      sinkItem(F, 261, 'sinkA.sink1'),
    ]
    const candidate = [
      passItem(F, 259, 'abc'),
      sinkItem(F, 261, 'sinkA.sink1'),
    ]
    assert.strictEqual(isDegenerateSubsequence(candidate, longer), false)
  })
})

describe('TaintOutputStrategy.isNewFinding', function () {
  const F = '/javaCase.java'

  it('简单 Var Pass 短退化链先入库时，后到完整链替换短链', function () {
    const node = { loc: { sourcefile: F, start: { line: 27, column: 1 } } }
    const shorter = [
      sourceItem(F, 23, 'cmd'),
      passItem(F, 26, 'chars'),
      sinkItem(F, 27, 'Runtime.getRuntime().exec'),
    ]
    const longer = [
      sourceItem(F, 23, 'cmd'),
      passItem(F, 26, 'chars'),
      passItem(F, 27, 'String'),
      sinkItem(F, 27, 'Runtime.getRuntime().exec'),
    ]
    const resultManager = { findings: { [TaintOutputStrategy.outputStrategyId]: [finding(shorter, node)] } }

    assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, finding(longer, node)), true)
    assert.strictEqual(resultManager.findings[TaintOutputStrategy.outputStrategyId].length, 0)
  })

  it('含 CALL/ARG PASS 的结构链路不做反向替换', function () {
    const node = { loc: { sourcefile: F, start: { line: 47, column: 1 } } }
    const shorter = [
      sourceItem(F, 28, 'cmd'),
      passItem(F, 30, 'result'),
      { file: F, line: 44, tag: 'ARG PASS: ', affectedNodeName: 'callback' },
      sinkItem(F, 47, 'Runtime.getRuntime().exec'),
    ]
    const longer = [
      sourceItem(F, 28, 'cmd'),
      passItem(F, 30, 'result'),
      { file: F, line: 44, tag: 'ARG PASS: ', affectedNodeName: 'callback' },
      passItem(F, 47, 'notCleanedResult'),
      sinkItem(F, 47, 'Runtime.getRuntime().exec'),
    ]
    const resultManager = { findings: { [TaintOutputStrategy.outputStrategyId]: [finding(shorter, node)] } }

    assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, finding(longer, node)), true)
    assert.strictEqual(resultManager.findings[TaintOutputStrategy.outputStrategyId].length, 1)
  })

  it('含合成 CALL/ARG PASS 的结构链路同样不做反向替换', function () {
    const node = { loc: { sourcefile: F, start: { line: 47, column: 1 } } }
    const shorter = [
      sourceItem(F, 28, 'cmd'),
      passItem(F, 30, 'result'),
      { file: F, line: 44, tag: 'CALL: ', affectedNodeName: 'callback', _synthetic: true },
      { file: F, line: 44, tag: 'ARG PASS: ', affectedNodeName: 'callback', _synthetic: true },
      sinkItem(F, 47, 'Runtime.getRuntime().exec'),
    ]
    const longer = [
      sourceItem(F, 28, 'cmd'),
      passItem(F, 30, 'result'),
      { file: F, line: 44, tag: 'CALL: ', affectedNodeName: 'callback', _synthetic: true },
      { file: F, line: 44, tag: 'ARG PASS: ', affectedNodeName: 'callback', _synthetic: true },
      passItem(F, 47, 'notCleanedResult'),
      sinkItem(F, 47, 'Runtime.getRuntime().exec'),
    ]
    const resultManager = { findings: { [TaintOutputStrategy.outputStrategyId]: [finding(shorter, node)] } }

    // 合成步过滤只服务于"等价链折叠"判据；"简单 Var Pass 链"的结构性判断必须看原始 trace，
    // 否则异步桥接场景里两条真实可见链会被误判为简单链并发生替换吞并。
    assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, finding(longer, node)), true)
    assert.strictEqual(resultManager.findings[TaintOutputStrategy.outputStrategyId].length, 1)
  })

  function javaFinding(trace: any[], type = 'taint_flow_java_input', sinkEndLine?: number): any {
    const sink = trace[trace.length - 1]
    const sinkLine = typeof sink?.line === 'number' ? sink.line : 47
    return { ...finding(trace, { loc: { sourcefile: F, start: { line: sinkLine, column: 1 }, end: sinkEndLine ? { line: sinkEndLine, column: 9 } : undefined } }), type, sourcefile: F }
  }

  function withLocations(trace: any[], endLine = 20, column = 1): any[] {
    return trace.map((item, index) => index === 0
      ? { ...item, node: { loc: { sourcefile: F, start: { line: item.line, column }, end: { line: endLine, column: column + 2 } } } }
      : index === 1 || index === 2
        ? { ...item, node: { loc: { sourcefile: F, start: { line: item.line, column }, end: { line: item.line, column: column + 2 } } } }
        : item)
  }

  it('Java位置忽略column但区分精确行范围', function () {
    const first = javaFinding(withLocations(javaTrace(), 21, 1), 'taint_flow_java_input', 47)
    const resultManager = { findings: { [TaintOutputStrategy.outputStrategyId]: [first] } }
    const sameRangeDifferentColumn = javaFinding(withLocations(javaTrace(), 21, 8), 'taint_flow_java_input', 47)
    sameRangeDifferentColumn.issuecause = 'different'
    assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, sameRangeDifferentColumn), false)
    const differentRange = javaFinding(withLocations(javaTrace(), 22, 8), 'taint_flow_java_input', 47)
    differentRange.issuecause = 'different'
    assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, differentRange), true)
  })

  function javaTrace(callLine = 35, argLine = 36): any[] {
    return [
      sourceItem(F, 20, 'request'),
      { file: F, line: callLine, tag: 'CALL: ', affectedNodeName: 'sinkWrapper' },
      { file: F, line: argLine, tag: 'ARG PASS: ', affectedNodeName: 'request' },
      sinkItem(F, 47, 'Runtime.exec'),
    ]
  }

  it('等价 Java finding 只拒绝后者且保留首条完整 trace', function () {
    const first = javaFinding(javaTrace())
    first.issuecause = 'first-cause'
    const originalTrace = first.trace
    const resultManager = { findings: { [TaintOutputStrategy.outputStrategyId]: [first] } }
    const duplicate = javaFinding(javaTrace())
    duplicate.issuecause = 'second-cause'
    assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, duplicate), false)
    assert.strictEqual(first.trace, originalTrace)
    assert.deepStrictEqual(first.trace, javaTrace())
  })

  it('source、sink、CALL、ARG PASS 或顺序变化均保留', function () {
    const first = javaFinding(javaTrace())
    const resultManager = { findings: { [TaintOutputStrategy.outputStrategyId]: [first] } }
    for (const trace of [
      [sourceItem(F, 21, 'request'), ...javaTrace().slice(1)],
      [...javaTrace().slice(0, -1), sinkItem(F, 48, 'Runtime.exec')],
      javaTrace(36, 37),
      [sourceItem(F, 20, 'request'), { file: F, line: 36, tag: 'CALL: ', affectedNodeName: 'other' }, { file: F, line: 36, tag: 'ARG PASS: ', affectedNodeName: 'request' }, sinkItem(F, 47, 'Runtime.exec')],
    ]) {
      const candidate = javaFinding(trace)
      candidate.issuecause = 'different'
      assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, candidate), true, JSON.stringify(trace))
    }
  })

  it('legacy 拒绝的 Java candidate 不污染 projection index', function () {
    const legacyIssue = javaFinding(javaTrace(), 'taint_flow_php_input')
    const resultManager = { findings: { [TaintOutputStrategy.outputStrategyId]: [legacyIssue] } }
    const rejectedCandidate = javaFinding(javaTrace())
    assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, rejectedCandidate), false)
    const acceptedCandidate = javaFinding(javaTrace())
    acceptedCandidate.issuecause = 'different'
    assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, acceptedCandidate), true)
  })

  it('非 Java 与不完整 CALL/ARG PASS 不参与去重', function () {
    const complete = javaFinding(javaTrace())
    const resultManager = { findings: { [TaintOutputStrategy.outputStrategyId]: [complete] } }
    const nonJava = javaFinding(javaTrace(), 'taint_flow_php_input')
    nonJava.issuecause = 'different'
    assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, nonJava), true)
    const incomplete = javaFinding([sourceItem(F, 20, 'request'), { file: F, line: 35, tag: 'CALL: ', affectedNodeName: 'sinkWrapper' }, sinkItem(F, 47, 'Runtime.exec')])
    incomplete.issuecause = 'different'
    assert.strictEqual(TaintOutputStrategy.isNewFinding(resultManager, incomplete), true)
  })
})
