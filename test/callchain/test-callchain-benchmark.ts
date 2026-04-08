import * as path from 'path'
import * as fs from 'fs'
import { execFileSync } from 'child_process'
import { describe, it, before } from 'mocha'
import * as assert from 'assert'
const logger = require('../../src/util/logger')(__filename)

// ========================= 工具函数 =========================

const WORKSPACE_ROOT = path.resolve(__dirname, '../..') + '/'
const REPORT_FILE = path.resolve(WORKSPACE_ROOT, 'report', 'callchain-report.json')

/**
 * 将 JSON 中所有绝对路径替换为相对路径，确保跨机器可比
 */
function normalizeJson(obj: any): any {
  const str = JSON.stringify(obj, null, 2)
  return JSON.parse(str.split(WORKSPACE_ROOT).join(''))
}

/**
 * 递归比较两个 JSON 对象，返回所有差异的描述
 */
function jsonDiff(expected: any, actual: any, currentPath: string = ''): string[] {
  const diffs: string[] = []
  if (expected === actual) return diffs

  if (expected === null || actual === null || expected === undefined || actual === undefined) {
    diffs.push(`${currentPath || '<root>'}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`)
    return diffs
  }
  if (typeof expected !== typeof actual) {
    diffs.push(`${currentPath || '<root>'}: type mismatch, expected ${typeof expected}, actual ${typeof actual}`)
    return diffs
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      diffs.push(`${currentPath}: array length expected=${expected.length}, actual=${actual.length}`)
    }
    const maxLen = Math.max(expected.length, actual.length)
    for (let i = 0; i < maxLen; i++) {
      if (i >= expected.length) {
        diffs.push(`${currentPath}[${i}]: 新增元素: ${JSON.stringify(actual[i]).slice(0, 200)}`)
      } else if (i >= actual.length) {
        diffs.push(`${currentPath}[${i}]: 缺失元素: ${JSON.stringify(expected[i]).slice(0, 200)}`)
      } else {
        diffs.push(...jsonDiff(expected[i], actual[i], `${currentPath}[${i}]`))
      }
    }
    return diffs
  }
  if (typeof expected === 'object') {
    const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    for (const key of allKeys) {
      const keyPath = currentPath ? `${currentPath}.${key}` : key
      if (!(key in expected)) {
        diffs.push(`${keyPath}: 新增字段, value=${JSON.stringify(actual[key]).slice(0, 200)}`)
      } else if (!(key in actual)) {
        diffs.push(`${keyPath}: 缺失字段, expected=${JSON.stringify(expected[key]).slice(0, 200)}`)
      } else {
        diffs.push(...jsonDiff(expected[key], actual[key], keyPath))
      }
    }
    return diffs
  }
  if (expected !== actual) {
    diffs.push(`${currentPath || '<root>'}: expected=${JSON.stringify(expected).slice(0, 200)}, actual=${JSON.stringify(actual).slice(0, 200)}`)
  }
  return diffs
}

// ========================= 测试配置 =========================

interface TestConfig {
  name: string
  runner: string // 已有的独立测试脚本路径
  expectFile: string
  expectedFindingsCount: number
}

const configs: TestConfig[] = [
  {
    name: 'Java',
    runner: path.resolve(__dirname, 'test-callchain-java.ts'),
    expectFile: path.resolve(__dirname, 'expect', 'callchain-java-expect.json'),
    expectedFindingsCount: 2,
  },
  {
    name: 'Go',
    runner: path.resolve(__dirname, 'test-callchain-go.ts'),
    expectFile: path.resolve(__dirname, 'expect', 'callchain-go-expect.json'),
    expectedFindingsCount: 9,
  },
  {
    name: 'JavaScript',
    runner: path.resolve(__dirname, 'test-callchain-js.ts'),
    expectFile: path.resolve(__dirname, 'expect', 'callchain-js-expect.json'),
    expectedFindingsCount: 9,
  },
  {
    name: 'Python',
    runner: path.resolve(__dirname, 'test-callchain-python.ts'),
    expectFile: path.resolve(__dirname, 'expect', 'callchain-python-expect.json'),
    expectedFindingsCount: 4,
  },
]

// ========================= Mocha 测试 =========================

