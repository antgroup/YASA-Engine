import * as assert from 'assert'
import { describe, it } from 'mocha'

const JavaAnalyzer = require('../../src/engine/analyzer/java/common/java-analyzer') as { prototype: object }
const { setGlobalAnalyzer, getGlobalAnalyzer } = require('../../src/engine/analyzer/common/source-line') as {
  setGlobalAnalyzer: (analyzer: unknown) => void
  getGlobalAnalyzer: () => unknown
}
const { ObjectValue } = require('../../src/engine/analyzer/common/value/object') as { ObjectValue: typeof import('../../src/engine/analyzer/common/value/object').ObjectValue }

type RuntimeValue = {
  vtype: string
  sid: string
  qid: string
  ast: { fdef: { body: { type: string } } }
  rtype: { definiteType: string }
}

type CoarseHarness = {
  symbolTable: { calculateUUID: (value: unknown, tag: string) => string; has: (uuid: string) => boolean }
  sourceCodeCache: Map<string, string[]>
  tryCoarseTaintPropagation: (
    scope: unknown,
    node: { arguments: unknown[] },
    state: { callstack: unknown[] },
    fclos: RuntimeValue & { _coarsePropEligible: boolean },
    argvalues: unknown[],
  ) => unknown
}

function createAnalyzer(): CoarseHarness {
  const analyzer = Object.create(JavaAnalyzer.prototype) as CoarseHarness
  analyzer.symbolTable = {
    calculateUUID: (value: { sid?: string }, tag: string) => `${value.sid ?? 'value'}|${tag}`,
    has: () => false,
  }
  analyzer.sourceCodeCache = new Map<string, string[]>()
  return analyzer
}

function createFclos(): RuntimeValue & { _coarsePropEligible: boolean } {
  return {
    vtype: 'fclos',
    sid: 'Example.load',
    qid: 'example.Example.load',
    ast: { fdef: { body: { type: 'Block' } } },
    rtype: { definiteType: 'java.lang.String' },
    _coarsePropEligible: true,
  }
}

describe('Java coarse clean depth guard', function () {
  it('executes clean eligible calls through target depth three', function () {
    const analyzer = createAnalyzer()
    const result = analyzer.tryCoarseTaintPropagation(
      {},
      { arguments: [] },
      { callstack: [{ depth: 1 }, { depth: 2 }] },
      createFclos(),
      [],
    )

    assert.strictEqual(result, undefined)
  })

  it('returns a typed clean CallExprValue below target depth three', function () {
    const analyzer = createAnalyzer()
    const result = analyzer.tryCoarseTaintPropagation(
      {},
      { arguments: [] },
      { callstack: [{ depth: 1 }, { depth: 2 }, { depth: 3 }] },
      createFclos(),
      [],
    ) as RuntimeValue & { taint?: { isTaintedRec?: boolean; tagTraces?: Map<string, unknown> } }

    assert.ok(result)
    assert.strictEqual(result.vtype, 'symbol')
    assert.strictEqual((result as RuntimeValue & { exprKind?: string }).exprKind, 'call')
    assert.deepStrictEqual(result.rtype, { definiteType: 'java.lang.String' })
    assert.ok(!result.taint || result.taint.isTaintedRec !== true)
    assert.ok(!result.taint?.tagTraces?.has('JAVA_INPUT'))
  })

  it('preserves existing ARG to RET and CALL trace semantics for tainted arguments', function () {
    const previousAnalyzer = getGlobalAnalyzer()
    const analyzer = createAnalyzer()
    setGlobalAnalyzer(analyzer)
    const source = new ObjectValue('', { sid: 'request', qid: 'request' })
    source.taint.addTag('JAVA_INPUT')
    source.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'SampleController.java', line: 89 })
    source.taint.markSource()
    const result = analyzer.tryCoarseTaintPropagation(
      {},
      {
        type: 'FunctionCall',
        callee: { type: 'Identifier' },
        arguments: [],
        loc: { sourcefile: 'SampleController.java', start: { line: 100 }, end: { line: 100 } },
      },
      { callstack: [{ depth: 1 }, { depth: 2 }, { depth: 3 }] },
      createFclos(),
      [source],
    ) as RuntimeValue & {
      getMisc: (key: string) => unknown
      taint: { isTaintedRec: boolean; getTags: () => string[]; getTrace: (tag: string) => Array<{ tag: string }> }
    }

    assert.strictEqual(result.vtype, 'symbol')
    assert.strictEqual(result.taint.isTaintedRec, true)
    assert.deepStrictEqual(result.taint.getTags(), ['JAVA_INPUT'])
    assert.ok(result.taint.getTrace('JAVA_INPUT').some((trace) => trace.tag === 'CALL: '))
    const propagatedArg = (result.getMisc('buffer') as Array<{ taint: { getTrace: (tag: string) => Array<{ tag: string }> } }>)[0]
    assert.ok(propagatedArg.taint.getTrace('JAVA_INPUT').some((trace) => trace.tag === 'SOURCE: '))
    assert.ok(propagatedArg.taint.getTrace('JAVA_INPUT').some((trace) => trace.tag === 'CALL: '))
    assert.strictEqual(source.taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
    setGlobalAnalyzer(previousAnalyzer)
  })
})
