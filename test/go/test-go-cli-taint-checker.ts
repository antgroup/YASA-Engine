import { describe, it } from 'mocha'
import * as assert from 'assert'

const Config = require('../../src/config')
const BasicRuleHandler = require('../../src/checker/common/rules-basic-handler')
const ResultManager = require('../../src/engine/analyzer/common/result-manager')
const { PrimitiveValue } = require('../../src/engine/analyzer/common/value/primitive')
const GoCliTaintChecker = require('../../src/checker/taint/go/go-cli-taint-checker')
const CobraCommandChecker = require('../../src/checker/taint/go/cobra-command-checker')
const { isCobraActionEntryPoint } = GoCliTaintChecker

const { processGoFrameworkCall } = require('../../src/engine/analyzer/golang/framework-call-model')
const { processCobraContextCall } = require('../../src/engine/analyzer/golang/cobra/cobra-context-model')
const {
  GO_CONTEXT_KEY_FIELD,
  GO_CONTEXT_PARENT_FIELD,
  GO_CONTEXT_VALUE_FIELD,
  isSameGoContextKey,
  resolveGoContextValue,
  setGoContextMember,
} = require('../../src/engine/analyzer/golang/common/builtins/go-context-builtins')

type AstNodeLike = {
  type: string
  name?: string
  value?: string
  body?: AstNodeLike[] | { body?: AstNodeLike[] }
  expression?: AstNodeLike
  id?: AstNodeLike
  init?: AstNodeLike
  varType?: AstNodeLike
  returnType?: AstNodeLike
  left?: AstNodeLike
  right?: AstNodeLike
  callee?: AstNodeLike
  argument?: AstNodeLike
  expressions?: AstNodeLike[]
  object?: AstNodeLike
  property?: AstNodeLike
  element?: AstNodeLike
  loc?: { sourcefile: string; start: { line: number }; end: { line: number } }
}

type FindingLike = {
  ruleName?: string
  sinkRule?: string
  trace?: Array<{ tag?: string; affectedNodeName?: string }>
}

type EntryPointCollectorLike = {
  entryPoints: unknown[]
}

type ProcessInstructionAnalyzerLike = EntryPointCollectorLike & {
  processInstruction: (_scope: unknown, node: AstNodeLike) => unknown
}

const SOURCE_FILE = '/tmp/go-cli-taint-checker/main.go'
const ENTRY_FCLOS = {
  vtype: 'fclos',
  ast: { node: { loc: { sourcefile: SOURCE_FILE, start: { line: 1 }, end: { line: 200 } } } },
}
const ENTRY_STATE = { callstack: [ENTRY_FCLOS] }

function loc(line: number): AstNodeLike['loc'] {
  return { sourcefile: SOURCE_FILE, start: { line }, end: { line } }
}

function identifier(name: string, line = 1): AstNodeLike {
  return { type: 'Identifier', name, loc: loc(line) }
}

function member(object: AstNodeLike, propertyName: string, line = 1): AstNodeLike {
  return { type: 'MemberAccess', object, property: identifier(propertyName, line), loc: loc(line) }
}

function call(callee: AstNodeLike, line = 1): AstNodeLike {
  return { type: 'CallExpression', callee, loc: loc(line) }
}

function makeStringValue(name: string): InstanceType<typeof PrimitiveValue> {
  return new PrimitiveValue('', name, name, 'string')
}

function makeChecker(): InstanceType<typeof GoCliTaintChecker> {
  const checker = new GoCliTaintChecker(new ResultManager())
  checker.checkerRuleConfigContent = {
    sources: {},
    sinks: {
      FuncCallTaintSink: [
        { fsig: 'http.NewRequest', calleeType: '', args: ['1'] },
        { fsig: 'exec.CommandContext', calleeType: '', args: ['*'] },
      ],
    },
  }
  return checker
}

function collectFindings(checker: InstanceType<typeof GoCliTaintChecker>): FindingLike[] {
  const findings = checker.resultManager.getFindings()
  return (findings.taintflow || []) as FindingLike[]
}

describe('go-cli-taint-checker source 边界', () => {
  it('Cobra action 入口应识别第二个 args 参数', () => {
    assert.strictEqual(
      isCobraActionEntryPoint({
        functionName: 'RunE',
        entryPointSymVal: { ast: { node: { parameters: [{}, {}] } } },
      }),
      true
    )
  })

  it('Cobra PersistentPreRunE 应作为 action 入口', () => {
    assert.strictEqual(
      isCobraActionEntryPoint({
        functionName: 'PersistentPreRunE',
        entryPointSymVal: { ast: { node: { parameters: [{}, {}] } } },
      }),
      true
    )
  })

  it('非 Cobra 普通单参数函数不应被视为 args source 入口', () => {
    assert.strictEqual(
      isCobraActionEntryPoint({
        functionName: 'helper',
        entryPointSymVal: { ast: { node: { parameters: [{}] } } },
      }),
      false
    )
  })
})

