/**
 * callargs 体系单元测试
 *
 * callArgs 将函数调用参数结构化为 CallArg（含 kind/name/value），支持 positional / keyword /
 * spread / kwspread 四种参数类型，替代旧的位置数组 argvalues。数据流分三层：
 *
 *   调用侧构建               形参绑定                checker 消费
 *   buildCallArgs ──→ bindCallArgs ──→ prepareArgs(normalizeSelectors)
 *        ↓                  ↓                   ↓
 *     CallArgs           BoundCall           筛选出的 value[]
 *
 * 测试围绕这三层设计：
 * 1. call-args.ts 工具函数 — CallInfo 字段提取与向后兼容
 * 2. Analyzer 方法 — buildCallArgs 构建 + bindCallArgs 绑定（positional/keyword/vararg/varkw/receiver）
 * 3. prepareArgs — 按 selector（position/keyword/all）从 CallArgs 中筛选参数，供 checker 使用
 *
 * fixture 设计：一个 callInfo 同时包含 positional + keyword + receiver + boundCall，
 * 各用例通过不同 rule 组合验证筛选行为。
 */
import { describe, it } from 'mocha'
import * as assert from 'assert'
import {
  getLegacyArgValues,
  getExplicitArgCount,
  getCallArgsFromInfo,
  getBoundCallFromInfo,
  type CallInfo,
  type CallArgs,
  type BoundCall,
} from '../../src/engine/analyzer/common/call-args'

const Analyzer = require('../../src/engine/analyzer/common/analyzer')
const { prepareArgs } = require('../../src/checker/common/rules-basic-handler')
const { matchSinkAtFuncCall } = require('../../src/checker/taint/common-kit/sink-util')

// ========================= 测试 fixture =========================

/** 模拟 f(val_0, data=val_1, val_2, key=val_3) 的调用参数 */
function makeCallArgs(): CallArgs {
  return {
    receiver: { sid: 'self_obj' },
    args: [
      { index: 0, value: 'val_0', kind: 'positional' },
      { index: 1, value: 'val_1', name: 'data', kind: 'keyword' },
      { index: 2, value: 'val_2', kind: 'positional' },
      { index: 3, value: 'val_3', name: 'key', kind: 'keyword' },
    ],
  }
}

/** 模拟 def f(a, data, b, **kwargs) 绑定后的 boundCall */
function makeBoundCall(): BoundCall {
  return {
    receiver: { sid: 'self_obj' },
    params: [
      { index: 0, name: 'a', value: 'val_0', provided: true, argIndexes: [0] },
      { index: 1, name: 'data', value: 'val_1', provided: true, argIndexes: [1] },
      { index: 2, name: 'b', value: 'val_2', provided: true, argIndexes: [2] },
      { index: 3, name: 'kwargs', value: { key: 'val_3' }, provided: true, argIndexes: [3] },
    ],
  }
}

function makeCallInfo(): CallInfo {
  return { callArgs: makeCallArgs(), boundCall: makeBoundCall() }
}

/** 含 spread 的 callArgs：f(val_0, *[val_s1, val_s2], key=val_k) */
function makeCallArgsWithSpread(): CallArgs {
  return {
    args: [
      { index: 0, value: 'val_0', kind: 'positional' },
      { index: 1, value: ['val_s1', 'val_s2'], kind: 'spread' },
      { index: 2, value: 'val_k', name: 'key', kind: 'keyword' },
    ],
  }
}

// ========================= 第 1 层：call-args.ts 工具函数 =========================
// CallInfo 的字段提取与向后兼容（getLegacyArgValues / getExplicitArgCount 等）

