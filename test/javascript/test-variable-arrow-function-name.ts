import { describe, it } from 'mocha'
import * as assert from 'assert'
import { Scoped } from '../../src/engine/analyzer/common/value/scoped'

const ASTUtil = require('../../src/util/ast-util') as {
  annotateAST(node: unknown, options?: { skipSourcefile?: boolean }): void
}
const Scope = require('../../src/engine/analyzer/common/scope') as new () => {
  createFuncScope(node: unknown, scope: Scoped): Scoped
}

type Location = {
  start: { line: number; column: number }
  end: { line: number; column: number }
}

type FunctionNode = {
  type: 'FunctionDefinition'
  id: null
  loc: Location
  parameters: unknown[]
  body: { type: 'ScopedStatement'; body: unknown[]; loc: Location; _meta: Record<string, never> }
  _meta: Record<string, never>
  name?: string
  parent?: unknown
}

function loc(line: number, column: number): Location {
  return {
    start: { line, column },
    end: { line: line + 1, column: 0 },
  }
}

function anonymousFunction(line: number, column: number): FunctionNode {
  return {
    type: 'FunctionDefinition',
    id: null,
    loc: loc(line, column),
    parameters: [],
    body: { type: 'ScopedStatement', body: [], loc: loc(line, column + 1), _meta: {} },
    _meta: {},
  }
}

describe('JavaScript variable arrow function names', () => {
  it('uses the variable name for a direct initializer and preserves callback anonymity', () => {
    const namedFunction = anonymousFunction(42, 28)
    const callbackFunction = anonymousFunction(60, 18)
    const root = {
      type: 'CompileUnit',
      body: [
        {
          type: 'VariableDeclaration',
          id: { type: 'Identifier', name: 'chineseName', loc: loc(42, 14), _meta: {} },
          init: namedFunction,
          loc: loc(42, 0),
          _meta: {},
        },
        {
          type: 'ExpressionStatement',
          expression: {
            type: 'CallExpression',
            callee: { type: 'Identifier', name: 'consume', loc: loc(60, 0), _meta: {} },
            arguments: [callbackFunction],
            loc: loc(60, 0),
            _meta: {},
          },
          loc: loc(60, 0),
          _meta: {},
        },
      ],
      loc: loc(1, 0),
      _meta: {},
    }

    ASTUtil.annotateAST(root, { skipSourcefile: true })

    assert.strictEqual(namedFunction.name, 'chineseName')
    assert.strictEqual(callbackFunction.name, '<anonymousFunc_60_18_61_0>')

    const scope = new Scoped({ sid: 'module', qid: 'module', parent: null, decls: {} })
    const scopeCreator = new Scope()
    const namedClosure = scopeCreator.createFuncScope(namedFunction, scope)
    const callbackClosure = scopeCreator.createFuncScope(callbackFunction, scope)

    assert.strictEqual(namedClosure.sid, 'chineseName')
    assert.strictEqual(namedClosure.qid, 'module.chineseName')
    assert.strictEqual(callbackClosure.sid, '<anonymousFunc_60_18_61_0>')
    assert.strictEqual(callbackClosure.qid, 'module.<anonymousFunc_60_18_61_0>')
  })
})
