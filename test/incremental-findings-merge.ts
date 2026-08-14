import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildFindingsIndexFromSarif,
  mergeSarifFindingFiles,
  mergeSarifFindings,
  type EpChangesDocument,
  type SarifLog,
  type SarifResult,
} from '../src/util/incremental-findings'

function result(ruleId: string, entrypointKey: string, sinkLine: number, sourceLine: number, traceTag: string): SarifResult {
  const file = `${entrypointKey.split('|')[0]}`
  return {
    ruleId,
    level: 'error',
    message: { text: `${ruleId}:${entrypointKey}` },
    entrypoint: { entrypointKey, filePath: file, functionName: entrypointKey.split('|')[1] },
    locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: sinkLine, endLine: sinkLine } } }],
    codeFlows: [{
      threadFlows: [{
        locations: [
          { location: { message: { text: traceTag }, physicalLocation: { artifactLocation: { uri: file }, region: { startLine: sourceLine, endLine: sourceLine } } } },
          { location: { message: { text: 'sink' }, physicalLocation: { artifactLocation: { uri: file }, region: { startLine: sinkLine, endLine: sinkLine } } } },
        ],
      }],
    }],
  }
}

function sarif(results: SarifResult[]): SarifLog {
  return { version: '2.1.0', runs: [{ tool: { driver: { name: 'yasa' } }, results }] }
}

const epUnaffected = 'src/a.ts|keep|ENTRY|1|10|GET /keep'
const epModified = 'src/b.ts|change|ENTRY|11|20|GET /change'
const epDeleted = 'src/c.ts|gone|ENTRY|21|30|GET /gone'
const epAdded = 'src/d.ts|new|ENTRY|31|40|GET /new'