describe('cobra-command-checker entrypoint 边界', () => {
  it('cobra.Command 临时对象 RunE 赋值应收集 entrypoint', () => {
    const checker = new CobraCommandChecker(new ResultManager())
    const cobraCommandValue = { qid: 'github.com/spf13/cobra.Command<instance_tmp45_endtag>', vtype: 'object' }
    const runE = { vtype: 'fclos', ast: { fdef: { loc: loc(38) }, node: { loc: loc(38), id: { name: 'RunE' } } } }
    const analyzer: EntryPointCollectorLike & { processInstruction: (_scope: unknown, node: AstNodeLike) => unknown } = {
      entryPoints: [],
      processInstruction: (_scope: unknown, node: AstNodeLike): unknown => (node.name === 'tmp45' ? cobraCommandValue : undefined),
    }

    checker.triggerAtAssignment(analyzer, null, {
      left: member(identifier('tmp45'), 'RunE', 38),
    }, null, { lvalue: { sid: 'RunE' }, rvalue: runE })

    assert.strictEqual(analyzer.entryPoints.length, 1)
  })

  it('普通临时对象 RunE 赋值不应收集 entrypoint', () => {
    const checker = new CobraCommandChecker(new ResultManager())
    const ordinaryValue = { qid: '<global>.tmp46', vtype: 'object' }
    const runE = { vtype: 'fclos', ast: { fdef: { loc: loc(40) }, node: { loc: loc(40), id: { name: 'RunE' } } } }
    const analyzer: EntryPointCollectorLike & { processInstruction: () => unknown } = {
      entryPoints: [],
      processInstruction: (): unknown => ordinaryValue,
    }

    checker.triggerAtAssignment(analyzer, null, {
      left: member(identifier('tmp46'), 'RunE', 40),
    }, null, { lvalue: { sid: 'RunE' }, rvalue: runE })

    assert.strictEqual(analyzer.entryPoints.length, 0)
  })

  it('未执行的返回 cobra.Command 工厂函数内 RunE 应静态收集 entrypoint', () => {
    const checker = new CobraCommandChecker(new ResultManager())
    const runE = { type: 'FunctionDefinition', loc: loc(52), id: { type: 'Identifier', name: 'RunE' } }
    const runEFClos = { vtype: 'fclos', ast: { fdef: runE, node: runE } }
    const analyzer: ProcessInstructionAnalyzerLike = {
      entryPoints: [],
      processInstruction: (_scope: unknown, node: AstNodeLike): unknown => (node === runE ? runEFClos : undefined),
    }

    checker.triggerAtFunctionDefinition(analyzer, null, {
      type: 'FunctionDefinition',
      returnType: { type: 'PointerType', element: member(identifier('cobra'), 'Command') },
      body: {
        body: [
          {
            type: 'VariableDeclaration',
            id: identifier('tmp48'),
            init: { type: 'NewExpression', callee: member(identifier('cobra'), 'Command') },
          },
          {
            type: 'AssignmentExpression',
            left: member(identifier('tmp48'), 'RunE', 52),
            right: runE,
          },
          { type: 'ReturnStatement', expression: identifier('tmp48') },
        ],
      },
    }, null, { fclos: undefined })

    assert.strictEqual(analyzer.entryPoints.length, 1)
  })

  it('ReferenceExpression 内 Sequence 展开的 cobra.Command RunE 应静态收集 entrypoint', () => {
    const checker = new CobraCommandChecker(new ResultManager())
    const runE = { type: 'FunctionDefinition', loc: loc(72), id: { type: 'Identifier', name: 'RunE' } }
    const runEFClos = { vtype: 'fclos', ast: { fdef: runE, node: runE } }
    const analyzer: ProcessInstructionAnalyzerLike = {
      entryPoints: [],
      processInstruction: (_scope: unknown, node: AstNodeLike): unknown => (node === runE ? runEFClos : undefined),
    }

    checker.triggerAtFunctionDefinition(analyzer, null, {
      type: 'FunctionDefinition',
      returnType: { type: 'PointerType', element: member(identifier('cobra'), 'Command') },
      body: {
        body: [
          {
            type: 'VariableDeclaration',
            id: identifier('cmd'),
            init: {
              type: 'ReferenceExpression',
              argument: {
                type: 'Sequence',
                expressions: [
                  {
                    type: 'VariableDeclaration',
                    id: identifier('tmp45'),
                    init: { type: 'NewExpression', callee: member(identifier('cobra'), 'Command') },
                  },
                  {
                    type: 'AssignmentExpression',
                    left: member(identifier('tmp45'), 'RunE', 72),
                    right: runE,
                  },
                ],
              },
            },
          },
          { type: 'ReturnStatement', argument: identifier('cmd') },
        ],
      },
    }, null, { fclos: undefined })

    assert.strictEqual(analyzer.entryPoints.length, 1)
  })

  it('闭包内部 return nil 不应阻止 factory 返回对象 action 收集', () => {
    const checker = new CobraCommandChecker(new ResultManager())
    const runE = {
      type: 'FunctionDefinition',
      loc: loc(82),
      id: { type: 'Identifier', name: 'RunE' },
      body: { body: [{ type: 'ReturnStatement', argument: identifier('nil') }] },
    }
    const runEFClos = { vtype: 'fclos', ast: { fdef: runE, node: runE } }
    const analyzer: ProcessInstructionAnalyzerLike = {
      entryPoints: [],
      processInstruction: (_scope: unknown, node: AstNodeLike): unknown => (node === runE ? runEFClos : undefined),
    }

    checker.triggerAtFunctionDefinition(analyzer, null, {
      type: 'FunctionDefinition',
      returnType: { type: 'PointerType', element: member(identifier('cobra'), 'Command') },
      body: {
        body: [
          {
            type: 'VariableDeclaration',
            id: identifier('tmp82'),
            init: { type: 'NewExpression', callee: member(identifier('cobra'), 'Command') },
          },
          {
            type: 'AssignmentExpression',
            left: member(identifier('tmp82'), 'RunE', 82),
            right: runE,
          },
          { type: 'ReturnStatement', expression: identifier('tmp82') },
        ],
      },
    }, null, { fclos: undefined })

    assert.strictEqual(analyzer.entryPoints.length, 1)
  })

  it('ReferenceExpression 内未返回的 cobra.Command RunE 不应静态收集 entrypoint', () => {
    const checker = new CobraCommandChecker(new ResultManager())
    const runE = { type: 'FunctionDefinition', loc: loc(92), id: { type: 'Identifier', name: 'RunE' } }
    const analyzer: ProcessInstructionAnalyzerLike = {
      entryPoints: [],
      processInstruction: (): unknown => ({ vtype: 'fclos', ast: { fdef: runE, node: runE } }),
    }

    checker.triggerAtFunctionDefinition(analyzer, null, {
      type: 'FunctionDefinition',
      returnType: { type: 'PointerType', element: member(identifier('cobra'), 'Command') },
      body: {
        body: [
          {
            type: 'VariableDeclaration',
            id: identifier('other'),
            init: {
              type: 'ReferenceExpression',
              argument: {
                type: 'Sequence',
                expressions: [
                  {
                    type: 'VariableDeclaration',
                    id: identifier('tmp92'),
                    init: { type: 'NewExpression', callee: member(identifier('cobra'), 'Command') },
                  },
                  {
                    type: 'AssignmentExpression',
                    left: member(identifier('tmp92'), 'RunE', 92),
                    right: runE,
                  },
                ],
              },
            },
          },
          { type: 'ReturnStatement', argument: identifier('cmd') },
        ],
      },
    }, null, { fclos: undefined })

    assert.strictEqual(analyzer.entryPoints.length, 0)
  })

  it('返回 cobra.Command 工厂函数内普通临时对象 RunE 不应静态收集 entrypoint', () => {
    const checker = new CobraCommandChecker(new ResultManager())
    const runE = { type: 'FunctionDefinition', loc: loc(62), id: { type: 'Identifier', name: 'RunE' } }
    const analyzer: ProcessInstructionAnalyzerLike = {
      entryPoints: [],
      processInstruction: (): unknown => ({ vtype: 'fclos', ast: { fdef: runE, node: runE } }),
    }

    checker.triggerAtFunctionDefinition(analyzer, null, {
      type: 'FunctionDefinition',
      returnType: { type: 'PointerType', element: member(identifier('cobra'), 'Command') },
      body: {
        body: [
          {
            type: 'VariableDeclaration',
            id: identifier('ordinary'),
            init: { type: 'NewExpression', callee: identifier('Handler') },
          },
          {
            type: 'AssignmentExpression',
            left: member(identifier('ordinary'), 'RunE', 62),
            right: runE,
          },
        ],
      },
    }, null, { fclos: undefined })

    assert.strictEqual(analyzer.entryPoints.length, 0)
  })
})


