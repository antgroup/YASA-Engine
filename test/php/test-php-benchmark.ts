import * as fs from 'fs'
import * as path from 'path'
import { describe, it, before } from 'mocha'
import * as assert from 'assert'
const config = require('../../src/config')
const PhpAnalyzer = require('../../src/engine/analyzer/php/common/php-analyzer')
const { recordFindingStr } = require('../test-utils')
const _ = require('lodash')
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')
const OutputStrategyAutoRegister = require('../../src/engine/analyzer/common/output-strategy-auto-register')
const { execute } = require('../../src/interface/starter')
const logger = require('../../src/util/logger')(__filename)

const taint_flow_name = ['taint_flow_test', 'taintflow']

/** 测试单元：单文件或跨文件目录 */
interface TestUnit {
  type: 'file' | 'dir'
  path: string
  /** 从 /benchmarks 截取的相对标签，用作 Map key */
  label: string
}

/**
 * 递归扫描 benchmarks 目录，返回混合测试单元列表。
 * - 以 _T.php / _F.php 结尾的文件 → file 型
 * - 以 _T/ / _F/ 结尾且含 .php 的目录 → dir 型（内部 .php 不再单独作为 case）
 */
function getAllTestUnits(rootDir: string): TestUnit[] {
  const units: TestUnit[] = []

  function scan(dir: string): void {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch (e) {
      handleException(e, 'Error occurred in test-php-benchmark.scan', 'Error occurred in test-php-benchmark.scan')
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry)
      let stat: fs.Stats | undefined
      try {
        stat = fs.lstatSync(fullPath)
      } catch (e) {
        handleException(e, 'Error occurred in test-php-benchmark.scan', 'Error occurred in test-php-benchmark.scan')
        continue
      }
      if (!stat) continue

      if (stat.isDirectory()) {
        // 目录名以 _T 或 _F 结尾，且内含 .php → 跨文件目录型 case
        if (/_[TF]$/.test(entry) && hasPhpFile(fullPath)) {
          const label = fullPath.substring(fullPath.lastIndexOf('/benchmarks'))
          units.push({ type: 'dir', path: fullPath, label })
        } else {
          scan(fullPath)
        }
      } else if (stat.isFile() && /_(T|F)\.php$/.test(entry)) {
        const label = fullPath.substring(fullPath.lastIndexOf('/benchmarks')).replace(/\.php$/, '')
        units.push({ type: 'file', path: fullPath, label })
      }
    }
  }

  scan(rootDir)
  return units
}

/** 判断目录内是否包含 .php 文件 */
function hasPhpFile(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir)
    return entries.some((e: string) => e.endsWith('.php'))
  } catch {
    return false
  }
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

