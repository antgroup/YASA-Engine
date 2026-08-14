/**
 * Go for-range 动态 key map 赋值后字面 key 读取 taint 传播单元测试
 *
 * 根因：resolveIndices 在 computed key evaluation 时使用 declaration scope（function scope），
 * 但 for-range 迭代变量声明在 block scope（function scope 的子 scope）。
 * 导致 tainted value 存储在 symbolic key 而非字面 key 下，后续字面 key 读取 taint 丢失。
 *
 * 修复：resolveIndices 接受可选 evalScope 参数，computed key 使用执行 scope 求值。
 *
 * 场景：
 *   DK-1: for-range 动态 key 赋值 + 字面 key 读取 → sink（应检出）
 *   DK-2: 直接字面 key 赋值 + 字面 key 读取 → sink（基线，应检出）
 *   DK-3: for-range 动态 key 赋值 + 传整个 map → sink（基线，应检出）
 */
import { describe, it, afterEach } from 'mocha'
import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
const config = require('../../src/config')
const Analyzer = require('../../src/engine/analyzer/golang/common/go-analyzer')

/** finding 结果的 key（taint checker 注册名） */
const FINDING_KEY = 'taintflow'

/**
 * 运行单文件 Go 代码分析，返回 findings 对象
 * analyzeSingleFile 返回 Promise，需 await
 */
async function analyzeGoCode(code: string, fileName: string): Promise<any> {
  config.ruleConfigFile = path.join(__dirname, '../../test/go/rule_config.json')
  config.checkerIds = ['taint_flow_test']
  config.uastSDKPath = path.join(__dirname, '../../deps')
  config.language = 'golang'
  config.maindirPrefix = os.tmpdir()

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

/**
 * 统计 taint finding 数量
 */
function countFindings(findings: any): number {
  if (!findings || !findings[FINDING_KEY]) return 0
  return findings[FINDING_KEY].length
}

describe('Go for-range 动态 key map 赋值 taint 传播', function () {
  this.timeout(60000)

  const tmpDir = os.tmpdir()
  const tmpFile = path.join(tmpDir, 'test-dynamic-key-taint.go')

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      // 忽略清理失败
    }
  })

  it('DK-1: for-range 动态 key 赋值后字面 key 读取应传播 taint', async function () {
    const code = `
package main

func processDynKey(tainted string) {
    keys := []string{"id", "name"}
    m := make(map[string]string)
    for _, k := range keys {
        m[k] = tainted
    }
    val := m["id"]
    __taint_sink(val)
}

func main() {
    processDynKey(__taint_src)
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    const count = countFindings(findings)
    assert.ok(count > 0, `DK-1: 期望 >=1 finding，实际 ${count}。for-range 动态 key 赋值后字面 key 读取 taint 应传播`)
  })

  it('DK-2: 直接字面 key 赋值后字面 key 读取应传播 taint（基线）', async function () {
    const code = `
package main

func processLiteralKey(tainted string) {
    m := make(map[string]string)
    m["id"] = tainted
    val := m["id"]
    __taint_sink(val)
}

func main() {
    processLiteralKey(__taint_src)
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    const count = countFindings(findings)
    assert.ok(count > 0, `DK-2: 期望 >=1 finding，实际 ${count}。字面 key 赋值后字面 key 读取 taint 应传播`)
  })

  it('DK-3: for-range 动态 key 赋值后传整个 map 应传播 taint（基线）', async function () {
    const code = `
package main

func processWholeMap(tainted string) {
    keys := []string{"id", "name"}
    m := make(map[string]string)
    for _, k := range keys {
        m[k] = tainted
    }
    __taint_sink(m)
}

func main() {
    processWholeMap(__taint_src)
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    const count = countFindings(findings)
    assert.ok(count > 0, `DK-3: 期望 >=1 finding，实际 ${count}。for-range 后传整个 map taint 应传播`)
  })

  it('DK-if: for-range 动态 key 赋值 + if 条件分支 + if 内字面 key 读取应传播 taint', async function () {
    // 模拟 opslight repository.go line 290-310 模式：
    //   for-range 写入 map → if 条件判断（BVT 分叉）→ if 内字面 key 读取 → sink
    // 方向 C 修复：fallback 分支从 container 子值继承 tags/traces
    const code = `
package main

func processWithIf(tainted string) {
    keys := []string{"id", "name", "status"}
    repository := make(map[string]string)
    for _, v := range keys {
        repository[v] = tainted
    }
    if repository["status"] == "enable" {
        val := repository["id"]
        __taint_sink(val)
    }
}

func main() {
    processWithIf(__taint_src)
}
`
    fs.writeFileSync(tmpFile, code)
    const findings = await analyzeGoCode(code, tmpFile)
    const count = countFindings(findings)
    assert.ok(count > 0, `DK-if: 期望 >=1 finding，实际 ${count}。if 分支内字面 key 读取 taint 应从 container 子值继承`)
  })
})
