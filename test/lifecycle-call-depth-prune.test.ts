import assert from 'assert'
import { describe, it } from 'mocha'
import JavaAnalyzer = require('../src/engine/analyzer/java/common/java-analyzer')
import { ObjectValue } from '../src/engine/analyzer/common/value/object'
import { PrimitiveValue } from '../src/engine/analyzer/common/value/primitive'
import type { Value } from '../src/types/analyzer'

interface IntegrationAnalyzer extends AnalyzerProbe {
  entryPointSymValArray: unknown[]
  globalState: Record<string, unknown>
  checkerManager: { checkAtFunctionCallBefore: () => void }
  entry_fclos: unknown
  ainfo: unknown
  inRange: boolean
  thisFClos: unknown
  processInstruction: () => unknown
  evaluateNestedCallArgument: (_scope: unknown, _argument: unknown, _state: unknown) => unknown
  findNodeInvocations: () => unknown[]
  checkFclosInInterfaceOrAbstractClass: () => boolean
  incrementAndCheckCallsiteLimit: () => boolean
  checkMethodCumulativeTimeLimit: () => boolean
  processLibFuncTagPropagation: () => { matched: boolean }
  buildCallArgs: (_node: unknown, values: unknown[]) => { args: unknown[] }
  propagateReadWrapperReceiverTrace: () => void
  isJavaBeanSetterCall: () => boolean
  getCalledMethodName: () => string
  getReadWrapperReceiver: () => unknown
  resolveRuntimeValueRef: (value: unknown) => unknown
  mergeJavaCallResultType: () => void
  executeWithSummary: (...args: unknown[]) => unknown
}

const createIntegrationAnalyzer = (): IntegrationAnalyzer => {
  const analyzer = createAnalyzer() as IntegrationAnalyzer
  analyzer.entryPointSymValArray = []
  analyzer.globalState = {}
  analyzer.checkerManager = { checkAtFunctionCallBefore: () => {} }
  analyzer.entry_fclos = undefined
  analyzer.ainfo = undefined
  analyzer.inRange = false
  ;(analyzer as unknown as { _thisFClos?: unknown })._thisFClos = undefined
  analyzer.processInstruction = () => undefined
  analyzer.evaluateNestedCallArgument = (_scope, argument) => argument
  analyzer.findNodeInvocations = () => []
  analyzer.checkFclosInInterfaceOrAbstractClass = () => false
  analyzer.incrementAndCheckCallsiteLimit = () => false
  analyzer.checkMethodCumulativeTimeLimit = () => false
  analyzer.processLibFuncTagPropagation = () => ({ matched: false })
  analyzer.buildCallArgs = (_node, values) => ({ args: values })
  analyzer.propagateReadWrapperReceiverTrace = () => {}
  analyzer.isJavaBeanSetterCall = () => false
  analyzer.getCalledMethodName = () => 'unknown'
  analyzer.getReadWrapperReceiver = () => undefined
  analyzer.resolveRuntimeValueRef = (value) => value
  analyzer.mergeJavaCallResultType = () => {}
  analyzer.executeWithSummary = (_scope, _fclos, _callInfo, _state, execute) => execute()
  return analyzer
}

const createInputValue = (): Value => {
  const value = new PrimitiveValue('', 'payload', 'payload', 'string', 'Literal')
  value.taint.addTag('JAVA_INPUT')
  value.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Lifecycle.java', line: 20 })
  value.taint.markSource()
  return value
}

const createCallInfo = (value: Value) => ({
  callArgs: { args: [{ index: 0, value, kind: 'positional' as const }] },
  boundCall: { params: [{ index: 0, name: 'payload', value, provided: true, argIndexes: [0] }] },
  callsiteNode: node,
})

const createFunctionDecl = () => ({
  type: 'FunctionDefinition',
  id: { type: 'Identifier', name: 'lifecycleFallback' },
  parameters: [{ type: 'Identifier', name: 'payload' }],
  body: { type: 'Block', body: [] },
})

const createLifecycleFallbackFclos = (analyzer: IntegrationAnalyzer, receiver: ObjectValue) => ({
  vtype: 'fclos',
  sid: 'lifecycleFallback',
  qid: 'bean.lifecycleFallback',
  ast: { fdef: createFunctionDecl() },
  _this: receiver,
  getThisObj: () => receiver,
  runtime: {
    execute: (_fclos: unknown, args: Value[]) => analyzer.processLibArgToRet(node, _fclos, args, { qid: 'scope' }, { pcond: [] }, createCallInfo(args[0])),
  },
})

