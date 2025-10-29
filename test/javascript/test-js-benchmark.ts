import * as _ from 'lodash'
import * as fs from 'fs'
import * as path from 'path'
import { describe, it } from 'mocha'
import * as assert from 'assert'
const config = require('../../src/config')
const logger = require('../../src/util/logger')(__filename)
const Analyzer = require('../../src/engine/analyzer/javascript/common/js-analyzer')
const { BENCHMARKS_DIR, XAST_JS_BENCHMARK, recordFindingStr } = require('../test-utils')
const fileUtil = require('../../src/util/file-util')
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')
const OutputStrategyAutoRegister = require('../../src/engine/analyzer/common/output-strategy-auto-register')

const taint_flow_name = ['taint_flow_test']

function regressionXastJsBenchmark(): void {
  const jsBenchmarkPath = path.resolve(__dirname, BENCHMARKS_DIR, XAST_JS_BENCHMARK)
  if (fs.existsSync(jsBenchmarkPath)) {
    const result = runXastJsBenchmark(jsBenchmarkPath)
    checkXastJsBenchmarkResult(result)
  } else {
    logger.warn(`XAST JS benchmark directory not found: ${jsBenchmarkPath}`)
  }
}

function getAllTestCase(filename: string): string[] {
  const ALL_TEST_CASE: string[] = []

  function loadTestCase(filename: string): void {
    let fileStat: fs.Stats | undefined
    try {
      fileStat = fs.lstatSync(filename)
    } catch (e) {
      handleException(
        e,
        'Error occurred in test-xast-js-benchmark.loadTestCase',
        'Error occurred in test-xast-js-benchmark.loadTestCase'
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
      if (!filename.endsWith('.js')) return
      ALL_TEST_CASE.push(filename)
    }
  }

  loadTestCase(filename)
  return ALL_TEST_CASE
}

function recordFinding(finding: any, filename: string, findingResMap: Map<string, any>): void {
  const keyname = filename.substring(filename.lastIndexOf('/benchmarks'))
  for (const ruleName of taint_flow_name) {
    if (!finding || Object.keys(finding).length === 0) {
      findingResMap.set(keyname, { [ruleName]: 0 })
      continue
    }
    if (finding[ruleName]) {
      findingResMap.set(keyname, { [ruleName]: finding[ruleName].length })
    }
  }
}

/**
 * @param findingResMap
 * @param logDir
 * @constructor
 */
function statisticImpactArea(findingResMap: Map<string, any>, logDir: string): string {
  let { TP, TN, FP, FN, tpChainNum, tnChainNum, unknown } = getTFPN(findingResMap)
  let loginfo: string[] = []

  loginfo.push('='.repeat(50))
  loginfo.push(`回归case总数:${findingResMap.size}`)
  loginfo.push(`统计case总数:${TP.size + TN.size + FP.size + FN.size}`)
  loginfo.push(`已检出(TP+TN)的链路数量(含误报):${tpChainNum + tnChainNum}`)
  loginfo.push(`未检出(FP+FN)(含待完善):${FP.size + FN.size}`)
  loginfo.push('-'.repeat(50))
  loginfo.push(`待完善的case数量: 未适配(FP):${FP.size}，误报数(TN):${TN.size} 共计(FP+TN):${FP.size + TN.size}`)
  loginfo.push(`待适配的case(FP):\n${Array.from(FP).join('\n')}`)
  loginfo.push(`误报case(TN):\n${Array.from(TN).join('\n')}`)
  loginfo.push(`未知case:${Array.from(unknown).join('\n')}，数量为${unknown.size}`)
  loginfo.push('-'.repeat(50))
  loginfo.push('='.repeat(50))

  return loginfo.join('\n')
}

function writeLog(log: string, logDir: string): void {
  try {
    const date = new Date()
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false, // 24小时制
    }
    const now = date
      .toLocaleString('zh-CN', options)
      .replace(/\//g, '-') // 将所有的'/‘替换为'-'
      .replace(/ /g, 'T') // 将所有的空格替换为'-'
      .replace(/:/g, '-') // 将所有的':'替换为'-'
    const logpath = path.join(path.resolve(logDir), `${now}-regression-report.log`)
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
    fs.writeFileSync(logpath, log)
    logger.info(`已生成jsbenchmark的回归报告:${logpath}`)
  } catch (e) {
    handleException(
      e,
      'Error occurred in test-xast-js-benchmark:write',
      'Error occurred in test-xast-js-benchmark:write'
    )
  }
}

function getTFPN(findingResMap: Map<string, any>): {
  TP: Set<string>
  TN: Set<string>
  FP: Set<string>
  FN: Set<string>
  tpChainNum: number
  tnChainNum: number
  unknown: Set<string>
} {
  let TP = new Set<string>(),
    TN = new Set<string>(),
    FP = new Set<string>(),
    FN = new Set<string>(),
    unknown = new Set<string>()
  // 检测出的链路数量，包含真阳和误报
  let tpChainNum = 0,
    tnChainNum = 0
  findingResMap.forEach((value, key) => {
    if (!/_T|_F/.test(key)) {
      taint_flow_name.forEach((ruleName) => {
        if (value[ruleName] && value[ruleName] > 0) {
          // 已检出
          TP.add(key)
          tpChainNum += value[ruleName]
        }
      })
      //遍历完两个规则 都没有检出链路 才算未检出
      if (!TP.has(key)) {
        // 未检出
        FN.add(key)
      }
    } else {
      // jsbenchmark 重点关注
      if (key.includes('_T')) {
        // _T代表样本是阳性
        taint_flow_name.forEach((ruleName) => {
          if (value[ruleName] && value[ruleName] > 0) {
            // 已检出
            TP.add(key)
            tpChainNum += value[ruleName]
          }
        })
        //遍历完两个规则 都没有检出链路 才算未检出
        if (!TP.has(key)) {
          // 未检出 待补充
          FP.add(key)
        }
      } else if (key.includes('_F')) {
        // _F代表样本是阴性
        taint_flow_name.forEach((ruleName) => {
          if (value[ruleName] && value[ruleName] > 0) {
            // 误报
            TN.add(key)
            tnChainNum += value[ruleName]
          }
        })
        //遍历完两个规则 都没有检出链路 才算预期内未检出
        if (!TN.has(key)) {
          // 预期未检出
          FN.add(key)
        }
      } else {
        unknown.add(key)
      }
    }
  })
  return { TP, TN, FP, FN, tpChainNum, tnChainNum, unknown }
}

function runSingleTest(casePath: string, actualResMap: Map<string, any>, outputStrategyAutoRegister: any): any {
  config.ruleConfigFile = './test/javascript/rule_config.json'
  config.checkerIds = ['taint_flow_test']
  config.language = 'javascript'

  const ruleConfigFile = fileUtil.getAbsolutePath(config.ruleConfigFile)

  const code = fs.readFileSync(casePath).toString()
  const recorder = recordFindingStr()
  const filename = casePath.substring(casePath.lastIndexOf('/jsbenchmark')).replace(/\.js/g, '')
  const analyzer = new Analyzer({
    ...config,
    language: 'javascript',
    checkers: {
      taint_flow_test: true,
    },
    mode: { intra: true },
    sanity: true,
    ruleConfigFile: ruleConfigFile,
  })

  const findingRes = analyzer.analyzeSingleFile(code, filename)
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
    recordFinding(findingRes, filename, actualResMap)
    return { [filename]: recorder.getFormatResult() }
  }
}