describe('call-args 工具函数', function () {
  describe('getLegacyArgValues', function () {
    it('callInfo undefined → 空数组', function () {
      assert.deepStrictEqual(getLegacyArgValues(undefined), [])
    })

    it('callInfo.callArgs undefined → 空数组', function () {
      assert.deepStrictEqual(getLegacyArgValues({} as CallInfo), [])
    })

    it('正常 callArgs → 提取 value 数组', function () {
      const info = makeCallInfo()
      assert.deepStrictEqual(getLegacyArgValues(info), ['val_0', 'val_1', 'val_2', 'val_3'])
    })

    it('传入数组（旧路径已移除） → 空数组', function () {
      const arr = ['a', 'b']
      assert.deepStrictEqual(getLegacyArgValues(arr as any), [])
    })
  })

  describe('getExplicitArgCount', function () {
    it('undefined → 0', function () {
      assert.strictEqual(getExplicitArgCount(undefined), 0)
    })

    it('4 个 positional+keyword → 4', function () {
      assert.strictEqual(getExplicitArgCount(makeCallInfo()), 4)
    })

    it('含 spread → 排除 spread/kwspread', function () {
      const info: CallInfo = { callArgs: makeCallArgsWithSpread() }
      // 3 个 args 中 1 个 spread → 排除 → 2
      assert.strictEqual(getExplicitArgCount(info), 2)
    })
  })

  describe('getCallArgsFromInfo / getBoundCallFromInfo', function () {
    it('undefined → undefined', function () {
      assert.strictEqual(getCallArgsFromInfo(undefined), undefined)
      assert.strictEqual(getBoundCallFromInfo(undefined), undefined)
    })

    it('正常 → 返回对应字段', function () {
      const info = makeCallInfo()
      assert.strictEqual(getCallArgsFromInfo(info), info.callArgs)
      assert.strictEqual(getBoundCallFromInfo(info), info.boundCall)
    })
  })
})

// ========================= 第 2 层：Analyzer 构建与绑定 =========================
// buildCallArgs: node + argvalues → CallArgs（标记 kind/name）
// bindCallArgs: CallArgs + fdecl.parameters → BoundCall（形参绑定）
// getParamKind: 判定形参类型（vararg/varkw/keyword_only 等），决定绑定策略
// resolveSpreadValues / resolveKwSpreadEntries: 展开 *args/**kwargs 值

