import { describe, it, afterEach } from 'mocha'
import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
interface AnalyzerOptions extends Record<string, unknown> {
  language: string
  examineIssues: boolean
  checkers: Record<string, boolean>
  mode: { intra: boolean }
  sanity: boolean
}

interface SinkUtilModule {
  getMatchedSinkCount: () => number
  resetMatchedSinkCount: () => void
}

interface GoAnalyzerInstance {
  analyzeSingleFile: (code: string, fileName: string) => Promise<TaintFindings>
}

type GoAnalyzerConstructor = new (options: AnalyzerOptions) => GoAnalyzerInstance

type MutableConfig = Record<string, unknown> & {
  ruleConfigFile?: string
  checkerIds?: string[]
  uastSDKPath?: string
  language?: string
  maindirPrefix?: string
}

type TaintFindings = Record<string, unknown[]>

const config = require('../../src/config') as MutableConfig
const Analyzer = require('../../src/engine/analyzer/golang/common/go-analyzer') as GoAnalyzerConstructor
const sinkUtil = require('../../src/checker/taint/common-kit/sink-util') as SinkUtilModule

const FINDING_KEY = 'taintflow'

function resolveUastSDKPath(): string {
  const localDeps = path.join(__dirname, '../../deps')
  if (!fs.existsSync(localDeps)) {
    throw new Error(`UAST dependencies not found at repository path: ${localDeps}`)
  }
  return localDeps
}

async function analyzeGoCode(
  code: string,
  fileName: string,
  ruleConfigFile?: string,
  checkerIds: string[] = ['taint_flow_test']
): Promise<TaintFindings> {
  config.ruleConfigFile = ruleConfigFile ?? path.join(__dirname, '../../test/go/rule_config.json')
  config.checkerIds = checkerIds
  config.uastSDKPath = resolveUastSDKPath()
  config.language = 'golang'
  config.maindirPrefix = os.tmpdir()

  const analyzer = new Analyzer({
    language: 'golang',
    examineIssues: true,
    checkers: Object.fromEntries(checkerIds.map((checkerId) => [checkerId, true])),
    ...config,
    mode: { intra: true },
    sanity: true,
  })
  return await analyzer.analyzeSingleFile(code, fileName)
}

function countFindings(findings: TaintFindings): number {
  return findings[FINDING_KEY]?.length ?? 0
}

function countAllFindings(findings: TaintFindings): number {
  return Object.values(findings).reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0)
}