const runSetterFallback = (analyzer: IntegrationAnalyzer, receiver: ObjectValue, input: Value): Value => {
  const field = new ObjectValue('', { sid: 'name', qid: 'bean.name' })
  receiver.setFieldValue('name', field)
  const setterNode = {
    type: 'CallExpression',
    callee: { type: 'MemberAccess', object: { type: 'Identifier', name: 'bean' }, property: { type: 'Identifier', name: 'setName' } },
    arguments: [{ type: 'Literal', value: 'payload' }],
    loc: node.loc,
  }
  const setter = {
    vtype: 'fclos',
    sid: 'setName',
    qid: 'bean.setName',
    ast: { fdef: { type: 'FunctionDefinition', body: { type: 'Block', body: [] } } },
    _this: receiver,
    getThisObj: () => receiver,
  }
  ;(analyzer as unknown as { symbolTable?: { register: (value: unknown) => string } }).symbolTable = { register: () => 'setter' }
  ;(analyzer as unknown as { executeCall: () => undefined }).executeCall = () => undefined
  analyzer.processInstruction = () => setter
  analyzer.evaluateNestedCallArgument = () => input
  analyzer.isJavaBeanSetterCall = () => true
  analyzer.getCalledMethodName = () => 'setName'
  analyzer.getReadWrapperReceiver = () => receiver
  return analyzer.processCallExpression({ qid: 'scope' }, setterNode as never, { callstack: [], pcond: [], einfo: {} } as never)
}

interface FakeAnalyzerState {
  pruneInfoMap: {
    aggressiveMode: boolean
    sinkArray: unknown[]
    otherSanitizerArray: unknown[]
  }
  lifecycleCallDepthPrunes: Array<{ callee: string; location: Record<string, unknown>; depth: number }>
}

type AnalyzerProbe = JavaAnalyzer & FakeAnalyzerState

const createAnalyzer = (): AnalyzerProbe => {
  const analyzer = Object.create(JavaAnalyzer.prototype) as AnalyzerProbe
  analyzer.pruneInfoMap = { aggressiveMode: false, sinkArray: [], otherSanitizerArray: [] }
  analyzer.lifecycleCallDepthPrunes = []
  return analyzer
}

const stateAt = (depth: number): { callstack: unknown[] } => ({ callstack: Array.from({ length: depth }, () => ({})) })

const fclos = { qid: 'bean.target', sid: 'target' }
const node = { loc: { sourcefile: 'Lifecycle.java', start: { line: 12, column: 4 } } }

