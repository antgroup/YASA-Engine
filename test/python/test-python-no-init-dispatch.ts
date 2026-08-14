import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { describe, it } from 'mocha'

const { execute } = require('../../src/interface/starter')
const { ErrorCode } = require('../../src/util/error-code')
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')
const logger = require('../../src/util/logger')(__filename)
const { readExpectRes, recordFindingStr, resolveTestFindingResult } = require('../test-utils')

type FindingMap = Map<string, string[] | string>

type NoInitDispatchResult = {
  expectedRes: string
  actualRes: string
  expectedResMap: FindingMap
  actualResMap: FindingMap
}

const expectedFindingCounts: Record<string, number> = {
  'explicit_init_T.py': 1,
  'imported_base.py': 0,
  'imported_child_T.py': 1,
  'no_init_class_attr_T.py': 1,
  'no_init_direct_T.py': 1,
  'no_init_dynamic_unknown_F.py': 0,
  'no_init_imported_override_T.py': 0,
  'no_init_inherited_override_T.py': 1,
  'no_init_local_hop_T.py': 1,
  'no_init_top_level_override_T.py': 1,
  'no_init_no_risk_F.py': 0,
  'no_init_untainted_F.py': 0,
}

const expectedFixtureFiles = Object.keys(expectedFindingCounts)

function assertFixturesReady(fixtureDir: string): void {
  assert.ok(fs.existsSync(fixtureDir), `no-init fixture目录缺失: ${fixtureDir}`)
  for (const fileName of expectedFixtureFiles) {
    const fixtureFile = path.join(fixtureDir, fileName)
    assert.ok(fs.existsSync(fixtureFile), `no-init fixture文件缺失: ${fixtureFile}`)
  }
}

function getFileFindingCount(resultMap: FindingMap, fileName: string): number {
  const matchedKey = Array.from(resultMap.keys()).find((key) => path.basename(key) === fileName)
  if (!matchedKey) {
    return 0
  }
  const value = resultMap.get(matchedKey)
  return Array.isArray(value) ? value.length : Number(value)
}

async function getRunNoInitDispatchResult(): Promise<NoInitDispatchResult> {
  const fixtureDir = path.resolve(__dirname, 'no-init-dispatch-cases')
  const ruleConfigFile = path.resolve(__dirname, 'rule_config_xast_python3.json')
  const expectPath = path.resolve(__dirname, 'expect', 'python-no-init-dispatch-expect.result')
  const recorder = recordFindingStr()
  recorder.clearResult()

  const args = [
    fixtureDir,
    '--ruleConfigFile',
    ruleConfigFile,
    '--analyzer',
    'PythonAnalyzer',
    '--checkerIds',
    'taint_flow_test',
    '--uastSDKPath',
    path.join(__dirname, '../../deps'),
  ]

  try {
    await execute(null, args, recorder.printAndAppend)
  } catch (e) {
    handleException(
      e,
      `[test-python-no-init-dispatch] 运行Python no-init回归测试时发生错误.ERROR: ${e}`,
      `[test-python-no-init-dispatch] 运行Python no-init回归测试时发生错误.ERROR: ${e}`
    )
    recorder.clearResult()
    process.exitCode = ErrorCode.unknown_error
  }

  const expectedRes = readExpectRes(expectPath)
  const actualRes = recorder.getFormatResult()
  return {
    expectedRes,
    actualRes,
    expectedResMap: resolveTestFindingResult(expectedRes),
    actualResMap: resolveTestFindingResult(actualRes),
  }
}

function checkNoInitDispatchResult(result: NoInitDispatchResult): void {
  describe('YASA test Python no-init dispatch fixtures', async function () {
    this.timeout(10000) // 小靶场仅用于 no-init method dispatch 回归

    it('matches recorded positive chains exactly', async function () {
      const { expectedRes, actualRes } = result
      logger.info(actualRes)
      assert.strictEqual(actualRes, expectedRes, 'no-init fixture扫描结果与预期不一致，请核对链路')
    })

    for (const [fileName, expectedCount] of Object.entries(expectedFindingCounts)) {
      it(`${fileName}: ${expectedCount} finding(s)`, async function () {
        assert.strictEqual(getFileFindingCount(result.actualResMap, fileName), expectedCount)
      })
    }
  })
}

describe('YASA test Python no-init dispatch', async function () {
  const fixtureDir = path.resolve(__dirname, 'no-init-dispatch-cases')
  assertFixturesReady(fixtureDir)
  const result = await getRunNoInitDispatchResult()
  checkNoInitDispatchResult(result)
})

module.exports = { getRunNoInitDispatchResult, checkNoInitDispatchResult }
