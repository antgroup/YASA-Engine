import * as assert from 'assert'
import { describe, it } from 'mocha'

const TornadoEntryPoint = require('../../src/engine/analyzer/python/tornado/entrypoint-collector/tornado-entrypoint')
const { isPreparedBodyRead } = require('../../src/checker/taint/python/tornado-util')

type AstNode = {
  type: string
  name?: string
  object?: AstNode
  property?: AstNode
  callee?: AstNode
  arguments?: AstNode[]
  left?: AstNode
  right?: AstNode
  operator?: string
  id?: AstNode
  body?: AstNode[]
  expression?: AstNode
}

function selfAttribute(name: string): AstNode {
  return { type: 'MemberAccess', object: { type: 'Identifier', name: 'self' }, property: { type: 'Identifier', name } }
}

function requestBody(): AstNode {
  return {
    type: 'MemberAccess',
    object: { type: 'MemberAccess', object: { type: 'Identifier', name: 'self' }, property: { type: 'Identifier', name: 'request' } },
    property: { type: 'Identifier', name: 'body' },
  }
}

function call(callee: AstNode, ...arguments_: AstNode[]): AstNode {
  return { type: 'CallExpression', callee, arguments: arguments_ }
}

function method(name: string, body: AstNode[]): AstNode {
  return { type: 'FunctionDefinition', id: { type: 'Identifier', name }, body }
}

function assignment(left: AstNode, right: AstNode): AstNode {
  return { type: 'AssignmentExpression', operator: '=', left, right }
}

function expressionStatement(expression: AstNode): AstNode {
  return { type: 'ExpressionStatement', expression }
}

function handler(methods: AstNode[]): AstNode {
  return { type: 'ClassDefinition', body: methods }
}

describe('Tornado prepare request body provenance', () => {
  it('registers only non-prepare reads of attributes derived from request.body', () => {
    const postRead = selfAttribute('json_args')
    const prepareRead = selfAttribute('json_args')
    const classNode = handler([
      method('prepare', [assignment(selfAttribute('json_args'), call({ type: 'MemberAccess', object: { type: 'Identifier', name: 'json' }, property: { type: 'Identifier', name: 'loads' } }, requestBody())), prepareRead]),
      method('post', [postRead]),
    ])

    TornadoEntryPoint._testOnly.registerPreparedBodyAttributeReads(classNode)

    assert.strictEqual(isPreparedBodyRead(postRead), true)
    assert.strictEqual(isPreparedBodyRead(prepareRead), false)
  })

  it('accepts decode chains from request.body', () => {
    const postRead = selfAttribute('payload')
    const classNode = handler([
      method('prepare', [assignment(selfAttribute('payload'), call({ type: 'MemberAccess', object: requestBody(), property: { type: 'Identifier', name: 'decode' } }))]),
      method('post', [postRead]),
    ])

    TornadoEntryPoint._testOnly.registerPreparedBodyAttributeReads(classNode)

    assert.strictEqual(isPreparedBodyRead(postRead), true)
  })

  it('honors the final top-level assignment for every prepared attribute', () => {
    const overwrittenObjectRead = selfAttribute('object_payload')
    const overwrittenJsonRead = selfAttribute('json_payload')
    const retainedBodyRead = selfAttribute('body_payload')
    const classNode = handler([
      method('prepare', [
        expressionStatement(assignment(selfAttribute('object_payload'), requestBody())),
        assignment(selfAttribute('object_payload'), { type: 'ObjectExpression' }),
        assignment(selfAttribute('json_payload'), requestBody()),
        assignment(selfAttribute('json_payload'), call({ type: 'MemberAccess', object: { type: 'Identifier', name: 'json' }, property: { type: 'Identifier', name: 'loads' } }, { type: 'Identifier', name: 'config_text' })),
        assignment(selfAttribute('body_payload'), { type: 'Literal', name: 'None' }),
        assignment(selfAttribute('body_payload'), requestBody()),
      ]),
      method('post', [overwrittenObjectRead, overwrittenJsonRead, retainedBodyRead]),
    ])

    TornadoEntryPoint._testOnly.registerPreparedBodyAttributeReads(classNode)

    assert.strictEqual(isPreparedBodyRead(overwrittenObjectRead), false)
    assert.strictEqual(isPreparedBodyRead(overwrittenJsonRead), false)
    assert.strictEqual(isPreparedBodyRead(retainedBodyRead), true)
  })

  it('does not register reads inside nested lexical scopes', () => {
    const nestedFunctionRead = selfAttribute('payload')
    const nestedLambdaRead = selfAttribute('payload')
    const directRead = selfAttribute('payload')
    const classNode = handler([
      method('prepare', [assignment(selfAttribute('payload'), requestBody())]),
      method('post', [
        { type: 'FunctionDefinition', id: { type: 'Identifier', name: 'helper' }, body: [nestedFunctionRead] },
        { type: 'LambdaExpression', expression: nestedLambdaRead },
        directRead,
      ]),
    ])

    TornadoEntryPoint._testOnly.registerPreparedBodyAttributeReads(classNode)

    assert.strictEqual(isPreparedBodyRead(nestedFunctionRead), false)
    assert.strictEqual(isPreparedBodyRead(nestedLambdaRead), false)
    assert.strictEqual(isPreparedBodyRead(directRead), true)
  })

  it('ignores assignments inside control flow and attributes from sibling classes', () => {
    const conditionalRead = selfAttribute('json_args')
    const reassignment = selfAttribute('payload')
    const siblingRead = selfAttribute('json_args')
    const classNode = handler([
      method('prepare', [
        { type: 'IfStatement', body: [assignment(selfAttribute('json_args'), requestBody())] },
        assignment(selfAttribute('payload'), requestBody()),
      ]),
      method('post', [conditionalRead, assignment(reassignment, { type: 'Literal', name: 'None' })]),
    ])
    const siblingClass = handler([method('post', [siblingRead])])

    TornadoEntryPoint._testOnly.registerPreparedBodyAttributeReads(classNode)
    TornadoEntryPoint._testOnly.registerPreparedBodyAttributeReads(siblingClass)

    assert.strictEqual(isPreparedBodyRead(conditionalRead), false)
    assert.strictEqual(isPreparedBodyRead(reassignment), false)
    assert.strictEqual(isPreparedBodyRead(siblingRead), false)
  })
})
