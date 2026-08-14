import { describe, it } from 'mocha'
import * as path from 'path'
import * as fs from 'fs'
import * as assert from 'assert'

// 单入口内存护栏 flush 单元测试：手工塞入 finding 验证 flushFindingsToReport 正确产出 sarif
import { flushFindingsToReport, createMemoryGuardState, resetForEntryPoint, probeMemoryAndUpdate } from '../../src/engine/analyzer/common/memory-guard/entrypoint-memory-guard'

describe('memory-guard unit', function () {
  this.timeout(60000)

  it('flushFindingsToReport writes sarif when resultManager has findings', function () {
    const reportDir = path.resolve(__dirname, 'report-memory-guard-unit')
    if (fs.existsSync(reportDir)) {
      fs.rmSync(reportDir, { recursive: true })
    }
    fs.mkdirSync(reportDir, { recursive: true })

    // 构造极简 ResultManager：findings['taintflow'] = [finding]
    const fakeFinding = {
      type: 'taint_flow_test',
      line: 1,
      node: { loc: { sourcefile: 'fake.py', start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }, _meta: { nodehash: 'fake' } },
      issuecause: 'unit-test',
      entry_fclos: { qid: 'fake.qid' },
      entrypoint: { attribute: ['test'] },
      sinkAttribute: ['test'],
      matchedSanitizerTags: [],
      argNode: undefined,
      trace: [{ file: 'fake.py', line: 1, tag: 'TEST', str: 'unit test', affectedNodeName: 'fake' }],
    }
    const resultManager = {
      findings: { taintflow: [fakeFinding] },
      getFindings() { return this.findings },
      clearFindings() { this.findings = {} },
      newFinding(f: any) { (this.findings.taintflow ||= []).push(f) },
    }

    const Config = require('../../src/config')
    Config.reportDir = reportDir
    const total = flushFindingsToReport(resultManager as any, Config)
    assert.ok(total > 0, `expected flush to write findings, got total=${total}`)
    const sarifPath = path.join(reportDir, 'report.sarif')
    assert.ok(fs.existsSync(sarifPath), 'sarif file should exist after flush')
    const sarif = JSON.parse(fs.readFileSync(sarifPath, 'utf-8'))
    const results = sarif?.runs?.[0]?.results ?? []
    assert.ok(results.length > 0, `expected sarif results > 0, got ${results.length}`)
    console.error(`[unit] flush OK: total=${total}, sarif results=${results.length}`)
  })

  it('flushFindingsToReport returns 0 without writing sarif when resultManager is empty', function () {
    const reportDir = path.resolve(__dirname, 'report-memory-guard-unit-empty')
    if (fs.existsSync(reportDir)) {
      fs.rmSync(reportDir, { recursive: true })
    }
    fs.mkdirSync(reportDir, { recursive: true })
    const resultManager = {
      findings: {},
      getFindings() { return this.findings },
      clearFindings() { this.findings = {} },
      newFinding() {},
    }
    const Config = require('../../src/config')
    Config.reportDir = reportDir
    const total = flushFindingsToReport(resultManager as any, Config)
    assert.strictEqual(total, 0)
    const sarifPath = path.join(reportDir, 'report.sarif')
    assert.ok(!fs.existsSync(sarifPath), 'no sarif should be written for empty findings')
    console.error('[unit] empty-flush OK: total=0, no sarif')
  })

  it('probeMemoryAndUpdate respects 200ms throttle and sets exceeded over limit', function () {
    // 用极小 limit 模拟超阈
    const state = createMemoryGuardState()
    state.enabled = true
    state.limitMb = 0 // 1 byte limit — 任何 heapUsed 都超阈
    resetForEntryPoint(state, 'test-ep', 0)
    // 第一次探测：超阈 → exceeded=true
    const first = probeMemoryAndUpdate(state, 0)
    assert.strictEqual(first, true, 'first probe should exceed limit')
    assert.strictEqual(state.exceeded, true)
    // 后续节流窗口内调用：cached exceeded=true
    const next = probeMemoryAndUpdate(state, 100)
    assert.strictEqual(next, true, 'throttled call should return cached exceeded')
    console.error('[unit] probe-throttle OK')
  })

  it('disabled guard never aborts', function () {
    const state = createMemoryGuardState()
    state.enabled = false
    state.limitMb = 0
    resetForEntryPoint(state, 'test-ep', 0)
    const r = probeMemoryAndUpdate(state, 0)
    assert.strictEqual(r, false, 'disabled guard should never abort')
    assert.strictEqual(state.exceeded, false)
    console.error('[unit] disabled-guard OK')
  })
})