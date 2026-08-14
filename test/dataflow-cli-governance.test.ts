import assert from 'assert'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'

const Config = require('../src/config')
const { initAnalyzer } = require('../src/interface/starter')

const REMOVED_DATAFLOW_OPTIONS = [
  '--dataflowLruDiag',
  '--dataflowEpCacheClear',
  '--dataflowEpEdgeDedupClear',
  '--dataflowPruneDeadSlots',
]

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
}

function createJsAstCase(prefix: string): { tempDir: string; sourceFile: string; astOutput: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const sourceFile = path.join(tempDir, 'sample.js')
  const astOutput = path.join(tempDir, 'sample.ast.json')
  fs.writeFileSync(sourceFile, 'const value = 1\n')
  return { tempDir, sourceFile, astOutput }
}

async function parseDumpAst(args: string[], prefix: string): Promise<{ tempDir: string; astOutput: string; exitCode: string | number | undefined }> {
  const { tempDir, sourceFile, astOutput } = createJsAstCase(prefix)
  process.exitCode = undefined
  await initAnalyzer(null, [
    '--sourcePath', sourceFile,
    '--language', 'javascript',
    ...args,
    '--dumpAST',
    '--report', astOutput,
  ])
  return { tempDir, astOutput, exitCode: process.exitCode }
}

async function parseDataflowMode(mode: 'full' | 'incremental-facts'): Promise<void> {
  const result = await parseDumpAst(['--dataflowDbMode', mode], `yasa-dataflow-cli-${mode}-`)

  assert.strictEqual(Config.dataflowDb, true)
  assert.strictEqual(Config.dataflowDbMode, mode)
  assert.strictEqual(result.exitCode, 0)
  assert.strictEqual(fs.existsSync(result.astOutput), true)
  fs.removeSync(result.tempDir)
}

describe('Dataflow CLI governance', () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  it('removes confirmed internal Dataflow options from CLI and Config surfaces', () => {
    const starter = readRepoFile('src/interface/starter.ts')
    const config = readRepoFile('src/config.ts')
    const edgeStats = readRepoFile('src/engine/analyzer/common/dataflow-edge-stats.ts')

    for (const option of REMOVED_DATAFLOW_OPTIONS) {
      assert.strictEqual(starter.includes(`.option('${option}`), false, `${option} must not remain in starter options`)
    }

    assert.strictEqual(config.includes('dataflowLruDiag'), false)
    assert.strictEqual(config.includes('dataflowEpCacheClear'), false)
    assert.strictEqual(config.includes('dataflowEpEdgeDedupClear'), false)
    assert.strictEqual(config.includes('dataflowPruneDeadSlots'), false)
    assert.strictEqual(edgeStats.includes('pruneDeadSlots'), false)
    assert.strictEqual(edgeStats.includes('epCacheClear'), false)
    assert.strictEqual(edgeStats.includes('epEdgeDedupClear'), false)
    assert.strictEqual(edgeStats.includes('lruDiag'), false)
    assert.strictEqual(starter.includes('REMOVED_DATAFLOW_INTERNAL_OPTIONS'), false)
    assert.strictEqual(starter.includes('parseRemovedDataflowInternalOption'), false)
    assert.strictEqual(starter.includes('rejectRemovedDataflowInternalOptions'), false)
    assert.strictEqual(starter.includes('has been removed from public CLI'), false)
  })

  it('keeps non-Dataflow unknown option tolerance unchanged', async () => {
    const result = await parseDumpAst(['--ordinaryUnknownOption'], 'yasa-dataflow-cli-unknown-')

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(fs.existsSync(result.astOutput), true)
    fs.removeSync(result.tempDir)
  })

  it('keeps dataflowDbMode full and incremental-facts CLI semantics', async () => {
    await parseDataflowMode('incremental-facts')
    await parseDataflowMode('full')
  })
})
