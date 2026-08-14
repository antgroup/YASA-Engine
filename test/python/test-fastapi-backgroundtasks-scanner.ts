import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it } from 'mocha'

const { parseSingleFile: parseSingleFilePython } = require('../../src/engine/parser/python/python-ast-builder') as {
  parseSingleFile: (code: string, options: { uastSDKPath: string }) => unknown
}
const { findFastApiEntryPointAndSource } = require('../../src/engine/analyzer/python/fastapi/entrypoint-collector/fastapi-entrypoint') as {
  findFastApiEntryPointAndSource: (files: Record<string, unknown>, root: string) => {
    fastApiEntryPointArray: Array<{ attribute?: string; filePath?: string; functionName?: string }>
  }
}
const { execute } = require('../../src/interface/starter') as {
  execute: (context: unknown, args: string[], printer: (...args: unknown[]) => void) => Promise<unknown>
}
const { recordFindingStr } = require('../test-utils') as {
  recordFindingStr: () => { clearResult: () => void; printAndAppend: (...args: unknown[]) => void }
}

type SarifLocation = {
  location?: {
    physicalLocation?: {
      region?: { snippet?: { text?: string } }
    }
  }
}

type SarifResult = {
  entrypoint?: {
    filePath?: string
    functionName?: string
    type?: string
  }
  locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }>
  codeFlows?: Array<{ threadFlows?: Array<{ locations?: SarifLocation[] }> }>
}

describe('FastAPI BackgroundTasks scanner integration', function () {
  it('finds exactly the historical callback payload boundary and excludes the decoy', async function () {
    this.timeout(30000)
    const fixtureDir = path.join(__dirname, 'fastapi-backgroundtasks-cases')
    const sourcePath = path.join(fixtureDir, 'scanner_callback.py')
    const discoveredRoutes = findFastApiEntryPointAndSource({
      [sourcePath]: parseSingleFilePython(fs.readFileSync(sourcePath, 'utf8'), { uastSDKPath: path.join(__dirname, '../../deps') }),
    }, fixtureDir).fastApiEntryPointArray
    assert.strictEqual(discoveredRoutes.length, 1)
    assert.strictEqual(discoveredRoutes[0].functionName, 'endpoint')
    assert.strictEqual(discoveredRoutes[0].filePath, '/scanner_callback.py')
    assert.strictEqual(discoveredRoutes[0].attribute, 'HTTP')
    const recorder = recordFindingStr()
    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-fastapi-backgroundtasks-'))
    recorder.clearResult()

    await execute(null, [
      fixtureDir,
      '--ruleConfigFile', path.join(__dirname, 'rule_config_xast_python3.json'),
      '--report', reportDir,
      '--analyzer', 'PythonAnalyzer',
      '--checkerIds', 'taint_flow_test',
      '--uastSDKPath', path.join(__dirname, '../../deps'),
    ], recorder.printAndAppend)

    const sarif = JSON.parse(fs.readFileSync(path.join(reportDir, 'report.sarif'), 'utf8')) as { runs?: Array<{ results?: SarifResult[] }> }
    const results = sarif.runs?.flatMap((run) => run.results ?? []) ?? []
    assert.strictEqual(results.length, 1, '精确 1/1：仅受 FastAPI 身份证明的调度器产生结果')
    const result = results[0]
    assert.strictEqual(result.entrypoint?.type, 'functionCall')
    assert.strictEqual(result.entrypoint?.functionName, discoveredRoutes[0].functionName)
    assert.strictEqual(result.entrypoint?.filePath, discoveredRoutes[0].filePath)
    assert.strictEqual(result.locations?.[0]?.physicalLocation?.artifactLocation?.uri?.endsWith('scanner_callback.py'), true)
    assert.strictEqual(result.locations?.[0]?.physicalLocation?.region?.startLine, 13)
    const snippets = result.codeFlows?.flatMap((flow) => flow.threadFlows ?? [])
      .flatMap((thread) => thread.locations ?? [])
      .map((location) => location.location?.physicalLocation?.region?.snippet?.text ?? '') ?? []
    assert.ok(snippets.some((snippet) => snippet.includes('taint_src')))
    assert.ok(snippets.some((snippet) => snippet.includes('schedule_verification(background_tasks, task_id, request)')))
    assert.ok(snippets.some((snippet) => snippet.includes('background_tasks.add_task(frontend_verify_sync, task_id, request)')))
    assert.ok(snippets.some((snippet) => snippet.includes('frontend_verify_sync(task_id: str, request: VerifyRequest)')))
    assert.ok(snippets.some((snippet) => snippet.includes('os.system(request.input)')))
    assert.ok(!snippets.some((snippet) => snippet.includes('class LocalQueue')))
    assert.ok(!snippets.some((snippet) => snippet.includes('async def decoy')))
  })
})
