import * as path from 'path'
import { describe, it } from 'mocha'
const { execute } = require('../../src/interface/starter')
const { ErrorCode } = require('../../src/util/error-code')
const { recordFindingStr, readExpectRes, resolveFindingResult } = require('../test-utils')
import * as assert from 'assert'
import * as fs from 'fs'
const logger = require('../../src/util/logger')(__filename)
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')

async function runJavaBenchmark(dir: string): Promise<void> {
  const description = `YASA test Java benchmark`
  describe(description, async function () {
    let result = await getRunJavaBenchmarkResult(dir)
    const { expectedRes, actualRes, expectedResMap, actualResMap } = result
    this.timeout(10000)

    it(`check result data directly`, function () {
      logger.info(actualRes)
      assert.strictEqual(actualRes, expectedRes, '当前靶场扫描结果与历史预期不一致,请逐个核对链路')
    })
    let i = 1
    expectedResMap.forEach((value, key) => {
      it(`${i++}-entryPointName:${key}`, function () {
        logger.info('expected:\n' + value)
        logger.info('actual:\n' + actualResMap.get(key))
        if (actualResMap.has(key)) {
          assert.strictEqual(actualResMap.get(key), value, `链路${key}实际trace或内容与预期不一致，请核对该链路`)
        } else {
          assert.fail(`链路或key${key}不存在！！！`)
        }
      })
    })

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

async function getRunJavaBenchmarkResult(dir: string): Promise<{
  expectedRes: any
  actualRes: any
  expectedResMap: Map<string, any>
  actualResMap: Map<string, any>
}> {
  const ruleConfigFile = path.join(path.resolve(dir), '../../rule_config_xast_java.json')
  const repoName = path.basename(dir)

  const expectPath = path.join(dir, '..', '..', 'expect', `${repoName}-expect.result`)
  let expectedRes: any, actualRes: any, expectedResMap: Map<string, any>, actualResMap: Map<string, any>
  let recorder = recordFindingStr()
  recorder.clearResult()

  let args = [
    dir,
    '--ruleConfigFile',
    ruleConfigFile,
    '--analyzer',
    'SpringAnalyzer',
    '--checkerPackIds',
    'taint-flow-java-inner',
  ]
  await (async () => {
    try {
      await execute(null, args, recorder.printAndAppend)
    } catch (e) {
      handleException(
        e,
        `[test-java-benchmark] 运行Java基准测试时发生错误.ERROR: ${e}`,
        `[test-java-benchmark] 运行Java基准测试时发生错误.ERROR: ${e}`
      )
      recorder.clearResult()
      process.exitCode = ErrorCode.unknown_error
    }
  })()

  expectedRes = readExpectRes(expectPath)
  actualRes = recorder.getFormatResult()
  expectedResMap = resolveFindingResult(expectedRes)
  actualResMap = resolveFindingResult(actualRes)

  return {
    expectedRes,
    actualRes,
    expectedResMap,
    actualResMap,
  }
}

async function updateExpect(dir: string): Promise<void> {
  const ruleConfigFile = path.join(path.resolve(dir), '../../rule_config_xast_java.json')
  const repoName = path.basename(dir)
  let actualRes: any
  let recorder = recordFindingStr()
  recorder.clearResult()
  let args = [
    dir,
    '--ruleConfigFile',
    ruleConfigFile,
    '--analyzer',
    'SpringAnalyzer',
    '--checkerPackIds',
    'taint-flow-java-inner',
  ]
  try {
    await execute(null, args, recorder.printAndAppend)
  } catch (e) {
    handleException(
      e,
      `[test-java-benchmark] 更新预期结果时发生错误.ERROR: ${e}`,
      `[test-java-benchmark] 更新预期结果时发生错误.ERROR: ${e}`
    )
    recorder.clearResult()
    process.exitCode = ErrorCode.unknown_error
  }
  actualRes = recorder.getFormatResult()
  fs.writeFileSync(path.join(path.resolve(dir), '..', '..', 'expect', `${repoName}-expect.result`), actualRes, {
    encoding: 'utf8',
  })
}

let dir = path.join(path.resolve(__dirname), '/benchmarks/sast-java/')
if (fs.existsSync(dir)) {
  runJavaBenchmark(dir)
}

// updateExpect(dir)
