import { describe, it } from 'mocha'
import * as assert from 'assert'
import type { CallInfo } from '../../src/engine/analyzer/common/call-args'
import type { FunctionDefinition, Node } from '../../src/types/uast'

const Analyzer = require('../../src/engine/analyzer/common/analyzer') as new (config: unknown) => unknown
const CompletableFuture = require('../../src/engine/analyzer/java/common/builtins/completablefuture-builtins') as {
  thenApply: (...args: unknown[]) => unknown
  thenApplyAsync: (...args: unknown[]) => unknown
  thenRunAsync: (...args: unknown[]) => unknown
}
const SourceLine = require('../../src/engine/analyzer/common/source-line') as {
  addSrcLineInfo: (value: unknown, node: unknown, sourcefile: unknown, tag: unknown, affectedNodeName: unknown, options?: unknown) => unknown
}
const MemSpace = require('../../src/engine/analyzer/common/memSpace') as { prototype: Record<string, unknown> }
const TaintChecker = require('../../src/checker/taint/taint-checker')

const traceSourceLineOptions = { callbackEdge: true, callbackClosureOwnerHash: 'generated-callback-owner' }

function makeTraceStep(tag: string, node: unknown, line: number): Record<string, unknown> {
  return { tag, node, file: 'CallbackFixture.java', line }
}

function makeFrame(node: unknown): Record<string, unknown> {
  return { vtype: 'fclos', ast: { node } }
}

function traceChecker(): { filterTraceToCallstackOrder: (finding: Record<string, unknown>) => void } {
  return Object.create(TaintChecker.prototype) as { filterTraceToCallstackOrder: (finding: Record<string, unknown>) => void }
}

type CallbackTraceBridge = {
  shouldEmitAnonymousCallbackEntryTrace(node: Node, callInfo: CallInfo | undefined): boolean
  addAnonymousCallbackEntryTrace(targetValue: unknown, callsiteNode: Node, fdecl: FunctionDefinition, fname: string): unknown
}

type FutureLike = {
  getThisObj(): FutureLike
  getMisc(name: string): unknown
  setMisc(name: string, value: unknown): void
}

type StoredCallbackContext = {
  callsiteNode?: Node
  node?: unknown
}

function loc(line: number): { sourcefile: string; start: { line: number; column: number }; end: { line: number; column: number } } {
  return { sourcefile: 'CallbackFixture.java', start: { line, column: 1 }, end: { line, column: 20 } }
}

function createFutureLike(): FutureLike {
  const misc = new Map<string, unknown>([
    ['futureScope', { qid: 'futureScope', value: {} }],
    ['thenFuncsWithContext', []],
  ])
  return {
    getThisObj(): FutureLike {
      return this
    },
    getMisc(name: string): unknown {
      return misc.get(name)
    },
    setMisc(name: string, value: unknown): void {
      misc.set(name, value)
    },
  }
}

function installMemSpaceStubs(): () => void {
  const originalGetMemberValueNoCreate = MemSpace.prototype.getMemberValueNoCreate
  const originalSaveVarInScope = MemSpace.prototype.saveVarInScope
  MemSpace.prototype.getMemberValueNoCreate = function getMemberValueNoCreateStub(): unknown {
    return { sid: 'previousResult' }
  }
  MemSpace.prototype.saveVarInScope = function saveVarInScopeStub(): undefined {
    return undefined
  }
  return () => {
    MemSpace.prototype.getMemberValueNoCreate = originalGetMemberValueNoCreate
    MemSpace.prototype.saveVarInScope = originalSaveVarInScope
  }
}

type CallbackContext = {
  capturedCallInfos: CallInfo[]
  executeCall(node: unknown, fclos: unknown, state: unknown, scope: unknown, callInfo: CallInfo): unknown
  buildCallArgs(node: unknown, argvalues: unknown, fclos: unknown): CallInfo['callArgs']
  processAndCallFuncDef(scope: unknown, node: unknown, fclos: unknown, state: unknown, argValues?: unknown, traceCallNode?: unknown): unknown
}

function createCallbackContext(): CallbackContext {
  return {
    capturedCallInfos: [],
    executeCall(node: unknown, fclos: unknown, state: unknown, scope: unknown, callInfo: CallInfo): unknown {
      void node
      void fclos
      void state
      void scope
      this.capturedCallInfos.push(callInfo)
      return { sid: 'callbackResult' }
    },
    buildCallArgs(node: unknown, argvalues: unknown, fclos: unknown): CallInfo['callArgs'] {
      void node
      void argvalues
      void fclos
      return { args: [] }
    },
    processAndCallFuncDef(scope: unknown, node: unknown, fclos: unknown, state: unknown, argValues?: unknown, traceCallNode?: unknown): unknown {
      void scope
      void node
      void fclos
      void state
      void argValues
      return { traceCallNode }
    },
  }
}


