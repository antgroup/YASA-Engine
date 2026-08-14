/**
 * matchField 单元测试
 *
 * 覆盖 rule_config 中 fsig 字段（用 . 拼接的方法路径）与 AST 节点的匹配规则：
 * - Identifier 终止：fsig 最末段匹配 Identifier 名
 * - MemberAccess 链：a.b.c 形态的成员访问
 * - CallExpression 中段：a.b().c 形态的链式调用
 * - 混合：MemberAccess + CallExpression 交替
 * - 通配：`**` 任意前缀、末尾 `*` 前缀匹配
 * - 边界：i === 0 约束，阻止多余前缀被忽略
 */
import { describe, it } from 'mocha'
import * as assert from 'assert'
import { matchField, prepareArgsByType } from '../../src/checker/common/rules-basic-handler'
const Analyzer = require('../../src/engine/analyzer/common/analyzer')
import { ObjectValue } from '../../src/engine/analyzer/common/value/object'
import { PrimitiveValue } from '../../src/engine/analyzer/common/value/primitive'

// ========================= AST fixture 构造器 =========================

interface AstNode {
  type: string
  [key: string]: unknown
}

type AnalyzerTestAccess = {
  shouldApplyLibPropagationForCallableWithBody: (node: unknown, fclos: unknown, callInfo: unknown, scope: unknown) => boolean
}

type TestFunctionClosure = {
  ast: { fdef: { type: 'FunctionDefinition'; body: unknown[] } }
  runtime?: { execute?: unknown }
  vtype: 'fclos'
  object: ObjectValue
  property: string
  rtype: { definiteType: { name: string }; vagueType: string }
  sid: string
  qid: string
}

function id(name: string): AstNode {
  return { type: 'Identifier', name }
}

function thisExpr(): AstNode {
  return { type: 'ThisExpression' }
}

function member(obj: AstNode, propName: string): AstNode {
  return {
    type: 'MemberAccess',
    object: obj,
    property: { name: propName },
  }
}

function call(callee: AstNode): AstNode {
  return {
    type: 'CallExpression',
    callee,
  }
}

function newExpr(callee: AstNode): AstNode {
  return {
    type: 'NewExpression',
    callee,
  }
}

// ========================= 辅助断言 =========================

function matches(node: AstNode, fsig: string): boolean {
  const marray = fsig.split('.')
  return matchField(node, marray, marray.length - 1)
}

// ========================= 用例 =========================

