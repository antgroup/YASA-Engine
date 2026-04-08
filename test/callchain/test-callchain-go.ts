import * as path from 'path'
const { execute } = require('../../src/interface/starter')
const logger = require('../../src/util/logger')(__filename)

async function testGoCallchain(): Promise<void> {
  const testDir = path.join(__dirname, 'go')
  const ruleConfigFile = path.join(__dirname, 'rule_config_callchain_go.json')

  console.log('\n========== Testing Go Callchain Checker ==========')
  console.log(`Test directory: ${testDir}`)
  console.log(`Rule config: ${ruleConfigFile}`)

  try {
    const args = [
      testDir,
      '--ruleConfigFile',
      ruleConfigFile,
      '--analyzer',
      'GoAnalyzer',
      '--reportDir',
      path.join(__dirname, 'go'),
      '--entryPointMode',
      'BOTH',
      '--checkerPackIds',
      'callchain-go',
      '--uastSDKPath',
      path.join(__dirname, '../../deps'),
    ]

    const result = await execute(null, args)

    console.log('\n✓ Go Callchain test completed')
    if (result) {
      console.log(`Found ${Object.keys(result).length} finding categories`)
      if (result.callchain) {
        console.log(`  - Callchain findings: ${result.callchain.length}`)
      }
    }
  } catch (error) {
    console.error('\n✗ Go Callchain test failed:', error)
    throw error
  }
}

testGoCallchain()
  .then(() => {
    console.log('\nAll Go Callchain tests passed!')
  })
  .catch((error) => {
    console.error('\nGo Callchain tests failed!')
    process.exit(1)
  })
