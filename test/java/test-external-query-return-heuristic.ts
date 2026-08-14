import { createRequire } from 'module'

const requireFromTest: NodeRequire = createRequire(__filename)

declare function describe(name: string, fn: () => void): void
declare function it(name: string, fn: () => void): void

type JavaAnalyzerTestHooks = {
  javaReturnExpressionReferencesExternalQueryResult: (fdef: unknown) => boolean
  javaReturnExpressionReferencesParameter: (fdef: unknown) => boolean
}

const JavaAnalyzer = requireFromTest(
  '../../src/engine/analyzer/java/common/java-analyzer',
) as { __javaAnalyzerTestHooks: JavaAnalyzerTestHooks }
const javaAnalyzerWithHooks = JavaAnalyzer as { __javaAnalyzerTestHooks: JavaAnalyzerTestHooks }
const { javaReturnExpressionReferencesExternalQueryResult, javaReturnExpressionReferencesParameter } =
  javaAnalyzerWithHooks.__javaAnalyzerTestHooks

function assertStrictEqual(actual: boolean, expected: boolean): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`)
  }
}

type TestAstNode = {
  type: string
  name?: string
  object?: TestAstNode
  property?: TestAstNode
  callee?: TestAstNode
  arguments?: TestAstNode[]
  id?: TestAstNode
  init?: TestAstNode
  argument?: TestAstNode
  parameters?: TestAstNode[]
  body?: TestAstNode[] | TestAstNode
}

function id(name: string): TestAstNode {
  return { type: 'Identifier', name }
}

function member(objectName: string, propertyName: string): TestAstNode {
  return { type: 'MemberAccess', object: id(objectName), property: id(propertyName) }
}

function call(objectName: string, methodName: string, args: TestAstNode[] = []): TestAstNode {
  return { type: 'FunctionCall', callee: member(objectName, methodName), arguments: args }
}

function variable(name: string, init: TestAstNode): TestAstNode {
  return { type: 'VariableDeclaration', id: id(name), init }
}

function ret(argument: TestAstNode): TestAstNode {
  return { type: 'ReturnStatement', argument }
}

function fdef(body: TestAstNode[]): TestAstNode {
  return { type: 'FunctionDefinition', parameters: [id('productId')], body: { type: 'ScopedStatement', body } }
}

describe('Java external query return heuristic', () => {
  it('matches storage query result field returned from parameter-derived key', () => {
    const node = fdef([
      variable('rowKey', call('DigestUtils', 'md5Hex', [id('productId')])),
      variable('archive', call('lindormTableServiceAdapter', 'getData', [id('rowKey')])),
      ret(call('archive', 'getProfilePath')),
    ])

    assertStrictEqual(javaReturnExpressionReferencesExternalQueryResult(node), true)
  })

  it('does not match ordinary helper return derived from parameter', () => {
    const node = fdef([
      variable('key', call('DigestUtils', 'md5Hex', [id('productId')])),
      variable('dto', call('helper', 'buildDto', [id('key')])),
      ret(call('dto', 'getProfilePath')),
    ])

    assertStrictEqual(javaReturnExpressionReferencesExternalQueryResult(node), false)
  })

  it('ignores nested function returns when judging the outer method', () => {
    const nested: TestAstNode = {
      type: 'FunctionDefinition',
      parameters: [],
      body: {
        type: 'ScopedStatement',
        body: [
          variable('archive', call('lindormTableServiceAdapter', 'getData', [id('productId')])),
          ret(call('archive', 'getProfilePath')),
        ],
      },
    }
    const node = fdef([nested, ret(id('productId'))])

    assertStrictEqual(javaReturnExpressionReferencesExternalQueryResult(node), false)
  })

  it('ignores nested parameter returns for ordinary outer member calls', () => {
    const nested: TestAstNode = {
      type: 'FunctionDefinition',
      parameters: [],
      body: { type: 'ScopedStatement', body: [ret(id('productId'))] },
    }
    const node = fdef([
      nested,
      variable('dto', call('helper', 'buildDto', [id('productId')])),
      ret(call('dto', 'getProfilePath')),
    ])

    assertStrictEqual(javaReturnExpressionReferencesParameter(node), false)
    assertStrictEqual(javaReturnExpressionReferencesExternalQueryResult(node), false)
  })
})