describe('matchField', () => {
  describe('Identifier 终止', () => {
    it('fsig "a" 匹配 Identifier a', () => {
      assert.strictEqual(matches(id('a'), 'a'), true)
    })

    it('fsig "a" 不匹配 Identifier b', () => {
      assert.strictEqual(matches(id('b'), 'a'), false)
    })

    it('fsig "a.b" 不匹配单独 Identifier b（剩余前缀 "a" 未消费）', () => {
      assert.strictEqual(matches(id('b'), 'a.b'), false)
    })
  })

  describe('MemberAccess 链', () => {
    it('fsig "a.b" 匹配 a.b', () => {
      assert.strictEqual(matches(member(id('a'), 'b'), 'a.b'), true)
    })

    it('fsig "a.b.c" 匹配 a.b.c', () => {
      assert.strictEqual(matches(member(member(id('a'), 'b'), 'c'), 'a.b.c'), true)
    })

    it('fsig "b.c" 匹配 a.b.c（原 MemberAccess 行为：根 Identifier 约束 i===0，未消费段失败）', () => {
      // 经典语义：marray 必须从右到左完整消费到 i===0
      assert.strictEqual(matches(member(member(id('a'), 'b'), 'c'), 'b.c'), false)
    })

    it('fsig "x.b" 不匹配 a.b', () => {
      assert.strictEqual(matches(member(id('a'), 'b'), 'x.b'), false)
    })
  })

  describe('CallExpression 中段', () => {
    it('fsig "b.c" 匹配 a.b().c（callee.object=CallExpression，再递归到 Identifier a 的 i===0）', () => {
      // AST: MemberAccess(object=CallExpression(callee=MemberAccess(a, b)), property=c)
      const node = member(call(member(id('a'), 'b')), 'c')
      assert.strictEqual(matches(node, 'b.c'), true)
    })

    it('fsig "a.b.c" 匹配 a.b().c（补齐根变量段）', () => {
      const node = member(call(member(id('a'), 'b')), 'c')
      assert.strictEqual(matches(node, 'a.b.c'), true)
    })

    it('fsig "b.c" 不匹配 a.c（中间没有 b() 调用）', () => {
      assert.strictEqual(matches(member(id('a'), 'c'), 'b.c'), false)
    })

    it('fsig "b.c" 不匹配 a().c（CallExpression.callee 是 Identifier a，不是 b）', () => {
      // AST: MemberAccess(object=CallExpression(callee=Identifier a), property=c)
      const node = member(call(id('a')), 'c')
      assert.strictEqual(matches(node, 'b.c'), false)
    })

    it('fsig "a.c" 匹配 a().c（CallExpression.callee 是 Identifier a，i===0 终止）', () => {
      const node = member(call(id('a')), 'c')
      assert.strictEqual(matches(node, 'a.c'), true)
    })

    it('fsig "b.c" 匹配 a.b.c（MemberAccess 链路保持匹配）', () => {
      assert.strictEqual(matches(member(member(id('a'), 'b'), 'c'), 'a.b.c'), true)
    })
  })

  describe('混合 MemberAccess + CallExpression', () => {
    it('fsig "a.b.c.d" 匹配 a.b().c().d（两次中段调用）', () => {
      // AST: member(call(member(call(member(a, b)), c)), d)
      const node = member(call(member(call(member(id('a'), 'b')), 'c')), 'd')
      assert.strictEqual(matches(node, 'a.b.c.d'), true)
    })

    it('fsig "b.c.d" 匹配 a.b().c().d（CallExpression 中段用尽 fsig，根变量任意）', () => {
      const node = member(call(member(call(member(id('a'), 'b')), 'c')), 'd')
      assert.strictEqual(matches(node, 'b.c.d'), true)
    })

    it('fsig "x.c.d" 不匹配 a.b().c().d（中段方法名不符）', () => {
      const node = member(call(member(call(member(id('a'), 'b')), 'c')), 'd')
      assert.strictEqual(matches(node, 'x.c.d'), false)
    })
  })

  describe('通配符', () => {
    it('fsig "**" 匹配任何节点（CallExpression 也不例外）', () => {
      const node = member(call(member(id('a'), 'b')), 'c')
      assert.strictEqual(matches(node, '**'), true)
    })

    it('fsig "**.c" 匹配任意前缀的 .c', () => {
      const node = member(call(member(id('a'), 'b')), 'c')
      assert.strictEqual(matches(node, '**.c'), true)
    })

    it('fsig "a.b*" 前缀匹配 a.bar（末尾 *）', () => {
      assert.strictEqual(matches(member(id('a'), 'bar'), 'a.b*'), true)
    })

    it('fsig "b*.c" 前缀匹配 a.bar().c', () => {
      const node = member(call(member(id('a'), 'bar')), 'c')
      assert.strictEqual(matches(node, 'b*.c'), true)
    })
  })

  describe('边界：i===0 约束', () => {
    it('fsig "c" 不匹配 x().c（i===0 时节点是 MemberAccess 不是 Identifier，终止失败）', () => {
      // marray=['c'], 从 MemberAccess(x(), c) 开始匹配 property=c 通过，递归 object=CallExpression, i=-1
      // 此时 i=-1 且 el=undefined，matchPrefix 一律 false
      const node = member(call(id('x')), 'c')
      assert.strictEqual(matches(node, 'c'), false)
    })

    it('fsig "c" 匹配 Identifier c（i===0 终止）', () => {
      assert.strictEqual(matches(id('c'), 'c'), true)
    })
  })

  describe('NewExpression', () => {
    it('N1: fsig "Foo" 匹配 new Foo(x)', () => {
      // AST: NewExpression(callee=Identifier('Foo'))
      const node = newExpr(id('Foo'))
      assert.strictEqual(matches(node, 'Foo'), true)
    })

    it('N2: fsig "*" 匹配 new Foo(x)（单段通配 + 末尾前缀匹配）', () => {
      const node = newExpr(id('Foo'))
      assert.strictEqual(matches(node, '*'), true)
    })

    it('N3: fsig "java.io.File" 匹配 new java.io.File(x)（FQN 三段）', () => {
      // AST: NewExpression(callee=MemberAccess(MemberAccess(Identifier('java'), 'io'), 'File'))
      const node = newExpr(member(member(id('java'), 'io'), 'File'))
      assert.strictEqual(matches(node, 'java.io.File'), true)
    })

    it('N4: fsig "**.File" 匹配 new java.io.File(x)（** 通配前缀）', () => {
      const node = newExpr(member(member(id('java'), 'io'), 'File'))
      assert.strictEqual(matches(node, '**.File'), true)
    })

    it('N5: fsig "java.io.File" 不匹配 new File(x)（层数不够）', () => {
      const node = newExpr(id('File'))
      assert.strictEqual(matches(node, 'java.io.File'), false)
    })

    it('N6: fsig "A.B" 匹配 new A().B(x)（NewExpression 递归到 Identifier A）', () => {
      // AST: CallExpression(callee=MemberAccess(object=NewExpression(callee=Identifier('A')), property='B'))
      const node = call(member(newExpr(id('A')), 'B'))
      assert.strictEqual(matches(node, 'A.B'), true)
    })

    it('N7: fsig "B" 匹配 new A().B(x)（段用尽即成功，根任意）', () => {
      const node = call(member(newExpr(id('A')), 'B'))
      assert.strictEqual(matches(node, 'B'), true)
    })

    it('N8: fsig "A" 不匹配 new A().B(x)（段太少 + 根 A 不是尾方法）', () => {
      const node = call(member(newExpr(id('A')), 'B'))
      assert.strictEqual(matches(node, 'A'), false)
    })
  })

  describe('其它节点类型不变', () => {
    it('ThisExpression：fsig "this" 匹配', () => {
      assert.strictEqual(matches(thisExpr(), 'this'), true)
    })

    it('Literal：fsig "foo" 匹配 Literal value=foo', () => {
      const node = { type: 'Literal', value: 'foo' } as AstNode
      assert.strictEqual(matches(node, 'foo'), true)
    })

    it('未知类型返回 false', () => {
      const node = { type: 'UnknownType' } as AstNode
      assert.strictEqual(matches(node, 'a'), false)
    })
  })
})