describe('Go encoding/json.Unmarshal struct field taint propagation', function () {
  this.timeout(60000)

  const tmpDir = os.tmpdir()
  const tmpFile = path.join(tmpDir, 'test-go-json-unmarshal-field-taint.go')

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      // 忽略清理失败
    }
  })

  it('tainted []byte input should taint tagged struct field read after json.Unmarshal', async function () {
    const code = `
package main

import "encoding/json"

type Req struct {
    TableName string ` + '`json:"tableName"`' + `
}

func handle(input string) {
    req := &Req{}
    json.Unmarshal([]byte(input), req)
    __taint_sink(req.TableName)
}

func main() {
    handle(__taint_src)
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    const count = countFindings(findings)
    assert.ok(count > 0, `expected >=1 finding for tagged field taint, got ${count}`)
  })

  it('tainted []byte input should not taint json ignored struct field', async function () {
    const code = `
package main

import "encoding/json"

type Req struct {
    TableName string ` + '`json:"-"`' + `
}

func handle(input string) {
    req := &Req{}
    json.Unmarshal([]byte(input), req)
    __taint_sink(req.TableName)
}

func main() {
    handle(__taint_src)
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    const count = countFindings(findings)
    assert.strictEqual(count, 0, `expected no finding for json ignored field, got ${count}`)
  })

  it('tainted []byte input should taint function-local tagged struct field', async function () {
    const code = `
package main

import "encoding/json"

func handle(input string) {
    type DataSource struct {
        TableName string ` + '`json:"tableName"`' + `
    }
    req := &DataSource{}
    json.Unmarshal([]byte(input), req)
    __taint_sink(req.TableName)
}

func main() {
    handle(__taint_src)
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    const count = countFindings(findings)
    assert.ok(count > 0, `expected >=1 finding for function-local field taint, got ${count}`)
  })

  it('tainted []byte input should reach sink through function-local field string concatenation', async function () {
    const code = `
package main

import "encoding/json"

func handle(input string) {
    type DataSource struct {
        TableName string ` + '`json:"tableName"`' + `
    }
    req := &DataSource{}
    json.Unmarshal([]byte(input), req)
    __taint_sink("Show Create Table " + req.TableName)
}

func main() {
    handle(__taint_src)
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    const count = countFindings(findings)
    assert.ok(count > 0, `expected >=1 finding for function-local concatenated field taint, got ${count}`)
  })

  it('tainted []byte input should taint untagged struct field via field-name fallback', async function () {
    const code = `
package main

import "encoding/json"

type Req struct {
    TableName string
}

func handle(input string) {
    req := &Req{}
    json.Unmarshal([]byte(input), req)
    __taint_sink(req.TableName)
}

func main() {
    handle(__taint_src)
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    const count = countFindings(findings)
    assert.ok(count > 0, `expected >=1 finding for field-name fallback taint, got ${count}`)
  })

  it('strict *sql.DB Query sink should match after sql.Open tuple assignment', async function () {
    const strictRuleConfig = path.join(tmpDir, 'test-go-sql-open-strict-sink-rule.json')
    const strictFile = path.join(tmpDir, 'test-go-sql-open-strict-sink.go')
    const code = `
package main

import (
    "database/sql"
)

func handle(input string) {
    db, err := sql.Open("mysql", "dsn")
    if err != nil {
        return
    }
    db.Query(input)
}

func main() {
    handle(__taint_src)
}
`
    const ruleConfig = [
      {
        checkerIds: ['taint_flow_go_input'],
        sources: {
          TaintSource: [{ path: '__taint_src' }],
        },
        sinks: {
          FuncCallTaintSink: [
            {
              fsig: 'Query',
              calleeType: '*sql.DB',
              args: [0],
            },
          ],
        },
      },
    ]

    fs.writeFileSync(strictFile, code)
    fs.writeFileSync(strictRuleConfig, JSON.stringify(ruleConfig, null, 2))
    sinkUtil.resetMatchedSinkCount()
    try {
      const findings = await analyzeGoCode(code, strictFile, strictRuleConfig, ['taint_flow_go_input'])
      const count = countAllFindings(findings)
      assert.ok(sinkUtil.getMatchedSinkCount() > 0, 'expected strict *sql.DB Query matchedSinkCount > 0')
      assert.ok(count > 0, `expected >=1 finding for strict *sql.DB Query sink, got ${count}`)
    } finally {
      try {
        fs.unlinkSync(strictFile)
      } catch {
        // 忽略清理失败
      }
      try {
        fs.unlinkSync(strictRuleConfig)
      } catch {
        // 忽略清理失败
      }
    }
  })

  it('strict *sql.DB Query sink should match through struct field receiver type', async function () {
    const strictRuleConfig = path.join(tmpDir, 'test-go-sql-field-receiver-strict-sink-rule.json')
    const strictFile = path.join(tmpDir, 'test-go-sql-field-receiver-strict-sink.go')
    const code = `
package main

import (
    "database/sql"
)

type holder struct {
    db *sql.DB
}

var h holder

func handle(input string) {
    h.db.Query(input)
}

func main() {
    handle(__taint_src)
}
`
    const ruleConfig = [
      {
        checkerIds: ['taint_flow_go_input'],
        sources: {
          TaintSource: [{ path: '__taint_src' }],
        },
        sinks: {
          FuncCallTaintSink: [
            {
              fsig: 'Query',
              calleeType: '*sql.DB',
              args: [0],
            },
          ],
        },
      },
    ]

    fs.writeFileSync(strictFile, code)
    fs.writeFileSync(strictRuleConfig, JSON.stringify(ruleConfig, null, 2))
    sinkUtil.resetMatchedSinkCount()
    try {
      const findings = await analyzeGoCode(code, strictFile, strictRuleConfig, ['taint_flow_go_input'])
      const count = countAllFindings(findings)
      assert.ok(sinkUtil.getMatchedSinkCount() > 0, 'expected strict *sql.DB Query matchedSinkCount > 0 through struct field receiver')
      assert.ok(count > 0, `expected >=1 finding for strict *sql.DB struct field receiver sink, got ${count}`)
    } finally {
      try {
        fs.unlinkSync(strictFile)
      } catch {
        // 忽略清理失败
      }
      try {
        fs.unlinkSync(strictRuleConfig)
      } catch {
        // 忽略清理失败
      }
    }
  })

  it('strict *gin.Context return source should match through embedded field type', async function () {
    const strictRuleConfig = path.join(tmpDir, 'test-go-gin-embedded-context-source-rule.json')
    const strictFile = path.join(tmpDir, 'test-go-gin-embedded-context-source.go')
    const code = `
package main

import (
    "github.com/gin-gonic/gin"
)

type BizContext struct {
    *gin.Context
}

func handle(b BizContext) {
    value := b.Context.GetQuery("tenant")
    sink(value)
}

func sink(input string) {}

func main() {
    handle(BizContext{})
}
`
    const ruleConfig = [
      {
        checkerIds: ['taint_flow_go_input'],
        sources: {
          FuncCallReturnValueTaintSource: [
            {
              fsig: 'GetQuery',
              calleeType: '*gin.Context',
              values: ['0'],
              kind: 'GO_INPUT',
            },
          ],
        },
        sinks: {
          FuncCallTaintSink: [
            {
              fsig: 'sink',
              calleeType: '*',
              args: [0],
            },
          ],
        },
      },
    ]

    fs.writeFileSync(strictFile, code)
    fs.writeFileSync(strictRuleConfig, JSON.stringify(ruleConfig, null, 2))
    try {
      const findings = await analyzeGoCode(code, strictFile, strictRuleConfig, ['taint_flow_go_input'])
      const count = countAllFindings(findings)
      assert.ok(count > 0, `expected >=1 finding for embedded *gin.Context return source, got ${count}`)
    } finally {
      try {
        fs.unlinkSync(strictFile)
      } catch {
        // 忽略清理失败
      }
      try {
        fs.unlinkSync(strictRuleConfig)
      } catch {
        // 忽略清理失败
      }
    }
  })

})
