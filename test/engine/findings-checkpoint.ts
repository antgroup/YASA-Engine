import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FindingsCheckpointWriter, writeFindingsCheckpoint, combineFindingsFinalizationErrors } from '../../src/engine/analyzer/common/findings-checkpoint'
import { shouldRunOutputStrategies } from '../../src/engine/analyzer/common/findings-checkpoint'
import type { FindingsCheckpointFs } from '../../src/engine/analyzer/common/findings-checkpoint'
import type { IResultManager } from '../../src/engine/analyzer/common/result-manager'

describe('findings checkpoint', () => {
  it('writes a minimal atomic DTO and omits graph fields', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-checkpoint-'))
    const filePath = path.join(directory, 'findings.json')
    const manager: IResultManager = { findings: { taintflow: [{ message: 'x', node: { huge: true }, nested: { ok: 1 } }] }, getFindings() { return this.findings }, clearFindings() {}, newFinding() {} }
    const result = writeFindingsCheckpoint(manager, { filePath, reason: 'timeout' })
    assert.equal(result.status, 'written')
    const document = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { status: string; findings: Record<string, Array<Record<string, unknown>>> }
    assert.equal(document.status, 'partial')
    assert.deepEqual(document.findings.taintflow[0], { message: 'x', nested: { ok: 1 } })
  })

  it('attempts once even when the budget is zero', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-checkpoint-'))
    const filePath = path.join(directory, 'findings.json')
    const manager: IResultManager = { findings: {}, getFindings() { return this.findings }, clearFindings() {}, newFinding() {} }
    const result = writeFindingsCheckpoint(manager, { filePath, reason: 'budget-exhausted', budgetMs: 0 })
    assert.equal(result.status, 'written')
    assert.equal(fs.existsSync(filePath), true)
  })

  it('finalizes at most once', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-checkpoint-'))
    const manager: IResultManager = { findings: {}, getFindings() { return this.findings }, clearFindings() {}, newFinding() {} }
    const writer = new FindingsCheckpointWriter({ filePath: path.join(directory, 'findings.json'), reason: 'timeout' })
    assert.equal(writer.writeOnce(manager).status, 'written')
    assert.equal(writer.writeOnce(manager).status, 'skipped')
  })
  it('retries after a transient persistence failure', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-checkpoint-'))
    const filePath = path.join(directory, 'findings.json')
    let attempts = 0
    const injected: FindingsCheckpointFs = {
      mkdirSync: () => {},
      openSync: () => 1,
      writeSync: () => {},
      fsyncSync: () => { attempts++; if (attempts === 1) throw new Error('temporary disk failure') },
      closeSync: () => {},
      renameSync: () => {},
      unlinkSync: () => {},
    }
    const manager: IResultManager = { findings: {}, getFindings() { return this.findings }, clearFindings() {}, newFinding() {} }
    const writer = new FindingsCheckpointWriter({ filePath, reason: 'timeout' })
    assert.equal(writer.writeOnce(manager, injected).error?.retriable, true)
    assert.equal(writer.writeOnce(manager, injected).status, 'written')
    assert.equal(writer.writeOnce(manager, injected).status, 'skipped')
    assert.equal(attempts, 2)
  })
  it('does not turn a non-retriable rename failure into a skipped success', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-checkpoint-'))
    const filePath = path.join(directory, 'findings.json')
    const injected: FindingsCheckpointFs = {
      mkdirSync: () => {}, openSync: () => 1, writeSync: () => {}, fsyncSync: () => {}, closeSync: () => {},
      renameSync: () => { throw new Error('rename denied') }, unlinkSync: () => {},
    }
    const manager: IResultManager = { findings: {}, getFindings() { return this.findings }, clearFindings() {}, newFinding() {} }
    const writer = new FindingsCheckpointWriter({ filePath, reason: 'timeout' })
    assert.equal(writer.writeOnce(manager, injected).error?.retriable, false)
    assert.equal(writer.writeOnce(manager, injected).status, 'skipped')
  })
  it('uses a same-directory temporary path and classifies fsync failure', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-checkpoint-'))
    const filePath = path.join(directory, 'findings.json')
    const calls: string[] = []
    const injected: FindingsCheckpointFs = { mkdirSync: () => {}, openSync: file => { calls.push(file); return 1 }, writeSync: () => {}, fsyncSync: () => { throw new Error('disk') }, closeSync: () => {}, renameSync: () => {}, unlinkSync: file => { calls.push(file) } }
    const manager: IResultManager = { findings: {}, getFindings() { return this.findings }, clearFindings() {}, newFinding() {} }
    const result = writeFindingsCheckpoint(manager, { filePath, reason: 'timeout' }, injected)
    assert.equal(result.error?.code, 'fsync_failed')
    assert.equal(calls[0].startsWith(directory), true)
    assert.equal(calls.some(file => file.endsWith('.tmp')), true)
  })

  it('classifies rename failure and cleans temporary path', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-checkpoint-'))
    const filePath = path.join(directory, 'findings.json'); fs.writeFileSync(filePath, 'old')
    let temporary = ''; let removed = ''
    const injected: FindingsCheckpointFs = { mkdirSync: () => {}, openSync: file => { temporary = file; return 1 }, writeSync: () => {}, fsyncSync: () => {}, closeSync: () => {}, renameSync: () => { throw new Error('no') }, unlinkSync: file => { temporary = file; removed = file } }
    const manager: IResultManager = { findings: {}, getFindings() { return this.findings }, clearFindings() {}, newFinding() {} }
    const result = writeFindingsCheckpoint(manager, { filePath, reason: 'timeout' }, injected)
    assert.equal(result.error?.code, 'rename_failed'); assert.equal(fs.readFileSync(filePath, 'utf8'), 'old'); assert.notEqual(temporary, ''); assert.equal(removed, temporary); assert.equal(temporary.endsWith('.tmp'), true)
  })

  it('does not start output strategies after timeout checkpoint', () => {
    assert.equal(shouldRunOutputStrategies('timeout'), false)
    assert.equal(shouldRunOutputStrategies('budget-expired'), false)
    assert.equal(shouldRunOutputStrategies('budget-exhausted'), false)
    assert.equal(shouldRunOutputStrategies('normal'), true)
  })

  it('combines scheduling and persistence errors independently', () => {
    const schedulingError = { code: 'unknown' as const, message: 'schedule', retriable: false }
    const persistenceError = { code: 'write_failed' as const, message: 'persist', retriable: true }
    assert.deepEqual(combineFindingsFinalizationErrors(schedulingError, undefined).schedulingError, schedulingError)
    assert.deepEqual(combineFindingsFinalizationErrors(undefined, persistenceError).persistenceError, persistenceError)
    const both = combineFindingsFinalizationErrors(schedulingError, persistenceError)
    assert.deepEqual(both.schedulingError, schedulingError); assert.deepEqual(both.persistenceError, persistenceError)
  })

})