function statisticImpactArea(findingResMap: Map<string, any>): string {
  let { TP, TN, FP, FN, tpChainNum, tnChainNum, unknown } = getTFPN(findingResMap)
  let loginfo: string[] = []

  const total = TP.size + TN.size + FP.size + FN.size
  const precision = TP.size + TN.size > 0 ? (TP.size / (TP.size + TN.size) * 100).toFixed(2) : '0.00'
  const recall = TP.size + FP.size > 0 ? (TP.size / (TP.size + FP.size) * 100).toFixed(2) : '0.00'

  loginfo.push('='.repeat(50))
  loginfo.push(`回归case总数:${findingResMap.size}`)
  loginfo.push(`统计case总数:${total}`)
  loginfo.push(`已检出(TP+TN)的链路数量(含误报):${tpChainNum + tnChainNum}`)
  loginfo.push(`未检出(FP+FN)(含待完善):${FP.size + FN.size}`)
  loginfo.push('-'.repeat(50))
  loginfo.push(`TP(阳性检出):${TP.size}  TN(阴性误报):${TN.size}  FP(阳性未检出):${FP.size}  FN(阴性正确):${FN.size}`)
  loginfo.push(`Precision(精确率): ${precision}%`)
  loginfo.push(`Recall(召回率): ${recall}%`)
  loginfo.push('-'.repeat(50))
  loginfo.push(`待完善的case数量: 未适配(FP):${FP.size}，误报数(TN):${TN.size} 共计(FP+TN):${FP.size + TN.size}`)
  loginfo.push(`待适配的case(FP):\n${Array.from(FP).join('\n')}`)
  loginfo.push(`误报case(TN):\n${Array.from(TN).join('\n')}`)
  loginfo.push(`未知case:${Array.from(unknown).join('\n')}，数量为${unknown.size}`)
  loginfo.push('-'.repeat(50))
  loginfo.push('='.repeat(50))

  const showstr = loginfo.join('\n')
  return showstr
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
  let tpChainNum = 0,
    tnChainNum = 0
  findingResMap.forEach((value, key) => {
    if (!/_T|_F/.test(key)) {
      taint_flow_name.forEach((ruleName) => {
        if (value[ruleName] && value[ruleName] > 0) {
          TP.add(key)
          tpChainNum += value[ruleName]
        }
      })
      if (!TP.has(key)) {
        FN.add(key)
      }
    } else {
      if (key.includes('_T')) {
        // _T 代表阳性样本
        taint_flow_name.forEach((ruleName) => {
          if (value[ruleName] && value[ruleName] > 0) {
            TP.add(key)
            tpChainNum += value[ruleName]
          }
        })
        if (!TP.has(key)) {
          // 阳性未检出
          FP.add(key)
        }
      } else if (key.includes('_F')) {
        // _F 代表阴性样本
        taint_flow_name.forEach((ruleName) => {
          if (value[ruleName] && value[ruleName] > 0) {
            // 阴性被检出 = 误报
            TN.add(key)
            tnChainNum += value[ruleName]
          }
        })
        if (!TN.has(key)) {
          // 阴性正确未检出
          FN.add(key)
        }
      } else {
        unknown.add(key)
      }
    }
  })
  return { TP, TN, FP, FN, tpChainNum, tnChainNum, unknown }
}

