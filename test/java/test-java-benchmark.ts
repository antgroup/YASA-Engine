import * as path from 'path'
import { describe, it, before } from 'mocha'
const { execute } = require('../../src/interface/starter')
const { ErrorCode } = require('../../src/util/error-code')
const { recordFindingStr, readExpectRes, resolveFindingResult } = require('../test-utils')
import * as assert from 'assert'
import * as fs from 'fs'
const logger = require('../../src/util/logger')(__filename)
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')

function runJavaBenchmark(dir: string): void {
  const description = `YASA test Java benchmark`
  const ruleConfigFile = path.join(path.resolve(dir), '../../rule_config_xast_java.json')
  const repoName = path.basename(dir)
  const expectPath = path.join(dir, '..', '..', 'expect', `${repoName}-expect.result`)
  
  // 先同步读取期望结果，用于注册测试用例
  let expectedResForRegistration: any = null
  let expectedResMapForRegistration: Map<string, any> = new Map()
  if (fs.existsSync(expectPath)) {
    expectedResForRegistration = readExpectRes(expectPath)
    expectedResMapForRegistration = resolveFindingResult(expectedResForRegistration)
  }
  
  describe(description, function () {
    this.timeout(0)
    let result: any
    let expectedRes: any
    let actualRes: any
    let expectedResMap: Map<string, any>
    let actualResMap: Map<string, any>
    let benchmarkReady = false
    
    before(async function () {
      result = await getRunJavaBenchmarkResult(dir)
      expectedRes = result.expectedRes
      actualRes = result.actualRes
      expectedResMap = result.expectedResMap
      actualResMap = result.actualResMap
      benchmarkReady = true
    })

    it(`check result data directly`, function () {
      if (!benchmarkReady) {
        this.skip()
        return
      }
      logger.info(actualRes)
      assert.strictEqual(actualRes, expectedRes, '当前靶场扫描结果与历史预期不一致,请逐个核对链路')
    })
    
    // 使用预先读取的期望结果注册测试用例
    let i = 1
    expectedResMapForRegistration.forEach((value, key) => {
      it(`${i++}-entryPointName:${key}`, function () {
        if (!benchmarkReady) {
          this.skip()
          return
        }
        logger.info('expected:\n' + value)
        logger.info('actual:\n' + actualResMap.get(key))
        if (actualResMap.has(key)) {
          assert.strictEqual(actualResMap.get(key), value, `链路${key}实际trace或内容与预期不一致，请核对该链路`)
        } else {
          assert.fail(`链路或key${key}不存在！！！`)
        }
      })
    })

    // 动态检查新增的链（在 before 执行后）
    it(`check for new chains`, function () {
      if (!benchmarkReady) {
        this.skip()
        return
      }
      const actualChains = Array.from(actualResMap.keys())
      let addChains = actualChains.filter((key) => !expectedResMap.has(key))
      if (Array.isArray(addChains) && addChains.length > 0) {
        for (const addChain of addChains) {
          logger.info(`新增检出${addChain},请核对新增检出内容是否符合预期`)
          logger.info(actualResMap.get(addChain))
        }
        assert.fail(`new chain:${addChains.length}`)
      }
    })
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
