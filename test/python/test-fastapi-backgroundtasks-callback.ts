import * as assert from 'assert'
import * as path from 'path'
import { describe, it } from 'mocha'
const { parseSingleFile: parseSingleFilePython } = require('../../src/engine/parser/python/python-ast-builder') as {
  parseSingleFile: (code: string, options: { uastSDKPath: string }) => unknown
}
import { dispatchPythonCallbackApiModel, type PythonFrameworkCallContext } from '../../src/engine/analyzer/python/framework-call-model'
import type { CallInfo } from '../../src/engine/analyzer/common/call-args'
import type { Scope, State, Value } from '../../src/types/analyzer'
import type { CallExpression } from '../../src/types/uast'

const PythonAnalyzer = require('../../src/engine/analyzer/python/common/python-analyzer') as {
  prototype: {
    processCallExpression: (scope: Scope, node: CallExpression, state: State) => unknown
  }
}
const Config = require('../../src/config') as { invokeCallbackOnUnknownFunction: boolean }

const backgroundTaskModel = {
  id: 'python.fastapi.background-tasks.add-task',
  language: 'python' as const,
  matcher: { method: 'add_task', receiverIdentities: ['fastapi.BackgroundTasks'], minArgs: 1 },
  callback: { index: 0 },
  argumentMapping: 'tail' as const,
  receiverPolicy: 'preserve-callback-receiver' as const,
  resultPolicy: 'ignore' as const,
  dispatchPolicy: 'short-circuit-generic-fallback' as const,
}

function attachParents(node: unknown, parent?: Record<string, unknown>): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) attachParents(item, parent)
    return
  }
  const record = node as Record<string, unknown>
  if (parent) record.parent = parent
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'parent') attachParents(value, record)
  }
}

function findDeclaration(ast: unknown, name: string): Record<string, unknown> | undefined {
  const pending: unknown[] = [ast]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || typeof current !== 'object') continue
    const record = current as Record<string, unknown>
    if (record.type === 'VariableDeclaration' && (record.id as { name?: string } | undefined)?.name === name) return record
    for (const [key, value] of Object.entries(record)) {
      if (key === 'parent') continue
      if (Array.isArray(value)) pending.push(...value)
      else if (value && typeof value === 'object') pending.push(value)
    }
  }
  return undefined
}

function createContext(receiverDeclaration: Record<string, unknown>, aborted = false): { context: PythonFrameworkCallContext; calls: CallInfo[] } {
  const calls: CallInfo[] = []
  const node = { type: 'CallExpression', callee: { type: 'MemberAccess', property: { type: 'Identifier', name: 'add_task' } } } as CallExpression
  const callInfo: CallInfo = {
    callsiteNode: node,
    callArgs: {
      receiver: { ast: { node: receiverDeclaration } },
      args: [
        { index: 0, value: { vtype: 'fclos', sid: 'void_callback' } as Value, kind: 'positional' },
        { index: 1, value: 'taint_src', kind: 'positional' },
        { index: 2, value: 'request', name: 'request', kind: 'keyword' },
      ],
    },
  }
  return {
    calls,
    context: {
      analyzer: {
        executeCall(): unknown {
          return undefined
        },
        executeCallbackModelCall(_node, _callback, _state, _scope, callbackCallInfo): boolean {
          calls.push(callbackCallInfo)
          return !aborted
        },
      },
      scope: { qid: 'fixture' } as Scope,
      node,
      state: {} as State,
      fclos: { vtype: 'symbol' } as Value,
      res: undefined,
      argvalues: [],
      callInfo,
      collectedArgs: [],
    },
  }
}

