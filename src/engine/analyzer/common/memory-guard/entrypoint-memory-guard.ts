/**
 * 单入口内存护栏：在 symbolInterpret 主循环每个入口开始/中检查 process.memoryUsage().heapUsed，
 * 超阈提前 stop 当前入口，flush 已分析入口 finding，跳到下一入口继续。
 *
 * 设计要点：
 * - 节流：process.memoryUsage() 调用本身有开销，按时间窗节流（默认 200ms 一次），避免每 AST node 调用。
 * - 不改 clone 逻辑：护栏只做"超阈 stop + flush"，零污染风险。
 * - 跨语言可扩展：基类暴露 shouldAbortExecutionForMemory hook，Python override 写入本状态。
 */

import type { IConfig } from '../../../../config'
import type { IResultManager } from '../result-manager'
import { snapshotFinding } from '../finding-snapshot'

const Config = require('../../../../config')
const logger = require('../../../../util/logger')(__filename)
const path = require('path')
const FileUtil = require('../../../../util/file-util')

/** 内存护栏状态：每个入口点开始时通过 resetForEntryPoint 重置。 */
export interface MemoryGuardState {
  /** 是否启用护栏 */
  enabled: boolean
  /** 堆使用上限（MB），绝对模式阈值（delta 模式下不使用）。无读取点，保留仅供历史诊断日志兼容 */
  limitMb: number
  /** per-entrypoint heap growth delta 上限（MB），delta 模式阈值 */
  deltaLimitMb: number
  /** 当前入口开始前的 heapUsed 基线（字节） */
  baselineHeapBytes: number
  /** 当前入口观测到的 heapUsed 峰值（字节） */
  peakHeapBytes: number
  /** 是否已触发 abort（一旦置 true，本入口内后续 processInstruction/executeCall 持续返回 undefined 提前退出） */
  exceeded: boolean
  /** 上次 process.memoryUsage() 调用时间戳（ms），用于节流 */
  lastProbeMs: number
  /** 节流窗（ms） */
  probeIntervalMs: number
  /** 当前入口标签（用于 diagnostics 日志） */
  entryPointLabel: string
  /** 当前入口开始时间戳（ms） */
  entryPointStartMs: number
  /** 累计已 flush 的 finding 数（跨入口累加） */
  cumulativeFlushedFindings: number
}

/** 创建默认护栏状态。enabled / deltaLimitMb 从 Config 读取。 */
export function createMemoryGuardState(): MemoryGuardState {
  const enabled = !!Config.entrypointMemoryGuard
  const limitMb = typeof Config.entrypointMemoryLimitMB === 'number' && Config.entrypointMemoryLimitMB > 0
    ? Config.entrypointMemoryLimitMB
    : 10240
  const deltaLimitMb = typeof Config.entrypointMemoryLimitDeltaMB === 'number' && Config.entrypointMemoryLimitDeltaMB > 0
    ? Config.entrypointMemoryLimitDeltaMB
    : 2048
  return {
    enabled,
    limitMb,
    deltaLimitMb,
    baselineHeapBytes: 0,
    peakHeapBytes: 0,
    exceeded: false,
    lastProbeMs: 0,
    probeIntervalMs: 200,
    entryPointLabel: '<unknown>',
    entryPointStartMs: 0,
    cumulativeFlushedFindings: 0,
  }
}

/**
 * 在入口开始前重置护栏状态：记录基线堆、清 exceeded、设置 label。
 */
export function resetForEntryPoint(
  state: MemoryGuardState,
  entryPointLabel: string,
  now: number = Date.now()
): void {
  state.entryPointLabel = entryPointLabel
  state.entryPointStartMs = now
  state.exceeded = false
  state.peakHeapBytes = 0
  // 初始化为窗口外，确保 EP 内首次 processInstruction 即触发一次真实探测
  state.lastProbeMs = now - state.probeIntervalMs - 1
  // 内存基线在 reset 时探测一次（不节流），用于入口结束后 delta 统计
  if (state.enabled) {
    state.baselineHeapBytes = process.memoryUsage().heapUsed
    state.peakHeapBytes = state.baselineHeapBytes
  }
}

/**
 * 节流探测 heapUsed：超时间窗才调 process.memoryUsage()，否则返回 cached 判定。
 * delta 模式：当前 heapUsed 相对 baselineHeapBytes 的增长超过 deltaLimitMb 才 abort。
 * baselineHeapBytes === 0 时（入口未 reset，如 processModule 阶段）直接返回 false，避免误杀。
 * 返回 true 表示超阈，调用方应 abort 当前入口。
 *
 * @param state  护栏状态
 * @param now    可选，调用方传入时间戳（测试用）
 * @returns      是否超阈
 */
export function probeMemoryAndUpdate(
  state: MemoryGuardState,
  now: number = Date.now()
): boolean {
  if (!state.enabled) return false
  if (state.exceeded) return true
  // processModule 阶段未 reset baseline，guard 不生效（避免误杀 entrypoint 收集）
  if (state.baselineHeapBytes === 0) return false
  // 节流：时间窗内不重复探测
  if (now - state.lastProbeMs < state.probeIntervalMs) return false
  state.lastProbeMs = now
  const heapUsed = process.memoryUsage().heapUsed
  if (heapUsed > state.peakHeapBytes) state.peakHeapBytes = heapUsed
  const deltaBytes = heapUsed - state.baselineHeapBytes
  const deltaLimitBytes = state.deltaLimitMb * 1024 * 1024
  if (deltaBytes >= deltaLimitBytes) {
    state.exceeded = true
    return true
  }
  return false
}