describe('Analyzer callargs 方法', function () {
  let analyzer: any

  before(function () {
    analyzer = new Analyzer(null)
  })

  describe('buildCallArgs', function () {
    it('positional 参数 → kind=positional', function () {
      const node = { arguments: [{ type: 'Literal' }] }
      const result = analyzer.buildCallArgs(node, ['v1'], {})
      assert.strictEqual(result.args.length, 1)
      assert.strictEqual(result.args[0].kind, 'positional')
      assert.strictEqual(result.args[0].value, 'v1')
      assert.strictEqual(result.args[0].index, 0)
    })

    it('keyword 参数（node.names） → kind=keyword + name', function () {
      const node = { arguments: [{ type: 'Literal' }, { type: 'Literal' }], names: [undefined, 'data'] }
      const result = analyzer.buildCallArgs(node, ['v1', 'v2'], {})
      assert.strictEqual(result.args[0].kind, 'positional')
      assert.strictEqual(result.args[1].kind, 'keyword')
      assert.strictEqual(result.args[1].name, 'data')
    })

    it('MemberAccess → receiver 绑定', function () {
      const node = { callee: { type: 'MemberAccess' }, arguments: [] }
      const fclos = { _this: { sid: 'obj' } }
      const result = analyzer.buildCallArgs(node, [], fclos)
      assert.deepStrictEqual(result.receiver, { sid: 'obj' })
    })

    it('非 MemberAccess → receiver undefined', function () {
      const node = { callee: { type: 'Identifier' }, arguments: [] }
      const result = analyzer.buildCallArgs(node, [], {})
      assert.strictEqual(result.receiver, undefined)
    })
  })

  describe('getParamKind', function () {
    it('普通参数 → positional_or_keyword', function () {
      assert.strictEqual(analyzer.getParamKind({ id: { name: 'x' } }), 'positional_or_keyword')
    })

    it('_meta.varkw → varkw', function () {
      assert.strictEqual(analyzer.getParamKind({ _meta: { varkw: true } }), 'varkw')
    })

    it('_meta.isRestElement → vararg', function () {
      assert.strictEqual(analyzer.getParamKind({ _meta: { isRestElement: true } }), 'vararg')
    })

    it('_meta.keyword_only → keyword_only', function () {
      assert.strictEqual(analyzer.getParamKind({ _meta: { keyword_only: true } }), 'keyword_only')
    })

    it('_meta.positional_only → positional_only', function () {
      assert.strictEqual(analyzer.getParamKind({ _meta: { positional_only: true } }), 'positional_only')
    })

    it('_meta.parameterKind 优先', function () {
      assert.strictEqual(analyzer.getParamKind({ _meta: { parameterKind: 'vararg', varkw: true } }), 'vararg')
    })

    it('Java varargs via varType._meta.varargs → vararg', function () {
      assert.strictEqual(
        analyzer.getParamKind({ id: { name: 'params' }, varType: { _meta: { varargs: true } } }),
        'vararg'
      )
    })
  })

  describe('bindCallArgs', function () {
    it('positional 参数按顺序绑定', function () {
      const node = {}
      const fclos = {}
      const fdecl = { parameters: [{ id: { name: 'a' } }, { id: { name: 'b' } }] }
      const callInfo: CallInfo = {
        callArgs: { args: [
          { index: 0, value: 'v1', kind: 'positional' },
          { index: 1, value: 'v2', kind: 'positional' },
        ] },
      }
      const bound = analyzer.bindCallArgs(node, fclos, fdecl, callInfo)
      assert.strictEqual(bound.params[0].value, 'v1')
      assert.strictEqual(bound.params[0].provided, true)
      assert.strictEqual(bound.params[1].value, 'v2')
    })

    it('keyword 参数按名绑定', function () {
      const fdecl = { parameters: [{ id: { name: 'a' } }, { id: { name: 'data' } }] }
      const callInfo: CallInfo = {
        callArgs: { args: [
          { index: 0, value: 'v_data', name: 'data', kind: 'keyword' },
        ] },
      }
      const bound = analyzer.bindCallArgs({}, {}, fdecl, callInfo)
      assert.strictEqual(bound.params[0].provided, false) // a 未提供
      assert.strictEqual(bound.params[1].value, 'v_data') // data 按名绑定
      assert.strictEqual(bound.params[1].provided, true)
    })

    it('vararg 参数收集为数组', function () {
      const fdecl = { parameters: [
        { id: { name: 'a' } },
        { id: { name: 'args' }, _meta: { isRestElement: true } },
      ] }
      const callInfo: CallInfo = {
        callArgs: { args: [
          { index: 0, value: 'v1', kind: 'positional' },
          { index: 1, value: 'v2', kind: 'positional' },
          { index: 2, value: 'v3', kind: 'positional' },
        ] },
      }
      const bound = analyzer.bindCallArgs({}, {}, fdecl, callInfo)
      assert.strictEqual(bound.params[0].value, 'v1')
      assert.deepStrictEqual(bound.params[1].value, ['v2', 'v3'])
    })

    it('varkw 参数收集 keyword 为对象', function () {
      const fdecl = { parameters: [
        { id: { name: 'a' } },
        { id: { name: 'kwargs' }, _meta: { varkw: true } },
      ] }
      const callInfo: CallInfo = {
        callArgs: { args: [
          { index: 0, value: 'v1', kind: 'positional' },
          { index: 1, value: 'v_data', name: 'data', kind: 'keyword' },
          { index: 2, value: 'v_key', name: 'key', kind: 'keyword' },
        ] },
      }
      const bound = analyzer.bindCallArgs({}, {}, fdecl, callInfo)
      assert.strictEqual(bound.params[0].value, 'v1')
      assert.strictEqual(bound.params[1].provided, true)
      assert.strictEqual(bound.params[1].value.data, 'v_data')
      assert.strictEqual(bound.params[1].value.key, 'v_key')
    })

    it('receiver 绑定到 self 参数', function () {
      const fdecl = { parameters: [{ id: { name: 'self' } }, { id: { name: 'x' } }] }
      const callInfo: CallInfo = {
        callArgs: {
          receiver: { sid: 'self_obj' },
          args: [{ index: 0, value: 'v1', kind: 'positional' }],
        },
      }
      const bound = analyzer.bindCallArgs({}, {}, fdecl, callInfo)
      assert.deepStrictEqual(bound.params[0].value, { sid: 'self_obj' })
      assert.strictEqual(bound.params[1].value, 'v1') // positional 从 index 1 开始
    })

    it('fdecl.parameters 为空 → 空 boundCall', function () {
      const bound = analyzer.bindCallArgs({}, {}, {}, { callArgs: { args: [] } })
      assert.strictEqual(bound.params.length, 0)
    })
  })

  describe('resolveSpreadValues', function () {
    it('数组 → 原样', function () {
      assert.deepStrictEqual(analyzer.resolveSpreadValues([1, 2]), [1, 2])
    })

    it('_field 为数组 → 返回 _field', function () {
      assert.deepStrictEqual(analyzer.resolveSpreadValues({ _field: [1, 2] }), [1, 2])
    })

    it('_field 为对象（数字键） → 按数字键排序', function () {
      assert.deepStrictEqual(analyzer.resolveSpreadValues({ _field: { '0': 'a', '1': 'b' } }), ['a', 'b'])
    })

    it('其他 → 包装为单元素数组', function () {
      assert.deepStrictEqual(analyzer.resolveSpreadValues('x'), ['x'])
    })
  })

  describe('resolveKwSpreadEntries', function () {
    it('undefined → 空数组', function () {
      assert.deepStrictEqual(analyzer.resolveKwSpreadEntries(undefined), [])
    })

    it('对象 → [key, value] 对', function () {
      const entries = analyzer.resolveKwSpreadEntries({ a: 1, b: 2 })
      assert.deepStrictEqual(entries, [['a', 1], ['b', 2]])
    })

    it('_field 对象 → 展开 _field', function () {
      const entries = analyzer.resolveKwSpreadEntries({ _field: { x: 10, y: 20 } })
      assert.deepStrictEqual(entries, [['x', 10], ['y', 20]])
    })
  })
})

