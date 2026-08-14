import * as assert from 'assert'
import { describe, it } from 'mocha'

const starter = require('../src/interface/starter') as {
  initAnalyzer: (dir: unknown, args: string[]) => Promise<unknown>
  getDataflowInternalOptionNames: () => ReadonlyArray<string>
}

const EXPECTED_GROUPS = [
  '常用扫描',
  '配置文件',
  '解析器运行依赖',
  '输出与导出',
  '算法与分析策略',
  'DB / Dataflow',
  '增量分析',
  'QL / AntQL 位置配置',
  '上下文缓存',
  '运行与性能',
  '帮助与版本',
]

const EXPECTED_PUBLIC_OPTIONS = [
  '--sourcePath',
  '--language',
  '--analyzer',
  '--single',
  '--configFilePath',
  '--ruleConfigFile',
  '--checkerIds',
  '--checkerPackIds',
  '--entrypointMode',
  '--report',
  '--uastSDKPath',
  '--workerCount',
  '--enablePerformanceLogging',
  '--dumpAST',
  '--dumpAllAST',
  '--dumpCG',
  '--dumpAllCG',
  '--dumpEntrypoint',
  '--dataflowDb',
  '--dataflowDbMode',
  '--intermediate-dir',
  '--incremental',
  '--incrementalCache',
  '--incrementalDiff',
  '--incrementalMode',
  '--impactEntrypointFile',
  '--source',
  '--sink',
  '--prefixPath',
  '--contextEnvironmentDir',
  '--saveContextEnvironment',
  '--miniSaveContextEnvironment',
  '--loadContextEnvironment',
  '--loadContextEnvironmentId',
  '--cgAlgo',
  '--taintTraceOutputStrategy',
  '--call-summary',
  '--help',
  '--version',
  '--echo',
]

async function captureHelpText(): Promise<string> {
  const chunks: string[] = []
  const originalWrite = process.stdout.write
  const originalExit = process.exit

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.exit = ((code?: string | number | null | undefined): never => {
    throw new Error(`process.exit:${code ?? 0}`)
  }) as typeof process.exit

  try {
    await starter.initAnalyzer(null, ['--help'])
  } catch (error) {
    assert.match(String(error), /process\.exit:0/)
  } finally {
    process.stdout.write = originalWrite
    process.exit = originalExit
  }

  return chunks.join('')
}

function optionNames(helpText: string): string[] {
  const matches = helpText.match(/(?:^|\s)--[A-Za-z][A-Za-z-]*/g) || []
  return [...new Set(matches.map((name) => name.trim()))]
}

describe('CLI help grouping', () => {
  it('renders professional Chinese help with usage and common example', async () => {
    const helpText = await captureHelpText()

    assert.ok(!helpText.includes('YASA2 - 多语言代码分析引擎'))
    assert.ok(!helpText.includes('Usage: yasa2'))
    assert.ok(helpText.includes('常用示例:'))
    assert.ok(helpText.includes('yasa2 --sourcePath <项目目录> \\'))
    assert.ok(helpText.includes('--checkerPackIds <规则包> \\'))
    assert.ok(helpText.includes('--language <语言> \\'))
    assert.ok(helpText.includes('--ruleConfigFile <规则配置.json> \\'))
    assert.ok(helpText.includes('--report <输出目录> \\'))
    assert.ok(helpText.includes('[--analyzer <分析器>] \\'))
    assert.ok(helpText.includes('[--entrypointMode ONLY_CUSTOM] \\'))
    assert.ok(helpText.includes('[--workerCount 0]'))
    assert.ok(helpText.includes('显示版本号'))
  })

  it('keeps every confirmed group visible in the default help', async () => {
    const helpText = await captureHelpText()

    for (const groupTitle of EXPECTED_GROUPS) {
      assert.ok(helpText.includes(groupTitle), `missing group ${groupTitle}`)
    }
  })

  it('covers all current public CLI options without duplicates', async () => {
    const names = optionNames(await captureHelpText())

    assert.deepStrictEqual([...new Set(names)], names)
    for (const optionName of EXPECTED_PUBLIC_OPTIONS) {
      assert.ok(names.includes(optionName), `missing option ${optionName}`)
    }
  })

  it('keeps release help parity for confirmed public option semantics', async () => {
    const helpText = await captureHelpText()

    assert.ok(helpText.includes('full 支持路径查询'))
    assert.ok(helpText.includes('调试用 EP changes/allowlist 文件'))
    assert.ok(helpText.includes('0表示自动计算，>0表示使用设置的值'))
  })

  it('does not expose confirmed Dataflow internal options in default help', async () => {
    const helpText = await captureHelpText()
    const names = optionNames(helpText)

    for (const optionName of starter.getDataflowInternalOptionNames()) {
      assert.ok(!helpText.includes(optionName), `unexpected internal option in help ${optionName}`)
      assert.ok(!names.includes(optionName), `unexpected internal option in default help ${optionName}`)
    }
  })
})
