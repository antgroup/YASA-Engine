import * as assert from 'assert'
import { describe, it } from 'mocha'

const JavaAnalyzer = require('../../src/engine/analyzer/java/common/java-analyzer') as { prototype: object }

type FieldNode = {
  type: 'VariableDeclaration'
  varType: { type: 'Identifier'; id: { name: string } }
}

type Resolver = {
  classMap: Map<string, string>
  topScope: { context: { packages: Map<string, unknown> } }
  resolveClassFieldDeclaredType(scope: unknown, fieldName: string, fieldValue: unknown): string | undefined
}

function createResolver(): Resolver {
  const analyzer = Object.create(JavaAnalyzer.prototype) as Resolver
  analyzer.classMap = new Map()
  analyzer.topScope = { context: { packages: new Map() } }
  return analyzer
}

describe('Java class field declared type resolution', function () {
  it('returns undefined when both field declaration sources are missing', function () {
    const analyzer = createResolver()

    assert.doesNotThrow(() => {
      assert.strictEqual(analyzer.resolveClassFieldDeclaredType({}, 'missingField', undefined), undefined)
    })
  })

  it('preserves the declared type from a valid field node', function () {
    const analyzer = createResolver()
    analyzer.classMap.set('Payload', 'payload-class')
    const fieldNode: FieldNode = {
      type: 'VariableDeclaration',
      varType: { type: 'Identifier', id: { name: 'Payload' } },
    }
    const fieldValue = { ast: { node: fieldNode } }

    assert.strictEqual(analyzer.resolveClassFieldDeclaredType({}, 'payload', fieldValue), 'Payload')
  })
})