describe('lib schema with-body guard', () => {
  it('真实源码同名方法不会进入 with-body schema opt-in', () => {
    const analyzer = new Analyzer(undefined) as AnalyzerTestAccess
    const receiver = new ObjectValue('<test>', {
      sid: 'receiver',
      _meta: { type: { definiteType: { name: 'com.example.SourceQueryClause' }, vagueType: 'receiver' } },
    })
    const arg = new PrimitiveValue('<test>', 'arg', 'tainted', 'string')
    arg.taint.markSource()
    arg.taint.addTag('JAVA_INPUT')
    const fclos: TestFunctionClosure = {
      ast: { fdef: { type: 'FunctionDefinition', body: [{ type: 'ExpressionStatement' }] } },
      vtype: 'fclos',
      object: receiver,
      property: 'addQuery',
      rtype: { definiteType: { name: 'com.example.SourceQueryClause' }, vagueType: 'addQuery' },
      sid: 'com.example.SourceQueryClause.addQuery',
      qid: '<global>.packageManager.com.example.SourceQueryClause.addQuery',
    }
    const node = {
      type: 'CallExpression',
      callee: { type: 'MemberAccess', object: { type: 'Identifier', name: 'receiver' }, property: { name: 'addQuery' } },
      loc: { sourcefile: '/tmp/SourceQueryClause.java', start: { line: 1 }, end: { line: 1 } },
    }
    const callInfo = { callArgs: { receiver, args: [{ index: 0, value: arg, kind: 'positional' }] } }

    const shouldApply = analyzer.shouldApplyLibPropagationForCallableWithBody(node, fclos, callInfo, {})

    assert.strictEqual(shouldApply, false)
    assert.strictEqual(receiver.taint.containsTag('JAVA_INPUT'), false)
  })
})

describe('prepareArgsByType', () => {
  function value(typeName: string, vagueType?: string): { rtype: { definiteType: { name: string }; vagueType?: string }; taint?: { isTaintedRec: boolean } } {
    return {
      rtype: {
        definiteType: { name: typeName },
        vagueType,
      },
    }
  }

  it('允许 builder 写入产生的 tainted 明确类型参数', () => {
    const arg = value('com.example.Request', 'setSearchClause')
    arg.taint = { isTaintedRec: true }
    const args = prepareArgsByType(
      { callArgs: { args: [{ index: 0, value: arg, kind: 'positional' }] } },
      undefined,
      { fsig: 'search', argTypes: ['Request'] }
    )
    assert.deepStrictEqual(args, [arg])
  })

  it('拒绝非 builder vagueType 的明确类型参数', () => {
    const arg = value('com.example.Request', 'search')
    arg.taint = { isTaintedRec: true }
    const args = prepareArgsByType(
      { callArgs: { args: [{ index: 0, value: arg, kind: 'positional' }] } },
      undefined,
      { fsig: 'search', argTypes: ['Request'] }
    )
    assert.deepStrictEqual(args, [])
  })

  it('拒绝未 tainted 的 builder vagueType 明确类型参数', () => {
    const arg = value('com.example.Request', 'setSearchClause')
    const args = prepareArgsByType(
      { callArgs: { args: [{ index: 0, value: arg, kind: 'positional' }] } },
      undefined,
      { fsig: 'search', argTypes: ['Request'] }
    )
    assert.deepStrictEqual(args, [])
  })
})
