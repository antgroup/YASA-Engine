import { describe, it } from 'mocha'
import * as assert from 'assert'
import * as path from 'path'

const Analyzer = require('../../src/engine/analyzer/common/analyzer')
const JavaAnalyzer = require('../../src/engine/analyzer/java/common/java-analyzer')
const { PrimitiveValue } = require('../../src/engine/analyzer/common/value/primitive')

type TraceStep = { tag?: string; file?: string; line?: number }
type AnalyzerWithInstructionStub = {
  processInstruction: (scope: unknown, node: unknown, state: unknown) => unknown
  processThrowStatement: (scope: unknown, node: unknown, state: { throwstack: unknown[] }) => unknown
}

const SOURCE_FILE = '/tmp/throw-trace-tag.ts'

function throwNode(type: string): { type: string; argument: { type: string; name: string }; loc: object } {
  return { type, argument: { type: 'Identifier', name: 'taintedValue' }, loc: { sourcefile: SOURCE_FILE, start: { line: 7, column: 2 }, end: { line: 7, column: 20 } } }
}

function runThrow(analyzer: AnalyzerWithInstructionStub, nodeType: string): TraceStep[] {
  const value = new PrimitiveValue('scope', 'taintedValue', 'tainted', 'string')
  value.taint.addTag('TEST_SOURCE')
  analyzer.processInstruction = () => value
  const state = { throwstack: [] as unknown[] }
  analyzer.processThrowStatement({}, throwNode(nodeType), state)
  assert.strictEqual(state.throwstack.length, 1, 'throw must execute and append its value to throwstack')
  const thrown = state.throwstack[0] as { taint: { getTrace: (tag: string) => TraceStep[] | undefined } }
  return thrown.taint.getTrace('TEST_SOURCE') ?? []
}

describe('throw trace tag', () => {
  it('common ThrowStatement emits Var Pass and no Throw Pass', () => {
    const trace = runThrow(new Analyzer(null) as AnalyzerWithInstructionStub, 'ThrowStatement')
    assert.strictEqual(trace.length, 1, 'executed throw must add one trace step')
    assert.strictEqual(trace[0].tag, 'Var Pass: ')
    assert.strictEqual(trace.some((step) => step.tag === 'Throw Pass: '), false)
  })

  it('Java ThrowStatement emits Var Pass and no Throw Pass', () => {
    const analyzer = new JavaAnalyzer({ language: 'java', uastSDKPath: path.resolve(__dirname, '../../deps'), checkerIds: [], checkerPackIds: [], printers: [] }) as AnalyzerWithInstructionStub
    const trace = runThrow(analyzer, 'ThrowStatement')
    assert.strictEqual(trace.length, 1, 'executed Java throw must add one trace step')
    assert.strictEqual(trace[0].tag, 'Var Pass: ')
    assert.strictEqual(trace.some((step) => step.tag === 'Throw Pass: '), false)
  })
})
