import * as path from 'path'
const { execute } = require('../../src/interface/starter')
const logger = require('../../src/util/logger')(__filename)

async function testJavaCallchain(): Promise<void> {
  const testDir = path.resolve(__dirname, 'java')
  const ruleConfigFile = path.resolve(__dirname, 'rule_config_callchain_java.json')
  const reportDir = path.resolve(__dirname, 'java')

  console.log('\n========== Testing Java Callchain Checker ==========')
  console.log(`Test directory: ${testDir}`)
  console.log(`Rule config: ${ruleConfigFile}`)

  try {
    const args = [
      testDir,
      '--ruleConfigFile',
      ruleConfigFile,
      '--analyzer',
      'JavaAnalyzer',
      '--reportDir',
      reportDir,
      '--entryPointMode',
      'ONLY_CUSTOM',
      '--checkerPackIds',
      'callchain-java',
    ]

    const result = await execute(null, args)

    console.log('\n✓ Java Callchain test completed')
    if (result) {
      console.log(`Found ${Object.keys(result).length} finding categories`)
      if (result.callchain) {
        console.log(`  - Callchain findings: ${result.callchain.length}`)
      }
    }
  } catch (error) {
    console.error('\n✗ Java Callchain test failed:', error)
    throw error
  }
}

testJavaCallchain()
  .then(() => {
    console.log('\nAll Java Callchain tests passed!')
  })
  .catch((error) => {
    console.error('\nJava Callchain tests failed!')
    process.exit(1)
  })
