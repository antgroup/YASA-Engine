import * as path from 'path'
const { execute } = require('../../src/interface/starter')
const logger = require('../../src/util/logger')(__filename)

async function testPythonCallchain(): Promise<void> {
  const testDir = path.join(__dirname, 'python')
  const ruleConfigFile = path.join(__dirname, 'rule_config_callchain_python.json')

  console.log('\n========== Testing Python Callchain Checker ==========')
  console.log(`Test directory: ${testDir}`)
  console.log(`Rule config: ${ruleConfigFile}`)

  try {
    const args = [
      testDir,
      '--ruleConfigFile',
      ruleConfigFile,
      '--analyzer',
      'PythonAnalyzer',
      '--reportDir',
      path.join(__dirname, 'python'),
      '--entryPointMode',
      'BOTH',
      '--checkerPackIds',
      'callchain-python',
      '--uastSDKPath',
      path.join(__dirname, '../../deps'),
    ]

    const result = await execute(null, args)

    console.log('\n✓ Python Callchain test completed')
    if (result) {
      console.log(`Found ${Object.keys(result).length} finding categories`)
      if (result.callchain) {
        console.log(`  - Callchain findings: ${result.callchain.length}`)
      }
    }
  } catch (error) {
    console.error('\n✗ Python Callchain test failed:', error)
    throw error
  }
}

testPythonCallchain()
  .then(() => {
    console.log('\nAll Python Callchain tests passed!')
  })
  .catch((error) => {
    console.error('\nPython Callchain tests failed!')
    process.exit(1)
  })