// ========================= 第 3 层：checker 消费端 =========================
// normalizeSelectors: 统一 rule 中的 selectors/args/positions/keywordNames/includeReceiver 为标准格式
// prepareArgs: 按 selector 从 callArgs.args 筛选参数值，供 sink/source/sanitizer checker 使用
// 支持 position（按索引）/ keyword（按参数名）/ all（全部）三种筛选模式 + paramNames 兼容路径

describe('prepareArgs（含 normalizeSelectors 间接覆盖）', function () {
  const callInfo = makeCallInfo()
  const fclos = { getThisObj: () => ({ sid: 'this_obj' }) }

  it('keyword selector → 按参数名筛选', function () {
    const rule = { selectors: [{ type: 'keyword', name: 'data' }] }
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, rule), ['val_1'])
  })

  it('keyword selector 多个 → 各自匹配', function () {
    const rule = { selectors: [{ type: 'keyword', name: 'data' }, { type: 'keyword', name: 'key' }] }
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, rule), ['val_1', 'val_3'])
  })

  it('keyword selector 不存在的名字 → 空', function () {
    const rule = { selectors: [{ type: 'keyword', name: 'nonexist' }] }
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, rule), [])
  })

  it('position selector → 按索引筛选', function () {
    const rule = { selectors: [{ type: 'position', index: 0 }] }
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, rule), ['val_0'])
  })

  it('position selector 多个 → 各自匹配', function () {
    const rule = { selectors: [{ type: 'position', index: 0 }, { type: 'position', index: 2 }] }
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, rule), ['val_0', 'val_2'])
  })

  it('all selector (index=*) → 全部参数', function () {
    const rule = { selectors: [{ type: 'position', index: '*' }] }
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, rule), ['val_0', 'val_1', 'val_2', 'val_3'])
  })

  it('receiver (includeReceiver) → callArgs.receiver', function () {
    const rule = { includeReceiver: true }
    const result = prepareArgs(callInfo, fclos, rule)
    assert.deepStrictEqual(result, [{ sid: 'self_obj' }])
  })

  it('旧格式 args 数字索引 → 按位置筛选', function () {
    const rule = { args: ['0', '2'] }
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, rule), ['val_0', 'val_2'])
  })

  it('旧格式 args 通配 → 全部', function () {
    const rule = { args: ['*'] }
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, rule), ['val_0', 'val_1', 'val_2', 'val_3'])
  })

  it('keywordNames → 按 keyword 追加', function () {
    const rule = { keywordNames: ['key'] }
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, rule), ['val_3'])
  })

  it('paramNames 兼容路径 → 通过 boundCall 形参名匹配', function () {
    const rule = { paramNames: ['data'] }
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, rule), ['val_1'])
  })

  it('paramNames self → 返回 receiver', function () {
    const rule = { paramNames: ['self'] }
    const result = prepareArgs(callInfo, fclos, rule)
    assert.deepStrictEqual(result, [{ sid: 'self_obj' }])
  })

  it('callInfo undefined → 空数组', function () {
    assert.deepStrictEqual(prepareArgs(undefined, fclos, { args: ['*'] }), [])
  })

  it('空 rule → 空数组', function () {
    assert.deepStrictEqual(prepareArgs(callInfo, fclos, {}), [])
  })

  it('混合 selectors + keywordNames → 合并去重', function () {
    const rule = {
      selectors: [{ type: 'keyword', name: 'data' }],
      keywordNames: ['data', 'key'],
    }
    const result = prepareArgs(callInfo, fclos, rule)
    // data 被 selectors 和 keywordNames 都选中，但去重
    assert.deepStrictEqual(result, ['val_1', 'val_3'])
  })

  it('receiver 回退到 fclos.getThisObj', function () {
    const noReceiverInfo: CallInfo = { callArgs: { args: [] } }
    const rule = { includeReceiver: true }
    const result = prepareArgs(noReceiverInfo, fclos, rule)
    assert.deepStrictEqual(result, [{ sid: 'this_obj' }])
  })

  it('旧格式数组（legacy）→ 空数组（不再支持）', function () {
    const legacyArray = [{ sid: 'v1' }, { sid: 'v2' }]
    assert.deepStrictEqual(prepareArgs(legacyArray, fclos, { args: ['*'] }), [])
    assert.deepStrictEqual(prepareArgs(legacyArray, fclos, { args: [0] }), [])
  })

  it('position selector 结果不受 boundCall 有无影响', function () {
    const withBound = makeCallInfo()
    const withoutBound: CallInfo = { callArgs: makeCallArgs() }
    const rule = { selectors: [{ type: 'position', index: 0 }] }
    assert.deepStrictEqual(prepareArgs(withBound, fclos, rule), ['val_0'])
    assert.deepStrictEqual(prepareArgs(withoutBound, fclos, rule), ['val_0'])
  })
})

