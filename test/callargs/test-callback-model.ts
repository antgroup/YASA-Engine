import { describe, it } from 'mocha'
import * as assert from 'assert'
import type { CallInfo } from '../../src/engine/analyzer/common/call-args'
import type { Scope, State, Value } from '../../src/types/analyzer'
import type { CallExpression } from '../../src/types/uast'
import {
  buildCallbackCallInfo,
  clearCallbackApiModelCache,
  dispatchCallbackApiModel,
  findCallbackApiModel,
  parseCallbackApiModelResource,
  type CallbackApiModel,
} from '../../src/engine/analyzer/common/callback-model'
import { dispatchPythonCallbackApiModel, type PythonFrameworkCallContext } from '../../src/engine/analyzer/python/framework-call-model'

const backgroundTaskModel: CallbackApiModel = {
  id: 'python.fastapi.background-tasks.add-task',
  language: 'python',
  matcher: {
    method: 'add_task',
    receiverIdentities: ['fastapi.BackgroundTasks'],
    minArgs: 1,
  },
  callback: { index: 0 },
  argumentMapping: 'tail',
  receiverPolicy: 'preserve-callback-receiver',
  resultPolicy: 'ignore',
  dispatchPolicy: 'short-circuit-generic-fallback',
}

const callbackNode = { type: 'CallExpression', marker: 'callback-node' }

function createCallInfo(): CallInfo {
  const callbackReceiver = { sid: 'callback-instance' }
  return {
    callsiteNode: callbackNode,
    callArgs: {
      receiver: { sid: 'scheduler' },
      node: callbackNode,
      args: [
        { index: 0, value: { vtype: 'fclos', sid: 'callback', _this: callbackReceiver }, kind: 'positional' },
        { index: 1, value: 'task', node: callbackNode, kind: 'positional' },
        { index: 2, value: 'request', node: callbackNode, name: 'request', kind: 'keyword' },
        { index: 3, value: ['a', 'b'], node: callbackNode, kind: 'spread' },
        { index: 4, value: { flag: true }, node: callbackNode, kind: 'kwspread' },
      ],
    },
  }
}

function createPythonFrameworkContext(
  receiverIdentity: string,
  executeResult?: Value,
  aborted = false
): PythonFrameworkCallContext {
  const node = {
    type: 'CallExpression',
    callee: {
      type: 'MemberAccess',
      property: { type: 'Identifier', name: 'add_task' },
    },
  } as CallExpression
  const callInfo = createCallInfo()
  callInfo.callsiteNode = node
  callInfo.callArgs!.receiver = { rtype: { definiteType: { name: receiverIdentity } } }
  const state = {} as State
  if (aborted) state.throwstackScopeAndState = [{ state }]
  return {
    analyzer: {
      executeCall(): unknown {
        return executeResult
      },
      executeCallbackModelCall(): boolean {
        return !aborted
      },
    },
    scope: { qid: 'test' } as Scope,
    node,
    state,
    fclos: { vtype: 'symbol' } as Value,
    res: undefined,
    argvalues: [],
    callInfo,
    collectedArgs: [],
  }
}

