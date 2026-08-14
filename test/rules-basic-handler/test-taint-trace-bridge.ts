import { describe, it } from 'mocha'
import * as assert from 'assert'

const TaintChecker = require('../../src/checker/taint/taint-checker')

type Loc = {
  sourcefile: string
  start: { line: number; column?: number }
  end: { line: number; column?: number }
}

type TraceNode = {
  type?: string
  loc: Loc
  _meta?: { nodehash: string }
  parent?: TraceNode
}

type TraceStep = {
  file: string
  line: number
  tag: string
  node: TraceNode
  affectedNodeName: string
  _synthetic?: boolean
}

type Fclos = {
  vtype: 'fclos'
  fname: string
  ast: { node: { loc: Loc; id?: { name: string; loc: Loc }; body?: { loc: Loc }; _meta?: { nodehash: string } } }
}

type Finding = {
  trace: TraceStep[]
  callstack: Fclos[]
  callsites: Array<{ loc: Loc; nodeHash: string }>
  entrypointLoc?: Loc
}

function loc(file: string, startLine: number, endLine = startLine): Loc {
  return { sourcefile: file, start: { line: startLine, column: 0 }, end: { line: endLine, column: 0 } }
}

function step(tag: string, file: string, line: number, name: string): TraceStep {
  return { file, line, tag, node: { loc: loc(file, line), _meta: { nodehash: `${tag}-${file}-${line}-${name}` } }, affectedNodeName: name }
}

function nestedFunctionStep(tag: string, file: string, line: number, name: string, functionName: string): TraceStep {
  const functionNode: TraceNode = { type: 'FunctionDefinition', loc: loc(file, line - 1, line + 1), _meta: { nodehash: `fclos-${functionName}` } }
  return {
    file,
    line,
    tag,
    node: { loc: loc(file, line), _meta: { nodehash: `${tag}-${file}-${line}-${name}` }, parent: functionNode },
    affectedNodeName: name,
  }
}

function fclos(file: string, startLine: number, endLine: number, name: string): Fclos {
  const nodeLoc = loc(file, startLine, endLine)
  return {
    vtype: 'fclos',
    fname: name,
    ast: {
      node: {
        loc: nodeLoc,
        id: { name, loc: loc(file, startLine) },
        body: { loc: nodeLoc },
        _meta: { nodehash: `fclos-${name}` },
      },
    },
  }
}

function checker(): {
  filterTraceToCallstackOrder(finding: Finding): void
  synthesizeBridgeSteps(finding: Finding): void
  validateArgPassSegmentWithinFrame(finding: Finding): boolean
} {
  return Object.create(TaintChecker.prototype) as {
    filterTraceToCallstackOrder(finding: Finding): void
    synthesizeBridgeSteps(finding: Finding): void
    validateArgPassSegmentWithinFrame(finding: Finding): boolean
  }
}

