import * as fs from 'fs'
import * as path from 'path'
import { before, describe, it } from 'mocha'
import * as assert from 'assert'

const config = require('../../src/config')
const Analyzer = require('../../src/engine/analyzer/golang/common/go-analyzer')
const { recordFindingStr } = require('../test-utils')
const _ = require('lodash')
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')
const OutputStrategyAutoRegister = require('../../src/engine/analyzer/common/output-strategy-auto-register')
const logger = require('../../src/util/logger')(__filename)

const TAINT_RULE_PATTERN = /taint_flow_(test|go)/

function getAllTestCase(filename: string): string[] {
  const ALL_TEST_CASE: string[] = []

  function loadTestCase(filename: string): void {
    let fileStat: fs.Stats | undefined
    try {
      fileStat = fs.lstatSync(filename)
    } catch (e) {
      handleException(
        e,
        'Error occurred in test-go-benchmark.loadTestCase',
        'Error occurred in test-go-benchmark.loadTestCase'
      )
    }
    if (!fileStat) return
    if (fileStat.isDirectory()) {
      const dir = filename
      const files = fs.readdirSync(dir)
      for (let i in files) {
        const name = path.join(dir, files[i])
        loadTestCase(name)
      }
    } else {
      if (!filename.endsWith('.go')) return
      ALL_TEST_CASE.push(filename)
    }
  }

  loadTestCase(filename)
  return ALL_TEST_CASE
}

/**
 * 某个 case 的 recorder 文本是否包含 taint 检出（而非 "No findings!"）。
 * @param result - recorder 生成的字符串
 * @returns {boolean} true 表示检出
 */
function isDetected(result: any): boolean {
  return typeof result === 'string' && !/No findings!/.test(result) && TAINT_RULE_PATTERN.test(result)
}

/**
 * 基于 recorder 字符串统计 TP/FN/FP/TN。
 *
 * 旧实现依赖 `analyzeSingleFile` 返回值的内部键（`taint_flow_test`），与
 * `recordCheckerFindings()` 实际返回的键（`taintflow` 等）不匹配，导致打印恒为 0，
 * 具误导性。这里直接以逐 case 的字符串结果为准（与 expect 比对的是同一份数据），
 * 统计口径与基线文档的 expect 反推一致。
 * @param actualRes - caseKey -> recorder 字符串
 * @returns {string} 可读的统计报告
 */
function statisticImpactArea(actualRes: Record<string, any>): string {
  const positive: string[] = []
  const negative: string[] = []
  const unknown: string[] = []
  let TP = 0
  let FN = 0
  let FP = 0
  let TN = 0
  for (const key of Object.keys(actualRes)) {
    const detected = isDetected(actualRes[key])
    if (/_T/.test(key)) {
      positive.push(key)
      if (detected) TP++
      else FN++
    } else if (/_F/.test(key)) {
      negative.push(key)
      if (detected) FP++
      else TN++
    } else {
      unknown.push(key)
    }
  }
  const loginfo: string[] = []

  loginfo.push('='.repeat(50))
  loginfo.push(`回归case总数:${Object.keys(actualRes).length}`)
  loginfo.push(`统计case总数:${TP + FN + FP + TN}`)
  loginfo.push(`阳性(_T):${positive.length} 检出(TP):${TP} 漏报(FN):${FN}`)
  loginfo.push(`阴性(_F):${negative.length} 误报(FP):${FP} 正确未检出(TN):${TN}`)
  loginfo.push(`未知case:${unknown.length}`)
  loginfo.push('='.repeat(50))

  return loginfo.join('\n')
}

