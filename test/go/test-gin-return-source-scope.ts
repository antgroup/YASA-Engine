/**
 * Return source 的 calleeType 匹配需要兼容 Go receiver 类型的多种承载位置。
 *
 * Go 成员调用在不同分析路径下，类型信息可能挂在方法闭包或 receiver 上；
 * 若只读取单一位置，Gin 请求读取 API 的返回值会漏标为 source。
 */
import { describe, it } from 'mocha'
import * as assert from 'assert'

const { matchReturnSourceCalleeType } = require('../../src/checker/taint/common-kit/source-util')

// Go parser 对 `*gin.Context` 注入的 rtype AST 形态：
//   PointerType { element: MemberAccess { object: Identifier "gin", property: Identifier "Context" } }
const GIN_CONTEXT_AST = {
  type: 'PointerType',
  element: {
    type: 'MemberAccess',
    object: { type: 'Identifier', name: 'gin' },
    property: { type: 'Identifier', name: 'Context' },
  },
}

describe('matchReturnSourceCalleeType — Return source scope/rtype 对齐 Arg 路径', () => {
  it('嵌套调用场景下使用方法闭包 rtype 匹配 calleeType', () => {
    const fclos = { rtype: { definiteType: GIN_CONTEXT_AST, type: undefined } }
    assert.strictEqual(matchReturnSourceCalleeType(fclos, fclos, '*gin.Context'), true)
  })

  it('直接赋值场景下使用 receiver rtype 匹配 calleeType', () => {
    const receiver = { rtype: GIN_CONTEXT_AST }
    const fclos = { object: receiver }
    assert.strictEqual(matchReturnSourceCalleeType(fclos, fclos, '*gin.Context'), true)
  })

  it('receiver rtype 使用 definiteType 包装时也能匹配 calleeType', () => {
    const receiver = { rtype: { definiteType: GIN_CONTEXT_AST, type: undefined } }
    const fclos = { object: receiver }
    assert.strictEqual(matchReturnSourceCalleeType(fclos, fclos, '*gin.Context'), true)
  })

  it('calleeType === "*" 通配符始终命中', () => {
    const fclos = {}
    assert.strictEqual(matchReturnSourceCalleeType(fclos, fclos, '*'), true)
  })

  it('calleeType 为空字符串时命中（视为无类型约束）', () => {
    const fclos = {}
    assert.strictEqual(matchReturnSourceCalleeType(fclos, fclos, ''), true)
  })

  it('负样本：scope/fclos/receiver 全无 rtype 信息 + calleeType 指定 → 不命中（不得误报）', () => {
    const fclos = { object: {} }
    assert.strictEqual(matchReturnSourceCalleeType(fclos, fclos, '*gin.Context'), false)
  })

  it('负样本：rtype 是另一类型 → 不命中', () => {
    const otherAST = {
      type: 'PointerType',
      element: {
        type: 'MemberAccess',
        object: { type: 'Identifier', name: 'net/http' },
        property: { type: 'Identifier', name: 'Request' },
      },
    }
    const fclos = { object: { rtype: otherAST } }
    assert.strictEqual(matchReturnSourceCalleeType(fclos, fclos, '*gin.Context'), false)
  })

  it('嵌入类型 fallback：fclos._base 带 gin.Context logicalQid 时命中 *gin.Context', () => {
    const fclos = { _base: { logicalQid: 'gin.Context' } }
    assert.strictEqual(matchReturnSourceCalleeType(fclos, fclos, '*gin.Context'), true)
  })

  it('rule entrypoint 形参 rtype 丢失时使用 qid 形参路径匹配 *gin.Context', () => {
    const fclos = {
      sid: 'Query',
      qid: '<global>.example.Handler.c.Query',
    }
    assert.strictEqual(matchReturnSourceCalleeType(fclos, fclos, '*gin.Context'), true)
  })
})