/**
 * flush 当前 resultManager 内 finding 到 Config.reportDir。
 *
 * 根治跨入口 OOM 的核心流程：
 * - 从当前批次 live findings 生成 SARIF（此时 AST 还活着，snippet 可用 prettyPrint 生成）
 * - 将 SARIF results 累积到 sarifResultsAccumulator（轻量 JSON，无 AST 重引用）
 * - 写 accumulator 到文件（checkpoint，覆盖写包含所有已 flush 批次）
 * - snapshot 当前批次 findings → dedupIndex（释放 AST 重引用，保留 dedup 字段供下一入口 isNewFinding）
 * - clearFindingsKeepDedup（清空当前批次，保留 dedupIndex 和 accumulator）
 *
 * @param resultManager  全局 ResultManager（来自 checkerManager）
 * @param config         配置对象（默认 Config）
 * @param printf         日志回调（noop 时传 undefined）
 * @param reportDirOverride  可选，覆盖 Config.reportDir
 * @returns              本次 flush 时 resultManager 内 finding 总数
 */
export function flushFindingsToReport(
  resultManager: IResultManager | undefined | null,
  config: IConfig = Config,
  printf?: ((...args: unknown[]) => void) | undefined,
  reportDirOverride?: string
): number {
  if (!resultManager) return 0
  const reportDir = reportDirOverride ?? config.reportDir
  if (!reportDir) {
    logger.warn('[memory-guard] flush skipped: reportDir not configured')
    return 0
  }
  const findings = resultManager.getFindings()
  let total = 0
  for (const key of Object.keys(findings)) {
    const list = findings[key]
    if (Array.isArray(list)) total += list.length
  }

  // 1. 生成 SARIF + 累积到 accumulator（当前批次有 findings 时）
  if (total > 0) {
    const OutputStrategyAutoRegister = require('../output-strategy-auto-register')
    const registry = new OutputStrategyAutoRegister()
    registry.autoRegisterAllStrategies()
    for (const strategyId of Object.keys(findings)) {
      const strategy = registry.getStrategy(strategyId)
      if (!strategy || typeof strategy.outputFindings !== 'function') continue
      try {
        const results = strategy.outputFindings(resultManager, strategy.getOutputFilePath(), config, printf)
        if (results) {
          mergeSarifResults(resultManager.sarifResultsAccumulator, strategyId, results)
        }
      } catch (e) {
        handleFlushError(strategyId, e)
      }
    }
  }

  // 2. 写 accumulator checkpoint（覆盖写，包含所有已 flush 批次的 results）
  writeAccumulatedResults(resultManager, reportDir)

  // 3. snapshot 当前批次 findings → dedupIndex + 清空当前批次
  if (total > 0) {
    for (const strategyId of Object.keys(findings)) {
      const list = findings[strategyId]
      if (!Array.isArray(list)) continue
      if (!resultManager.dedupIndex[strategyId]) {
        resultManager.dedupIndex[strategyId] = []
      }
      for (const finding of list) {
        snapshotFinding(finding)
        resultManager.dedupIndex[strategyId].push(finding)
      }
    }
    resultManager.clearFindingsKeepDedup()
  }

  return total
}

/** 合并 SARIF results 到 accumulator（按 strategyId 累积 runs[0].results） */
function mergeSarifResults(
  accumulator: Record<string, any>,
  strategyId: string,
  newResults: any
): void {
  if (!newResults?.runs?.[0]?.results) return
  const existing = accumulator[strategyId]
  if (!existing) {
    accumulator[strategyId] = newResults
    return
  }
  if (!existing.runs?.[0]?.results) {
    accumulator[strategyId] = newResults
    return
  }
  existing.runs[0].results.push(...newResults.runs[0].results)
}

/** 写 accumulator 到 report 目录（checkpoint，覆盖写） */
function writeAccumulatedResults(
  resultManager: IResultManager,
  reportDir: string
): void {
  const OutputStrategyAutoRegister = require('../output-strategy-auto-register')
  const registry = new OutputStrategyAutoRegister()
  registry.autoRegisterAllStrategies()
  for (const strategyId of Object.keys(resultManager.sarifResultsAccumulator)) {
    const strategy = registry.getStrategy(strategyId)
    if (!strategy || typeof strategy.getOutputFilePath !== 'function') continue
    const results = resultManager.sarifResultsAccumulator[strategyId]
    if (!results) continue
    try {
      const reportFilePath = path.join(reportDir, strategy.getOutputFilePath())
      FileUtil.writeJSONfile(reportFilePath, results, true)
    } catch (e) {
      handleFlushError(strategyId, e)
    }
  }
}

function handleFlushError(strategyId: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  logger.warn(`[memory-guard] flush strategy ${strategyId} failed: ${msg}`)
}

/**
 * 计算当前入口内存 delta（MB）。在入口结束后调用。
 */
export function getEntryPointHeapDeltaMb(state: MemoryGuardState): {
  peakMb: number
  baselineMb: number
  deltaMb: number
} {
  const toMb = (bytes: number) => bytes / 1024 / 1024
  return {
    peakMb: toMb(state.peakHeapBytes),
    baselineMb: toMb(state.baselineHeapBytes),
    deltaMb: toMb(Math.max(0, state.peakHeapBytes - state.baselineHeapBytes)),
  }
}