function runXastJsBenchmark(dir: string): {
  actualRes: any
  actualResMap: Map<string, any>
  expectedResult: any
} {
  let allCases = getAllTestCase(dir)
  let actualRes: any = {}
  let actualResMap = new Map<string, any>()
  const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
  outputStrategyAutoRegister.autoRegisterAllStrategies()
  for (const casePath of allCases) {
    const singleRes = runSingleTest(casePath, actualResMap, outputStrategyAutoRegister)
    if (singleRes) {
      for (const [key, value] of Object.entries(singleRes)) {
        actualRes[key] = value
      }
    }
  }
  const expectResultPath = path.join(path.resolve(dir), '..', '..', 'expect', 'jsbenchmark-expect.json')
  const expectedData = fs.readFileSync(expectResultPath).toString()
  const expectedResult = JSON.parse(expectedData)
  return {
    actualRes,
    actualResMap,
    expectedResult,
  }
}

function checkXastJsBenchmarkResult(result: {
  actualRes: any
  actualResMap: Map<string, any>
  expectedResult: any
}): void {
  const { actualRes, actualResMap, expectedResult } = result
  describe('YASA test Xast Js Benchmark', function () {
    it(`check result data directly`, function () {
      let testReport = statisticImpactArea(actualResMap, './test/javascript/test-report')
      logger.info(testReport)
      writeLog(testReport, './test/javascript/test-report')
    })
    let i = 1
    if (expectedResult) {
      for (let caseKey of Object.keys(expectedResult)) {
        it(`${i++}-case:${caseKey}`, function () {
          logger.info('expected:\n' + expectedResult[caseKey])
          logger.info('actual:\n' + actualRes[caseKey])
          if (_.has(actualRes, caseKey)) {
            assert.strictEqual(
              actualRes[caseKey],
              expectedResult[caseKey],
              `链路${caseKey}实际trace或内容与预期不一致,请核对该链路`
            )
          } else {
            assert.fail(`链路:${caseKey}不存在！！！需要排查原因`)
          }
        })
      }
    }
  })
}

regressionXastJsBenchmark()
// const JSBENCHMARK_PATH = fileUtil.getAbsolutePath('./test/javascript/benchmarks/jsbenchmark/')
// updateJsBenchmarkBackupfile(JSBENCHMARK_PATH)

function updateJsBenchmarkBackupfile(dir: string): void {
  let allCases = getAllTestCase(dir)
  let actualRes: any = {}
  let actualResMap = new Map<string, any>()
  const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
  outputStrategyAutoRegister.autoRegisterAllStrategies()
  for (const casePath of allCases) {
    const singleRes = runSingleTest(casePath, actualResMap, outputStrategyAutoRegister)
    if (singleRes) {
      for (const [key, value] of Object.entries(singleRes)) {
        actualRes[key] = value
      }
    }
  }
  fs.writeFileSync(
    path.join(path.resolve(dir), '..', '..', 'expect', 'jsbenchmark-expect.json'),
    JSON.stringify(actualRes),
    { encoding: 'utf8' }
  )
}

module.exports = {
  regressionXastJsBenchmark,
}
