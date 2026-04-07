import * as path from 'path'
const { execute } = require('../../src/interface/starter')
const logger = require('../../src/util/logger')(__filename)

async function testJsCallchain(): Promise<void> {
  const testDir = path.join(__dirname, 'js')
  const ruleConfigFile = path.join(__dirname, 'rule_config_callchain_js.json')

  console.log('\n========== Testing JavaScript Callchain Checker ==========')
  console.log(`Test directory: ${testDir}`)
  console.log(`Rule config: ${ruleConfigFile}`)

  try {
    const args = [
      testDir,
      '--ruleConfigFile',
      ruleConfigFile,
      '--analyzer',
      'JavaScriptAnalyzer',
      '--reportDir',
      path.join(__dirname, 'js'),
      '--entryPointMode',
      'ONLY_CUSTOM',
      '--checkerPackIds',
      'callchain-js',
    ]

    const result = await execute(null, args)

    console.log('\n✓ JavaScript Callchain test completed')
    if (result) {
      console.log(`Found ${Object.keys(result).length} finding categories`)
      if (result.callchain) {
        console.log(`  - Callchain findings: ${result.callchain.length}`)
      }
    }
  } catch (error) {
    console.error('\n✗ JavaScript Callchain test failed:', error)
    throw error
  }
}

testJsCallchain()
  .then(() => {
    console.log('\nAll JavaScript Callchain tests passed!')
  })
  .catch((error) => {
    console.error('\nJavaScript Callchain tests failed!')
    process.exit(1)
  })
