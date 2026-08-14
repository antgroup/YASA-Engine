/**
 * gin taint source 字段分配单元测试
 *
 * 覆盖 bug 修复点：prepareEntryPoints 必须把
 * - TaintSource → sources.TaintSource
 * - FuncCallArgTaintSource → sources.FuncCallArgTaintSource
 * - FuncCallReturnValueTaintSource → sources.FuncCallReturnValueTaintSource
 *
 * 修复前：FuncCallArgTaintSource / FuncCallReturnValueTaintSource 都被错 push 到 TaintSource，
 * 导致 ~100 条 gin 规则在 runtime 静默丢失。
 */
import { describe, it, before, after } from 'mocha'
import * as assert from 'assert'

const GinEntryPoint = require('../../src/engine/analyzer/golang/gin/entrypoint-collector/gin-default-entrypoint')
const GinTaintChecker = require('../../src/checker/taint/go/gin-taint-checker')
const GinDefaultTaintChecker = require('../../src/checker/taint/go/gin-default-taint-checker')

interface SourcesShape {
  TaintSource?: any[]
  FuncCallArgTaintSource?: any[]
  FuncCallReturnValueTaintSource?: any[]
}

interface CheckerStub {
  checkerRuleConfigContent: {
    sources?: SourcesShape
    entrypoints?: any[]
  }
}

const TS_RULE = { fsig: 'gin.Context.field', __kind: 'TaintSource' }
const ARG_RULE = { fsig: 'gin.Context.BindJSON', args: [0], __kind: 'FuncCallArgTaintSource' }
const RET_RULE = { fsig: 'gin.Context.Query', __kind: 'FuncCallReturnValueTaintSource' }

const fakeAnalyzer = {
  ruleEntrypoints: [],
  entryPoints: [],
  typeResolver: undefined,
}

const fakeTopScope = {
  context: {
    packages: {},
  },
}

function runPrepareEntryPoints(
  CheckerCtor: any,
  stub: CheckerStub,
  collectedSources: { TaintSource: any[]; FuncCallArgTaintSource: any[]; FuncCallReturnValueTaintSource: any[] }
): void {
  const original = GinEntryPoint.getGinEntryPointAndSource
  const originalDefault = GinEntryPoint.getGinDefaultEntrypoint
  GinEntryPoint.getGinEntryPointAndSource = () => collectedSources
  // gin-default-taint-checker 还会调用 getGinDefaultEntrypoint，单测中返回空数组即可
  GinEntryPoint.getGinDefaultEntrypoint = () => []
  try {
    CheckerCtor.prototype.prepareEntryPoints.call(stub, fakeAnalyzer, fakeTopScope)
  } finally {
    GinEntryPoint.getGinEntryPointAndSource = original
    GinEntryPoint.getGinDefaultEntrypoint = originalDefault
  }
}

