import { describe, it, before, after } from 'mocha'
import * as assert from 'assert'

const { addSrcLineInfo, setGlobalAnalyzer, getGlobalAnalyzer } = require('../../src/engine/analyzer/common/source-line')
const { TaintRecord } = require('../../src/engine/analyzer/common/value/taint-record')

type MockNode = { loc: { sourcefile: string; start: { line: number; column: number }; end: { line: number; column: number } } }

type MockValue = {
  vtype: string
  sid: string
  _qid: string
  uuid: string | null
  value?: unknown
  taint: InstanceType<typeof TaintRecord>
  expression?: MockValue
  clone: () => MockValue
}

const SOURCE_FILE = '/mock/nested-trace.js'
const TAG = 'OS_COMMAND_INJECTION'

function makeNode(line: number): MockNode {
  return { loc: { sourcefile: SOURCE_FILE, start: { line, column: 0 }, end: { line, column: 0 } } }
}

/** 构造带 clone 能力的最小符号值：clone 时克隆 TaintRecord，模拟真实 Value 的污点隔离语义 */
function makeValue(vtype: string, sid: string): MockValue {
  const val: MockValue = {
    vtype,
    sid,
    _qid: `qid-${sid}`,
    uuid: null,
    taint: undefined as unknown as InstanceType<typeof TaintRecord>,
    clone(): MockValue {
      const copy: MockValue = Object.assign({}, this)
      copy.taint = this.taint._clone(copy)
      return copy
    },
  }
  val.taint = new TaintRecord(val)
  return val
}

/** 统计 trace 中与当前步（文件+行+tag）一致的条数 */
function countCurrentStep(taint: InstanceType<typeof TaintRecord>, line: number, tag: string): number {
  const trace = taint.getTrace(TAG) ?? []
  return trace.filter((t: { file?: string; line?: unknown; tag?: string }) => t.file === SOURCE_FILE && t.line === line && t.tag === tag).length
}

describe('source-line 嵌套 source-line 隔离', () => {
  let previousAnalyzer: unknown

  function installAnalyzer(enableNestedSourceLineIsolation: boolean): void {
    setGlobalAnalyzer({
      enableNestedSourceLineIsolation,
      sourceCodeCache: new Map<string, string[]>(),
      symbolTable: {
        calculateUUID: (v: { _qid?: string }, tag: string) => `${v?._qid ?? 'v'}|${tag}`,
        has: () => false,
      },
    })
  }

  before(() => {
    previousAnalyzer = getGlobalAnalyzer()
    installAnalyzer(true)
  })

  after(() => {
    setGlobalAnalyzer(previousAnalyzer)
  })

  it('开启隔离时，子值独立写入当前步且原值不被污染', () => {
    const root = makeValue('union', 'root')
    root.taint.addSanitizerTag({ kind: 'precondition' })

    const child = makeValue('symbol', 'child')
    child.taint.addTag(TAG)
    root.expression = child

    const result = addSrcLineInfo(root, makeNode(6), SOURCE_FILE, 'Var Pass: ', 'x') as MockValue

    const isolatedChild = result.expression as MockValue
    assert.notStrictEqual(isolatedChild, child, '子值应被隔离为独立实例')
    assert.strictEqual(countCurrentStep(isolatedChild.taint, 6, 'Var Pass: '), 1, '隔离子值的当前步必须恰好一条')
    assert.strictEqual(countCurrentStep(child.taint, 6, 'Var Pass: '), 0, '原子值不应被写入')
  })

  it('关闭隔离时，子值原地传播当前步且不重复', () => {
    installAnalyzer(false)
    const root = makeValue('union', 'root-disabled')
    root.taint.addSanitizerTag({ kind: 'precondition' })

    const child = makeValue('symbol', 'child-disabled')
    child.taint.addTag(TAG)
    root.expression = child

    const result = addSrcLineInfo(root, makeNode(7), SOURCE_FILE, 'Var Pass: ', 'z') as MockValue

    const propagatedChild = result.expression as MockValue
    assert.strictEqual(propagatedChild, child, '子值应保持原实例')
    assert.strictEqual(countCurrentStep(propagatedChild.taint, 7, 'Var Pass: '), 1, '原地传播当前步必须恰好一条')
    installAnalyzer(true)
  })

  it('容器自身有 tag 时，子值经合并继承当前步且不重复', () => {
    const root = makeValue('object', 'root2')
    root.taint.addTag(TAG)

    const child = makeValue('symbol', 'child2')
    child.taint.addTag(TAG)
    root.expression = child

    const result = addSrcLineInfo(root, makeNode(9), SOURCE_FILE, 'Var Pass: ', 'y') as MockValue

    assert.strictEqual(countCurrentStep(result.taint, 9, 'Var Pass: '), 1, '容器当前步恰好一条')
    const isolatedChild = result.expression as MockValue
    assert.strictEqual(countCurrentStep(isolatedChild.taint, 9, 'Var Pass: '), 1, '子值经合并继承当前步且不重复')
  })

  it('连续两次 addSrcLineInfo，子值不累积重复步', () => {
    const root = makeValue('union', 'root3')
    root.taint.addSanitizerTag({ kind: 'precondition' })

    const child = makeValue('symbol', 'child3')
    child.taint.addTag(TAG)
    root.expression = child

    const first = addSrcLineInfo(root, makeNode(11), SOURCE_FILE, 'Var Pass: ', 'a') as MockValue
    const second = addSrcLineInfo(first, makeNode(12), SOURCE_FILE, 'CALL: ', 'fn') as MockValue

    const finalChild = second.expression as MockValue
    assert.strictEqual(finalChild, first.expression, '已隔离子值不应在后续 trace 传播中重复注册')
    assert.strictEqual(countCurrentStep(finalChild.taint, 11, 'Var Pass: '), 1, '第一步在子值中恰好一条')
    assert.strictEqual(countCurrentStep(finalChild.taint, 12, 'CALL: '), 1, '第二步在子值中恰好一条')
  })
})