describe('FastAPI BackgroundTasks Python call path', function () {
  const fixture = path.join(__dirname, 'fastapi-backgroundtasks-cases/background_tasks.py')
  const ast = parseSingleFilePython(require('fs').readFileSync(fixture, 'utf8'), { uastSDKPath: path.join(__dirname, '../../deps') })
  attachParents(ast)

  it('recognizes bound aliases and dispatches the callback once with rebased metadata', function () {
    const declaration = findDeclaration(ast, 'tasks')
    assert.ok(declaration)
    const { context, calls } = createContext(declaration!)

    assert.strictEqual(dispatchPythonCallbackApiModel(context, [backgroundTaskModel]), true)
    assert.strictEqual(calls.length, 1)
    assert.deepStrictEqual(calls[0].callArgs?.args.map((arg) => ({ index: arg.index, kind: arg.kind, name: arg.name })), [
      { index: 0, kind: 'positional', name: undefined },
      { index: 1, kind: 'keyword', name: 'request' },
    ])
  })

  it('rejects same-named non-FastAPI receivers and failed callback dispatch', function () {
    const declaration = findDeclaration(ast, 'tasks')
    assert.ok(declaration)
    const decoy = { ...declaration!, varType: { type: 'Identifier', name: 'BackgroundTasks' } }
    const decoyContext = createContext(decoy)
    const abortedContext = createContext(declaration!, true)

    assert.strictEqual(dispatchPythonCallbackApiModel(decoyContext.context, [backgroundTaskModel]), false)
    assert.strictEqual(decoyContext.calls.length, 0)
    assert.strictEqual(dispatchPythonCallbackApiModel(abortedContext.context, [backgroundTaskModel]), false)
    assert.strictEqual(abortedContext.calls.length, 1)
  })

  it('executes real processCallExpression descriptor dispatch once and preserves fallback failures', function () {
    const declaration = findDeclaration(ast, 'tasks')
    assert.ok(declaration)
    const parameterIdentifier = { type: 'Identifier', name: 'tasks', parent: declaration }
    const callback = { vtype: 'fclos', sid: 'callback' } as Value
    const scheduler = { ast: { node: parameterIdentifier } }
    const method = { vtype: 'symbol', sid: 'add_task', _this: scheduler } as Value
    const node = {
      type: 'CallExpression',
      callee: { type: 'MemberAccess', object: { type: 'Identifier', name: 'tasks' }, property: { type: 'Identifier', name: 'add_task' } },
      arguments: [{ type: 'Identifier', name: 'callback' }, { type: 'Identifier', name: 'payload' }],
    } as CallExpression
    const state = { pcond: [], einfo: {}, callstack: [], brs: '', binfo: {} } as State
    const scope = { qid: 'fixture' } as Scope
    const analyzer = Object.create(PythonAnalyzer.prototype) as {
      processInstruction: (scope: Scope, instruction: unknown, state: State) => Value
      buildPythonCallArgs: (args: unknown[], values: Value[], fclos: Value, call: CallExpression) => CallInfo['callArgs']
      processPythonCallExpressionDirect: (scope: Scope, call: CallExpression, state: State, fclos: Value, values: Value[], info: CallInfo) => Value
    }
    const callbackCalls: CallInfo[] = []
    let genericFallbackCalls = 0
    analyzer.processInstruction = (_scope, instruction): Value => {
      if ((instruction as { type?: string }).type === 'MemberAccess') return method
      if ((instruction as { name?: string }).name === 'callback') return callback
      return { vtype: 'symbol', sid: 'payload' } as Value
    }
    analyzer.buildPythonCallArgs = (_args, values) => ({ receiver: scheduler, args: values.map((value, index) => ({ index, value, kind: 'positional' as const })) })
    analyzer.processPythonCallExpressionDirect = (_scope, _call, _state, _fclos, _values, info) => {
      const handled = dispatchPythonCallbackApiModel({
        analyzer: {
          executeCall(): unknown {
            return undefined
          },
          executeCallbackModelCall(_node, _callback, _callbackState, _callbackScope, callbackInfo): boolean {
            callbackCalls.push(callbackInfo)
            return true
          },
        },
        scope,
        node,
        state,
        fclos: method,
        res: undefined,
        argvalues: info.callArgs?.args.map((arg) => arg.value) ?? [],
        callInfo: info,
        collectedArgs: node.arguments,
      })
      if (!handled) genericFallbackCalls++
      return { vtype: 'undefine' } as Value
    }
    const originalFallback = Config.invokeCallbackOnUnknownFunction
    Config.invokeCallbackOnUnknownFunction = true
    try {
      analyzer.processCallExpression(scope, node, state)
    } finally {
      Config.invokeCallbackOnUnknownFunction = originalFallback
    }

    assert.strictEqual(callbackCalls.length, 1)
    assert.deepStrictEqual(callbackCalls[0].callArgs?.args.map((arg) => arg.index), [0])
    assert.strictEqual(genericFallbackCalls, 0)

    analyzer.processPythonCallExpressionDirect = (_scope, _call, _state, _fclos, _values, info) => {
      const handled = dispatchPythonCallbackApiModel({
        analyzer: {
          executeCall(): unknown {
            return undefined
          },
          executeCallbackModelCall(): boolean {
            return false
          },
        },
        scope,
        node,
        state,
        fclos: method,
        res: undefined,
        argvalues: info.callArgs?.args.map((arg) => arg.value) ?? [],
        callInfo: info,
        collectedArgs: node.arguments,
      })
      if (!handled) genericFallbackCalls++
      return { vtype: 'undefine' } as Value
    }
    analyzer.processCallExpression(scope, node, state)

    assert.strictEqual(genericFallbackCalls, 1)
  })

  it('executes a bound instance callback with its own self receiver', function () {
    const scheduler = { rtype: { definiteType: { name: 'fastapi.BackgroundTasks' } }, sid: 'scheduler-instance' }
    const callbackInstance = { sid: 'callback-instance', prefix: 'callback:' }
    const callback = {
      vtype: 'fclos',
      sid: 'Worker.handle',
      _this: callbackInstance,
      ast: { fdef: { parameters: [{ id: { name: 'self' } }, { id: { name: 'payload' } }] } },
    } as Value
    const node = { type: 'CallExpression', callee: { type: 'MemberAccess', property: { type: 'Identifier', name: 'add_task' } } } as CallExpression
    const state = { pcond: [], einfo: {}, callstack: [], brs: '', binfo: {} } as State
    const scope = { qid: 'fixture' } as Scope
    const analyzer = Object.create(PythonAnalyzer.prototype) as {
      bindCallArgs: (node: CallExpression, fclos: Value, fdecl: unknown, callInfo: CallInfo) => { params: Array<{ value?: unknown }> }
      executeCall: (node: CallExpression, fclos: Value, state: State, scope: Scope, callInfo: CallInfo) => unknown
      executeCallbackModelCall: (node: CallExpression, fclos: Value, state: State, scope: Scope, callInfo: CallInfo) => boolean
    }
    let callbackBodyResult: string | undefined
    analyzer.executeCall = (_node, executedCallback, _state, _scope, callbackCallInfo): undefined => {
      const fdecl = executedCallback.ast?.fdef
      const bound = analyzer.bindCallArgs(node, executedCallback, fdecl, callbackCallInfo)
      const self = bound.params[0].value as { prefix: string }
      const payload = bound.params[1].value as string
      callbackBodyResult = `${self.prefix}${payload}`
      return undefined
    }

    const handled = dispatchPythonCallbackApiModel({
      analyzer,
      scope,
      node,
      state,
      fclos: { vtype: 'symbol', sid: 'add_task', _this: scheduler } as Value,
      res: undefined,
      argvalues: [callback, 'payload'],
      callInfo: {
        callsiteNode: node,
        callArgs: {
          receiver: scheduler,
          args: [
            { index: 0, value: callback, kind: 'positional' },
            { index: 1, value: 'payload', kind: 'positional' },
          ],
        },
      },
      collectedArgs: [],
    }, [backgroundTaskModel])

    assert.strictEqual(handled, true)
    assert.strictEqual(callbackBodyResult, 'callback:payload')
  })

  it('keeps generic fallback available when a real callback body throws under host try state', function () {
    const analyzer = Object.create(PythonAnalyzer.prototype) as {
      executeCall: (node: CallExpression, callback: Value, state: State, scope: Scope, callInfo: CallInfo) => unknown
      executeCallbackModelCall: (node: CallExpression, callback: Value, state: State, scope: Scope, callInfo: CallInfo) => boolean
    }
    const hostState = { pcond: [], einfo: {}, callstack: [], brs: '', binfo: {}, throwstack: ['host exception'] } as State
    analyzer.executeCall = (_node, _callback, callbackState): unknown => {
      callbackState.throwstack = callbackState.throwstack ?? []
      callbackState.throwstack.push('callback exception')
      return undefined
    }

    const handled = analyzer.executeCallbackModelCall(
      { type: 'CallExpression' } as CallExpression,
      { vtype: 'fclos', sid: 'throws' } as Value,
      hostState,
      { qid: 'fixture' } as Scope,
      { callArgs: { args: [] } }
    )

    assert.strictEqual(handled, false)
    assert.deepStrictEqual(hostState.throwstack, ['host exception'])
  })
})