describe('Callchain Checker Regression Tests', function () {
  this.timeout(0)

  for (const config of configs) {
    // 同步预读 expect 文件，用于注册测试用例
    let expectedFindings: any[] = []
    let expectedJson: any = null
    if (fs.existsSync(config.expectFile)) {
      expectedJson = JSON.parse(fs.readFileSync(config.expectFile, 'utf-8'))
      expectedFindings = expectedJson.findings || []
    }

    describe(`${config.name} Callchain`, function () {
      let actualJson: any
      let benchmarkReady = false

      before(function () {
        // 在子进程中运行各语言测试脚本，避免 Config 单例污染
        // 每个 test-callchain-<lang>.ts 会写入 report/callchain-report.json
        try {
          execFileSync('npx', ['tsx', config.runner], {
            cwd: WORKSPACE_ROOT,
            stdio: 'pipe',
            timeout: 120000,
          })
        } catch (e: any) {
          logger.info(`[${config.name}] 子进程执行出错: ${e.message || e}`)
          if (e.stdout) logger.info(`stdout: ${e.stdout.toString().slice(-500)}`)
          if (e.stderr) logger.info(`stderr: ${e.stderr.toString().slice(-500)}`)
        }

        // 读取子进程生成的 report 并标准化
        if (fs.existsSync(REPORT_FILE)) {
          const rawJson = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf-8'))
          actualJson = normalizeJson(rawJson)
          benchmarkReady = true
        }

        // UPDATE_EXPECT=1 时保存当前输出为新 expect
        if (process.env.UPDATE_EXPECT === '1' && actualJson) {
          fs.mkdirSync(path.dirname(config.expectFile), { recursive: true })
          fs.writeFileSync(config.expectFile, JSON.stringify(actualJson, null, 2) + '\n', 'utf-8')
          logger.info(`Updated: ${config.expectFile}`)
          expectedJson = actualJson
          expectedFindings = actualJson.findings || []
        }
      })

      it(`should produce report`, function () {
        assert.ok(benchmarkReady, `${config.name}: callchain-report.json 未生成`)
      })

      it(`should have expect file`, function () {
        assert.ok(
          fs.existsSync(config.expectFile),
          `未找到expect文件: ${config.expectFile}\n请执行: UPDATE_EXPECT=1 npm run test-callchain`
        )
      })

      it(`total findings count: ${expectedFindings.length}`, function () {
        if (!benchmarkReady) { this.skip(); return }
        assert.ok(expectedJson, 'expect文件不存在')
        assert.strictEqual(
          actualJson.totalFindings,
          expectedJson.totalFindings,
          `检出数量不一致: 预期 ${expectedJson.totalFindings}, 实际 ${actualJson.totalFindings}`
        )
      })

      // 为每个预期 finding 注册独立测试
      expectedFindings.forEach((expected: any, index: number) => {
        const sinkRule = expected.sinkInfo?.sinkRule || 'unknown'
        const file = expected.sinkInfo?.callSite?.file || '?'
        const line = expected.sinkInfo?.callSite?.line || '?'
        const entryFunc = expected.entrypoint?.functionName || 'N/A'

        it(`${index + 1}-finding:[${sinkRule}] at ${file}:${line} (entry:${entryFunc})`, function () {
          if (!benchmarkReady) { this.skip(); return }
          const actual = actualJson?.findings?.[index]
          if (!actual) {
            assert.fail(`第${index + 1}个finding缺失(实际仅${actualJson?.findings?.length || 0}个)`)
            return
          }
          const diffs = jsonDiff(expected, actual)
          if (diffs.length > 0) {
            const diffReport = diffs.map((d, i) => `  [${i + 1}] ${d}`).join('\n')
            logger.info(`Finding ${index + 1} expected:\n${JSON.stringify(expected, null, 2)}`)
            logger.info(`Finding ${index + 1} actual:\n${JSON.stringify(actual, null, 2)}`)
            assert.fail(`第${index + 1}个finding有${diffs.length}处差异:\n${diffReport}`)
          }
        })
      })

      it(`no extra findings`, function () {
        if (!benchmarkReady) { this.skip(); return }
        if (!actualJson?.findings || !expectedJson?.findings) return
        if (actualJson.findings.length > expectedJson.findings.length) {
          const extras = actualJson.findings.slice(expectedJson.findings.length)
          const desc = extras
            .map((f: any, i: number) => `  [${expectedJson.findings.length + i + 1}] ${f.sinkInfo?.sinkRule || '?'} at ${f.sinkInfo?.callSite?.file || '?'}:${f.sinkInfo?.callSite?.line || '?'}`)
            .join('\n')
          assert.fail(`多出${extras.length}个finding:\n${desc}\n请执行 UPDATE_EXPECT=1 npm run test-callchain 更新`)
        }
      })
    })
  }
})
