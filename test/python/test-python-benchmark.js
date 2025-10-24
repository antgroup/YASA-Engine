const path = require('path')
const { describe, it } = require('mocha')
const { execute } = require('../../src/interface/starter')
const { ErrorCode } = require('../../src/util/error-code')
const { recordFindingStr, resolveTestFindingResult, readExpectRes } = require('../test-utils')
const assert = require('assert')
const fs = require('fs')
const logger = require('../../src/util/logger')(__filename)
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')

function calResult(result, name) {
  const description = 'YASA test pythonbenchmark'
  describe(description, async function () {
    this.timeout(10000) // 设置超时时间

    it(`check result data directly`, async function () {
      const { expectedRes, actualRes } = result
      logger.info(actualRes)
      assert.strictEqual(actualRes, expectedRes, '当前靶场扫描结果与历史预期不一致,请逐个核对链路')
    })
    let i = 1
    const { expectedResMap, actualResMap } = result
    for (const [key, value] of expectedResMap.entries()) {
      it(`${i++}-file:${key}`, async function () {
        if (Array.isArray(value)) {
          logger.info('expected:\n')
          value.forEach((chain) => logger.info(chain + '\n'))
        } else {
          logger.info('expected:\n' + value)
        }
        if (Array.isArray(actualResMap.get(key))) {
          logger.info('actual:\n')
          actualResMap.get(key).forEach((chain) => logger.info(chain + '\n'))
        } else {
          logger.info('actual:\n' + actualResMap.get(key))
        }

        if (actualResMap.has(key)) {
          if (
            Array.isArray(value) &&
            Array.isArray(actualResMap.get(key)) &&
            value.length === actualResMap.get(key).length
          ) {
            for (const i in value) {
              assert.strictEqual(
                actualResMap.get(key)[i],
                value[i],
                `链路${key}实际trace或内容与预期不一致，请核对该链路`
              )
            }
          } else {
            assert.strictEqual(actualResMap.get(key), value, `链路${key}实际trace或内容与预期不一致，请核对该链路`)
          }
        } else {
          assert.fail(`链路或key${key}不存在！！！`)
        }
      })
    }

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
  })
}

async function update(dir) {
  const ruleConfigFile = __dirname + '/rule_config_xast_python3.json'
  let actualRes
  let recorder = recordFindingStr()
  recorder.clearResult()
  let args = [
    dir,
    '--ruleConfigFile',
    ruleConfigFile,
    '--analyzer',
    'PythonAnalyzer',
    '--checkerIds',
    'taint_flow_test',
    '--uastSDKPath',
    path.join(__dirname, '../../deps/uast4py/uast4py'),
  ]
  try {
    await execute(null, args, recorder.printAndAppend)
  } catch (e) {
    handleException(
      e,
      `[test-python-benchmark] 更新Python基准测试预期结果时发生错误.ERROR: ${e}`,
      `[test-python-benchmark] 更新Python基准测试预期结果时发生错误.ERROR: ${e}`
    )
    recorder.clearResult()
    process.exitCode = ErrorCode.unknown_error
  }
  actualRes = recorder.getFormatResult()
  fs.writeFileSync(path.join(path.resolve(dir), '..', '..', 'expect', 'pythonbenchmark-expect.result'), actualRes, {
    encoding: 'utf8',
  })

  return actualRes
}

async function getRunPythonBenchmarkResult(dir, expectFile) {
  const ruleConfigFile = __dirname + '/rule_config_xast_python3.json'
  let expectPath = path.join(path.resolve(dir), '..', '..', 'expect', expectFile)

  const repoName = path.basename(dir)
  let expectedRes, actualRes, expectedResMap, actualResMap
  let recorder = recordFindingStr()
  recorder.clearResult()

  let args = [
    dir,
    '--ruleConfigFile',
    ruleConfigFile,
    '--analyzer',
    'PythonAnalyzer',
    '--checkerIds',
    'taint_flow_test',
    '--uastSDKPath',
    path.join(__dirname, '../../deps/uast4py/uast4py'),
  ]

  try {
    await execute(null, args, recorder.printAndAppend)
  } catch (e) {
    handleException(
      e,
      `[test-python-benchmark] 运行Python基准测试时发生错误.ERROR: ${e}`,
      `[test-python-benchmark] 运行Python基准测试时发生错误.ERROR: ${e}`
    )
    recorder.clearResult()
    process.exitCode = ErrorCode.unknown_error
  }

  expectedRes = readExpectRes(expectPath)
  actualRes = recorder.getFormatResult()
  expectedResMap = resolveTestFindingResult(expectedRes)
  actualResMap = resolveTestFindingResult(actualRes)

  return {
    expectedRes,
    actualRes,
    expectedResMap,
    actualResMap,
  }
}

describe('YASA test All pythonBenchmarks', async function () {
  let pythonBenchmarkPath = path.resolve(__dirname, 'benchmarks/sast-python3/')
  if (fs.existsSync(pythonBenchmarkPath)) {
    const res = await getRunPythonBenchmarkResult(pythonBenchmarkPath, 'pythonbenchmark-expect.result')
    calResult(res, pythonBenchmarkPath)
  }
})

// update(path.resolve(__dirname, 'benchmarks/sast-python3/'))

module.exports = { getRunPythonBenchmarkResult, calResult }