describe('TaintChecker callstack bridge trace shape', function () {
  it('过滤 callstack 外流转并保持桥接节点不出现在 SOURCE 前', function () {
    const mainFile = '/case/Main.java'
    const helperFile = '/case/Helper.java'
    const finding: Finding = {
      trace: [
        step('SOURCE: ', mainFile, 11, 'input'),
        step('CALL: ', helperFile, 50, 'wrap'),
        step('ARG PASS: ', helperFile, 20, 'value'),
        step('Var Pass: ', helperFile, 21, 'tmp'),
        step('SINK: ', mainFile, 55, 'sink'),
      ],
      callstack: [fclos(mainFile, 1, 100, 'entry'), fclos(mainFile, 40, 60, 'sinkCaller')],
      callsites: [
        { loc: loc(mainFile, 11), nodeHash: 'call-entry' },
        { loc: loc(mainFile, 54), nodeHash: 'call-sink' },
      ],
    }

    const instance = checker()
    instance.filterTraceToCallstackOrder(finding)
    instance.synthesizeBridgeSteps(finding)

    assert.strictEqual(finding.trace[0].tag, 'SOURCE: ')
    assert.strictEqual(finding.trace[finding.trace.length - 1].tag, 'SINK: ')
    assert.strictEqual(finding.trace.slice(0, 1).some((item) => item.tag === 'CALL: ' || item.tag === 'ARG PASS: '), false)
    assert.strictEqual(finding.trace.some((item) => item.file === helperFile), false)
    assert.deepStrictEqual(finding.trace.slice(1, 3).map((item) => item.tag), ['CALL: ', 'ARG PASS: '])
    assert.strictEqual(finding.trace[1]._synthetic, true)
    assert.strictEqual(finding.trace[1].file, mainFile)
    assert.strictEqual(finding.trace[1].line, 54)
    assert.strictEqual(finding.trace[1].node._meta?.nodehash, 'call-sink')
    assert.strictEqual(finding.trace[2].file, mainFile)
    assert.strictEqual(finding.trace[2].line, 40)
  })

  it('缺少可信 caller 时仅补 ARG PASS，不伪造 FunctionDefinition CALL', function () {
    const mainFile = '/case/bridge.py'
    const finding: Finding = {
      trace: [step('SOURCE: ', mainFile, 10, 'input'), step('SINK: ', mainFile, 45, 'sink')],
      callstack: [fclos(mainFile, 1, 60, 'entry'), fclos(mainFile, 30, 50, 'target')],
      callsites: [{ loc: loc(mainFile, 10), nodeHash: 'call-entry' }],
    }

    checker().synthesizeBridgeSteps(finding)

    const syntheticSteps = finding.trace.filter((item) => item._synthetic)
    assert.deepStrictEqual(syntheticSteps.map((item) => item.tag), ['ARG PASS: '])
    assert.strictEqual(syntheticSteps[0].line, 30)
    assert.strictEqual(finding.trace.some((item) => item.tag === 'CALL: ' && item.line === 30), false)
  })

  it('按最近 FunctionDefinition 过滤外层方法范围内的匿名函数分支', function () {
    const mainFile = '/case/Controller.java'
    const finding: Finding = {
      trace: [
        step('SOURCE: ', mainFile, 35, 'req'),
        nestedFunctionStep('CALL: ', mainFile, 40, 'assertParam', 'checkParam'),
        nestedFunctionStep('CALL RETURN:', mainFile, 42, 'validHdfImageUrl', 'checkParam'),
        nestedFunctionStep('ARG PASS: ', mainFile, 41, 'assertUrl', 'checkParam'),
        step('CALL: ', mainFile, 36, 'execute'),
        step('ARG PASS: ', mainFile, 49, 'url'),
        step('SINK: ', mainFile, 90, 'openStream'),
      ],
      callstack: [fclos(mainFile, 35, 80, 'extract'), fclos(mainFile, 48, 60, 'execute')],
      callsites: [
        { loc: loc(mainFile, 36), nodeHash: 'call-execute' },
        { loc: loc(mainFile, 49), nodeHash: 'call-sink' },
      ],
    }

    const instance = checker()
    instance.filterTraceToCallstackOrder(finding)

    assert.strictEqual(finding.trace.some((item) => item.affectedNodeName === 'assertParam'), false)
    assert.strictEqual(finding.trace.some((item) => item.affectedNodeName === 'assertUrl'), false)
    assert.strictEqual(finding.trace.some((item) => item.affectedNodeName === 'validHdfImageUrl'), false)
    assert.strictEqual(finding.trace.some((item) => item.affectedNodeName === 'execute'), true)
  })


  it('保留跨函数 helper 的参数到返回构造边', function () {
    const mainFile = '/case/service.go'
    const finding: Finding = {
      trace: [
        step('SOURCE: ', mainFile, 10, 'req'),
        step('CALL: ', mainFile, 20, 'makeUrl'),
        step('ARG PASS: ', mainFile, 100, 'record'),
        step('Return Value: ', mainFile, 105, '[return value]'),
        step('CALL RETURN:', mainFile, 20, 'url'),
        step('SINK: ', mainFile, 30, 'http.Get'),
      ],
      callstack: [fclos(mainFile, 1, 40, 'entry')],
      callsites: [{ loc: loc(mainFile, 20), nodeHash: 'call-entry' }],
    }

    checker().filterTraceToCallstackOrder(finding)

    assert.deepStrictEqual(finding.trace.map((item) => item.line), [10, 20, 100, 105, 20, 30])
  })

  it('丢弃普通 object-builder helper 的字段 fan-out', function () {
    const mainFile = '/case/builder.js'
    const helperFile = '/case/helper.js'
    const finding: Finding = {
      trace: [
        step('SOURCE: ', mainFile, 10, 'ctx'),
        step('CALL: ', mainFile, 20, 'genBaseParams'),
        step('ARG PASS: ', helperFile, 19, 'options'),
        step('Var Pass: ', helperFile, 20, 'functionName'),
        step('Return Value: ', helperFile, 23, '[return value]'),
        step('SINK: ', mainFile, 30, 'sink'),
      ],
      callstack: [fclos(mainFile, 1, 40, 'entry')],
      callsites: [{ loc: loc(mainFile, 20), nodeHash: 'call-entry' }],
    }

    checker().filterTraceToCallstackOrder(finding)

    assert.deepStrictEqual(finding.trace.map((item) => item.line), [10, 20, 30])
  })

  it('接受 ARG PASS 后仍停留在同一 frame 的 segment', function () {
    const mainFile = '/case/Flow.java'
    const finding: Finding = {
      trace: [
        step('SOURCE: ', mainFile, 11, 'req'),
        step('ARG PASS: ', mainFile, 42, 'request'),
        step('Var Pass: ', mainFile, 45, 'model'),
        step('SINK: ', mainFile, 90, 'sink'),
      ],
      callstack: [fclos(mainFile, 1, 100, 'entry'), fclos(mainFile, 40, 60, 'search')],
      callsites: [
        { loc: loc(mainFile, 20), nodeHash: 'call-entry' },
        { loc: loc(mainFile, 41), nodeHash: 'call-search' },
      ],
    }

    assert.strictEqual(checker().validateArgPassSegmentWithinFrame(finding), true)
  })

  it('拒绝 ARG PASS 后漂移到其他 callstack frame 的 segment', function () {
    const mainFile = '/case/Flow.java'
    const finding: Finding = {
      trace: [
        step('SOURCE: ', mainFile, 11, 'req'),
        step('ARG PASS: ', mainFile, 42, 'request'),
        step('Var Pass: ', mainFile, 73, 'converted'),
        step('SINK: ', mainFile, 90, 'sink'),
      ],
      callstack: [
        fclos(mainFile, 1, 100, 'entry'),
        fclos(mainFile, 40, 60, 'search'),
        fclos(mainFile, 70, 80, 'convert'),
      ],
      callsites: [
        { loc: loc(mainFile, 20), nodeHash: 'call-entry' },
        { loc: loc(mainFile, 41), nodeHash: 'call-search' },
        { loc: loc(mainFile, 72), nodeHash: 'call-convert' },
      ],
    }

    assert.strictEqual(checker().validateArgPassSegmentWithinFrame(finding), false)
    assert.strictEqual((finding as Finding & { traceRejectReason?: string }).traceRejectReason, 'ARG_PASS_SEGMENT_OUT_OF_FRAME')
  })

  it('连续 ARG PASS、synthetic bridge 与无 loc step 不触发 segment 误判', function () {
    const mainFile = '/case/Flow.java'
    const noLoc = { tag: 'Var Pass: ', affectedNodeName: 'opaque' } as unknown as TraceStep
    const finding: Finding = {
      trace: [
        step('SOURCE: ', mainFile, 11, 'req'),
        { ...step('CALL: ', mainFile, 21, 'search'), _synthetic: true },
        { ...step('ARG PASS: ', mainFile, 42, 'request'), _synthetic: true },
        step('ARG PASS: ', mainFile, 72, 'converted'),
        noLoc,
        step('Var Pass: ', mainFile, 73, 'model'),
        step('SINK: ', mainFile, 90, 'sink'),
      ],
      callstack: [
        fclos(mainFile, 1, 100, 'entry'),
        fclos(mainFile, 40, 60, 'search'),
        fclos(mainFile, 70, 80, 'convert'),
      ],
      callsites: [
        { loc: loc(mainFile, 20), nodeHash: 'call-entry' },
        { loc: loc(mainFile, 41), nodeHash: 'call-search' },
        { loc: loc(mainFile, 72), nodeHash: 'call-convert' },
      ],
    }

    assert.strictEqual(checker().validateArgPassSegmentWithinFrame(finding), true)
  })

  it('接受 callback CALL 后进入更深实现 frame 的合法 segment', function () {
    const mainFile = '/case/Callback.java'
    const finding: Finding = {
      trace: [
        step('SOURCE: ', mainFile, 12, 'req'),
        step('ARG PASS: ', mainFile, 45, 'request'),
        step('CALL: ', mainFile, 48, 'callback.doBefore'),
        step('Var Pass: ', mainFile, 74, 'request.getStartTime'),
        step('SINK: ', mainFile, 90, 'sink'),
      ],
      callstack: [
        fclos(mainFile, 1, 100, 'entry'),
        fclos(mainFile, 40, 55, 'standardExecute'),
        fclos(mainFile, 70, 80, 'doBefore'),
      ],
      callsites: [
        { loc: loc(mainFile, 20), nodeHash: 'call-entry' },
        { loc: loc(mainFile, 44), nodeHash: 'call-standardExecute' },
        { loc: loc(mainFile, 48), nodeHash: 'call-doBefore' },
      ],
    }

    assert.strictEqual(checker().validateArgPassSegmentWithinFrame(finding), true)
  })

  it('接受 Python nested method 返回到当前 frame 的合法 Return Value segment', function () {
    const mainFile = '/case/constructor_extends_003_T.py'
    const finding: Finding = {
      trace: [
        step('SOURCE: ', mainFile, 12, 'taint_src'),
        step('ARG PASS: ', mainFile, 32, 'derived'),
        step('ARG PASS: ', mainFile, 28, 'self'),
        step('Return Value: ', mainFile, 18, '[return value]'),
        step('CALL RETURN:', mainFile, 28, 'get_data'),
        step('CALL: ', mainFile, 28, 'taint_sink'),
        step('ARG PASS: ', mainFile, 36, 'taint_sink'),
        step('SINK: ', mainFile, 37, 'os.system'),
      ],
      callstack: [
        fclos(mainFile, 12, 32, 'constructor_extends_003_T'),
        fclos(mainFile, 27, 28, 'process'),
        fclos(mainFile, 36, 37, 'taint_sink'),
      ],
      callsites: [
        { loc: loc(mainFile, 42), nodeHash: 'call-entry' },
        { loc: loc(mainFile, 32), nodeHash: 'call-process' },
        { loc: loc(mainFile, 28), nodeHash: 'call-sink' },
      ],
    }

    assert.strictEqual(checker().validateArgPassSegmentWithinFrame(finding), true)
  })
})