describe('gin-taint-checker prepareEntryPoints source 字段分配', () => {
  it('TaintSource 应只 push 到 sources.TaintSource', () => {
    const stub: CheckerStub = { checkerRuleConfigContent: {} }
    runPrepareEntryPoints(GinTaintChecker, stub, {
      TaintSource: [TS_RULE],
      FuncCallArgTaintSource: [],
      FuncCallReturnValueTaintSource: [],
    })
    const s = stub.checkerRuleConfigContent.sources || {}
    assert.deepStrictEqual(s.TaintSource, [TS_RULE])
    assert.ok(s.FuncCallArgTaintSource === undefined || s.FuncCallArgTaintSource.length === 0)
    assert.ok(s.FuncCallReturnValueTaintSource === undefined || s.FuncCallReturnValueTaintSource.length === 0)
  })

  it('FuncCallArgTaintSource 应 push 到 sources.FuncCallArgTaintSource，禁止落入 TaintSource', () => {
    const stub: CheckerStub = { checkerRuleConfigContent: {} }
    runPrepareEntryPoints(GinTaintChecker, stub, {
      TaintSource: [],
      FuncCallArgTaintSource: [ARG_RULE],
      FuncCallReturnValueTaintSource: [],
    })
    const s = stub.checkerRuleConfigContent.sources || {}
    assert.deepStrictEqual(s.FuncCallArgTaintSource, [ARG_RULE])
    assert.ok(
      s.TaintSource === undefined || s.TaintSource.every((r: any) => r.__kind !== 'FuncCallArgTaintSource'),
      'FuncCallArgTaintSource 不应落入 TaintSource'
    )
  })

  it('FuncCallReturnValueTaintSource 应 push 到 sources.FuncCallReturnValueTaintSource，禁止落入 TaintSource', () => {
    const stub: CheckerStub = { checkerRuleConfigContent: {} }
    runPrepareEntryPoints(GinTaintChecker, stub, {
      TaintSource: [],
      FuncCallArgTaintSource: [],
      FuncCallReturnValueTaintSource: [RET_RULE],
    })
    const s = stub.checkerRuleConfigContent.sources || {}
    assert.deepStrictEqual(s.FuncCallReturnValueTaintSource, [RET_RULE])
    assert.ok(
      s.TaintSource === undefined || s.TaintSource.every((r: any) => r.__kind !== 'FuncCallReturnValueTaintSource'),
      'FuncCallReturnValueTaintSource 不应落入 TaintSource'
    )
  })

  it('三类同时存在时分别落入对应字段（无串扰）', () => {
    const stub: CheckerStub = { checkerRuleConfigContent: {} }
    runPrepareEntryPoints(GinTaintChecker, stub, {
      TaintSource: [TS_RULE],
      FuncCallArgTaintSource: [ARG_RULE],
      FuncCallReturnValueTaintSource: [RET_RULE],
    })
    const s = stub.checkerRuleConfigContent.sources || {}
    assert.deepStrictEqual(s.TaintSource, [TS_RULE])
    assert.deepStrictEqual(s.FuncCallArgTaintSource, [ARG_RULE])
    assert.deepStrictEqual(s.FuncCallReturnValueTaintSource, [RET_RULE])
  })

  it('已存在 rule_config 来源时应保留并追加（合并语义）', () => {
    const preExistingArg = { fsig: 'gin.Context.BindYAML', args: [0], __kind: 'preexisting-arg' }
    const preExistingRet = { fsig: 'gin.Context.GetHeader', __kind: 'preexisting-ret' }
    const stub: CheckerStub = {
      checkerRuleConfigContent: {
        sources: {
          FuncCallArgTaintSource: [preExistingArg],
          FuncCallReturnValueTaintSource: [preExistingRet],
        },
      },
    }
    runPrepareEntryPoints(GinTaintChecker, stub, {
      TaintSource: [],
      FuncCallArgTaintSource: [ARG_RULE],
      FuncCallReturnValueTaintSource: [RET_RULE],
    })
    const s = stub.checkerRuleConfigContent.sources || {}
    assert.deepStrictEqual(s.FuncCallArgTaintSource, [preExistingArg, ARG_RULE])
    assert.deepStrictEqual(s.FuncCallReturnValueTaintSource, [preExistingRet, RET_RULE])
  })
})

describe('gin-default-taint-checker prepareEntryPoints source 字段分配', () => {
  it('三类同时存在时分别落入对应字段（无串扰）', () => {
    const stub: CheckerStub = { checkerRuleConfigContent: {} }
    runPrepareEntryPoints(GinDefaultTaintChecker, stub, {
      TaintSource: [TS_RULE],
      FuncCallArgTaintSource: [ARG_RULE],
      FuncCallReturnValueTaintSource: [RET_RULE],
    })
    const s = stub.checkerRuleConfigContent.sources || {}
    assert.deepStrictEqual(s.TaintSource, [TS_RULE])
    assert.deepStrictEqual(s.FuncCallArgTaintSource, [ARG_RULE])
    assert.deepStrictEqual(s.FuncCallReturnValueTaintSource, [RET_RULE])
  })

  it('FuncCallArgTaintSource 与 FuncCallReturnValueTaintSource 不再串扰到 TaintSource', () => {
    const stub: CheckerStub = { checkerRuleConfigContent: {} }
    runPrepareEntryPoints(GinDefaultTaintChecker, stub, {
      TaintSource: [],
      FuncCallArgTaintSource: [ARG_RULE],
      FuncCallReturnValueTaintSource: [RET_RULE],
    })
    const s = stub.checkerRuleConfigContent.sources || {}
    assert.deepStrictEqual(s.FuncCallArgTaintSource, [ARG_RULE])
    assert.deepStrictEqual(s.FuncCallReturnValueTaintSource, [RET_RULE])
    assert.ok(
      s.TaintSource === undefined || s.TaintSource.length === 0,
      `TaintSource 不应再吃到 Arg/Ret 类型，实际：${JSON.stringify(s.TaintSource)}`
    )
  })
})