// ========================= 第 4 层：sink 匹配 =========================
// matchSinkAtFuncCall: 按 fsig + argNum 匹配 sink 规则

describe('matchSinkAtFuncCall', function () {
  it('argNum 按显式参数数量匹配（不含 boundCall slots）', function () {
    const callInfo: CallInfo = {
      callArgs: {
        receiver: { sid: 'receiver' },
        args: [{ index: 0, value: true, name: 'core_mode', kind: 'keyword' as const }],
      },
      boundCall: {
        params: [
          { index: 0, name: 'self', value: { sid: 'receiver' }, provided: true, argIndexes: [] },
          { index: 1, name: 'config_path', provided: false, argIndexes: [] },
          { index: 2, name: 'core_mode', value: true, provided: true, argIndexes: [0] },
        ],
      },
    }
    // 显式参数 1 个（不含 spread/kwspread），argNum=1 应匹配
    const matched = matchSinkAtFuncCall(
      { callee: { type: 'Identifier', name: 'start' } },
      { sid: 'start' },
      [{ fsig: 'start', argNum: 1 }],
      callInfo
    )
    assert.strictEqual(matched.length, 1)
  })

  it('argNum 不匹配时跳过', function () {
    const callInfo: CallInfo = {
      callArgs: { args: [{ index: 0, value: 'v1', kind: 'positional' as const }] },
    }
    const matched = matchSinkAtFuncCall(
      { callee: { type: 'Identifier', name: 'fn' } },
      { sid: 'fn' },
      [{ fsig: 'fn', argNum: 3 }],
      callInfo
    )
    assert.strictEqual(matched.length, 0)
  })
})