async function runSingleTest(casePath: string, outputStrategyAutoRegister: any): Promise<any> {
  const configPath = require.resolve('../../src/config')
  logger.info(`[CONFIG] Loaded from: ${configPath}`)

  config.ruleConfigFile = __dirname + '/rule_config.json'
  config.checkerIds = ['taint_flow_test']
  config.language = 'golang'
  config.maindirPrefix = __dirname + '/benchmarks'

  const code = fs.readFileSync(casePath).toString()
  const recorder = recordFindingStr()
  const filename = casePath.substring(casePath.lastIndexOf('/benchmarks')).replace(/\.go/g, '')
  const analyzer = new Analyzer({
    language: 'golang',
    examineIssues: true,
    checkers: {
      taint_flow_test: true,
    },
    ...config,
    uastSDKPath: undefined,
    mode: { intra: true },
    sanity: true,
  })
  const findingRes = await analyzer.analyzeSingleFile(code, casePath)
  if (findingRes) {
    const { resultManager } = analyzer.getCheckerManager()
    const allFindings = resultManager.getFindings()
    if (_.isEmpty(allFindings)) {
      recorder.printAndAppend('\n======================== Findings ======================== ')
      recorder.printAndAppend('No findings!')
      recorder.printAndAppend('========================================================== \n')
    }
    for (const outputStrategyId in allFindings) {
      const strategy = outputStrategyAutoRegister.getStrategy(outputStrategyId)
      if (strategy && typeof strategy.outputFindings === 'function') {
        strategy.outputFindings(resultManager, strategy.getOutputFilePath(), config, recorder.printAndAppend)
      }
    }
    return { [filename]: recorder.getFormatResult() }
  }
  return {}
}

async function update(dir: string): Promise<void> {
  let allCases = getAllTestCase(dir)
  let actualRes: any = {}
  const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
  outputStrategyAutoRegister.autoRegisterAllStrategies()
  for (const casePath of allCases) {
    const singleRes = await runSingleTest(casePath, outputStrategyAutoRegister)
    for (const [key, value] of Object.entries(singleRes)) {
      actualRes[key] = value
    }
  }
  fs.writeFileSync(
    path.join(path.resolve(dir), '..', '..', 'expect', 'gobenchmark-expect.json'),
    JSON.stringify(actualRes),
    {
      encoding: 'utf8',
    }
  )
}

function runGoBenchmark(dir: string): void {
  const allCases = getAllTestCase(dir)
  const actualRes: any = {}
  const expectPath = path.join(path.resolve(dir), '..', '..', 'expect', 'gobenchmark-expect.json')
  const expectedData = fs.readFileSync(expectPath).toString()
  const expectedRes = JSON.parse(expectedData)

  describe('YASA test GoBenchmark', function () {
    this.timeout(0)

    // 解析统一放到 before：analyzeSingleFile 为 async，必须 await 后结果才完整。
    before(async function () {
      const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
      outputStrategyAutoRegister.autoRegisterAllStrategies()
      for (const casePath of allCases) {
        const singleRes = await runSingleTest(casePath, outputStrategyAutoRegister)
        for (const [key, value] of Object.entries(singleRes)) {
          actualRes[key] = value
        }
      }
    })

    it(`check result data directly`, function () {
      let testReport = statisticImpactArea(actualRes)
      logger.info(testReport)
    })
    let i = 1
    for (let caseKey of Object.keys(expectedRes)) {
      it(`${i++}-case:${caseKey}`, function () {
        logger.info('expected:\n' + expectedRes[caseKey])
        logger.info('actual:\n' + actualRes[caseKey])
        if (_.has(actualRes, caseKey)) {
          assert.strictEqual(
            actualRes[caseKey],
            expectedRes[caseKey],
            `链路${caseKey}实际trace或内容与预期不一致,请核对该链路`
          )
        } else {
          assert.fail(`链路:${caseKey}不存在！！！需要排查原因`)
        }
      })
    }
  })
}

describe('YASA test All GoBenchmarks', function () {
  let goBenchmarkPath = path.resolve(__dirname, 'benchmarks/sast-go/')
  if (fs.existsSync(goBenchmarkPath)) {
    runGoBenchmark(goBenchmarkPath)
  }
})

// update(path.resolve(__dirname, 'benchmarks/sast-go/'))