describe('go cobra context 模型边界', () => {
  function cobraReceiver(name: string): unknown {
    return {
      qid: `<global>.${name}`,
      sid: name,
      vtype: 'object',
      rtype: { definiteType: '*github.com/spf13/cobra.Command' },
      misc_: {},
    }
  }

  it('SetContext 应返回 undefined-like value 而不是 payload', () => {
    const analyzer = { processInstruction: (): unknown => undefined }
    const payload = { sid: 'payload', vtype: 'object' }
    const ret = processCobraContextCall({
      analyzer,
      scope: { qid: '<global>' },
      node: call(member(identifier('cmd'), 'SetContext')),
      state: { pcond: [], callstack: [], brs: '', binfo: {}, einfo: {} },
      fclos: undefined,
      argvalues: [payload],
      methodName: 'SetContext',
      receiver: cobraReceiver('root'),
    })

    assert.strictEqual(ret?.vtype, 'undefine')
    assert.notStrictEqual(ret, payload)
  })

  it('两个 Cobra receiver 的 Context fallback 应互相隔离', () => {
    const analyzer = { processInstruction: (): unknown => undefined }
    const scope = { qid: '<global>' }
    const state = { pcond: [], callstack: [], brs: '', binfo: {}, einfo: {} }
    const rootPayload = { sid: 'rootPayload', vtype: 'object' }
    const childPayload = { sid: 'childPayload', vtype: 'object' }
    const rootSetter = cobraReceiver('root')
    const childSetter = cobraReceiver('child')
    const rootLookup = cobraReceiver('root')
    const childLookup = cobraReceiver('child')

    processCobraContextCall({ analyzer, scope, node: call(member(identifier('cmd'), 'SetContext')), state, fclos: undefined, argvalues: [rootPayload], methodName: 'SetContext', receiver: rootSetter })
    processCobraContextCall({ analyzer, scope, node: call(member(identifier('cmd'), 'SetContext')), state, fclos: undefined, argvalues: [childPayload], methodName: 'SetContext', receiver: childSetter })

    assert.strictEqual(processCobraContextCall({ analyzer, scope, node: call(member(identifier('cmd'), 'Context')), state, fclos: undefined, argvalues: [], methodName: 'Context', receiver: rootLookup }), rootPayload)
    assert.strictEqual(processCobraContextCall({ analyzer, scope, node: call(member(identifier('cmd'), 'Context')), state, fclos: undefined, argvalues: [], methodName: 'Context', receiver: childLookup }), childPayload)
  })

  it('processGoFrameworkCall 遇到非框架方法不应求值 member receiver', () => {
    let receiverEvaluations = 0
    const analyzer = {
      processInstruction: (): unknown => {
        receiverEvaluations += 1
        return { sid: 'receiver' }
      },
    }

    const ret = processGoFrameworkCall({
      analyzer,
      scope: { qid: '<global>' },
      node: call(member(identifier('fmt'), 'Printf'), 12),
      state: { pcond: [], callstack: [], brs: '', binfo: {}, einfo: {} },
      fclos: undefined,
      argvalues: [],
    })

    assert.strictEqual(ret, null)
    assert.strictEqual(receiverEvaluations, 0)
  })
})

