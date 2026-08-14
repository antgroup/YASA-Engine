/**
 * Go sink 的 calleeType 匹配需要支持 interface receiver 到 concrete implementer 的保守穿透。
 *
 * 当规则声明 concrete 类型而调用点 receiver 是接口时，分析器通过类层次信息查找实现类型；
 * 宽接口或非接口类型不穿透，避免把过多实现者误判为 sink。
 */
import { describe, it } from 'mocha'
import * as assert from 'assert'
const { matchSinkAtFuncCallWithCalleeType, tryMatchSinkGoInterfacePassthrough } = require('../../src/checker/taint/common-kit/sink-util')

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

function call(callee: AstNode, args: AstNode[] = []): AstNode {
  return { type: 'CallExpression', callee, arguments: args }
}

/**
 * 模拟调用 `receiver.method(...)`，receiver rtype 是 interface
 * fclos.object.rtype.definiteType 是接口声明类型（Identifier）
 * fclos.property 是方法名
 */
function mockFclosForInterfaceCall(receiverName: string, interfaceType: string, methodName: string): any {
  return {
    object: {
      rtype: {
        definiteType: id(interfaceType),
        vagueType: id(receiverName),
      },
    },
    property: id(methodName),
    rtype: {},
  }
}

/**
 * 构造贴近 Go 分析路径的 mock analyzer。
 * classHierarchyMap 挂在 analyzer 本体，findSubTypes 由 typeResolver 提供。
 */
function mockAnalyzer(interfaceDefs: Record<string, { typeDeclaration: string; implementers: string[] }>): any {
  const classHierarchyMap = new Map<string, any>()
  for (const [qid, def] of Object.entries(interfaceDefs)) {
    classHierarchyMap.set(qid, {
      typeDeclaration: def.typeDeclaration,
      type: qid,
      value: null,
      extends: [],
      extendedBy: [],
      implements: [],
      // implementedBy 字段被 findSubTypes 读取，type 字段是实现者类型名
      implementedBy: def.implementers.map((t) => ({
        typeDeclaration: 'struct',
        type: t,
        value: null,
        extends: [],
        extendedBy: [],
        implements: [],
        implementedBy: [],
      })),
    })
  }
  return {
    classHierarchyMap,
    typeResolver: {
      // 复用 TypeRelatedInfoResolver.findSubTypes 的语义：遍历 extendedBy + implementedBy 的 type 字段
      findSubTypes: (typeInfo: any): string[] => {
        const out: string[] = []
        if (!typeInfo) return out
        for (const ext of typeInfo.extendedBy || []) out.push(ext.type)
        for (const impl of typeInfo.implementedBy || []) out.push(impl.type)
        return out
      },
    },
  }
}

