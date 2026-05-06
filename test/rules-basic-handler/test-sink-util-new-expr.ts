/**
 * matchSinkAtFuncCallWithCalleeType / matchSinkAtFuncCall 对 NewExpression 的支持单元测试
 *
 * 覆盖 D23 构造器 sink 能力在 sink-util 入口层的行为：
 * - `new Foo(x)` 的 callee 是 Identifier / MemberAccess，sink-util `callExpr = node.callee || node` 应能透明处理
 * - `matchSinkAtFuncCallWithCalleeType`（Java/PHP 走）：calleeType 基于 `fclos.rtype.definiteType` 做类型收敛
 * - `matchSinkAtFuncCall`（JS 系走）：不读 calleeType，仅按 fsig 匹配
 *
 * 关键断言：
 * - C1: 精确 fsig 无 calleeType 可命中 new
 * - C2: fsig 短名 + calleeType FQN 可命中 new（用 calleeType 收敛类型身份）
 * - C3: calleeType 不匹配时，不命中
 * - C4: calleeType "*" 通配时命中
 * - C5: matchSinkAtFuncCall（JS 入口）忽略 calleeType，只要 fsig 命中即中
 */
import { describe, it } from 'mocha'
import * as assert from 'assert'
const { matchSinkAtFuncCall, matchSinkAtFuncCallWithCalleeType } = require('../../src/checker/taint/common-kit/sink-util')

// ========================= AST fixture =========================

interface AstNode {
  type: string
  [key: string]: any
}

function id(name: string): AstNode {
  return { type: 'Identifier', name }
}

function member(obj: AstNode, propName: string): AstNode {
  return {
    type: 'MemberAccess',
    object: obj,
    property: { type: 'Identifier', name: propName },
  }
}

function newExpr(callee: AstNode): AstNode {
  return {
    type: 'NewExpression',
    callee,
    arguments: [],
  }
}

// fclos mock：引擎在 processNewObject 时会传入 fclos，其 rtype 记录被构造类的类型信息
// - sid：简单名（类名），matchSinkAtFuncCallWithCalleeType 分支 3 用于 fsig 匹配
// - rtype.definiteType：精确类型（FQN 形态），用于 calleeType 收敛
// - rtype.vagueType：模糊类型，容错分支
function mockFclosForClass(simpleName: string, fqn: string): any {
  return {
    sid: simpleName,
    rtype: {
      definiteType: id(fqn),  // prettyPrint(Identifier) 就是 name，可匹配 "java.io.File" 这类字符串
      vagueType: id(simpleName),
    },
  }
}

// ========================= 用例 =========================

describe('sink-util × NewExpression', () => {
  describe('matchSinkAtFuncCallWithCalleeType（Java/PHP 路径）', () => {
    const callInfo = undefined  // 不设 argNum，跳过 arg 数量过滤

    it('C1: 精确 fsig 无 calleeType 可命中 new Foo(x)（走分支 1 prettyPrint 直匹）', () => {
      const node = newExpr(id('Foo'))
      const fclos = mockFclosForClass('Foo', 'com.x.Foo')
      const rules = [{ fsig: 'Foo', args: ['0'], attribute: 'TestSink' }]
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, callInfo)
      assert.strictEqual(matched.length, 1)
      assert.strictEqual(matched[0].fsig, 'Foo')
    })

    it('C2: fsig 短名 + calleeType FQN 命中 new File(x)（走分支 3 类型收敛）', () => {
      // new File(x) 在代码里是短名，但引擎解析后 fclos.rtype.definiteType = "java.io.File"
      const node = newExpr(id('File'))
      const fclos = mockFclosForClass('File', 'java.io.File')
      const rules = [{ fsig: 'File', calleeType: 'java.io.File', args: ['0'], attribute: 'PathTraversal' }]
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, callInfo)
      assert.strictEqual(matched.length, 1, `期望命中 File+java.io.File，实际 ${matched.length}`)
    })

    it('C3: calleeType 不匹配时不命中（不同包的同名类不误伤）', () => {
      // new File(x) 解析到 com.acme.File（不是 java.io.File），规则要求 java.io.File → 应失配
      const node = newExpr(id('File'))
      const fclos = mockFclosForClass('File', 'com.acme.File')
      const rules = [{ fsig: 'File', calleeType: 'java.io.File', args: ['0'], attribute: 'PathTraversal' }]
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, callInfo)
      assert.strictEqual(matched.length, 0, `期望失配，实际命中 ${matched.length}`)
    })

    it('C4: calleeType "*" 通配任意类型均命中', () => {
      const node = newExpr(id('File'))
      const fclos = mockFclosForClass('File', 'random.pkg.File')
      const rules = [{ fsig: 'File', calleeType: '*', args: ['0'], attribute: 'PathTraversal' }]
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, callInfo)
      assert.strictEqual(matched.length, 1)
    })

    it('C5: calleeType 用 endsWith 后缀匹配（短名 calleeType 也能命中 FQN 类型）', () => {
      // calleeType: "File" 应能匹配 definiteType "java.io.File"（endsWith ".File"）
      const node = newExpr(id('File'))
      const fclos = mockFclosForClass('File', 'java.io.File')
      const rules = [{ fsig: 'File', calleeType: 'File', args: ['0'], attribute: 'PathTraversal' }]
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, callInfo)
      assert.strictEqual(matched.length, 1)
    })

    it('C6: FQN fsig 无需 calleeType（分支 1 prettyPrint 匹配 MemberAccess 链）', () => {
      // new java.io.File(x)：callee 是 MemberAccess 链
      const node = newExpr(member(member(id('java'), 'io'), 'File'))
      const fclos = mockFclosForClass('File', 'java.io.File')
      const rules = [{ fsig: 'java.io.File', args: ['0'], attribute: 'PathTraversal' }]
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, callInfo)
      assert.strictEqual(matched.length, 1)
    })
  })

  describe('matchSinkAtFuncCall（JS 系路径，无 calleeType）', () => {
    const callInfo = undefined

    it('C7: fsig 匹配构造器，忽略规则里写的 calleeType（JS 入口不读该字段）', () => {
      // JS 系 checker 用 matchSinkAtFuncCall，规则里就算写了 calleeType 也不会被检查
      const node = newExpr(id('Foo'))
      const fclos = mockFclosForClass('Foo', 'com.x.Foo')
      const rules = [{ fsig: 'Foo', calleeType: 'never-matches.Foo', args: ['0'], attribute: 'TestSink' }]
      const matched = matchSinkAtFuncCall(node, fclos, rules, callInfo)
      // JS 入口只认 fsig，calleeType 被无视 → 仍命中
      assert.strictEqual(matched.length, 1, '期望命中（JS 入口忽略 calleeType）')
    })

    it('C8: fsig 不匹配时即使 JS 入口也不中', () => {
      const node = newExpr(id('Foo'))
      const fclos = mockFclosForClass('Foo', 'com.x.Foo')
      const rules = [{ fsig: 'Bar', args: ['0'], attribute: 'TestSink' }]
      const matched = matchSinkAtFuncCall(node, fclos, rules, callInfo)
      assert.strictEqual(matched.length, 0, '期望失配')
    })
  })
})
