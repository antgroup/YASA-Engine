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

const Config = require('../../../../config')
const logger = require('../../../../util/logger')(__filename)

/** 内存护栏状态：每个入口点开始时通过 resetForEntryPoint 重置。 */
export interface MemoryGuardState {
  /** 是否启用护栏 */
  enabled: boolean
  /** 堆使用上限（MB） */
  limitMb: number
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

/** 创建默认护栏状态。enabled / limitMb 从 Config 读取。 */
export function createMemoryGuardState(): MemoryGuardState {
  const enabled = !!Config.entrypointMemoryGuard
  const limitMb = typeof Config.entrypointMemoryLimitMB === 'number' && Config.entrypointMemoryLimitMB > 0
    ? Config.entrypointMemoryLimitMB
    : 10240
  return {
    enabled,
    limitMb,
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
  // 节流：时间窗内不重复探测
  if (now - state.lastProbeMs < state.probeIntervalMs) return false
  state.lastProbeMs = now
  const heapUsed = process.memoryUsage().heapUsed
  if (heapUsed > state.peakHeapBytes) state.peakHeapBytes = heapUsed
  const limitBytes = state.limitMb * 1024 * 1024
  if (heapUsed >= limitBytes) {
    state.exceeded = true
    return true
  }
  return false
}

/**
 * flush 当前 resultManager 内 finding 到 Config.reportDir。
 *
 * 通过实例化 OutputStrategyAutoRegister 调各 strategy 的 outputFindings：
 * - 多次调用幂等（outputFindings 全量覆盖写同一路径 sarif）
 * - 不 clear resultManager，后续入口继续 append，最终 outputAnalyzerResult 仍正常输出全量
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
  if (total === 0) return 0
  // OutputStrategyAutoRegister 通过 require 加载输出策略；flush 路径只复用同一注册表
  const OutputStrategyAutoRegister = require('../output-strategy-auto-register')
  const registry = new OutputStrategyAutoRegister()
  registry.autoRegisterAllStrategies()
  for (const strategyId of Object.keys(findings)) {
    const strategy = registry.getStrategy(strategyId)
    if (!strategy || typeof strategy.outputFindings !== 'function') continue
    try {
      strategy.outputFindings(resultManager, strategy.getOutputFilePath(), config, printf)
    } catch (e) {
      // flush 失败不影响主流程，记录后继续
      handleFlushError(strategyId, e)
    }
  }
  return total
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