describe('sink-util × Go interface → concrete 穿透', () => {
  describe('tryMatchSinkGoInterfacePassthrough helper 单测', () => {
    it('GI-7a: 接口 + 小 implementer 集合 + rule.calleeType 命中 implementer → 返回 true', () => {
      const ana = mockAnalyzer({
        'dataprovider.sqlQuerier': {
          typeDeclaration: 'interface',
          implementers: ['sql.DB', 'sql.Tx'],
        },
      })
      const ok = tryMatchSinkGoInterfacePassthrough('sqlQuerier', { fsig: 'QueryContext', calleeType: '*sql.DB' }, ana)
      assert.strictEqual(ok, true)
    })

    it('GI-7b: 没有 rule.calleeType → 返回 false', () => {
      const ana = mockAnalyzer({
        'X': { typeDeclaration: 'interface', implementers: ['Y'] },
      })
      assert.strictEqual(tryMatchSinkGoInterfacePassthrough('X', { fsig: 'foo' }, ana), false)
    })

    it('GI-7c: declType 不在 classHierarchyMap → 返回 false', () => {
      const ana = mockAnalyzer({})
      assert.strictEqual(
        tryMatchSinkGoInterfacePassthrough('Unknown', { fsig: 'foo', calleeType: 'bar' }, ana),
        false
      )
    })

    it('GI-7d: declType 存在但是 struct（非 interface）→ 返回 false', () => {
      const ana = mockAnalyzer({
        'MyStruct': { typeDeclaration: 'struct', implementers: ['bar'] },
      })
      assert.strictEqual(
        tryMatchSinkGoInterfacePassthrough('MyStruct', { fsig: 'foo', calleeType: 'bar' }, ana),
        false
      )
    })

    it('GI-7e: implementer 集合为空 → 返回 false', () => {
      const ana = mockAnalyzer({
        'I': { typeDeclaration: 'interface', implementers: [] },
      })
      assert.strictEqual(
        tryMatchSinkGoInterfacePassthrough('I', { fsig: 'foo', calleeType: 'Bar' }, ana),
        false
      )
    })

    it('GI-7f: implementer 数量 > 8（宽接口 FP 爆炸防护）→ 返回 false', () => {
      const ana = mockAnalyzer({
        'error': {
          typeDeclaration: 'interface',
          implementers: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9'],
        },
      })
      assert.strictEqual(
        tryMatchSinkGoInterfacePassthrough('error', { fsig: 'Error', calleeType: 'E5' }, ana),
        false
      )
    })

    it('GI-7g: 没有 implementer 匹配 rule.calleeType → 返回 false', () => {
      const ana = mockAnalyzer({
        'I': { typeDeclaration: 'interface', implementers: ['A', 'B', 'C'] },
      })
      assert.strictEqual(
        tryMatchSinkGoInterfacePassthrough('I', { fsig: 'foo', calleeType: 'D' }, ana),
        false
      )
    })

    it('GI-7h: declType 带包前缀 + implementer 精确匹配 rule.calleeType → true', () => {
      const ana = mockAnalyzer({
        'pkg.I': { typeDeclaration: 'interface', implementers: ['pkg.Impl'] },
      })
      assert.strictEqual(
        tryMatchSinkGoInterfacePassthrough('pkg.I', { fsig: 'foo', calleeType: 'pkg.Impl' }, ana),
        true
      )
    })

    it('GI-7i: declType 短名查表（走尾匹配 endsWith(.declType)）→ true', () => {
      const ana = mockAnalyzer({
        'dataprovider.sqlQuerier': { typeDeclaration: 'interface', implementers: ['*sql.DB'] },
      })
      assert.strictEqual(
        tryMatchSinkGoInterfacePassthrough('sqlQuerier', { fsig: 'QueryContext', calleeType: '*sql.DB' }, ana),
        true
      )
    })

    it('GI-7j: rule.calleeType 带 * 前缀，implementer 去前缀后尾匹配 → true', () => {
      const ana = mockAnalyzer({
        'I': { typeDeclaration: 'interface', implementers: ['pkg.Impl'] },
      })
      assert.strictEqual(
        tryMatchSinkGoInterfacePassthrough('I', { fsig: 'foo', calleeType: '*Impl' }, ana),
        true
      )
    })

    it('GI-7k: classHierarchyMap 仅在 analyzer.typeResolver（兼容旧形参）→ 仍能命中', () => {
      // 兼容入口：若外部传入的对象自身没有 classHierarchyMap 但 typeResolver 有，也能走通
      const hierarchy = {
        typeDeclaration: 'interface',
        type: 'I',
        value: null,
        extends: [],
        extendedBy: [],
        implements: [],
        implementedBy: [{ type: '*sql.DB' }],
      }
      const map = new Map<string, any>([['I', hierarchy]])
      const compat = {
        typeResolver: {
          classHierarchyMap: map,
          findSubTypes: (h: any) => h.implementedBy.map((i: any) => i.type),
        },
      }
      assert.strictEqual(
        tryMatchSinkGoInterfacePassthrough('I', { fsig: 'foo', calleeType: '*sql.DB' }, compat),
        true
      )
    })
  })

  describe('matchSinkAtFuncCallWithCalleeType 集成 Go interface 穿透', () => {
    const rules = [{ fsig: 'QueryContext', calleeType: '*sql.DB', args: ['1'], attribute: 'GoSqlInjection' }]

    it('GI-1: amazonsftp 场景 — interface 直调命中 concrete sink', () => {
      // dbHandle.QueryContext(...)，dbHandle 是 sqlQuerier，concrete 是 *sql.DB
      const node = call(member(id('dbHandle'), 'QueryContext'))
      const fclos = mockFclosForInterfaceCall('dbHandle', 'sqlQuerier', 'QueryContext')
      const ana = mockAnalyzer({
        'dataprovider.sqlQuerier': {
          typeDeclaration: 'interface',
          implementers: ['*sql.DB', '*sql.Tx'],
        },
      })
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, undefined, ana)
      assert.strictEqual(matched.length, 1, `期望命中 amazonsftp interface 穿透，实际 ${matched.length}`)
      assert.strictEqual(matched[0].calleeType, '*sql.DB')
    })

    it('GI-2: 传统 concrete receiver 仍走字符串分支（不触发穿透，行为不变）', () => {
      // 直接 *sql.DB.QueryContext(...) — 已有分支命中
      const node = call(member(id('db'), 'QueryContext'))
      const fclos = {
        object: {
          rtype: {
            definiteType: id('*sql.DB'),
            vagueType: id('db'),
          },
        },
        property: id('QueryContext'),
        rtype: {},
      }
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, undefined, undefined)
      // concrete 分支走 rtype.definiteType='*sql.DB' base 匹配 + property='QueryContext' === fsig → 命中
      assert.ok(matched.length >= 1, `传统 concrete 路径应由已有分支命中，实际 ${matched.length}`)
    })

    it('GI-3: 宽接口（> 8 implementers）interface 调用拒绝穿透', () => {
      const node = call(member(id('x'), 'Error'))
      const fclos = mockFclosForInterfaceCall('x', 'error', 'Error')
      const ana = mockAnalyzer({
        error: {
          typeDeclaration: 'interface',
          implementers: Array.from({ length: 9 }, (_, i) => `*pkg.E${i}`),
        },
      })
      const errorRules = [{ fsig: 'Error', calleeType: '*pkg.E1', args: ['0'], attribute: 'X' }]
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, errorRules, null, undefined, ana)
      assert.strictEqual(matched.length, 0, '宽接口穿透应被拒绝')
    })

    it('GI-4: declType 是 struct（非 interface）不触发穿透', () => {
      const node = call(member(id('x'), 'QueryContext'))
      const fclos = mockFclosForInterfaceCall('x', 'MyStruct', 'QueryContext')
      const ana = mockAnalyzer({
        MyStruct: {
          typeDeclaration: 'struct',
          implementers: ['*sql.DB'],
        },
      })
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, undefined, ana)
      assert.strictEqual(matched.length, 0, 'struct 声明类型不应触发 interface 穿透')
    })

    it('GI-5: implementer 列表不含 rule.calleeType 时拒绝穿透', () => {
      const node = call(member(id('x'), 'QueryContext'))
      const fclos = mockFclosForInterfaceCall('x', 'sqlQuerier', 'QueryContext')
      const ana = mockAnalyzer({
        sqlQuerier: {
          typeDeclaration: 'interface',
          implementers: ['*custom.Dialect'], // 与 rule.calleeType '*sql.DB' 无关
        },
      })
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, undefined, ana)
      assert.strictEqual(matched.length, 0, 'implementer 集合不含 rule.calleeType 时应拒绝穿透')
    })

    it('GI-6: 不传 analyzer（非 Go 路径）不触发穿透 — Java/PHP 调用者安全', () => {
      const node = call(member(id('dbHandle'), 'QueryContext'))
      const fclos = mockFclosForInterfaceCall('dbHandle', 'sqlQuerier', 'QueryContext')
      // analyzer=undefined 模拟 Java/PHP 调用
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, undefined, undefined)
      assert.strictEqual(matched.length, 0, '未传 analyzer 不应走 Go 穿透')
    })

    it('GI-8: fsig 不匹配时穿透分支不命中', () => {
      const node = call(member(id('dbHandle'), 'OtherMethod'))
      const fclos = mockFclosForInterfaceCall('dbHandle', 'sqlQuerier', 'OtherMethod')
      const ana = mockAnalyzer({
        sqlQuerier: {
          typeDeclaration: 'interface',
          implementers: ['*sql.DB'],
        },
      })
      const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, null, undefined, ana)
      assert.strictEqual(matched.length, 0, 'fsig 失配时不应命中穿透分支')
    })
  })
})