describe('go-cli-taint-checker 端到端 finding', function () {
  beforeEach(() => {
    Config.entryPointMode = 'BOTH'
    BasicRuleHandler.setPreprocessReady(true)
  })

  it('StringVar 绑定变量传播到 http.NewRequest URL 参数', function () {
    const checker = makeChecker()
    const baseURL = makeStringValue('baseURL')

    checker.triggerAtFunctionCallBefore(null, null, call(member(identifier('flags'), 'StringVar'), 10), null, {
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: baseURL, kind: 'positional' },
            { index: 1, value: makeStringValue('base-url'), kind: 'positional' },
            { index: 2, value: makeStringValue(''), kind: 'positional' },
            { index: 3, value: makeStringValue('target URL'), kind: 'positional' },
          ],
        },
      },
    })

    checker.triggerAtFunctionCallBefore(null, null, call(member(identifier('http'), 'NewRequest'), 20), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('GET'), kind: 'positional' },
            { index: 1, value: baseURL, kind: 'positional' },
            { index: 2, value: makeStringValue('nil'), kind: 'positional' },
          ],
        },
      },
    })

    const findings = collectFindings(checker)
    assert.strictEqual(findings.length, 1)
    assert.ok(findings[0].ruleName?.includes('http.NewRequest'))
    assert.ok(findings[0].trace?.some((item) => item.tag === 'SOURCE: ' && item.affectedNodeName?.includes('StringVar')))
  })

  it('Cobra args 参数传播到 exec.CommandContext 参数', function () {
    const checker = makeChecker()
    const argsValue = makeStringValue('args')
    const argsParam = identifier('args', 5)

    checker.triggerAtSymbolInterpretOfEntryPointBefore(
      { processInstruction: () => argsValue },
      null,
      null,
      null,
      { entryPoint: { functionName: 'RunE', entryPointSymVal: { ast: { node: { parameters: [identifier('cmd', 5), argsParam] } } } } }
    )

    checker.triggerAtFunctionCallBefore(null, null, call(member(identifier('exec'), 'CommandContext'), 30), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('ctx'), kind: 'positional' },
            { index: 1, value: makeStringValue('curl'), kind: 'positional' },
            { index: 2, value: argsValue, kind: 'positional' },
          ],
        },
      },
    })

    const findings = collectFindings(checker)
    assert.strictEqual(findings.length, 1)
    assert.ok(findings[0].ruleName?.includes('exec.CommandContext'))
  })

  it('os.Args 传播到 exec.CommandContext 参数', function () {
    const checker = makeChecker()
    const osArgsValue = makeStringValue('os.Args')

    checker.triggerAtMemberAccess(null, null, member(identifier('os'), 'Args', 8), null, { res: osArgsValue })
    checker.triggerAtFunctionCallBefore(null, null, call(member(identifier('exec'), 'CommandContext'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('ctx'), kind: 'positional' },
            { index: 1, value: makeStringValue('curl'), kind: 'positional' },
            { index: 2, value: osArgsValue, kind: 'positional' },
          ],
        },
      },
    })

    const findings = collectFindings(checker)
    assert.strictEqual(findings.length, 1)
    assert.ok(findings[0].ruleName?.includes('exec.CommandContext'))
  })
})