describe('Spring lifecycle call-depth prune', () => {
  it('preserves the aggressive baseline predicate before callback protection', () => {
    const analyzer = createAnalyzer()
    analyzer.pruneInfoMap.aggressiveMode = true
    assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [{ vtype: 'fclos' }], stateAt(12), false), true)
    assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, { ...node, arguments: [{ type: 'FunctionDefinition' }] }, [], stateAt(12), false), true)
  })

  it('keeps calls before the configured threshold and prunes at the threshold', () => {
    const analyzer = createAnalyzer()
    assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [], stateAt(11), false), false)
    assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [], stateAt(12), false), false)
    analyzer.withLifecycleCallDepthPrune(() => {
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [], stateAt(11), false), false)
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [], stateAt(12), false), true)
    })
    assert.deepStrictEqual(analyzer.getLifecycleCallDepthPrunes(), [{ callee: 'bean.target', location: node.loc, depth: 12 }])
  })

  it('prunes invocation paths at the threshold, including callgraph-originated calls', () => {
    const analyzer = createAnalyzer()
    analyzer.withLifecycleCallDepthPrune(() => {
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [], stateAt(12), true), true)
    })
    assert.deepStrictEqual(analyzer.getLifecycleCallDepthPrunes(), [{ callee: 'bean.target', location: node.loc, depth: 12 }])
  })

  it('keeps lifecycle callbacks protected even when the ordinary gate is disabled', () => {
    const analyzer = createAnalyzer()
    analyzer.withLifecycleCallDepthPrune(() => {
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, { ...node, arguments: [{ type: 'FunctionDefinition' }] }, [], stateAt(12), false), false)
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [{ vtype: 'fclos' }], stateAt(12), false), false)
    })
    assert.deepStrictEqual(analyzer.getLifecycleCallDepthPrunes(), [])
  })

  it('keeps callback and closure arguments executable before depth pruning', () => {
    const analyzer = createAnalyzer()
    const sequenceNode = { ...node, arguments: [{ type: 'Sequence' }] }
    const functionNode = { ...node, arguments: [{ type: 'FunctionDefinition' }] }
    const callback = { vtype: 'fclos' }
    const classValue = { vtype: 'class' }
    analyzer.withLifecycleCallDepthPrune(() => {
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, sequenceNode, [], stateAt(12), false), false)
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, functionNode, [], stateAt(12), false), false)
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [callback], stateAt(12), false), false)
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [classValue], stateAt(12), false), false)
    })
    assert.deepStrictEqual(analyzer.getLifecycleCallDepthPrunes(), [])
  })

  it('restores the dynamic scope after nested and throwing callbacks', () => {
    const analyzer = createAnalyzer()
    assert.throws(() => analyzer.withLifecycleCallDepthPrune(() => {
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [], stateAt(12), false), true)
      analyzer.withLifecycleCallDepthPrune(() => {
        assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [], stateAt(12), false), true)
      })
      throw new Error('lifecycle failure')
    }), /lifecycle failure/)
    assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [], stateAt(12), false), false)
    assert.strictEqual(analyzer.getLifecycleCallDepthPrunes().length, 2)
  })

  it('preserves fallback eligibility for sink propagation at the depth boundary', () => {
    const analyzer = createAnalyzer()
    const fallback = { qid: 'bean.fallback', ast: { fdef: { type: 'FunctionDefinition' } } }
    analyzer.withLifecycleCallDepthPrune(() => {
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fallback, node, [], stateAt(12), false), true)
    })
    assert.strictEqual(analyzer.getLifecycleCallDepthPrunes()[0]?.callee, 'bean.fallback')
    assert.strictEqual(analyzer.getLifecycleCallDepthPrunes()[0]?.depth, 12)
  })

  it('preserves fallback execution hook and ARG→RET taint at the depth boundary', () => {
    const analyzer = createIntegrationAnalyzer()
    let hookCalls = 0
    analyzer.checkerManager.checkAtFunctionCallBefore = () => { hookCalls += 1 }
    const receiver = new ObjectValue('', { sid: 'bean', qid: 'bean' })
    const input = createInputValue()
    const fallback = createLifecycleFallbackFclos(analyzer, receiver)
    const fallbackNode = { ...node, callee: { type: 'MemberAccess' }, arguments: [{ type: 'Literal', value: 'payload' }] }
    analyzer.withLifecycleCallDepthPrune(() => {
      assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fallback, fallbackNode, [], stateAt(12), false), true)
      analyzer.checkerManager.checkAtFunctionCallBefore()
      const result = analyzer.processLibArgToRet(fallbackNode, fallback, [input], { qid: 'scope' }, { pcond: [] }, createCallInfo(input))
      assert.ok(result.taint?.isTaintedRec)
      assert.ok(result.getMisc('buffer')?.includes(input))
    })
    assert.strictEqual(hookCalls, 1)
  })

  it('preserves setter receiver and field write-back after lifecycle depth pruning', () => {
    const analyzer = createIntegrationAnalyzer()
    const receiver = new ObjectValue('', { sid: 'bean', qid: 'bean' })
    const input = createInputValue()
    const result = runSetterFallback(analyzer, receiver, input)
    const field = receiver.getFieldValue('name', false)
    assert.ok(result)
    assert.ok(receiver.taint.isTaintedRec)
    assert.ok(field?.taint?.isTaintedRec)
  })

  it('does not prune ordinary entrypoints when the lifecycle scope is inactive', () => {
    const analyzer = createAnalyzer()
    assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [], stateAt(50), false), false)
    assert.strictEqual(analyzer.checkFclosCanPruneDuringInterpret(fclos, node, [], stateAt(50), true), false)
    assert.deepStrictEqual(analyzer.getLifecycleCallDepthPrunes(), [])
  })
})
