import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it } from 'mocha'

const JavaAnalyzer = require('../../src/engine/analyzer/java/common/java-analyzer')
const Config = require('../../src/config')
const AstUtil = require('../../src/util/ast-util')

type Invocation = {
  callSiteLiteral: string
  calleeType: string
  fsig: string
}

type JavaAnalyzerInstance = {
  preProcess(dir: string): Promise<void>
  funcSymbolTable: Record<string, JavaFunctionValue>
  processInstruction(scope: unknown, node: unknown, state: TypeResolverState): unknown
  initState(scope: unknown): TypeResolverState
  typeResolver: { resolveInstruction(analyzer: unknown, scope: unknown, node: unknown, state: TypeResolverState): unknown }
}

type CallExpressionNode = {
  type?: string
  callee: {
    type?: string
    object?: { type?: string; name?: string }
    property?: { type?: string; name?: string }
  }
}

type JavaFunctionValue = {
  ast: { node: { body: { body: Array<CallExpressionNode | unknown> } } }
  invocationMap?: Map<string, Invocation[]>
}

type TypeResolverState = {
  nodeScope?: unknown
  nodeScopeAst?: unknown
}

type ReceiverValue = {
  _this?: { rtype?: { definiteType?: unknown } }
}

type ReceiverProbe = {
  invocationCalleeTypes: string[]
  receiverType: string
  selectedCall: string
  resolvedFclosQid?: string
  resolvedFclosBodyType?: string
  resolvedFclosHasBody: boolean
}

type SelectedCall = {
  call: CallExpressionNode
  index: number
}

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function collectInvocationCalleeTypes(method: JavaFunctionValue): string[] {
  if (!(method.invocationMap instanceof Map)) return []
  const calleeTypes: string[] = []
  for (const invocationArray of method.invocationMap.values()) {
    for (const invocation of invocationArray) {
      calleeTypes.push(invocation.calleeType)
    }
  }
  return calleeTypes
}

function findStaticClientFetchCall(method: JavaFunctionValue): SelectedCall {
  const statements = method.ast.node.body.body
  for (let index = statements.length - 1; index >= 0; index--) {
    const statement = statements[index] as CallExpressionNode
    if (
      statement.type === 'CallExpression' &&
      statement.callee?.type === 'MemberAccess' &&
      statement.callee.object?.name === 'StaticClient' &&
      statement.callee.property?.name === 'fetch'
    ) {
      return { call: statement, index }
    }
  }
  throw new Error('StaticClient.fetch call not found')
}

async function analyzeDemo(demoSource: string): Promise<ReceiverProbe> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-java-import-receiver-'))
  writeFile(root, 'lib/StaticClient.java', 'package lib; public class StaticClient { public static String fetch(String url){ return url; } }')
  writeFile(root, 'app/Demo.java', demoSource)

  Config.maindirPrefix = root
  const analyzer = new JavaAnalyzer({
    language: 'java',
    sourcePath: root,
    uastSDKPath: path.resolve(__dirname, '../../deps'),
    checkerIds: [],
    checkerPackIds: [],
    printers: [],
  }) as JavaAnalyzerInstance
  await analyzer.preProcess(root)

  const demoMethod = analyzer.funcSymbolTable['app.Demo.m']
  const selected = findStaticClientFetchCall(demoMethod)
  const state = analyzer.initState(demoMethod)
  state.nodeScope = demoMethod
  state.nodeScopeAst = demoMethod.ast.node
  for (const statement of demoMethod.ast.node.body.body.slice(0, selected.index + 1)) {
    analyzer.typeResolver.resolveInstruction(analyzer, demoMethod, statement, state)
    analyzer.processInstruction(demoMethod, statement, analyzer.initState(demoMethod))
  }
  const receiver = analyzer.processInstruction(demoMethod, selected.call.callee, analyzer.initState(demoMethod)) as ReceiverValue
  const resolvedCallee = analyzer.processInstruction(demoMethod, selected.call.callee, analyzer.initState(demoMethod)) as {
    qid?: string
    vtype?: string
    ast?: { fdef?: { body?: { type?: string; body?: unknown[] } } }
  }
  const fdefBody = resolvedCallee?.ast?.fdef?.body
  return {
    invocationCalleeTypes: collectInvocationCalleeTypes(demoMethod),
    receiverType: AstUtil.prettyPrint(receiver._this?.rtype?.definiteType),
    selectedCall: `${selected.call.callee.object?.name}.${selected.call.callee.property?.name}`,
    resolvedFclosQid: typeof resolvedCallee?.qid === 'string' ? resolvedCallee.qid : undefined,
    resolvedFclosBodyType: typeof fdefBody?.type === 'string' ? fdefBody.type : undefined,
    resolvedFclosHasBody: !!fdefBody && fdefBody.type !== 'Noop' && Array.isArray(fdefBody.body) && fdefBody.body.length > 0,
  }
}

describe('Java import receiver lifting', function () {
  it('exposes imported class receiver through invocation calleeType', async function () {
    const result = await analyzeDemo(
      'package app; import lib.StaticClient; public class Demo { void m(String url){ StaticClient.fetch(url); } }'
    )

    assert.strictEqual(result.selectedCall, 'StaticClient.fetch')
    assert.ok(result.invocationCalleeTypes.includes('lib.StaticClient'))
    assert.strictEqual(result.receiverType, 'lib.StaticClient')
  })

  it('keeps local variable shadowing ahead of import fallback', async function () {
    const result = await analyzeDemo(
      'package app; import lib.StaticClient; public class Demo { void m(String url){ String StaticClient = url; StaticClient.fetch(url); } }'
    )

    assert.strictEqual(result.selectedCall, 'StaticClient.fetch')
    assert.ok(!result.invocationCalleeTypes.includes('lib.StaticClient'))
    assert.strictEqual(result.receiverType, 'String')
    // 局部变量遮蔽时，receiver 不会被识别为 import 类，fclos 也不应被重定向到 lib.StaticClient.fetch 真方法符号。
    assert.ok(!result.resolvedFclosHasBody)
  })

  it('redirects fclos to imported static class member when classMap has real method body', async function () {
    const result = await analyzeDemo(
      'package app; import lib.StaticClient; public class Demo { void m(String url){ StaticClient.fetch(url); } }'
    )

    assert.strictEqual(result.selectedCall, 'StaticClient.fetch')
    // dispatcher 用 fclos.ast.fdef 决定是否进入函数体；重定向后 body 应为真实 BlockStatement 且非空。
    assert.ok(result.resolvedFclosHasBody, `expected real fclos body, got body type=${result.resolvedFclosBodyType ?? 'undefined'}`)
    assert.ok(
      typeof result.resolvedFclosQid === 'string' && result.resolvedFclosQid.includes('lib.StaticClient'),
      `expected fclos qid bound to lib.StaticClient, got ${result.resolvedFclosQid ?? 'undefined'}`
    )
    // qid 末段必须是被调静态方法符号，而非块级合成前缀
    assert.ok(
      result.resolvedFclosQid?.endsWith('.fetch'),
      `expected fclos qid to end with .fetch, got ${result.resolvedFclosQid ?? 'undefined'}`
    )
  })
})