describe('callback API descriptor model', function () {
  it('资源按 language 过滤并拒绝不合法 descriptor', function () {
    const resource = {
      version: 1,
      models: [
        backgroundTaskModel,
        { ...backgroundTaskModel, id: 'javascript.task', language: 'javascript' },
        { ...backgroundTaskModel, id: 'invalid-callback', callback: { index: 0, keyword: 'func' } },
      ],
    }

    assert.deepStrictEqual(parseCallbackApiModelResource(resource, 'python'), [backgroundTaskModel])
    assert.deepStrictEqual(parseCallbackApiModelResource(resource, 'javascript'), [{
      ...backgroundTaskModel,
      id: 'javascript.task',
      language: 'javascript',
    }])
    assert.deepStrictEqual(parseCallbackApiModelResource({ version: 2, models: [backgroundTaskModel] }, 'python'), [])
    assert.deepStrictEqual(parseCallbackApiModelResource(null, 'python'), [])
    assert.deepStrictEqual(parseCallbackApiModelResource({ version: 1, models: [{ ...backgroundTaskModel, matcher: null }] }, 'python'), [])
    assert.deepStrictEqual(parseCallbackApiModelResource({ version: 1, models: [{ ...backgroundTaskModel, matcher: { ...backgroundTaskModel.matcher, receiverIdentities: [] } }] }, 'python'), [])
    assert.deepStrictEqual(parseCallbackApiModelResource({ version: 1, models: [{ ...backgroundTaskModel, argumentMapping: 'all' }] }, 'python'), [])
  })

  it('按 language 和 receiver identity 保守匹配', function () {
    const callInfo = createCallInfo()
    const python = findCallbackApiModel({
      language: 'python',
      methodName: 'add_task',
      receiverIdentities: ['fastapi.BackgroundTasks'],
      callInfo,
    }, [backgroundTaskModel])
    const javascript = findCallbackApiModel({
      language: 'javascript',
      methodName: 'add_task',
      receiverIdentities: ['fastapi.BackgroundTasks'],
      callInfo,
    }, [backgroundTaskModel])
    const decoy = findCallbackApiModel({
      language: 'python',
      methodName: 'add_task',
      receiverIdentities: ['project.TaskQueue'],
      callInfo,
    }, [backgroundTaskModel])

    assert.strictEqual(python, backgroundTaskModel)
    assert.strictEqual(javascript, undefined)
    assert.strictEqual(decoy, undefined)
  })

  it('保留 bound instance callback 的 receiver 并重编号 tail CallArg 元数据', function () {
    const callInfo = createCallInfo()
    const callbackCall = buildCallbackCallInfo(backgroundTaskModel, callInfo)
    assert.ok(callbackCall)
    assert.strictEqual(callbackCall!.callback.sid, 'callback')
    assert.deepStrictEqual(callbackCall!.callInfo.callArgs?.receiver, { sid: 'callback-instance' })
    assert.notStrictEqual(callbackCall!.callInfo.callArgs?.receiver, callInfo.callArgs?.receiver)
    assert.strictEqual(callbackCall!.callInfo.callsiteNode, callbackNode)
    assert.deepStrictEqual(callbackCall!.callInfo.callArgs?.args, [
      { index: 0, value: 'task', node: callbackNode, kind: 'positional' },
      { index: 1, value: 'request', node: callbackNode, name: 'request', kind: 'keyword' },
      { index: 2, value: ['a', 'b'], node: callbackNode, kind: 'spread' },
      { index: 3, value: { flag: true }, node: callbackNode, kind: 'kwspread' },
    ])
  })

  it('FastAPI receiver identity 成功执行时短路 fallback', function () {
    const handled = dispatchPythonCallbackApiModel(createPythonFrameworkContext('fastapi.BackgroundTasks'), [backgroundTaskModel])

    assert.strictEqual(handled, true)
  })

  it('默认 descriptor 资源在生产 dispatch 路径中可加载', function () {
    clearCallbackApiModelCache()
    const handled = dispatchPythonCallbackApiModel(createPythonFrameworkContext('fastapi.BackgroundTasks'))

    assert.strictEqual(handled, true)
  })

  function dispatchAnnotatedReceiver(imported: string, local: string, annotation: string): boolean {
    const context = createPythonFrameworkContext('missing')
    const module = {
      type: 'CompileUnit',
      body: [{
        type: 'VariableDeclaration',
        loc: { start: { line: 1, column: 0 } },
        id: { type: 'Identifier', name: local },
        init: {
          type: 'ImportExpression',
          from: { value: 'fastapi' },
          imported: { type: 'Identifier', name: imported },
        },
      }],
    }
    const declaration = {
      type: 'VariableDeclaration',
      loc: { start: { line: 2, column: 0 } },
      varType: { type: 'Identifier', name: annotation },
      parent: module,
    }
    context.callInfo.callArgs!.receiver = { ast: { node: declaration } }
    return dispatchPythonCallbackApiModel(context, [backgroundTaskModel])
  }

  it('FastAPI 导入别名的 BackgroundTasks 注解可作为 receiver identity', function () {
    assert.strictEqual(dispatchAnnotatedReceiver('BackgroundTasks', 'BT', 'BT'), true)
  })

  it('receiver Identifier 可沿 parameter declaration 解析注解', function () {
    const context = createPythonFrameworkContext('missing')
    const module = {
      type: 'CompileUnit',
      body: [{
        type: 'VariableDeclaration',
        loc: { start: { line: 1, column: 0 } },
        id: { type: 'Identifier', name: 'BT' },
        init: { type: 'ImportExpression', from: { value: 'fastapi' }, imported: { type: 'Identifier', name: 'BackgroundTasks' } },
      }],
    }
    const parameter = { type: 'VariableDeclaration', loc: { start: { line: 2, column: 0 } }, varType: { type: 'Identifier', name: 'BT' }, parent: module }
    const identifier = { type: 'Identifier', name: 'tasks', parent: parameter }
    context.callInfo.callArgs!.receiver = { ast: { node: identifier } }

    assert.strictEqual(dispatchPythonCallbackApiModel(context, [backgroundTaskModel]), true)
  })

  it('canonical annotation requires a live module binding', function () {
    const context = createPythonFrameworkContext('missing')
    const module = {
      type: 'CompileUnit',
      body: [
        { type: 'VariableDeclaration', loc: { start: { line: 1, column: 0 } }, id: { type: 'Identifier', name: 'fastapi' }, init: { type: 'ImportExpression', imported: { type: 'Identifier', name: 'fastapi' } } },
        { type: 'AssignmentExpression', loc: { start: { line: 2, column: 0 } }, left: { type: 'Identifier', name: 'fastapi' }, right: { type: 'Identifier', name: 'LocalQueue' } },
      ],
    }
    const declaration = { type: 'VariableDeclaration', loc: { start: { line: 3, column: 0 } }, varType: { type: 'MemberAccess', object: { type: 'Identifier', name: 'fastapi' }, property: { type: 'Identifier', name: 'BackgroundTasks' } }, parent: module }
    context.callInfo.callArgs!.receiver = { ast: { node: declaration } }

    assert.strictEqual(dispatchPythonCallbackApiModel(context, [backgroundTaskModel]), false)
  })

  it('Starlette root and background aliases resolve only through bound imports', function () {
    const createStarletteContext = (local: string, annotation: unknown): PythonFrameworkCallContext => {
      const context = createPythonFrameworkContext('missing')
      const module = { type: 'CompileUnit', body: [{ type: 'VariableDeclaration', loc: { start: { line: 1, column: 0 } }, id: { type: 'Identifier', name: local }, init: { type: 'ImportExpression', from: local === 'sb' ? { value: 'starlette' } : null, imported: { type: 'Identifier', name: local === 'sb' ? 'background' : 'starlette' } } }] }
      const declaration = { type: 'VariableDeclaration', loc: { start: { line: 2, column: 0 } }, varType: annotation, parent: module }
      context.callInfo.callArgs!.receiver = { ast: { node: declaration } }
      return context
    }

    assert.strictEqual(dispatchPythonCallbackApiModel(createStarletteContext('sb', { type: 'MemberAccess', object: { type: 'Identifier', name: 'sb' }, property: { type: 'Identifier', name: 'BackgroundTasks' } }), [{ ...backgroundTaskModel, matcher: { ...backgroundTaskModel.matcher, receiverIdentities: ['starlette.background.BackgroundTasks'] } }]), true)
    assert.strictEqual(dispatchPythonCallbackApiModel(createStarletteContext('st', { type: 'MemberAccess', object: { type: 'MemberAccess', object: { type: 'Identifier', name: 'st' }, property: { type: 'Identifier', name: 'background' } }, property: { type: 'Identifier', name: 'BackgroundTasks' } }), [{ ...backgroundTaskModel, matcher: { ...backgroundTaskModel.matcher, receiverIdentities: ['starlette.background.BackgroundTasks'] } }]), true)
  })

  it('unbound Starlette aliases do not match', function () {
    const context = createPythonFrameworkContext('missing')
    const declaration = { type: 'VariableDeclaration', loc: { start: { line: 1, column: 0 } }, varType: { type: 'MemberAccess', object: { type: 'Identifier', name: 'st' }, property: { type: 'Identifier', name: 'BackgroundTasks' } }, parent: { type: 'CompileUnit', body: [] } }
    context.callInfo.callArgs!.receiver = { ast: { node: declaration } }

    assert.strictEqual(dispatchPythonCallbackApiModel(context, [backgroundTaskModel]), false)
  })

  it('FastAPI 模块别名的 BackgroundTasks 注解可作为 receiver identity', function () {
    const context = createPythonFrameworkContext('missing')
    const module = {
      type: 'CompileUnit',
      body: [{
        type: 'VariableDeclaration',
        loc: { start: { line: 1, column: 0 } },
        id: { type: 'Identifier', name: 'api' },
        init: { type: 'ImportExpression', imported: { type: 'Identifier', name: 'fastapi' } },
      }],
    }
    const declaration = {
      type: 'VariableDeclaration',
      loc: { start: { line: 2, column: 0 } },
      varType: {
        type: 'MemberAccess',
        object: { type: 'Identifier', name: 'api' },
        property: { type: 'Identifier', name: 'BackgroundTasks' },
      },
      parent: module,
    }
    context.callInfo.callArgs!.receiver = { ast: { node: declaration } }

    assert.strictEqual(dispatchPythonCallbackApiModel(context, [backgroundTaskModel]), true)
  })

  it('同名、局部重绑定或无证明 BackgroundTasks 注解不匹配', function () {
    assert.strictEqual(dispatchAnnotatedReceiver('Request', 'BackgroundTasks', 'BackgroundTasks'), false)
    assert.strictEqual(dispatchAnnotatedReceiver('BackgroundTasks', 'BT', 'BackgroundTasks'), false)
  })

  it('模块控制块中的 alias 重绑定不证明 receiver identity', function () {
    const createNestedRebindingContext = (alias: string, annotation: unknown, blockType: string): PythonFrameworkCallContext => {
      const context = createPythonFrameworkContext('missing')
      const module = {
        type: 'CompileUnit',
        body: [
          { type: 'VariableDeclaration', loc: { start: { line: 1, column: 0 } }, id: { type: 'Identifier', name: alias }, init: { type: 'ImportExpression', imported: { type: 'Identifier', name: alias === 'BT' ? 'BackgroundTasks' : alias === 'st' ? 'starlette' : 'fastapi' }, from: alias === 'BT' ? { value: 'fastapi' } : null } },
          { type: blockType, loc: { start: { line: 2, column: 0 } }, body: [{ type: 'AssignmentExpression', loc: { start: { line: 3, column: 0 } }, left: { type: 'Identifier', name: alias }, right: { type: 'Identifier', name: 'LocalQueue' } }] },
        ],
      }
      const declaration = { type: 'VariableDeclaration', loc: { start: { line: 4, column: 0 } }, varType: annotation, parent: module }
      context.callInfo.callArgs!.receiver = { ast: { node: declaration } }
      return context
    }
    const annotations = [
      { alias: 'BT', annotation: { type: 'Identifier', name: 'BT' }, model: backgroundTaskModel },
      { alias: 'api', annotation: { type: 'MemberAccess', object: { type: 'Identifier', name: 'api' }, property: { type: 'Identifier', name: 'BackgroundTasks' } }, model: backgroundTaskModel },
      { alias: 'st', annotation: { type: 'MemberAccess', object: { type: 'MemberAccess', object: { type: 'Identifier', name: 'st' }, property: { type: 'Identifier', name: 'background' } }, property: { type: 'Identifier', name: 'BackgroundTasks' } }, model: { ...backgroundTaskModel, matcher: { ...backgroundTaskModel.matcher, receiverIdentities: ['starlette.background.BackgroundTasks'] } } },
    ]

    for (const { alias, annotation, model } of annotations) {
      assert.strictEqual(dispatchPythonCallbackApiModel(createNestedRebindingContext(alias, annotation, 'IfStatement'), [model]), false)
      assert.strictEqual(dispatchPythonCallbackApiModel(createNestedRebindingContext(alias, annotation, 'TryStatement'), [model]), false)
    }
  })

  // UAST 未保留 global/nonlocal 声明，函数赋值保守视为模块别名重绑定。
  it('函数 scope 中的 alias 重绑定不证明 receiver identity', function () {
    const createFunctionLocalRebindingContext = (alias: string, annotation: unknown): PythonFrameworkCallContext => {
      const context = createPythonFrameworkContext('missing')
      const importStatement = {
        type: 'VariableDeclaration',
        loc: { start: { line: 1, column: 0 } },
        id: { type: 'Identifier', name: alias },
        init: {
          type: 'ImportExpression',
          imported: { type: 'Identifier', name: alias === 'BT' ? 'BackgroundTasks' : alias === 'st' ? 'starlette' : 'fastapi' },
          from: alias === 'BT' ? { value: 'fastapi' } : null,
        },
      }
      const localAssignment = {
        type: 'AssignmentExpression',
        loc: { start: { line: 3, column: 0 } },
        left: { type: 'Identifier', name: alias },
        right: { type: 'Identifier', name: 'LocalQueue' },
      }
      const functionDefinition = {
        type: 'FunctionDefinition',
        loc: { start: { line: 2, column: 0 } },
        body: { type: 'ScopedStatement', body: [localAssignment] },
      }
      const module = { type: 'CompileUnit', body: [importStatement, functionDefinition] }
      const declaration = { type: 'VariableDeclaration', loc: { start: { line: 4, column: 0 } }, varType: annotation, parent: module }
      context.callInfo.callArgs!.receiver = { ast: { node: declaration } }
      return context
    }

    assert.strictEqual(dispatchPythonCallbackApiModel(createFunctionLocalRebindingContext('BT', { type: 'Identifier', name: 'BT' }), [backgroundTaskModel]), false)
    assert.strictEqual(dispatchPythonCallbackApiModel(createFunctionLocalRebindingContext('api', { type: 'MemberAccess', object: { type: 'Identifier', name: 'api' }, property: { type: 'Identifier', name: 'BackgroundTasks' } }), [backgroundTaskModel]), false)
    assert.strictEqual(dispatchPythonCallbackApiModel(createFunctionLocalRebindingContext('st', { type: 'MemberAccess', object: { type: 'MemberAccess', object: { type: 'Identifier', name: 'st' }, property: { type: 'Identifier', name: 'background' } }, property: { type: 'Identifier', name: 'BackgroundTasks' } }), [{ ...backgroundTaskModel, matcher: { ...backgroundTaskModel.matcher, receiverIdentities: ['starlette.background.BackgroundTasks'] } }]), false)
  })

  it('重绑定、嵌套导入或晚于声明的导入不证明 receiver identity', function () {
    const context = createPythonFrameworkContext('missing')
    const declaration = {
      type: 'VariableDeclaration',
      loc: { start: { line: 3, column: 0 } },
      varType: { type: 'Identifier', name: 'BT' },
    }
    const module = {
      type: 'CompileUnit',
      body: [
        { type: 'VariableDeclaration', loc: { start: { line: 1, column: 0 } }, id: { type: 'Identifier', name: 'BT' }, init: { type: 'ImportExpression', from: { value: 'fastapi' }, imported: { type: 'Identifier', name: 'BackgroundTasks' } } },
        { type: 'AssignmentExpression', loc: { start: { line: 2, column: 0 } }, left: { type: 'Identifier', name: 'BT' }, right: { type: 'Identifier', name: 'LocalQueue' } },
        declaration,
        { type: 'ScopedStatement', loc: { start: { line: 4, column: 0 } }, body: [{ type: 'VariableDeclaration', id: { type: 'Identifier', name: 'BT' }, init: { type: 'ImportExpression', from: { value: 'fastapi' }, imported: { type: 'Identifier', name: 'BackgroundTasks' } } }] },
        { type: 'VariableDeclaration', loc: { start: { line: 5, column: 0 } }, id: { type: 'Identifier', name: 'BT' }, init: { type: 'ImportExpression', from: { value: 'fastapi' }, imported: { type: 'Identifier', name: 'BackgroundTasks' } } },
      ],
    }
    declaration.parent = module
    context.callInfo.callArgs!.receiver = { ast: { node: declaration } }

    assert.strictEqual(dispatchPythonCallbackApiModel(context, [backgroundTaskModel]), false)
  })

  it('非 FastAPI add_task 不由 descriptor 处理', function () {
    const handled = dispatchPythonCallbackApiModel(createPythonFrameworkContext('project.TaskQueue'), [backgroundTaskModel])

    assert.strictEqual(handled, false)
  })

  it('void callback 成功执行时短路 fallback', function () {
    const handled = dispatchPythonCallbackApiModel(
      createPythonFrameworkContext('fastapi.BackgroundTasks', undefined),
      [backgroundTaskModel]
    )

    assert.strictEqual(handled, true)
  })

  it('callback 抛错时不短路 fallback', function () {
    const context = createPythonFrameworkContext('fastapi.BackgroundTasks')
    context.analyzer.executeCallbackModelCall = (): boolean => false

    assert.strictEqual(dispatchPythonCallbackApiModel(context, [backgroundTaskModel]), false)
  })

  it('中止 callback 不短路 fallback', function () {
    const handled = dispatchPythonCallbackApiModel(
      createPythonFrameworkContext('fastapi.BackgroundTasks', undefined, true),
      [backgroundTaskModel]
    )

    assert.strictEqual(handled, false)
  })

  it('callback 成功完成时返回 handled', function () {
    const calls: Array<{ callback: string; args: number }> = []
    const handled = dispatchCallbackApiModel({
      language: 'python',
      methodName: 'add_task',
      receiverIdentities: ['fastapi.BackgroundTasks'],
      callInfo: createCallInfo(),
      execute(callback, callInfo) {
        calls.push({ callback: callback.sid as string, args: callInfo.callArgs?.args.length ?? -1 })
        return { status: 'completed' }
      },
    }, [backgroundTaskModel])

    assert.strictEqual(handled, true)
    assert.deepStrictEqual(calls, [{ callback: 'callback', args: 4 }])
  })

  it('union callback 保留 payload 并执行', function () {
    const callInfo = createCallInfo()
    callInfo.callArgs!.args[0].value = {
      vtype: 'union',
      value: [
        { vtype: 'fclos', sid: 'first-callback' },
        { vtype: 'fclos', sid: 'second-callback' },
      ],
    } as Value
    const handled = dispatchCallbackApiModel({
      language: 'python',
      methodName: 'add_task',
      receiverIdentities: ['fastapi.BackgroundTasks'],
      callInfo,
      execute(callback, callbackCallInfo) {
        assert.strictEqual(callback.vtype, 'union')
        assert.deepStrictEqual(callbackCallInfo.callArgs?.args.map((arg) => arg.index), [0, 1, 2, 3])
        return { status: 'completed' }
      },
    }, [backgroundTaskModel])

    assert.strictEqual(handled, true)
  })

  it('callback 执行失败时不返回 handled', function () {
    const handled = dispatchCallbackApiModel({
      language: 'python',
      methodName: 'add_task',
      receiverIdentities: ['fastapi.BackgroundTasks'],
      callInfo: createCallInfo(),
      execute() {
        return { status: 'failed' }
      },
    }, [backgroundTaskModel])

    assert.strictEqual(handled, false)
  })

  it('callback 执行未完成时不返回 handled', function () {
    const handled = dispatchCallbackApiModel({
      language: 'python',
      methodName: 'add_task',
      receiverIdentities: ['fastapi.BackgroundTasks'],
      callInfo: createCallInfo(),
      execute() {
        return { status: 'incomplete' }
      },
    }, [backgroundTaskModel])

    assert.strictEqual(handled, false)
  })

  it('非 closure callback 不处理调用', function () {
    const callInfo = createCallInfo()
    callInfo.callArgs!.args[0].value = { vtype: 'symbol', sid: 'callback' }
    const handled = dispatchCallbackApiModel({
      language: 'python',
      methodName: 'add_task',
      receiverIdentities: ['fastapi.BackgroundTasks'],
      callInfo,
      execute() {
        throw new Error('不应执行')
      },
    }, [backgroundTaskModel])

    assert.strictEqual(handled, false)
  })
})
