import * as assert from 'assert'
import { describe, it } from 'mocha'

import { buildEntryPointAnalysisKey, markEntryPointForAnalysis } from '../src/util/entrypoint-metrics'
import { createAnalyzerMemoryOverlay } from '../src/engine/analyzer/common/analyzer-memory-overlay'
import { ValueRefMap, type ValueRegistry } from '../src/engine/analyzer/common/value/value-ref-map'
import { ValueRef } from '../src/engine/analyzer/common/value/value-ref'

const FUNCALL_TYPE = 'funcall'
const FILE_BEGIN_TYPE = 'fileBegin'

interface TestLoc {
  sourcefile: string
  start: { line: number; column: number }
  end: { line: number; column: number }
}

interface TestReceiver {
  logicalQid?: string
  qid?: string
  vtype?: string
  loc?: TestLoc
}

interface TestEntrypoint {
  type: string
  filePath: string
  functionName: string
  attribute: string
  scopeVal?: { uuid: string }
  entryPointSymVal: {
    qid: string
    ast: { node: { loc: TestLoc } }
    _this?: TestReceiver
  }
}

function loc(sourcefile: string, line: number): TestLoc {
  return {
    sourcefile,
    start: { line, column: 1 },
    end: { line, column: 20 },
  }
}

function makeEntrypoint(receiver?: TestReceiver, qid = 'handler'): TestEntrypoint {
  const entrypoint: TestEntrypoint = {
    type: FUNCALL_TYPE,
    filePath: 'src/routes/user.ts',
    functionName: 'handle',
    attribute: 'GET /user',
    entryPointSymVal: {
      qid,
      ast: { node: { loc: loc('src/routes/user.ts', 10) } },
    },
  }
  if (receiver) entrypoint.entryPointSymVal._this = receiver
  return entrypoint
}

describe('buildEntryPointAnalysisKey param0 shape', () => {
  it('distinguishes same runtime location with different param0 shapes', () => {
    const serviceA = makeEntrypoint({ logicalQid: 'ServiceA', vtype: 'Object' })
    const serviceB = makeEntrypoint({ logicalQid: 'ServiceB', vtype: 'Object' })

    assert.notStrictEqual(
      buildEntryPointAnalysisKey(serviceA, FUNCALL_TYPE, FILE_BEGIN_TYPE),
      buildEntryPointAnalysisKey(serviceB, FUNCALL_TYPE, FILE_BEGIN_TYPE),
    )
  })

  it('does not split clone-only qid differences in param0 shape', () => {
    const base = makeEntrypoint({ qid: 'Service<cloned_a_endtag>', vtype: 'Object' })
    const clone = makeEntrypoint({ qid: 'Service<cloned_b_endtag>', vtype: 'Object' })

    assert.strictEqual(
      buildEntryPointAnalysisKey(base, FUNCALL_TYPE, FILE_BEGIN_TYPE),
      buildEntryPointAnalysisKey(clone, FUNCALL_TYPE, FILE_BEGIN_TYPE),
    )
  })

  it('uses one stable marker when param0 is absent', () => {
    assert.strictEqual(
      buildEntryPointAnalysisKey(makeEntrypoint(undefined, 'handlerA'), FUNCALL_TYPE, FILE_BEGIN_TYPE),
      buildEntryPointAnalysisKey(makeEntrypoint(undefined, 'handlerB'), FUNCALL_TYPE, FILE_BEGIN_TYPE),
    )
  })

  it('ignores scopeVal instance identity when explicit param0 is absent', () => {
    const first = makeEntrypoint(undefined, 'handlerA')
    const second = makeEntrypoint(undefined, 'handlerB')
    first.scopeVal = { uuid: 'symuuid_scope_a' }
    second.scopeVal = { uuid: 'symuuid_scope_b' }

    const firstKey = buildEntryPointAnalysisKey(first, FUNCALL_TYPE, FILE_BEGIN_TYPE)
    const secondKey = buildEntryPointAnalysisKey(second, FUNCALL_TYPE, FILE_BEGIN_TYPE)

    assert.strictEqual(firstKey, secondKey)
    assert.ok(firstKey.includes('<no-param0>'))
  })

  it('remembers runtime entrypoints before rule duplicates are checked', () => {
    const analyzedEntryPointKeys = new Set<string>()
    const runtimeEntrypoint = makeEntrypoint(undefined, 'handlerA')
    const ruleDuplicate = makeEntrypoint(undefined, 'handlerB')

    const runtimeMark = markEntryPointForAnalysis(
      runtimeEntrypoint,
      analyzedEntryPointKeys,
      FUNCALL_TYPE,
      FILE_BEGIN_TYPE
    )
    const ruleMark = markEntryPointForAnalysis(
      ruleDuplicate,
      analyzedEntryPointKeys,
      FUNCALL_TYPE,
      FILE_BEGIN_TYPE
    )

    assert.strictEqual(runtimeMark.skipped, false)
    assert.strictEqual(ruleMark.skipped, true)
    assert.strictEqual(ruleMark.skipReason, 'duplicate-runtime-entrypoint')
  })
})


interface TestPackageUnit {
  vtype: 'package'
  qid: string
  uuid?: string | null
  _members: ValueRefMap
  _field: Record<string | symbol, unknown>
  clone(): TestPackageUnit
}

function makeSymbol(qid: string): Record<string, unknown> {
  return { vtype: 'symbol', qid, ast: { node: { _meta: { nodehash: qid } } } }
}

function makePackage(qid: string, baseSymbolTable: ValueRegistry): TestPackageUnit {
  const pkg: TestPackageUnit = {
    vtype: 'package',
    qid,
    uuid: null,
    _members: new ValueRefMap(() => baseSymbolTable, () => pkg as never),
    _field: {},
    clone(): TestPackageUnit {
      const cloned = makePackage(this.qid, baseSymbolTable)
      cloned.uuid = this.uuid
      cloned._members = this._members._clone(() => baseSymbolTable)
      cloned._field = cloned._members.getProxy()
      return cloned
    },
  }
  pkg._field = pkg._members.getProxy()
  return pkg
}

describe('analyzer memory overlay package resetLocal', () => {
  it('clears cached package overlay local members and tombstones between entrypoints', () => {
    const SymbolTableManager = require('../src/engine/analyzer/common/symbol-table-manager')
    const baseSymbolTable = new SymbolTableManager()
    const basePackage = makePackage('pkg', baseSymbolTable)
    const baseMember = makeSymbol('pkg.base')
    basePackage._members.set('baseMember', new ValueRef('', baseMember))

    const overlay = createAnalyzerMemoryOverlay(baseSymbolTable)
    const ep1Package = overlay.clonePackageRoot(basePackage)
    ep1Package._members.set('localMember', new ValueRef('', makeSymbol('pkg.local')))
    assert.strictEqual(ep1Package._members.has('localMember'), true)
    assert.strictEqual(ep1Package._members.delete('baseMember'), true)
    assert.strictEqual(ep1Package._members.has('baseMember'), false)
    assert.deepStrictEqual(Array.from(ep1Package._members.keys()).sort(), ['localMember'])

    overlay.resetLocal()

    const ep2Package = overlay.clonePackageRoot(basePackage)
    assert.strictEqual(ep2Package, ep1Package)
    assert.strictEqual(ep2Package._members.get('localMember'), null)
    assert.strictEqual(ep2Package._members.has('localMember'), false)
    assert.strictEqual(ep2Package._members.has('baseMember'), true)
    assert.deepStrictEqual(Array.from(ep2Package._members.keys()).sort(), ['baseMember'])
  })
})