describe('anonymous callback nodeHash trace binding', function () {
  it('zero-parameter callback emits CALL from CallExpression and ARG PASS from FunctionDefinition', function () {
    const analyzer = new Analyzer(null) as unknown as CallbackTraceBridge
    const callsiteNode = { type: 'CallExpression', loc: loc(10) } as unknown as Node
    const callbackNode = { type: 'FunctionDefinition', loc: loc(11), parameters: [], _meta: { nodehash: 'generated-callback-owner' } } as unknown as FunctionDefinition
    const callInfo: CallInfo = { callsiteNode }
    const captured: Array<{ nodeType: string | undefined; tag: string | undefined }> = []
    const originalAddSrcLineInfo = SourceLine.addSrcLineInfo

    SourceLine.addSrcLineInfo = (value: unknown, node: unknown, sourcefile: unknown, tag: unknown, affectedNodeName: unknown): unknown => {
      void sourcefile
      void affectedNodeName
      const typedNode = node as { type?: string }
      captured.push({ nodeType: typedNode.type, tag: typeof tag === 'string' ? tag : undefined })
      return value
    }

    try {
      assert.strictEqual(analyzer.shouldEmitAnonymousCallbackEntryTrace(callbackNode, callInfo), true)
      const targetValue = { marker: 'tainted-return' }
      analyzer.addAnonymousCallbackEntryTrace(targetValue, callsiteNode, callbackNode, 'callback')
    } finally {
      SourceLine.addSrcLineInfo = originalAddSrcLineInfo
    }

    assert.deepStrictEqual(captured, [
      { tag: 'CALL: ', nodeType: 'CallExpression' },
      { tag: 'ARG PASS: ', nodeType: 'FunctionDefinition' },
    ])
  })



  it('generated callback provenance reaches filtering and rejects foreign owner only', function () {
    const analyzer = new Analyzer(null) as unknown as CallbackTraceBridge
    const callsiteNode = { type: 'CallExpression', loc: loc(60) } as unknown as Node
    const callbackNode = { type: 'FunctionDefinition', loc: loc(61), parameters: [], _meta: { nodehash: 'generated-callback-owner' } } as unknown as FunctionDefinition
    const captured: unknown[] = []
    const originalAddSrcLineInfo = SourceLine.addSrcLineInfo
    SourceLine.addSrcLineInfo = (value: unknown, node: unknown, sourcefile: unknown, tag: unknown, affectedNodeName: unknown, options?: unknown): unknown => {
      captured.push({ value, node, sourcefile, tag, affectedNodeName, options })
      return value
    }
    try {
      analyzer.addAnonymousCallbackEntryTrace({ marker: 'tainted-return' }, callsiteNode, callbackNode, 'callback')
    } finally {
      SourceLine.addSrcLineInfo = originalAddSrcLineInfo
    }
    assert.strictEqual(captured.length, 2)
    assert.deepStrictEqual((captured[0] as { options: unknown }).options, traceSourceLineOptions)
    const trace = [
      { ...makeTraceStep('SOURCE: ', callsiteNode, 1) },
      { ...makeTraceStep('CALL: ', callsiteNode, 60), _callbackEdge: true, _callbackClosureOwnerHash: 'generated-callback-owner' },
      { ...makeTraceStep('ARG PASS: ', callbackNode, 61), _callbackEdge: true, _callbackClosureOwnerHash: 'generated-callback-owner' },
      makeTraceStep('SINK: ', callsiteNode, 70),
    ]
    const finding = { trace, callstack: [makeFrame(callbackNode)], callsites: [] }
    traceChecker().filterTraceToCallstackOrder(finding)
    assert.notStrictEqual(finding.trace.length, 0)
    const foreign = { trace: trace.map((step) => ({ ...step, _callbackClosureOwnerHash: step._callbackEdge ? 'foreign-owner' : undefined })), callstack: [makeFrame(callsiteNode)], callsites: [] }
    traceChecker().filterTraceToCallstackOrder(foreign)
    assert.deepStrictEqual(foreign.trace.map((step: { tag?: string }) => step.tag), ['SOURCE: ', 'SINK: '])
  })

  it('casted zero-parameter callback emits CALL from cast expression', function () {
    const analyzer = new Analyzer(null) as unknown as CallbackTraceBridge
    const castNode = { type: 'CastExpression', loc: loc(50) } as unknown as Node
    const callbackNode = { type: 'FunctionDefinition', loc: loc(51), parameters: [] } as unknown as FunctionDefinition
    const callInfo: CallInfo = { callsiteNode: castNode }
    const captured: Array<{ nodeType: string | undefined; tag: string | undefined }> = []
    const originalAddSrcLineInfo = SourceLine.addSrcLineInfo

    SourceLine.addSrcLineInfo = (value: unknown, node: unknown, sourcefile: unknown, tag: unknown, affectedNodeName: unknown): unknown => {
      void sourcefile
      void affectedNodeName
      const typedNode = node as { type?: string }
      captured.push({ nodeType: typedNode.type, tag: typeof tag === 'string' ? tag : undefined })
      return value
    }

    try {
      assert.strictEqual(analyzer.shouldEmitAnonymousCallbackEntryTrace(callbackNode, callInfo), true)
      analyzer.addAnonymousCallbackEntryTrace({ marker: 'callable-return' }, castNode, callbackNode, 'callable')
    } finally {
      SourceLine.addSrcLineInfo = originalAddSrcLineInfo
    }

    assert.deepStrictEqual(captured, [
      { tag: 'CALL: ', nodeType: 'CastExpression' },
      { tag: 'ARG PASS: ', nodeType: 'FunctionDefinition' },
    ])
  })

  it('plain FunctionDefinition execution does not use callback entry trace', function () {
    const analyzer = new Analyzer(null) as unknown as CallbackTraceBridge
    const callbackNode = { type: 'FunctionDefinition', loc: loc(20), parameters: [] } as unknown as FunctionDefinition
    const callInfo: CallInfo = { callsiteNode: callbackNode as unknown as Node }

    assert.strictEqual(analyzer.shouldEmitAnonymousCallbackEntryTrace(callbackNode, callInfo), false)
    assert.strictEqual(analyzer.shouldEmitAnonymousCallbackEntryTrace(callbackNode, undefined), false)
  })

  it('thenApply and thenApplyAsync pass and store the outer callsite', function () {
    const restoreMemSpace = installMemSpaceStubs()
    try {
      for (const invoke of [CompletableFuture.thenApply, CompletableFuture.thenApplyAsync]) {
        const callsiteNode = { type: 'CallExpression', loc: loc(30), arguments: [{ type: 'FunctionDefinition', loc: loc(31) }] } as unknown as Node & { arguments: unknown[] }
        const futureLike = createFutureLike()
        const callbackValue = { vtype: 'fclos', parent: undefined }
        const context = createCallbackContext()

        invoke.call(context, futureLike, [callbackValue], {}, callsiteNode, { qid: 'scope', value: {} }, { callsiteNode })

        const storedContexts = futureLike.getMisc('thenFuncsWithContext') as StoredCallbackContext[]
        assert.strictEqual(context.capturedCallInfos.length, 1)
        assert.strictEqual(context.capturedCallInfos[0].callsiteNode, callsiteNode)
        assert.strictEqual(storedContexts.length, 1)
        assert.strictEqual(storedContexts[0].callsiteNode, callsiteNode)
        assert.strictEqual(storedContexts[0].node, callsiteNode.arguments[0])
        assert.strictEqual(callbackValue.parent, undefined)
      }
    } finally {
      restoreMemSpace()
    }
  })

  it('thenRunAsync passes the outer callsite into processAndCallFuncDef and queue context', function () {
    const callsiteNode = { type: 'CallExpression', loc: loc(40), arguments: [{ type: 'FunctionDefinition', loc: loc(41) }] } as unknown as Node & { arguments: unknown[] }
    const futureLike = createFutureLike()
    const callbackValue = { vtype: 'fclos', parent: undefined }
    const context = createCallbackContext()
    const result = CompletableFuture.thenRunAsync.call(context, futureLike, [callbackValue], {}, callsiteNode, { qid: 'scope', value: {} }, { callsiteNode }) as FutureLike

    const storedContexts = result.getMisc('thenFuncsWithContext') as StoredCallbackContext[]
    assert.strictEqual(storedContexts.length, 1)
    assert.strictEqual(storedContexts[0].callsiteNode, callsiteNode)
    assert.strictEqual(storedContexts[0].node, callsiteNode.arguments[0])
    assert.strictEqual(callbackValue.parent, undefined)
  })
})