async function runSingleTest(casePath: string, actualResMap: Map<string, any>, outputStrategyAutoRegister: any): Promise<Record<string, string>> {
  config.ruleConfigFile = __dirname + '/rule_config.json'
  config.checkerIds = ['taint_flow_test', 'sanitizer']
  config.language = 'php'
  config.maindirPrefix = __dirname + '/benchmarks'

  const code = fs.readFileSync(casePath).toString()
  const recorder = recordFindingStr()
  const filename = casePath.substring(casePath.lastIndexOf('/benchmarks')).replace(/\.php$/g, '')
  const analyzer = new PhpAnalyzer({
    language: 'php',
    examineIssues: true,
    checkers: {
      taint_flow_test: true,
      sanitizer: true,
    },
    ...config,
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
    recordFinding(findingRes, filename, actualResMap)
  } else {
    recordFinding(null, filename, actualResMap)
  }
  return { [filename]: recorder.getFormatResult() }
}

/**
 * 以项目模式（execute）运行跨文件目录型 case，提取 taint_flow_test/taintflow 结果数。
 * 参照 Python benchmark 的 execute(null, args) 调用方式。
 */
async function runDirectoryTest(
  dirPath: string,
  label: string,
  actualResMap: Map<string, any>,
  _outputStrategyAutoRegister: any
): Promise<Record<string, string>> {
  const ruleConfigFile = __dirname + '/rule_config.json'
  const reportDir = path.join(__dirname, 'report')
  const recorder = recordFindingStr()

  const args: string[] = [
    dirPath,
    '--ruleConfigFile', ruleConfigFile,
    '--analyzer', 'PhpAnalyzer',
    '--checkerIds', 'taint_flow_test,sanitizer',
    '--report', reportDir,
  ]

  try {
    const allFindings = await execute(null, args, recorder.printAndAppend)
    const findingRecord: Record<string, number> = {}
    if (allFindings && typeof allFindings === 'object') {
      for (const ruleName of taint_flow_name) {
        if (allFindings[ruleName] && Array.isArray(allFindings[ruleName])) {
          findingRecord[ruleName] = allFindings[ruleName].length
        } else {
          findingRecord[ruleName] = 0
        }
      }
    } else {
      findingRecord['taint_flow_test'] = 0
    }
    actualResMap.set(label, findingRecord)
  } catch (e) {
    handleException(
      e,
      `[PHP Benchmark] 目录分析失败: ${label}`,
      `[PHP Benchmark] 目录分析失败: ${label}`
    )
    actualResMap.set(label, { taint_flow_test: 0 })
  }

  return { [label]: recorder.getFormatResult() }
}

async function update(dir: string): Promise<void> {
  const casePath = path.join(dir, 'case')
  const allUnits = getAllTestUnits(casePath)
  const actualRes: Record<string, string> = {}
  const actualResMap = new Map<string, any>()
  const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
  outputStrategyAutoRegister.autoRegisterAllStrategies()

  for (const unit of allUnits) {
    try {
      if (unit.type === 'file') {
        const singleRes = await runSingleTest(unit.path, actualResMap, outputStrategyAutoRegister)
        Object.assign(actualRes, singleRes)
      } else {
        const dirRes = await runDirectoryTest(unit.path, unit.label, actualResMap, outputStrategyAutoRegister)
        Object.assign(actualRes, dirRes)
      }
    } catch (e) {
      handleException(
        e,
        `[PHP Benchmark] update 用例执行失败: ${unit.label}`,
        `[PHP Benchmark] update 用例执行失败: ${unit.label}`
      )
    }
  }

  const expectDir = path.join(__dirname, 'expect')
  if (!fs.existsSync(expectDir)) {
    fs.mkdirSync(expectDir, { recursive: true })
  }
  fs.writeFileSync(
    path.join(expectDir, 'phpbenchmark-expect.json'),
    JSON.stringify(actualRes),
    { encoding: 'utf8' }
  )
}

describe('YASA test All PhpBenchmarks', function () {
  this.timeout(600000)

  const phpBenchmarkPath = path.resolve(__dirname, 'benchmarks/sast-php/')
  if (!fs.existsSync(phpBenchmarkPath)) return

  const expectPath = path.join(__dirname, 'expect', 'phpbenchmark-expect.json')
  const actualRes: Record<string, string> = {}
  const actualResMap = new Map<string, any>()

  before(async function () {
    const casePath = path.join(phpBenchmarkPath, 'case')
    if (!fs.existsSync(casePath)) {
      throw new Error(`PHP benchmark case 路径不存在: ${casePath}，请先运行 prepare-php-benchmark`)
    }

    const allUnits = getAllTestUnits(casePath)
    const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
    outputStrategyAutoRegister.autoRegisterAllStrategies()

    for (const unit of allUnits) {
      try {
        if (unit.type === 'file') {
          const singleRes = await runSingleTest(unit.path, actualResMap, outputStrategyAutoRegister)
          Object.assign(actualRes, singleRes)
        } else {
          const dirRes = await runDirectoryTest(unit.path, unit.label, actualResMap, outputStrategyAutoRegister)
          Object.assign(actualRes, dirRes)
        }
      } catch (e) {
        handleException(
          e,
          `[PHP Benchmark] 用例执行失败: ${unit.label}`,
          `[PHP Benchmark] 用例执行失败: ${unit.label}`
        )
        actualResMap.set(unit.label, { taint_flow_test: 0 })
      }
    }
  })

  it('准召率统计', function () {
    const testReport = statisticImpactArea(actualResMap)
    logger.info(testReport)
    console.log(testReport)
  })

  if (fs.existsSync(expectPath)) {
    const expectedRes = JSON.parse(fs.readFileSync(expectPath).toString())
    let i = 1
    for (const caseKey of Object.keys(expectedRes)) {
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
  }
})

// update(path.resolve(__dirname, 'benchmarks/sast-php/'))
