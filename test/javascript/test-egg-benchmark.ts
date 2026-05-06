import * as path from 'path'
import { describe, it } from 'mocha'
// @ts-ignore
import { computeAccuracyFromSarif, AccuracyStats } from '../trace-accuracy'
const { execute } = require('../../src/interface/starter')
const { ErrorCode } = require('../../src/util/error-code')
const {
  BENCHMARKS_DIR,
  XAST_JS_BENCHMARK,
  recordFindingStr,
  readExpectRes,
  resolveFindingResult,
  getExpectResultPath,
} = require('../test-utils')
import * as assert from 'assert'
import * as fs from 'fs'
const RULE_CONFIG_PATH = 'rule_config.json'
const logger = require('../../src/util/logger')(__filename)
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')
const fileUtil = require('../../src/util/file-util')

async function regressionEggBenchmark(): Promise<void> {
  const benchmarkRootPath = path.resolve(__dirname, BENCHMARKS_DIR)
  const benchmarkDir = fs.readdirSync(benchmarkRootPath)
  for (const benchmarkPathItem of benchmarkDir) {
    let filePath = path.join(benchmarkRootPath, benchmarkPathItem)
    const fileStat = fs.lstatSync(filePath)
    if (fileStat.isDirectory()) {
      filePath = filePath + '/'
      if (benchmarkPathItem !== XAST_JS_BENCHMARK) {
        logger.info('execute test in ', filePath)
        const result = await runEggBenchmark(filePath)
        checkEggBenchmarkResult(result, filePath)
      }
    }
  }
}

async function runEggBenchmark(dir: string): Promise<
  | {
      expectedRes: any
      actualRes: any
      expectedResMap: Map<string, any>
      actualResMap: Map<string, any>
      accuracyStats: AccuracyStats | null
    }
  | undefined
> {
  try {
    const ruleConfigFile = path.join(path.resolve(dir), RULE_CONFIG_PATH)
    const expectPath = getExpectResultPath(dir)

    const repoName = path.basename(dir)
    const reportDir = path.join(__dirname, 'report', repoName)
    let expectedRes: any, actualRes: any, expectedResMap: Map<string, any>, actualResMap: Map<string, any>
    let recorder = recordFindingStr()
    recorder.clearResult()

    let args = [
      dir,
      '--ruleConfigFile',
      ruleConfigFile,
      '--analyzer',
      'EggAnalyzer',
      '--checkerPackIds',
      'taint-flow-javascript-inner',
      '--report',
      reportDir,
    ]

    await execute(null, args, recorder.printAndAppend, false)
    expectedRes = readExpectRes(expectPath)
    actualRes = recorder.getFormatResult()
    expectedResMap = resolveFindingResult(expectedRes)
    actualResMap = resolveFindingResult(actualRes)

    // 计算 trace 准确率
    let accuracyStats: AccuracyStats | null = null
    const sarifPath = path.join(reportDir, 'report.sarif')
    if (fs.existsSync(sarifPath)) {
      const sarifData = JSON.parse(fs.readFileSync(sarifPath, 'utf-8'))
      accuracyStats = computeAccuracyFromSarif(sarifData)
    }

    return {
      expectedRes,
      actualRes,
      expectedResMap,
      actualResMap,
      accuracyStats,
    }
  } catch (e) {
    handleException(e, `ERROR in runEggBenchmark: ${e}`, `ERROR in runEggBenchmark: ${e}`)
    process.exitCode = ErrorCode.unknown_error
  }
}

function checkEggBenchmarkResult(
  result:
    | {
        expectedRes: any
        actualRes: any
        expectedResMap: Map<string, any>
        actualResMap: Map<string, any>
        accuracyStats: AccuracyStats | null
      }
    | undefined,
  name: string
): void {
  if (!result) return

  const description = `YASA test ${name.includes('chairbenchmark') ? 'chairBenchmark' : 'yasaNodeJsBenchmark'}`
  describe(description, async function () {
    this.timeout(10000) // 设置超时时间

    it(`check result data directly`, async function () {
      const { expectedRes, actualRes } = result
      logger.info(actualRes)
      assert.strictEqual(actualRes, expectedRes, '当前靶场扫描结果与历史预期不一致,请逐个核对链路')
    })
    let i = 1
    const { expectedResMap, actualResMap } = result
    expectedResMap.forEach((value, key) => {
      it(`${i++}-entryPoint:${key}`, async function () {
        logger.info('expected:\n' + value)
        logger.info('actual:\n' + actualResMap.get(key))
        if (actualResMap.has(key)) {
          assert.strictEqual(actualResMap.get(key), value, `链路${key}实际trace或内容与预期不一致，请核对该链路`)
        } else {
          assert.fail(`链路或key${key}不存在！！！`)
        }
      })
    })

    const actualChains = Array.from(actualResMap.keys())
    let addChains = actualChains.filter((key) => !expectedResMap.has(key))
    if (Array.isArray(addChains) && addChains.length > 0) {
      for (const addChain of addChains) {
        it(`new chain:${addChain}`, function () {
          logger.info(`新增检出${addChain},请核对新增检出内容是否符合预期`)
          logger.info(actualResMap.get(addChain))
          assert.fail(`new chain:${addChain}`)
        })
      }
    }

    it(`trace accuracy`, function () {
      const { accuracyStats } = result
      if (!accuracyStats) {
        this.skip()
        return
      }
      const benchmarkName = name.includes('chairbenchmark') ? 'chairBenchmark' : 'yasaNodeJsBenchmark'
      const pct =
        accuracyStats.evaluableHops > 0
          ? ((accuracyStats.accurateHops / accuracyStats.evaluableHops) * 100).toFixed(2)
          : 'N/A'
      logger.info(
        `=== Trace Accuracy [${benchmarkName}]: ${pct}% (${accuracyStats.accurateHops}/${accuracyStats.evaluableHops} hops, ${accuracyStats.totalFindings} findings) ===`
      )
    })
  })
}

async function updateBackup(dir: string): Promise<void> {
  const ruleConfigFile = path.join(path.resolve(dir), 'rule_config.json')
  const repoName = path.basename(dir)
  let actualRes: any
  let recorder = recordFindingStr()
  recorder.clearResult()
  let args = [
    dir,
    '--ruleConfigFile',
    ruleConfigFile,
    '--analyzer',
    'EggAnalyzer',
    '--checkerPackIds',
    'taint-flow-javascript-inner',
  ]
  try {
    await execute(null, args, recorder.printAndAppend, false)
  } catch (e) {
    handleException(
      e,
      `[test-egg-benchmark] 更新备份时发生错误，ERROR: ${e}`,
      `[test-egg-benchmark] 更新备份时发生错误，ERROR: ${e}`
    )
    recorder.clearResult()
    process.exitCode = ErrorCode.unknown_error
  }
  actualRes = recorder.getFormatResult()
  fs.writeFileSync(path.join(path.resolve(dir), '..', '..', 'expect', `${repoName}-expect.result`), actualRes, {
    encoding: 'utf8',
  })
}

regressionEggBenchmark()
// const benchmarkPath = fileUtil.getAbsolutePath('./test/javascript/benchmarks/yasaNodeJsBenchmark/')
// updateBackup(benchmarkPath)

module.exports = {
  regressionEggBenchmark,
}
