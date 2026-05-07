import * as path from 'path'
import * as fs from 'fs'
// @ts-ignore
import { computeAccuracyFromSarif, AccuracyStats } from '../trace-accuracy'
const { execute } = require('../../src/interface/starter')
const logger = require('../../src/util/logger')(__filename)

interface TestConfig {
  name: string
  testDir: string
  ruleConfigFile: string
  analyzer: string
  checkerPackId: string
}

const tests: TestConfig[] = [
  {
    name: 'Java',
    testDir: path.join(__dirname, 'java'),
    ruleConfigFile: path.join(__dirname, 'rule_config_callchain_java.json'),
    analyzer: 'JavaAnalyzer',
    checkerPackId: 'callchain-java',
  },
  {
    name: 'Go',
    testDir: path.join(__dirname, 'go'),
    ruleConfigFile: path.join(__dirname, 'rule_config_callchain_go.json'),
    analyzer: 'GoAnalyzer',
    checkerPackId: 'callchain-go',
  },
  {
    name: 'JavaScript',
    testDir: path.join(__dirname, 'js'),
    ruleConfigFile: path.join(__dirname, 'rule_config_callchain_js.json'),
    analyzer: 'JavaScriptAnalyzer',
    checkerPackId: 'callchain-js',
  },
  {
    name: 'Python',
    testDir: path.join(__dirname, 'python'),
    ruleConfigFile: path.join(__dirname, 'rule_config_callchain_python.json'),
    analyzer: 'PythonAnalyzer',
    checkerPackId: 'callchain-python',
  },
]

async function runCallchainTest(config: TestConfig): Promise<AccuracyStats | null> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Testing ${config.name} Callchain Checker`)
  console.log(`${'='.repeat(60)}`)
  console.log(`Test directory: ${config.testDir}`)
  console.log(`Rule config: ${config.ruleConfigFile}`)

  try {
    const reportDir = path.join(config.testDir, 'report')
    const args = [
      config.testDir,
      '--ruleConfigFile',
      config.ruleConfigFile,
      '--analyzer',
      config.analyzer,
      '--report',
      reportDir,
      '--entryPointMode',
      'ONLY_CUSTOM',
      '--checkerPackIds',
      config.checkerPackId,
    ]

    const result = await execute(null, args)

    console.log(`\n✓ ${config.name} Callchain test completed successfully`)
    if (result) {
      console.log(`  Found ${Object.keys(result).length} finding categories`)
      if (result.callchain) {
        console.log(`  - Callchain findings: ${result.callchain.length}`)
      }
    }

    // 计算 trace 准确率
    const sarifPath = path.join(reportDir, 'report.sarif')
    if (fs.existsSync(sarifPath)) {
      const sarifData = JSON.parse(fs.readFileSync(sarifPath, 'utf-8'))
      const stats = computeAccuracyFromSarif(sarifData)
      const pct = stats.evaluableHops > 0 ? ((stats.accurateHops / stats.evaluableHops) * 100).toFixed(2) : 'N/A'
      console.log(
        `  Trace Accuracy: ${pct}% (${stats.accurateHops}/${stats.evaluableHops} hops, ${stats.totalFindings} findings)`
      )
      return stats
    }
    return null
  } catch (error) {
    console.error(`\n✗ ${config.name} Callchain test failed:`, error)
    throw error
  }
}

async function runAllTests(): Promise<void> {
  console.log('\n' + '='.repeat(60))
  console.log('Running All Callchain Checker Tests')
  console.log('='.repeat(60))

  const results: Array<{ name: string; success: boolean; error?: any; accuracy?: AccuracyStats | null }> = []

  for (const test of tests) {
    try {
      const accuracy = await runCallchainTest(test)
      results.push({ name: test.name, success: true, accuracy })
    } catch (error) {
      results.push({ name: test.name, success: false, error })
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log('Test Results Summary')
  console.log('='.repeat(60))

  results.forEach((result) => {
    const status = result.success ? '✓ PASS' : '✗ FAIL'
    console.log(`${status} - ${result.name}`)
    if (!result.success && result.error) {
      console.log(`  Error: ${result.error.message || result.error}`)
    }
  })

  const failedCount = results.filter((r) => !r.success).length
  const passedCount = results.filter((r) => r.success).length

  console.log(`\nTotal: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`)

  // 输出 trace 准确率汇总
  console.log('\n' + '='.repeat(60))
  console.log('Trace Accuracy Summary')
  console.log('='.repeat(60))
  for (const result of results) {
    if (result.accuracy) {
      const pct =
        result.accuracy.evaluableHops > 0
          ? ((result.accuracy.accurateHops / result.accuracy.evaluableHops) * 100).toFixed(2)
          : 'N/A'
      console.log(
        `${result.name}: ${pct}% (${result.accuracy.accurateHops}/${result.accuracy.evaluableHops} hops, ${result.accuracy.totalFindings} findings)`
      )
    } else {
      console.log(`${result.name}: N/A`)
    }
  }

  if (failedCount > 0) {
    throw new Error(`${failedCount} test(s) failed`)
  }
}

runAllTests()
  .then(() => {
    console.log('\n✓ All Callchain tests passed!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('\n✗ Some Callchain tests failed!')
    process.exit(1)
  })
