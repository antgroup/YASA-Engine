/**
 * 独立生成 PHP benchmark expect 文件
 * 用法: npx tsx test/php/generate-expect.ts
 */
import * as fs from 'fs'
import * as path from 'path'
const config = require('../../src/config')
const PhpAnalyzer = require('../../src/engine/analyzer/php/common/php-analyzer')
const { recordFindingStr } = require('../test-utils')
const _ = require('lodash')
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')
const OutputStrategyAutoRegister = require('../../src/engine/analyzer/common/output-strategy-auto-register')
const { execute } = require('../../src/interface/starter')
const logger = require('../../src/util/logger')(__filename)

const taint_flow_name = ['taint_flow_test', 'taintflow']

interface TestUnit {
  type: 'file' | 'dir'
  path: string
  label: string
}

function getAllTestUnits(rootDir: string): TestUnit[] {
  const units: TestUnit[] = []
  function scan(dir: string): void {
    let entries: string[]
    try { entries = fs.readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry)
      let stat: fs.Stats | undefined
      try { stat = fs.lstatSync(fullPath) } catch { continue }
      if (!stat) continue
      if (stat.isDirectory()) {
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

function hasPhpFile(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((e: string) => e.endsWith('.php'))
  } catch { return false }
}

async function runSingleTest(casePath: string, outputStrategyAutoRegister: any): Promise<Record<string, string>> {
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
    checkers: { taint_flow_test: true, sanitizer: true },
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
  }
  return { [filename]: recorder.getFormatResult() }
}

async function runDirectoryTest(dirPath: string, label: string): Promise<Record<string, string>> {
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
    await execute(null, args, recorder.printAndAppend)
  } catch (e) {
    handleException(e, `[generate-expect] 目录分析失败: ${label}`, `[generate-expect] 目录分析失败: ${label}`)
  }
  return { [label]: recorder.getFormatResult() }
}

async function main(): Promise<void> {
  const benchmarkPath = path.resolve(__dirname, 'benchmarks/sast-php/')
  const casePath = path.join(benchmarkPath, 'case')

  if (!fs.existsSync(casePath)) {
    console.error(`靶场路径不存在: ${casePath}，请先运行 prepare-php-benchmark`)
    process.exit(1)
  }

  const allUnits = getAllTestUnits(casePath)
  console.log(`扫描到 ${allUnits.length} 个测试单元`)

  const actualRes: Record<string, string> = {}
  const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
  outputStrategyAutoRegister.autoRegisterAllStrategies()

  for (let i = 0; i < allUnits.length; i++) {
    const unit = allUnits[i]
    try {
      if (unit.type === 'file') {
        Object.assign(actualRes, await runSingleTest(unit.path, outputStrategyAutoRegister))
      } else {
        Object.assign(actualRes, await runDirectoryTest(unit.path, unit.label))
      }
      if ((i + 1) % 50 === 0) console.log(`  进度: ${i + 1}/${allUnits.length}`)
    } catch (e) {
      console.error(`用例失败: ${unit.label}`)
    }
  }

  const expectDir = path.join(__dirname, 'expect')
  if (!fs.existsSync(expectDir)) fs.mkdirSync(expectDir, { recursive: true })
  fs.writeFileSync(
    path.join(expectDir, 'phpbenchmark-expect.json'),
    JSON.stringify(actualRes),
    { encoding: 'utf8' }
  )
  console.log(`\n生成 expect 文件完成，共 ${Object.keys(actualRes).length} 个 case`)
}

main()
