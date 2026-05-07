import * as path from 'path'
import * as fs from 'fs'
import { describe, it, before } from 'mocha'
import * as assert from 'assert'
const { execute } = require('../../src/interface/starter')
const Config = require('../../src/config')

const WORKSPACE_ROOT = path.resolve(__dirname, '../..') + '/'
const RULE_CONFIG = path.resolve(WORKSPACE_ROOT, 'resource', 'checker', 'rule_config_php.json')
const DEPS_PATH = path.resolve(WORKSPACE_ROOT, 'deps')
const TEST_CASES_DIR = path.resolve(__dirname, 'checker-cases')

/** 重置 Config 中 commander 回调会修改的运行时字段，避免跨测试污染 */
function resetConfig(): void {
  Config.dumpCG = false
  Config.dumpAllCG = false
  Config.dumpAST = false
  Config.dumpAllAST = false
  Config.single = false
  Config.checkerIds = []
  Config.checkerPackIds = []
  Config.ruleConfigFile = ''
  Config.reportDir = ''
  Config.language = undefined
  Config.uastSDKPath = undefined
}

/** 等待异步流写入完成（createWriteStream 无 await，需轮询） */
function waitForFile(filePath: string, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = (): void => {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
        resolve()
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`等待文件超时: ${filePath}`))
      } else {
        setTimeout(check, intervalMs)
      }
    }
    check()
  })
}

function readScanSummary(reportDir: string): any {
  const summaryPath = path.join(reportDir, 'scan_summary.json')
  if (!fs.existsSync(summaryPath)) return null
  return JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
}

describe('PHP Checker Regression Tests', function () {
  this.timeout(0)

  // ============= Taint Checker =============
  describe('Taint Checker (taint-flow-php-default)', function () {
    const reportDir = path.resolve('/tmp', 'php-checker-test-taint')
    let summary: any

    before(async function () {
      if (fs.existsSync(reportDir)) {
        fs.rmSync(reportDir, { recursive: true })
      }
      resetConfig()
      await execute(null, [
        TEST_CASES_DIR,
        '--ruleConfigFile', RULE_CONFIG,
        '--checkerPackIds', 'taint-flow-php-default',
        '--language', 'php',
        '--uastSDKPath', DEPS_PATH,
        '--report', reportDir,
      ])
      summary = readScanSummary(reportDir)
    })

    it('should produce scan_summary.json', function () {
      assert.ok(summary, 'scan_summary.json 未生成')
    })

    it('should detect PHP files', function () {
      assert.ok(summary.fileCount >= 4, `文件数不足: ${summary.fileCount}`)
    })

    it('should mark sources (>= 1)', function () {
      assert.ok(summary.markedSourceCount >= 1, `Sources marked: ${summary.markedSourceCount}`)
    })

    it('should find taint findings (>= 1)', function () {
      assert.ok(summary.findingCount >= 1, `Findings: ${summary.findingCount}，期望 >= 1`)
    })

    it('should have valid entrypoints', function () {
      assert.ok(summary.entryPointCount >= 1, `Entrypoints: ${summary.entryPointCount}`)
    })
  })

  // ============= Callchain Checker =============
  describe('Callchain Checker (callchain-php)', function () {
    const reportDir = path.resolve('/tmp', 'php-checker-test-callchain')
    let summary: any

    before(async function () {
      if (fs.existsSync(reportDir)) {
        fs.rmSync(reportDir, { recursive: true })
      }
      resetConfig()
      await execute(null, [
        TEST_CASES_DIR,
        '--ruleConfigFile', RULE_CONFIG,
        '--checkerPackIds', 'callchain-php',
        '--language', 'php',
        '--uastSDKPath', DEPS_PATH,
        '--report', reportDir,
      ])
      summary = readScanSummary(reportDir)
    })

    it('should produce scan_summary.json', function () {
      assert.ok(summary, 'scan_summary.json 未生成')
    })

    it('should detect PHP files', function () {
      assert.ok(summary.fileCount >= 4, `文件数不足: ${summary.fileCount}`)
    })

    it('should complete without error', function () {
      assert.ok(summary.totalTimeMs >= 0, '执行异常')
    })
  })

  // ============= dumpCG =============
  describe('dumpCG (callgraph)', function () {
    const reportDir = path.resolve('/tmp', 'php-checker-test-dumpcg')

    before(async function () {
      if (fs.existsSync(reportDir)) {
        fs.rmSync(reportDir, { recursive: true })
      }
      resetConfig()
      await execute(null, [
        TEST_CASES_DIR,
        '--dumpCG',
        '--language', 'php',
        '--uastSDKPath', DEPS_PATH,
        '--report', reportDir,
        '--ruleConfigFile', RULE_CONFIG,
        '--checkerPackIds', 'callchain-php',
      ])
      // callgraph 使用 createWriteStream 异步写入，等待流刷盘
      await waitForFile(path.join(reportDir, 'callgraph.json'))
    })

    it('should produce callgraph.json', function () {
      const cgPath = path.join(reportDir, 'callgraph.json')
      assert.ok(fs.existsSync(cgPath), 'callgraph.json 未生成')
    })

    it('should have nodes in callgraph', function () {
      const cgPath = path.join(reportDir, 'callgraph.json')
      const cg = JSON.parse(fs.readFileSync(cgPath, 'utf-8'))
      assert.ok(cg.nodes && Object.keys(cg.nodes).length > 0, 'callgraph 没有 nodes')
    })
  })

  // ============= dumpAllAST =============
  describe('dumpAllAST', function () {
    const reportDir = path.resolve('/tmp', 'php-checker-test-dumpast')

    before(async function () {
      if (fs.existsSync(reportDir)) {
        fs.rmSync(reportDir, { recursive: true })
      }
      resetConfig()
      await execute(null, [
        TEST_CASES_DIR,
        '--dumpAllAST',
        '--language', 'php',
        '--uastSDKPath', DEPS_PATH,
        '--report', reportDir,
      ])
    })

    it('should produce astList.json', function () {
      const astListPath = path.join(reportDir, 'astList.json')
      assert.ok(fs.existsSync(astListPath), 'astList.json 未生成')
    })

    it('should produce AST JSON files', function () {
      const astListPath = path.join(reportDir, 'astList.json')
      const astList = JSON.parse(fs.readFileSync(astListPath, 'utf-8'))
      assert.ok(Array.isArray(astList) && astList.length > 0, 'AST 文件列表为空')
    })
  })
})