describe('incremental findings index and SARIF merge', function () {
  it('generates stable finding index from SARIF result contents', function () {
    const base = sarif([result('rule-a', epUnaffected, 8, 2, 'source')])
    const indexA = buildFindingsIndexFromSarif(base, 'demo', 'base')
    const indexB = buildFindingsIndexFromSarif(base, 'demo', 'base')

    assert.strictEqual(indexA.findings.length, 1)
    assert.strictEqual(indexA.findings[0].findingId, indexB.findings[0].findingId)
    assert.strictEqual(indexA.findings[0].entrypointKey, epUnaffected)
    assert.strictEqual(indexA.findings[0].sarifResultIndex, 0)
    assert.strictEqual(indexA.findings[0].status, 'active')
    assert.match(indexA.findings[0].traceDigest, /^[a-f0-9]{40}$/)
  })

  it('keeps unaffected, replaces modified, appends added, and resolves deleted findings', function () {
    const base = sarif([
      result('rule-keep', epUnaffected, 8, 2, 'base-keep'),
      result('rule-change-old', epModified, 18, 12, 'base-old'),
      result('rule-gone', epDeleted, 28, 22, 'base-gone'),
    ])
    const selected = sarif([
      result('rule-change-new', epModified, 19, 12, 'selected-new'),
      result('rule-added', epAdded, 38, 32, 'selected-added'),
    ])
    const epChanges: EpChangesDocument = {
      epChanges: [
        { status: 'modified', epKey: epModified },
        { status: 'added', epKey: epAdded },
        { status: 'deleted', epKey: epDeleted },
      ],
    }

    const outputs = mergeSarifFindings(
      base,
      buildFindingsIndexFromSarif(base, 'demo', 'base'),
      selected,
      buildFindingsIndexFromSarif(selected, 'demo', 'head'),
      epChanges
    )

    const finalResults = outputs.sarif.runs?.[0]?.results ?? []
    assert.deepStrictEqual(finalResults.map(item => item.ruleId), ['rule-keep', 'rule-change-new', 'rule-added'])
    assert.strictEqual(outputs.findingsIndex.findings.length, 3)
    assert.deepStrictEqual(outputs.findingsIndex.findings.map(item => item.sarifResultIndex), [0, 1, 2])
    assert.strictEqual(outputs.summary.counts.keptUnaffected, 1)
    assert.strictEqual(outputs.summary.counts.removedModified, 1)
    assert.strictEqual(outputs.summary.counts.resolvedDeleted, 1)
    assert.strictEqual(outputs.auditLog.some(item => item.action === 'resolved_deleted' && item.entrypointKey === epDeleted), true)
  })

  it('replaces base findings when change key has range but SARIF key omits range', function () {
    const baseKeyWithoutRange = 'src/service.py|stream_output_sync|functionCall|||AREC'
    const selectedKeyWithRange = 'src/service.py|stream_output_sync|functionCall|88|96|AREC'
    const base = sarif([result('rule-old', baseKeyWithoutRange, 92, 90, 'base-old')])
    const selected = sarif([result('rule-new', selectedKeyWithRange, 93, 91, 'selected-new')])
    const epChanges: EpChangesDocument = {
      epChanges: [{ status: 'modified', epKey: selectedKeyWithRange }],
    }

    const outputs = mergeSarifFindings(
      base,
      buildFindingsIndexFromSarif(base, 'demo', 'base'),
      selected,
      buildFindingsIndexFromSarif(selected, 'demo', 'head'),
      epChanges
    )

    const finalResults = outputs.sarif.runs?.[0]?.results ?? []
    assert.deepStrictEqual(finalResults.map(item => item.ruleId), ['rule-new'])
    assert.strictEqual(outputs.summary.counts.keptUnaffected, 0)
    assert.strictEqual(outputs.summary.counts.removedModified, 1)
    assert.strictEqual(outputs.summary.counts.addedOrModifiedNew, 1)
    assert.strictEqual(outputs.summary.counts.finalFindings, 1)
    assert.strictEqual(outputs.auditLog.some(item => item.action === 'removed_for_rerun' && item.entrypointKey === baseKeyWithoutRange), true)
  })

  it('merges 30 entrypoints with 15 modified rerun results', function () {
    const entrypointKey = (index: number): string => `src/api${index}.ts|handler${index}|ENTRY|${10 + index}|${20 + index}|GET /api${index}`
    const base = sarif(Array.from({ length: 30 }, (_, index) => result(`base-rule-${index}`, entrypointKey(index), 15 + index, 14 + index, `base-${index}`)))
    const selected = sarif(Array.from({ length: 15 }, (_, index) => result(`selected-rule-${index}`, entrypointKey(index), 15 + index, 14 + index, `selected-${index}`)))
    const epChanges: EpChangesDocument = {
      epChanges: Array.from({ length: 15 }, (_, index) => ({ status: 'modified', epKey: entrypointKey(index) })),
    }

    const outputs = mergeSarifFindings(
      base,
      buildFindingsIndexFromSarif(base, 'demo', 'base'),
      selected,
      buildFindingsIndexFromSarif(selected, 'demo', 'head'),
      epChanges
    )
    const finalResults = outputs.sarif.runs?.[0]?.results ?? []

    assert.strictEqual(finalResults.length, 30)
    assert.strictEqual(outputs.findingsIndex.findings.length, 30)
    assert.strictEqual(outputs.summary.counts.baseFindings, 30)
    assert.strictEqual(outputs.summary.counts.selectedFindings, 15)
    assert.strictEqual(outputs.summary.counts.finalFindings, 30)
    assert.strictEqual(outputs.summary.counts.keptUnaffected, 15)
    assert.strictEqual(outputs.summary.counts.removedModified, 15)
    assert.strictEqual(outputs.summary.counts.addedOrModifiedNew, 15)
    assert.strictEqual(finalResults.filter(item => item.ruleId?.startsWith('base-rule-')).length, 15)
    assert.strictEqual(finalResults.filter(item => item.ruleId?.startsWith('selected-rule-')).length, 15)
  })

  it('uses full head SARIF when unknown status triggers fallback', function () {
    const base = sarif([result('rule-keep', epUnaffected, 8, 2, 'base-keep')])
    const fullHead = sarif([result('rule-full', epModified, 18, 12, 'full-head')])
    const outputs = mergeSarifFindings(
      base,
      buildFindingsIndexFromSarif(base),
      fullHead,
      buildFindingsIndexFromSarif(fullHead),
      { epChanges: [{ status: 'unknown', reasons: ['path map failed'] }] }
    )

    assert.strictEqual(outputs.summary.mode, 'full-fallback')
    assert.deepStrictEqual(outputs.sarif, fullHead)
    assert.strictEqual(outputs.sarif.runs?.[0]?.results?.[0]?.ruleId, 'rule-full')
    assert.strictEqual(outputs.auditLog[0].action, 'full_fallback')
  })

  it('writes merged report, final index, summary, and audit log files', function () {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-incremental-'))
    const base = sarif([result('rule-keep', epUnaffected, 8, 2, 'base-keep')])
    const selected = sarif([result('rule-added', epAdded, 38, 32, 'selected-added')])
    const basePath = path.join(tmpDir, 'base.sarif')
    const selectedPath = path.join(tmpDir, 'selected.sarif')
    const changesPath = path.join(tmpDir, 'ep-changes.json')
    fs.writeFileSync(basePath, JSON.stringify(base), 'utf-8')
    fs.writeFileSync(selectedPath, JSON.stringify(selected), 'utf-8')
    fs.writeFileSync(changesPath, JSON.stringify({ epChanges: [{ status: 'added', epKey: epAdded }] }), 'utf-8')

    const resultPaths = mergeSarifFindingFiles({
      baseSarifPath: basePath,
      selectedSarifPath: selectedPath,
      epChangesPath: changesPath,
      outputDir: tmpDir,
      project: 'demo',
      commit: 'head',
    })

    assert.strictEqual(fs.existsSync(resultPaths.mergedSarifPath), true)
    assert.strictEqual(fs.existsSync(resultPaths.findingsIndexPath), true)
    assert.strictEqual(fs.existsSync(resultPaths.summaryPath), true)
    assert.strictEqual(fs.existsSync(resultPaths.auditLogPath), true)
    assert.strictEqual(resultPaths.outputs.summary.counts.finalFindings, 2)
  })
})
