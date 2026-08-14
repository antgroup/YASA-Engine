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

type TraceStep = { file?: string; line?: number | number[]; tag?: string; affectedNodeName?: string }

const SOURCE_FILE = '/mock/trace-step-replace.js'
const TAG = 'OS_COMMAND_INJECTION'

function makeNode(startLine: number, endLine: number = startLine): MockNode {
  return { loc: { sourcefile: SOURCE_FILE, start: { line: startLine, column: 0 }, end: { line: endLine, column: 0 } } }
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

/** 结构化比较行号（number 或 number[]） */
function sameLine(a: number | number[] | undefined, b: number | number[]): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i])
  return false
}

/** 统计子值 trace 中与指定 (line, tag) 一致的步数 */
function countStep(taint: InstanceType<typeof TaintRecord>, line: number | number[], tag: string): number {
  const trace: TraceStep[] = taint.getTrace(TAG) ?? []
  return trace.filter((t) => t.file === SOURCE_FILE && sameLine(t.line, line) && t.tag === tag).length
}

/** 取子值 trace 中与指定 (line, tag) 一致的末步展示名 */
function lastStepName(taint: InstanceType<typeof TaintRecord>, line: number | number[], tag: string): string | undefined {
  const trace: TraceStep[] = taint.getTrace(TAG) ?? []
  const hits = trace.filter((t) => t.file === SOURCE_FILE && sameLine(t.line, line) && t.tag === tag)
  return hits.length > 0 ? hits[hits.length - 1].affectedNodeName : undefined
}

/** 构造「容器仅携带非传播型 tag、子值带污点 tag」的最小结构，触发子值 push 路径（propagateTraceFrom） */
function makeRootWithChild(rootSid: string, childSid: string): MockValue {
  const root = makeValue('union', rootSid)
  root.taint.addSanitizerTag({ kind: 'precondition' })
  const child = makeValue('symbol', childSid)
  child.taint.addTag(TAG)
  root.expression = child
  return root
}

describe('子值 push 路径同位置末步替换（propagateTraceFrom 对齐 dedupLastTrace 语义）', () => {
  let previousAnalyzer: unknown

  before(() => {
    previousAnalyzer = getGlobalAnalyzer()
    setGlobalAnalyzer({
      enableNestedSourceLineIsolation: true,
      sourceCodeCache: new Map<string, string[]>(),
      symbolTable: {
        calculateUUID: (v: { _qid?: string }, tag: string) => `${v?._qid ?? 'v'}|${tag}`,
        has: () => false,
      },
    })
  })

  after(() => {
    setGlobalAnalyzer(previousAnalyzer)
  })

  it('连续写入同 (file, line, tag) 时，子值收敛为 1 条且保留最新展示名', () => {
    const root = makeRootWithChild('rootA', 'childA')

    // 同一语句点的两次 decoration（解构 lowering 兄弟读语句的典型形态）
    const first = addSrcLineInfo(root, makeNode(11), SOURCE_FILE, 'Var Pass: ', 'a') as MockValue
    const second = addSrcLineInfo(first, makeNode(11), SOURCE_FILE, 'Var Pass: ', 'b') as MockValue

    const finalChild = second.expression as MockValue
    assert.strictEqual(countStep(finalChild.taint, 11, 'Var Pass: '), 1, '同位置连续写入必须收敛为 1 条')
    assert.strictEqual(lastStepName(finalChild.taint, 11, 'Var Pass: '), 'b', '收敛后保留最新一次的展示名')
  })

  it('不同 line 或不同 tag 时不收敛，各自保留 1 条', () => {
    const root = makeRootWithChild('rootB', 'childB')

    const first = addSrcLineInfo(root, makeNode(11), SOURCE_FILE, 'Var Pass: ', 'a') as MockValue
    const second = addSrcLineInfo(first, makeNode(12), SOURCE_FILE, 'Var Pass: ', 'b') as MockValue
    const third = addSrcLineInfo(second, makeNode(12), SOURCE_FILE, 'CALL: ', 'fn') as MockValue

    const finalChild = third.expression as MockValue
    assert.strictEqual(countStep(finalChild.taint, 11, 'Var Pass: '), 1, '不同 line 不收敛')
    assert.strictEqual(countStep(finalChild.taint, 12, 'Var Pass: '), 1, '前一步保留')
    assert.strictEqual(countStep(finalChild.taint, 12, 'CALL: '), 1, '同 line 不同 tag 不收敛')
  })

  it('同位置回调边按闭包归属区分，不覆盖另一条回调 provenance', () => {
    const root = makeRootWithChild('rootCallback', 'childCallback')
    const first = addSrcLineInfo(
      root,
      makeNode(30),
      SOURCE_FILE,
      'CALL: ',
      'fnA',
      { callbackEdge: true, callbackClosureOwnerHash: 'closure-a' }
    ) as MockValue
    const second = addSrcLineInfo(
      first,
      makeNode(30),
      SOURCE_FILE,
      'CALL: ',
      'fnB',
      { callbackEdge: true, callbackClosureOwnerHash: 'closure-b' }
    ) as MockValue

    const trace = (second.expression as MockValue).taint.getTrace(TAG) ?? []
    const callbackSteps = trace.filter((step) => step.line === 30 && step.tag === 'CALL: ')
    assert.strictEqual(callbackSteps.length, 2, '不同闭包归属的同位置回调边必须并存')
    assert.deepStrictEqual(callbackSteps.map((step) => step._callbackClosureOwnerHash), ['closure-a', 'closure-b'])
  })

  it('跨行 trace（line 为数组）按结构化比较：同区间收敛、不同区间追加', () => {
    const root = makeRootWithChild('rootC', 'childC')

    // 同一多行区间 [20,21] 的两次 decoration 收敛为 1 条
    const first = addSrcLineInfo(root, makeNode(20, 21), SOURCE_FILE, 'CALL: ', 'fnA') as MockValue
    const second = addSrcLineInfo(first, makeNode(20, 21), SOURCE_FILE, 'CALL: ', 'fnB') as MockValue

    const midChild = second.expression as MockValue
    assert.strictEqual(countStep(midChild.taint, [20, 21], 'CALL: '), 1, '同跨行区间收敛为 1 条')
    assert.strictEqual(lastStepName(midChild.taint, [20, 21], 'CALL: '), 'fnB', '收敛后保留最新展示名')

    // 不同区间 [20,21,22] 追加
    const third = addSrcLineInfo(second, makeNode(20, 22), SOURCE_FILE, 'CALL: ', 'fnC') as MockValue
    const finalChild = third.expression as MockValue
    assert.strictEqual(countStep(finalChild.taint, [20, 21], 'CALL: '), 1, '原区间步保留')
    assert.strictEqual(countStep(finalChild.taint, [20, 21, 22], 'CALL: '), 1, '不同区间追加为新步')
  })
})
