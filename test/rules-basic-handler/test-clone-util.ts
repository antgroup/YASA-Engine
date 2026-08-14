import { describe, it } from 'mocha'
import * as assert from 'assert'
import { buildNewValueInstance } from '../../src/util/clone-util'
import { ObjectValue } from '../../src/engine/analyzer/common/value/object'
import { RAW_TARGET } from '../../src/engine/analyzer/common/value/symbols'

interface SymbolTableStub {
  get(uuid: string): unknown
}

interface CloneableChild {
  vtype: string
  qid: string
  _qid: string
  _field: Record<symbol, string[]>
  taint: { clear(): void }
  clone(): CloneableChild
}

function makeSymbolTable(value: unknown): SymbolTableStub {
  return {
    get(uuid: string): unknown {
      return uuid === 'symuuid_child' ? value : undefined
    },
  }
}

describe('buildNewValueInstance', () => {
  it('回填 _field 数组子值时初始化 clone 父节点 value 容器', () => {
    const child = new ObjectValue({ sid: 'child', qid: 'root.child', _skipRegister: true })
    const original = new ObjectValue({ sid: 'root', qid: 'root', _skipRegister: true })
    original.value = [child]

    const clone = buildNewValueInstance(
      { symbolTable: makeSymbolTable(child) },
      original,
      { loc: { sourcefile: '/tmp/sample.py', start: { line: 1, column: 1 }, end: { line: 1, column: 5 } } },
      { sid: '<global>' },
      () => false,
      () => false,
      1,
      { skipTagTraceMap: true }
    )

    assert.ok(clone.value[0])
    assert.notStrictEqual(clone.value[0], child)
    assert.ok(clone.value[0].qid.includes('<instance_sample_1_1_1_5_'))
  })

  it('递归 _field 数组时不依赖 clone 子节点预置 value', () => {
    const fieldChild = new ObjectValue({ sid: 'fieldChild', qid: 'root.child.fieldChild', _skipRegister: true })
    const child: CloneableChild = {
      vtype: 'object',
      qid: 'root.child',
      _qid: 'root.child',
      _field: { [RAW_TARGET]: ['symuuid_child'] },
      taint: { clear(): void {} },
      clone(): CloneableChild {
        return { ...this, _field: this._field, taint: this.taint }
      },
    }
    const original = new ObjectValue({ sid: 'root', qid: 'root', _skipRegister: true })
    original.value = [child]

    const clone = buildNewValueInstance(
      { symbolTable: makeSymbolTable(fieldChild) },
      original,
      { loc: { sourcefile: '/tmp/sample.py', start: { line: 2, column: 1 }, end: { line: 2, column: 5 } } },
      { sid: '<global>' },
      () => false,
      () => false,
      2,
      { skipTagTraceMap: true }
    )

    assert.ok(clone.value[0].value[0])
    assert.notStrictEqual(clone.value[0].value[0], fieldChild)
    assert.ok(clone.value[0].value[0].qid.includes('<instance_sample_2_1_2_5_'))
  })
})
