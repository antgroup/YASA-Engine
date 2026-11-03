/**
 * Go `http.Client.*` 实例方法 sink 匹配的 qid fallback 需要兼容 Go 包路径 `/` 分隔符。
 *
 * Go qid 形如 `net/http.Client.Do`，rule.fsig 形如 `http.Client.Do`，
 * 直接 `endsWith` 因前导字符 `/` ≠ `.` 失配；
 * 修复方案：把 `cleanQid` 中的 `/` 归一化为 `.` 后再做 `endsWith` 比较。
 */
import { describe, it } from 'mocha'
import * as assert from 'assert'
const { matchEmptyCalleeTypeInstanceMethod } = require('../../src/checker/taint/common-kit/sink-util')

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

/**
 * 构造 `client.Do(req)` 形式的 callExpr + fclos。
 * - callExpr.type = 'MemberAccess'，property = 'Do'
 * - fclos.property = 'Do'
 * - fclos.qid 由测试用例控制（Go 包路径用 `/` 分隔）
 * - fclos.object.rtype.definiteType = N/A（rtype 解析缺失场景，强制走 qid fallback）
 * - fclos.rtype.definiteType = N/A
 */
function mockClientDoCall(qid: string): { callExpr: AstNode; fclos: any } {
  const receiver = id('client')
  return {
    callExpr: member(receiver, 'Do'),
    fclos: {
      object: {
        rtype: { definiteType: id('N/A'), vagueType: id('client') },
      },
      property: id('Do'),
      rtype: { definiteType: id('N/A') },
      qid,
    },
  }
}

describe('sink-util × Go qid fallback 包路径分隔符兼容', () => {
  describe('matchEmptyCalleeTypeInstanceMethod qid fallback', () => {
    it('QF-1: Go 包路径 qid `net/http.Client.Do` + fsig `http.Client.Do` → 命中', () => {
      const { callExpr, fclos } = mockClientDoCall('net/http.Client.Do')
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'http.Client.Do' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), true)
    })

    it('QF-2: Go 包路径 qid `net/http.Client.Get` + fsig `http.Client.Get` → 命中', () => {
      const callExpr = member(id('client'), 'Get')
      const fclos = {
        object: { rtype: { definiteType: id('N/A'), vagueType: id('client') } },
        property: id('Get'),
        rtype: { definiteType: id('N/A') },
        qid: 'net/http.Client.Get',
      }
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'http.Client.Get' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), true)
    })

    it('QF-3: Go 包路径 qid `net/http.Client.Post` + fsig `http.Client.Post` → 命中', () => {
      const callExpr = member(id('client'), 'Post')
      const fclos = {
        object: { rtype: { definiteType: id('N/A'), vagueType: id('client') } },
        property: id('Post'),
        rtype: { definiteType: id('N/A') },
        qid: 'net/http.Client.Post',
      }
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'http.Client.Post' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), true)
    })

    it('QF-4: Go 包路径 qid `net/http.Client.Head` + fsig `http.Client.Head` → 命中', () => {
      const callExpr = member(id('client'), 'Head')
      const fclos = {
        object: { rtype: { definiteType: id('N/A'), vagueType: id('client') } },
        property: id('Head'),
        rtype: { definiteType: id('N/A') },
        qid: 'net/http.Client.Head',
      }
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'http.Client.Head' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), true)
    })

    it('QF-5: Go 包路径 qid `net/http.Client.PostForm` + fsig `http.Client.PostForm` → 命中', () => {
      const callExpr = member(id('client'), 'PostForm')
      const fclos = {
        object: { rtype: { definiteType: id('N/A'), vagueType: id('client') } },
        property: id('PostForm'),
        rtype: { definiteType: id('N/A') },
        qid: 'net/http.Client.PostForm',
      }
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'http.Client.PostForm' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), true)
    })

    it('QF-6: 修复前失配验证 — qid 含 `<instance_*>` 标记被清掉后仍保留 `/` 分隔符路径', () => {
      const { callExpr, fclos } = mockClientDoCall('net/http.Client.Do<instance_123>')
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'http.Client.Do' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), true)
    })

    it('QF-7: 深层包路径 qid `example.com/pkg/sub/http.Client.Do` + fsig `http.Client.Do` → 命中', () => {
      const { callExpr, fclos } = mockClientDoCall('example.com/pkg/sub/http.Client.Do')
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'http.Client.Do' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), true)
    })

    it('QF-8: qid 方法名与 fsig 不匹配 → 不命中', () => {
      const { callExpr, fclos } = mockClientDoCall('net/http.Client.Do')
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'http.Client.Get' }
      // propertyName='Do' vs methodName='Get' → L382 直接 return false
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), false)
    })

    it('QF-9: qid 类型名与 fsig 不匹配 → 不命中', () => {
      const { callExpr, fclos } = mockClientDoCall('net/http.OtherClient.Do')
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'http.Client.Do' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), false)
    })

    it('QF-10: 非 `/` 分隔符 qid（Java/Python 形式）不受影响', () => {
      // Java qid 形如 `com.example.HttpClient.doRequest`，无 `/`
      const callExpr = member(id('client'), 'doRequest')
      const fclos = {
        object: { rtype: { definiteType: id('N/A'), vagueType: id('client') } },
        property: id('doRequest'),
        rtype: { definiteType: id('N/A') },
        qid: 'com.example.HttpClient.doRequest',
      }
      const rule = { args: ['0'], attribute: ['JavaSsrf'], calleeType: '', fsig: 'HttpClient.doRequest' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), true)
    })

    it('QF-11: calleeType 不为空 → L375 直接 return false，qid fallback 不跑', () => {
      const { callExpr, fclos } = mockClientDoCall('net/http.Client.Do')
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '*http.Client', fsig: 'http.Client.Do' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), false)
    })

    it('QF-12: fsig 不含点 → L375 直接 return false，qid fallback 不跑', () => {
      const { callExpr, fclos } = mockClientDoCall('net/http.Client.Do')
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'Do' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), false)
    })

    it('QF-13: callExpr 不是 MemberAccess → return false', () => {
      const callExpr = { type: 'Identifier', name: 'Do' }
      const fclos = mockClientDoCall('net/http.Client.Do').fclos
      const rule = { args: ['0'], attribute: ['GoSsrf'], calleeType: '', fsig: 'http.Client.Do' }
      assert.strictEqual(matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, rule), false)
    })
  })
})