describe('go context key matching 边界', () => {
  function keyValue(typeName: string, qid: string): unknown {
    return { qid, sid: qid.split('.').at(-1), rtype: { definiteType: { name: typeName } } }
  }

  it('同一 Go context key 类型的不同 instance 应匹配', () => {
    const stored = keyValue('quotonestop/pkg/cmd.contextKey<instance_root_50_endtag>', 'root.contextKey<instance_root_50_endtag>')
    const lookup = keyValue('quotonestop/pkg/cmd.contextKey<instance_root_69_endtag>', 'root.contextKey<instance_root_69_endtag>')

    assert.strictEqual(isSameGoContextKey(stored, lookup), true)
  })

  it('不同 Go context key 类型不应匹配', () => {
    const stored = keyValue('quotonestop/pkg/cmd.contextKey<instance_root_50_endtag>', 'root.contextKey<instance_root_50_endtag>')
    const lookup = keyValue('quotonestop/pkg/cmd.otherContextKey<instance_root_69_endtag>', 'root.otherContextKey<instance_root_69_endtag>')

    assert.strictEqual(isSameGoContextKey(stored, lookup), false)
  })

  it('当前 key 命中时应优先返回 current payload 而不是 parent', () => {
    const parentPayload = { sid: 'parentPayload' }
    const currentPayload = { sid: 'currentPayload' }
    const parentCtx = { misc_: {} }
    const currentCtx = { misc_: {} }
    const key = keyValue('quotonestop/pkg/cmd.contextKey<instance_root_50_endtag>', 'root.contextKey<instance_root_50_endtag>')
    const lookup = keyValue('quotonestop/pkg/cmd.contextKey<instance_root_69_endtag>', 'root.contextKey<instance_root_69_endtag>')

    setGoContextMember(parentCtx, GO_CONTEXT_KEY_FIELD, key)
    setGoContextMember(parentCtx, GO_CONTEXT_VALUE_FIELD, parentPayload)
    setGoContextMember(currentCtx, GO_CONTEXT_PARENT_FIELD, parentCtx)
    setGoContextMember(currentCtx, GO_CONTEXT_KEY_FIELD, lookup)
    setGoContextMember(currentCtx, GO_CONTEXT_VALUE_FIELD, currentPayload)

    assert.strictEqual(resolveGoContextValue(currentCtx, key), currentPayload)
  })
})
