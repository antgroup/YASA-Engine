import { describe, it } from 'mocha'
import * as assert from 'assert'
import type { TraceItem } from '../../src/util/finding-util'
import type { TaintFinding } from '../../src/engine/analyzer/common/common-types'
const Unit = require('../../src/engine/analyzer/common/value/unit')

const TaintChecker = require('../../src/checker/taint/taint-checker')

const F = '/trace-boundary.js'

type LocNode = {
  loc?: { sourcefile: string; start: { line: number; column?: number }; end: { line: number; column?: number } }
  callee?: { type: string; name: string }
  id?: { name: string; loc?: LocNode['loc'] }
  body?: { loc?: LocNode['loc'] }
  _meta?: { nodehash?: string }
}

type TestValue = {
  type?: string
  expression?: unknown
  arguments?: TestValue[]
  taint: {
    addTag(tag: string): void
    addTraceToTag(tag: string, trace: TraceItem): void
  }
}

type BoundaryFinding = TaintFinding & {
  nd: TestValue
  kind: string
  ruleName: string
  fclos: LocNode
  callstack: Array<{ vtype: string; ast: { node: LocNode }; fname?: string; qid?: string }>
  callsites?: Array<{ loc: NonNullable<LocNode['loc']>; nodeHash?: string }>
}

function loc(line: number): NonNullable<LocNode['loc']> {
  return { sourcefile: F, start: { line, column: 0 }, end: { line, column: 1 } }
}

function node(line: number, name?: string): LocNode {
  return {
    loc: loc(line),
    callee: name ? { type: 'Identifier', name } : undefined,
  }
}

function fclos(startLine: number, endLine: number, name: string): LocNode {
  return {
    loc: { sourcefile: F, start: { line: startLine, column: 0 }, end: { line: endLine, column: 1 } },
    id: { name, loc: loc(startLine) },
    body: { loc: { sourcefile: F, start: { line: startLine, column: 0 }, end: { line: endLine, column: 1 } } },
    _meta: { nodehash: `${name}-${startLine}` },
  }
}

function step(tag: string, line: number, affectedNodeName: string): TraceItem {
  return { file: F, line, tag, node: node(line), affectedNodeName }
}

function checker(): { buildTaintFindingDetail(finding: BoundaryFinding): TaintFinding | null } {
  return new TaintChecker({}, 'trace-boundary-test')
}

function findingWithArg(argNode: TestValue, sinkNode: LocNode = node(99, 'sink')): BoundaryFinding {
  const sinkLoc = sinkNode.loc
  const callstack = sinkLoc?.sourcefile
    ? [{ vtype: 'fclos', ast: { node: { loc: { sourcefile: sinkLoc.sourcefile, start: { line: 1 }, end: { line: 120 } } } } }]
    : []
  return {
    nd: argNode,
    kind: 'USER_INPUT',
    node: sinkNode,
    ruleName: 'sinkRule',
    fclos: sinkNode,
    matchedSanitizerTags: [],
    callstack,
  }
}

function taintedArg(trace: TraceItem[], tag = 'USER_INPUT'): TestValue {
  const arg = new Unit({ vtype: 'test', sid: 'arg', qid: 'arg' }) as TestValue
  arg.taint.addTag(tag)
  for (const traceStep of trace) {
    arg.taint.addTraceToTag(tag, traceStep)
  }
  return arg
}

describe('TaintChecker trace boundary validation', function () {
  it('缺少真实 SOURCE 时丢弃 finding', function () {
    const arg = taintedArg([step('Var Pass: ', 2, 'tmp')])
    const result = checker().buildTaintFindingDetail(findingWithArg(arg))
    assert.strictEqual(result, null)
  })

  it('缺少当前 SINK 定位时丢弃 finding', function () {
    const arg = taintedArg([step('SOURCE: ', 1, 'req.query')])
    const finding = findingWithArg(arg, { loc: undefined, callee: { type: 'Identifier', name: 'sink' } })
    const result = checker().buildTaintFindingDetail(finding)
    assert.strictEqual(result, null)
  })

  it('SOURCE 不是第一条时丢弃 finding', function () {
    const source = step('SOURCE: ', 1, 'req.query')
    const arg = taintedArg([step('Var Pass: ', 2, 'tmp'), source])
    const result = checker().buildTaintFindingDetail(findingWithArg(arg, node(99, 'sink')))
    assert.strictEqual(result, null)
  })

  it('SINK 不是最后一条时丢弃 finding', function () {
    const source = step('SOURCE: ', 1, 'req.query')
    const oldSink = step('SINK: ', 2, 'oldSink')
    const arg = taintedArg([source, oldSink, step('Var Pass: ', 3, 'tmp')])
    const result = checker().buildTaintFindingDetail(findingWithArg(arg, node(99, 'realSink')))
    assert.strictEqual(result, null)
  })

  it('buffer donor source 链路保留，不要求中间节点也是 SOURCE', function () {
    const donorSource = step('SOURCE: ', 10, 'buffer.request')
    const donorPass = step('Var Pass: ', 11, 'buffer.value')
    const donor = taintedArg([donorSource, donorPass])
    const arg = taintedArg([])
    arg.type = 'FunctionCall'
    arg.expression = undefined
    arg.arguments = [donor]

    const result = checker().buildTaintFindingDetail(findingWithArg(arg, node(99, 'sink')))

    assert.ok(result)
    assert.deepStrictEqual(result.trace?.map((item: TraceItem) => item.tag), ['SOURCE: ', 'Var Pass: ', 'SINK: '])
    assert.strictEqual(result.trace?.[0], donorSource)
    assert.strictEqual(result.trace?.[1], donorPass)
  })

  it('CALL 和 ARG PASS 补桥只插入 SOURCE 与 SINK 中间', function () {
    const source = step('SOURCE: ', 10, 'req.query')
    const pass = step('Var Pass: ', 60, 'inner.value')
    const arg = taintedArg([source, pass])
    const outer = fclos(10, 100, 'outer')
    const inner = fclos(50, 80, 'inner')
    const sink = node(99, 'sink')
    const finding = findingWithArg(arg, sink)
    finding.callstack = [
      { vtype: 'fclos', ast: { node: outer }, fname: 'outer' },
      { vtype: 'fclos', ast: { node: inner }, fname: 'inner' },
    ]
    finding.callsites = [{ loc: loc(10), nodeHash: 'outer-call' }, { loc: loc(40), nodeHash: 'inner-call' }]

    const result = checker().buildTaintFindingDetail(finding)

    assert.ok(result)
    assert.strictEqual(result.trace?.[0].tag, 'SOURCE: ')
    assert.strictEqual(result.trace?.[result.trace.length - 1].tag, 'SINK: ')
    assert.deepStrictEqual(result.trace?.map((item: TraceItem) => item.tag), [
      'SOURCE: ',
      'CALL: ',
      'ARG PASS: ',
      'Var Pass: ',
      'SINK: ',
    ])
  })
})
