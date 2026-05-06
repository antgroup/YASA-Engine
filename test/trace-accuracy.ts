import * as fs from 'fs'
import * as path from 'path'

// ===== SARIF 类型定义 =====

interface SarifSnippet {
  text: string
  affectedNodeName?: string
}

interface SarifRegion {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  snippet: SarifSnippet
}

interface SarifPhysicalLocation {
  artifactLocation?: { uri: string }
  region: SarifRegion
  nodeHash: string
}

interface SarifFlowLocation {
  location: {
    message: { text: string }
    physicalLocation: SarifPhysicalLocation
  }
}

interface SarifThreadFlow {
  locations: SarifFlowLocation[]
}

interface SarifCodeFlow {
  threadFlows: SarifThreadFlow[]
}

interface SarifResult {
  message: { text: string }
  codeFlows: SarifCodeFlow[]
}

interface SarifRun {
  results: SarifResult[]
}

interface SarifReport {
  runs: SarifRun[]
  version: string
}

// ===== 准确率统计接口 =====

export interface AccuracyStats {
  totalFindings: number
  evaluableHops: number
  accurateHops: number
}

// ===== 排除逻辑 =====

/**
 * 判断 affectedNodeName 是否为引擎特殊标记，应排除出准确率计算
 *
 * 排除条件：空值、匿名函数、返回值占位符、双下划线前缀的引擎内部标记、构造函数
 */
function shouldExclude(name: string | undefined): boolean {
  return (
    !name ||
    name.startsWith('<anonymous') ||
    name === '[return value]' ||
    name.startsWith('__') ||
    name === 'constructor'
  )
}

// ===== 核心计算 =====

/**
 * 从 SARIF 数据计算 trace 跳间准确率
 *
 * 遍历每个 finding 的 codeFlows[0].threadFlows[0].locations，
 * 对连续跳 (hop[i], hop[i+1])：
 * - 分母：hop[i] 有 affectedNodeName 且不被 shouldExclude 排除
 * - 分子：满足分母条件，且 hop[i].affectedNodeName 出现在 hop[i+1] 的 snippet.text 中
 */
export function computeAccuracyFromSarif(sarifData: SarifReport): AccuracyStats {
  let totalFindings = 0
  let evaluableHops = 0
  let accurateHops = 0

  for (const run of sarifData.runs) {
    if (!run.results) continue

    for (const result of run.results) {
      totalFindings++

      if (!result.codeFlows || result.codeFlows.length === 0) continue

      const codeFlow = result.codeFlows[0]
      if (!codeFlow.threadFlows || codeFlow.threadFlows.length === 0) continue

      const threadFlow = codeFlow.threadFlows[0]
      const locations = threadFlow.locations
      if (!locations || locations.length < 2) continue

      // 遍历连续跳对
      for (let i = 0; i < locations.length - 1; i++) {
        const currentHop = locations[i]
        const nextHop = locations[i + 1]

        const currentSnippet = currentHop?.location?.physicalLocation?.region?.snippet
        const nextSnippet = nextHop?.location?.physicalLocation?.region?.snippet

        if (!currentSnippet || !nextSnippet) continue

        const affectedName = currentSnippet.affectedNodeName

        // 分母条件：有 affectedNodeName 且不被排除
        if (shouldExclude(affectedName)) continue

        evaluableHops++

        // 分子条件：affectedNodeName 出现在下一跳的 snippet.text 中
        if (nextSnippet.text && nextSnippet.text.includes(affectedName!)) {
          accurateHops++
        }
      }
    }
  }

  return { totalFindings, evaluableHops, accurateHops }
}

/**
 * 合并多个准确率统计结果
 */
export function mergeAccuracyStats(statsList: AccuracyStats[]): AccuracyStats {
  let totalFindings = 0
  let evaluableHops = 0
  let accurateHops = 0

  for (const stats of statsList) {
    totalFindings += stats.totalFindings
    evaluableHops += stats.evaluableHops
    accurateHops += stats.accurateHops
  }

  return { totalFindings, evaluableHops, accurateHops }
}

// ===== 报告输出 =====

/**
 * 格式化准确率报告
 */
function formatReport(stats: AccuracyStats): string {
  const accuracy = stats.evaluableHops > 0
    ? ((stats.accurateHops / stats.evaluableHops) * 100).toFixed(2)
    : 'N/A'

  const lines = [
    '=== Trace Accuracy Report ===',
    `Total findings: ${stats.totalFindings}`,
    `Total evaluable hops: ${stats.evaluableHops}`,
    `Accurate hops: ${stats.accurateHops}`,
    stats.evaluableHops > 0
      ? `Accuracy: ${stats.accurateHops}/${stats.evaluableHops} = ${accuracy}%`
      : 'Accuracy: N/A (no evaluable hops)',
  ]

  return lines.join('\n')
}

// ===== CLI 入口 =====

function main(): void {
  const args = process.argv.slice(2)
  const sarifPath = args[0] || './report/report.sarif'

  const resolvedPath = path.resolve(sarifPath)

  if (!fs.existsSync(resolvedPath)) {
    console.log(`No SARIF file found: ${resolvedPath}`)
    process.exit(0)
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8')
  const sarifData: SarifReport = JSON.parse(content)

  const stats = computeAccuracyFromSarif(sarifData)
  console.log(formatReport(stats))
}

// 仅直接运行时执行 CLI，被 import 时不执行
if (require.main === module) {
  main()
}
