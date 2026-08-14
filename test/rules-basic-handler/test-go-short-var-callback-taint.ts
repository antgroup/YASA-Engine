import { describe, it, afterEach } from 'mocha'
import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
const config = require('../../src/config')
const Analyzer = require('../../src/engine/analyzer/golang/common/go-analyzer')

const FINDING_KEY = 'taintflow'

async function analyzeGoCode(code: string, fileName: string): Promise<unknown> {
  config.ruleConfigFile = path.join(__dirname, '../../test/go/rule_config.json')
  config.checkerIds = ['taint_flow_test']
  config.uastSDKPath = path.join(__dirname, '../../deps')
  config.language = 'golang'
  config.maindirPrefix = os.tmpdir()
  config.invokeCallbackOnUnknownFunction = 1

  const analyzer = new Analyzer({
    language: 'golang',
    examineIssues: true,
    checkers: {
      taint_flow_test: true,
    },
    ...config,
    mode: { intra: true },
    sanity: true,
  })
  return await analyzer.analyzeSingleFile(code, fileName)
}

function countFindings(findings: unknown): number {
  if (!findings || typeof findings !== 'object') return 0
  const groupedFindings = findings as Partial<Record<typeof FINDING_KEY, unknown[]>>
  return groupedFindings[FINDING_KEY]?.length ?? 0
}

describe('Go 短变量声明中的 callback taint 传播', function () {
  this.timeout(60000)

  const tmpFile = path.join(os.tmpdir(), 'test-go-short-var-callback-taint.go')

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      // 忽略临时文件清理失败
    }
  })

  it('err := helper(func(){ sink(tainted) }) 应执行 RHS callback', async function () {
    const code = `
package main

func __taint_sink(v string) {}

func helper(fn func()) error {
    fn()
    return nil
}

func run() {
    tainted := __taint_src
    err := helper(func() {
        __taint_sink(tainted)
    })
    _ = err
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    assert.strictEqual(countFindings(findings), 1, '短变量声明 RHS callback 内 sink 应检出')
  })

  it('短变量声明 RHS callback 内 sink 不应重复检出', async function () {
    const code = `
package main

func __taint_sink(v string) {}

func helper(fn func()) error {
    fn()
    return nil
}

func run() {
    pageIndex := __taint_src
    pageSize := __taint_src
    err := helper(func() {
        __taint_sink(pageIndex)
        __taint_sink(pageSize)
    })
    _ = err
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    assert.strictEqual(countFindings(findings), 2, 'callback 内两条自由变量链路应各检出一次')
  })
})
