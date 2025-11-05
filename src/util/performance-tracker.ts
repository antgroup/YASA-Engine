import { string } from 'is-type-of'
const { logDiagnostics } = require('./diagnostics-log-util')

/**
 * 性能追踪阶段名称常量
 * 用于统一管理阶段名称，避免拼写错误
 */
export const PerformanceStage = {
  PRE_PROCESS: 'preProcess',
  PARSE_CODE: 'parseCode',
  PRELOAD: 'preload',
  PROCESS_MODULE: 'processModule',
  START_ANALYZE: 'startAnalyze',
  SYMBOL_INTERPRET: 'symbolInterpret',
} as const

/**
 * PerformanceTracker 接口定义
 * 定义了性能追踪器对外暴露的所有方法
 */
export interface IPerformanceTracker {
  // 整体追踪：开始整个分析流程，或开始某个阶段
  start(stage?: string): void
  
  // 阶段追踪：结束某个阶段
  end(stage: string): void
  
  // 累加模式：记录一段时间的耗时
  record(stage: string, duration: number): void
  
  // 指令追踪
  enableInstructionMonitor(enabled?: boolean): void
  startInstructionMonitor(): void
  startInstruction(): void
  endInstructionAndUpdateStats(node: any, getLocationKey: (node: any, instructionType: string) => string): void
  
  // 数据输出
  logPerformance(): void
  
  // 其他方法
  getTimings(): {
    total: number
    preProcess: number | null
    parseCode: number | null
    preload: number | null
    processModule: number | null
    startAnalyze: number | null
    symbolInterpret: number | null
  }
}

/**
 * 性能追踪器 - 记录 YASA 分析各个阶段的性能数据
 * 
 * 设计背景：
 * 原本的性能监控代码分散在 analyzer.ts 中，与业务逻辑耦合。本次重构将性能监控逻辑
 * 提取为独立的工具类，提供统一的 API 供各语言分析器使用。
 * 
 * 主要功能：
 * 1. 阶段级别追踪：支持追踪分析流程的各个阶段（preProcess、parseCode、preload、
 *    processModule、startAnalyze、symbolInterpret）
 * 2. 指令级别追踪：可选启用，追踪 AST 指令的执行时间和次数
 * 3. 性能数据输出：自动输出性能统计摘要，并将数据写入诊断日志
 * 
 * 阶段关系说明：
 * - preProcess：预处理阶段，包含以下子阶段：
 *   - parseCode：解析代码为 AST
 *   - preload：预加载文件到包管理器
 *   - processModule：处理模块（分析 AST）
 * - startAnalyze：开始分析阶段
 * - symbolInterpret：符号解释阶段
 * 
 * 使用示例：
 * ```typescript
 * const tracker = new PerformanceTracker()
 * tracker.start()
 * tracker.start('preProcess')
 * // ... 执行 preProcess ...
 * tracker.end('preProcess')
 * tracker.logPerformance()
 * ```
 * 
 * 累加模式使用：
 * 对于在循环中多次执行的阶段（如 parseCode、preload），可以使用 record 方法累加：
 * ```typescript
 * for (const file of files) {
 *   const start = Date.now()
 *   parseCode(file)
 *   tracker.record('parseCode', Date.now() - start)
 * }
 * ```
 */
class PerformanceTracker {
  private startTime: number = 0
  private enableInstructionMonitoring: boolean = false

  // 各阶段的时间数据
  private stages: {
    [key: string]: {
      startTime: number
      endTime: number
      totalTime: number // 用于累加的场景（如 parseCode、preload）
      currentStartTime: number // 当前正在计时的时间
    }
  } = {}

  // 指令级别的性能监控
  private instructionStats: {
    instructionTimes: Map<string, number[]> // 指令总执行时间记录（包含嵌套调用）
    instructionCounts: Map<string, number> // 指令执行次数统计
    instructionNetTimes: Map<string, number[]> // 指令净执行时间记录（排除嵌套调用）
    totalExecutionTime: number // 总执行时间
    startTime: number // 开始时间
    monitoringOverhead: number // 监控开销
    updateStatsOverhead: number // 更新统计信息的开销
    executionStack: Array<{ startTime: number; nestedTime: number }> // 执行栈，用于跟踪嵌套调用
  } = {
    instructionTimes: new Map(),
    instructionCounts: new Map(),
    instructionNetTimes: new Map(),
    totalExecutionTime: 0,
    startTime: 0,
    monitoringOverhead: 0,
    updateStatsOverhead: 0,
    executionStack: [],
  }

  /**
   * 初始化阶段数据
   * @param stage - 阶段名称
   */
  private initStage(stage: string): void {
    if (!this.stages[stage]) {
      this.stages[stage] = {
        startTime: 0,
        endTime: 0,
        totalTime: 0,
        currentStartTime: 0,
      }
    }
  }

  /**
   * 开始整个分析流程，或开始某个阶段
   * @param stage - 可选，阶段名称。如果不传，则开始整个分析流程；如果传入，则开始指定阶段
   */
  start(stage?: string): void {
    if (stage === undefined) {
      // 开始整个分析流程
      this.startTime = Date.now()
    } else {
      // 开始某个阶段
      this.startStage(stage)
    }
  }

  /**
   * 获取阶段显示名称
   * @param stage - 阶段名称（内部标识）
   * @returns 阶段的显示名称（PascalCase）
   */
  private getStageDisplayName(stage: string): string {
    const displayNames: { [key: string]: string } = {
      preProcess: 'PreProcess',
      parseCode: 'ParseCode',
      preload: 'Preload',
      processModule: 'ProcessModule',
      startAnalyze: 'StartAnalyze',
      symbolInterpret: 'SymbolInterpret',
    }
    return displayNames[stage] || stage
  }

  /**
   * 开始某个阶段（内部方法，外部应使用 start(stage)）
   * @param stage - 阶段名称（如 'preProcess', 'parseCode', 'preload', 'processModule', 'startAnalyze', 'symbolInterpret'）
   */
  private startStage(stage: string): void {
    if (!stage || typeof stage !== 'string') {
      return
    }
    this.initStage(stage)
    const stageData = this.stages[stage]
    if (stageData.currentStartTime === 0) {
      stageData.currentStartTime = Date.now()
      const logger = require('./logger')(__filename)
      const displayName = this.getStageDisplayName(stage)
      if (displayName && displayName !== 'undefined') {
        logger.info(`[Engine] Start ${displayName}...`)
      }
    }
  }

  /**
   * 结束某个阶段
   * @param stage - 阶段名称
   */
  end(stage: string): void {
    if (!stage || typeof stage !== 'string') {
      return
    }
    this.endStage(stage)
  }

  /**
   * 结束某个阶段（内部方法）
   * @param stage - 阶段名称
   */
  private endStage(stage: string): void {
    if (!stage || typeof stage !== 'string') {
      return
    }
    this.initStage(stage)
    const stageData = this.stages[stage]
    if (stageData.currentStartTime > 0) {
      const duration = Date.now() - stageData.currentStartTime
      stageData.totalTime += duration
      if (stageData.startTime === 0) {
        stageData.startTime = stageData.currentStartTime
      }
      stageData.endTime = Date.now()
      stageData.currentStartTime = 0
      
      // 输出结束日志
      const logger = require('./logger')(__filename)
      const displayName = this.getStageDisplayName(stage)
      if (displayName && displayName !== 'undefined') {
        logger.info(`[Engine] ${displayName} cost: ${duration}ms`)
      }
      // 对于 preProcess 要输出 3 个子阶段的耗时
      if (stage == PerformanceStage.PRE_PROCESS) {
        // 确保子阶段已初始化，避免访问 undefined
        this.initStage(PerformanceStage.PARSE_CODE)
        this.initStage(PerformanceStage.PRELOAD)
        this.initStage(PerformanceStage.PROCESS_MODULE)
        
        const parseCodeStage = this.stages[PerformanceStage.PARSE_CODE]
        const preloadStage = this.stages[PerformanceStage.PRELOAD]
        const processModuleStage = this.stages[PerformanceStage.PROCESS_MODULE]
        
        logDiagnostics('performance_preProcess', {
            string1: 'parseCode',
            string2: 'preload',
            string3: 'processModule',
            number1: parseCodeStage.totalTime || 0,
            number2: preloadStage.totalTime || 0,
            number3: processModuleStage.totalTime || 0,
            date1: parseCodeStage.startTime > 0 ? new Date(parseCodeStage.startTime) : null,
            date2: parseCodeStage.endTime > 0 ? new Date(parseCodeStage.endTime) : null,
        })
      }
    }
  }

  /**
   * 记录一段时间的耗时（用于累加场景，如穿插的 parseCode 和 preload）
   * 
   * **何时使用 record：**
   * - 当某个阶段在循环中多次执行时（如 Java Analyzer 中每个文件都执行 parseCode 和 preload）
   * - 当阶段执行时间分散在多个地方，无法用连续的开始/结束来追踪时
   * - 需要手动累加多个时间片段时
   * 
   * **何时使用 start/end：**
   * - 当阶段连续执行，有明确的开始和结束点
   * - 当阶段只执行一次，或执行次数很少时
   * - 当需要自动计算持续时间时
   * 
   * **重要：两种模式不能混用**
   * - 对于同一个阶段，要么全程使用 start/end，要么全程使用 record
   * - 混用会导致统计数据不准确
   * 
   * **使用示例：**
   * 
   * 累加模式（record）：
   * ```typescript
   * // 在循环中累加每个文件的 parseCode 时间
   * for (const file of files) {
   *   const parseStart = Date.now()
   *   const ast = parseCode(file.content)
   *   const parseTime = Date.now() - parseStart
   *   tracker.record('parseCode', parseTime)  // 累加时间
   * }
   * ```
   * 
   * 连续模式（start/end）：
   * ```typescript
   * // 连续执行整个 preProcess 阶段
   * tracker.start('preProcess')
   * await this.preProcess(dir)
   * tracker.end('preProcess')  // 自动计算持续时间
   * ```
   * 
   * 时间计算说明：
   * - totalTime：累加所有 record 记录的时间
   * - currentStartTime：在使用 record 时保持为 0（不会自动计时）
   * - startTime：第一次调用 record 时记录（用于日志输出）
   * - endTime：每次调用 record 时更新为当前时间
   * 
   * @param stage - 阶段名称
   * @param duration - 耗时（毫秒）
   */
  record(stage: string, duration: number): void {
    this.initStage(stage)
    const stageData = this.stages[stage]
    stageData.totalTime += duration
    if (stageData.startTime === 0) {
      stageData.startTime = Date.now() // 使用当前时间作为开始时间（近似值）
    }
    stageData.endTime = Date.now()
  }

  /**
   * 获取某个阶段的耗时
   * @param stage - 阶段名称
   * @returns 阶段耗时（毫秒），如果阶段未开始或未结束则返回 null
   */
  getStageTime(stage: string): number | null {
    this.initStage(stage)
    const stageData = this.stages[stage]
    
    // 如果有正在计时的阶段，先结束它
    if (stageData.currentStartTime > 0) {
      this.end(stage)
    }
    
    // 如果使用累加模式（totalTime > 0），返回累加时间
    if (stageData.totalTime > 0) {
      return stageData.totalTime
    }
    
    // 否则返回单次时间
    if (stageData.endTime > 0 && stageData.startTime > 0) {
      return stageData.endTime - stageData.startTime
    }
    
    return null
  }

  /**
   * 记录性能数据到诊断日志并输出摘要
   */
  logPerformance(): void {
    const logger = require('./logger')(__filename)
    const endTime = Date.now()
    const totalTime = endTime - this.startTime

    // 确保所有进行中的阶段都结束
    Object.keys(this.stages).forEach((stage) => {
      if (this.stages[stage].currentStartTime > 0) {
        this.end(stage)
      }
    })

    // 记录总体性能到诊断日志
    logDiagnostics('performance_total', {
      string1: 'preProcess',
      string2: 'startAnalyze',
      string3: 'symbolInterpret',
      number1: this.getStageTime(PerformanceStage.PRE_PROCESS) || 0,
      number2: this.getStageTime(PerformanceStage.START_ANALYZE) || 0,
      number3: this.getStageTime(PerformanceStage.SYMBOL_INTERPRET) || 0,
      date1: new Date(this.startTime),
      date2: new Date(endTime),
    })

    // 输出摘要（包含指令统计，如果启用）
    this.outputSummary()
  }

  /**
   * 输出性能统计（合并阶段统计和指令统计）
   */
  outputSummary(): void {
    const logger = require('./logger')(__filename)
    const timings = this.getTimings()
    
    logger.info('=================  Performance Statistics  =======================')
    logger.info(`Total cost: ${timings.total}ms`)
    
    // preProcess 及其子阶段
    if (timings.preProcess !== null) {
      logger.info(`${this.getStageDisplayName('preProcess')} cost: ${timings.preProcess}ms`)
      
      // 子阶段（缩进显示）
      const subStages: Array<{ name: string; time: number }> = []
      if (timings.parseCode !== null) {
        subStages.push({ name: this.getStageDisplayName('parseCode'), time: timings.parseCode })
      }
      if (timings.preload !== null) {
        subStages.push({ name: this.getStageDisplayName('preload'), time: timings.preload })
      }
      if (timings.processModule !== null) {
        subStages.push({ name: this.getStageDisplayName('processModule'), time: timings.processModule })
      }
      
      // 输出子阶段
      subStages.forEach(({ name, time }) => {
        logger.info(`  ${name} cost: ${time}ms`)
      })
      
      // 计算子阶段总和和差值
      const subTotal = subStages.reduce((sum, stage) => sum + stage.time, 0)
      if (subTotal > 0) {
        const diff = timings.preProcess - subTotal
        if (diff > 0) {
          logger.info(`  Other cost: ${diff}ms`)
        } else if (diff < 0) {
          logger.info(`  (sub-stages total: ${subTotal}ms, diff: ${diff}ms)`)
        }
      }
    }
    
    // 独立阶段
    if (timings.startAnalyze !== null) {
      logger.info(`${this.getStageDisplayName('startAnalyze')} cost: ${timings.startAnalyze}ms`)
    }
    if (timings.symbolInterpret !== null) {
      logger.info(`${this.getStageDisplayName('symbolInterpret')} cost: ${timings.symbolInterpret}ms`)
    }
    
    // 计算所有主要阶段的总和（preProcess 已经包含其子阶段）
    const allStagesTotal = [
      timings.preProcess,
      timings.startAnalyze,
      timings.symbolInterpret,
    ]
      .filter((time): time is number => time !== null && time > 0)
      .reduce((sum, time) => sum + time, 0)
    
    // 计算 other 时间（总时间减去所有已统计的阶段时间）
    const otherTime = timings.total - allStagesTotal
    if (otherTime > 0) {
      logger.info(`Other cost: ${otherTime}ms`)
    }
    
    // 如果启用了指令监控，输出指令统计
    if (this.enableInstructionMonitoring) {
      this.outputInstructionStats()
    }
    
    logger.info('================  Performance Statistics done  ===================')
  }

  /**
   * 输出指令性能统计（合并到 Performance Statistics 中）
   */
  private outputInstructionStats(): void {
    const logger = require('./logger')(__filename)
    
    // 结束指令监控并计算总时间
    const endTime = Date.now()
    this.instructionStats.totalExecutionTime = endTime - this.instructionStats.startTime
    
    const totalOverhead = this.instructionStats.updateStatsOverhead
    const overheadPercent = ((totalOverhead / this.instructionStats.totalExecutionTime) * 100).toFixed(1)

    if (this.instructionStats.instructionTimes.size === 0) {
      logger.info('\nInstruction Statistics: No instruction data available')
      return
    }

    // 计算总指令数（所有 locationKey 的计数之和）
    let totalInstructions = 0
    for (const count of this.instructionStats.instructionCounts.values()) {
      totalInstructions += count
    }
    const numProcessedInstructions = totalInstructions

    // 计算整体平均时间
    let totalAvgTime = 0
    let totalInstructionCount = 0
    for (const [locationKey, times] of this.instructionStats.instructionTimes) {
      const count = this.instructionStats.instructionCounts.get(locationKey) || 0
      const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length
      totalAvgTime += avgTime * count
      totalInstructionCount += count
    }
    const overallAvgTime = totalInstructionCount > 0 ? totalAvgTime / totalInstructionCount : 0

    logger.info('\nInstruction Statistics:')
    logger.info(
      `  Time: ${this.instructionStats.totalExecutionTime}ms | Instructions: ${numProcessedInstructions} | Overhead: ${totalOverhead.toFixed(1)}ms (${overheadPercent}%) | Locations: ${this.instructionStats.instructionTimes.size} | Avg: ${overallAvgTime.toFixed(2)}ms`
    )

    // 前5个最慢指令（按净时间排序）
    const executionTimeEntries = Array.from(this.instructionStats.instructionTimes.entries())
      .map(([locationKey, times]) => {
        const netTimes = this.instructionStats.instructionNetTimes.get(locationKey) || []
        const netMaxTime = netTimes.length > 0 ? Math.max(...netTimes) : 0
        const netAvgTime = netTimes.length > 0 ? netTimes.reduce((sum, time) => sum + time, 0) / netTimes.length : 0
        return {
          locationKey,
          maxTime: Math.max(...times),
          avgTime: times.reduce((sum, time) => sum + time, 0) / times.length,
          netMaxTime,
          netAvgTime,
          count: this.instructionStats.instructionCounts.get(locationKey) || 0,
        }
      })
      .sort((a, b) => b.netMaxTime - a.netMaxTime)
      .slice(0, 5)

    if (executionTimeEntries.length > 0) {
      logger.info('  Top 5 Slowest Instructions (by Net Time):')
      executionTimeEntries.forEach((entry, index) => {
        const [instructionType, ...locationParts] = entry.locationKey.split(':')
        const location = locationParts.join(':')
        logger.info(
          `    ${index + 1}. ${instructionType} at ${location} (Net: Max ${entry.netMaxTime.toFixed(2)}ms, Avg ${entry.netAvgTime.toFixed(2)}ms | Total: Max ${entry.maxTime.toFixed(2)}ms, Avg ${entry.avgTime.toFixed(2)}ms | Count: ${entry.count})`
        )
      })
    }

    // 前5个最频繁指令（按执行次数排序）
    const executionCountEntries = Array.from(this.instructionStats.instructionCounts.entries())
      .map(([locationKey, count]) => {
        const times = this.instructionStats.instructionTimes.get(locationKey)
        return {
          locationKey,
          count,
          avgTime: times ? times.reduce((sum, time) => sum + time, 0) / times.length : 0,
          maxTime: times ? Math.max(...times) : 0,
        }
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    if (executionCountEntries.length > 0) {
      logger.info('  Top 5 Most Frequent Instructions:')
      executionCountEntries.forEach((entry, index) => {
        const [instructionType, ...locationParts] = entry.locationKey.split(':')
        const location = locationParts.join(':')
        logger.info(
          `    ${index + 1}. ${instructionType} at ${location} (Count: ${entry.count}, Avg: ${entry.avgTime.toFixed(2)}ms, Max: ${entry.maxTime.toFixed(2)}ms)`
        )
      })
    }
  }

  /**
   * 获取各阶段耗时（毫秒）
   * @returns 包含总时间和各阶段耗时的对象
   */
  getTimings(): {
    total: number
    preProcess: number | null
    parseCode: number | null
    preload: number | null
    processModule: number | null
    startAnalyze: number | null
    symbolInterpret: number | null
  } {
    const endTime = Date.now()
    return {
      total: endTime - this.startTime,
      preProcess: this.getStageTime('preProcess'),
      parseCode: this.getStageTime('parseCode'),
      preload: this.getStageTime('preload'),
      processModule: this.getStageTime('processModule'),
      startAnalyze: this.getStageTime('startAnalyze'),
      symbolInterpret: this.getStageTime('symbolInterpret'),
    }
  }

  /**
   * 启用指令级别的性能监控
   * 
   * 如果传入 undefined 或 true，则启用监控；如果传入 false，则禁用监控。
   * 此方法内部会检查传入的值，只有当值为 true 时才启用监控。
   * 
   * @param enabled - 是否启用指令监控。如果传入 undefined，默认为 true（启用）
   */
  enableInstructionMonitor(enabled: boolean | undefined = true): void {
    this.enableInstructionMonitoring = enabled !== false
  }

  /**
   * 开始指令级别的性能监控
   */
  startInstructionMonitor(): void {
    if (!this.enableInstructionMonitoring) return

    const startTime = Date.now()
    this.instructionStats.startTime = startTime
    this.instructionStats.totalExecutionTime = 0
    this.instructionStats.instructionTimes.clear()
    this.instructionStats.instructionCounts.clear()
    this.instructionStats.instructionNetTimes.clear()
    this.instructionStats.monitoringOverhead = 0
    this.instructionStats.updateStatsOverhead = 0
    this.instructionStats.executionStack = []
  }


  /**
   * 开始指令执行（内部检查是否启用）
   * 在指令开始执行时调用，内部会自动记录开始时间
   */
  startInstruction(): void {
    if (!this.enableInstructionMonitoring) return
    const startTime = Date.now()
    this.instructionStats.executionStack.push({ startTime, nestedTime: 0 })
  }

  /**
   * 结束指令执行并更新统计（内部检查是否启用）
   * 在指令执行结束时调用，内部会自动记录结束时间并更新统计信息
   * @param node - 正在处理的 AST 节点（包含 type 属性）
   * @param getLocationKey - 用于生成位置唯一键的函数
   */
  endInstructionAndUpdateStats(
    node: any,
    getLocationKey: (node: any, instructionType: string) => string
  ): void {
    if (!this.enableInstructionMonitoring) return

    // 检查执行栈是否为空，避免不平衡调用导致的错误
    if (this.instructionStats.executionStack.length === 0) {
      // 执行栈为空，可能是异常情况或未正确调用 startInstruction
      // 记录警告但不抛出错误，避免影响正常流程
      const logger = require('./logger')(__filename)
      logger.warn('endInstructionAndUpdateStats called but execution stack is empty. This may indicate a mismatch between startInstruction and endInstruction calls.')
      return
    }

    // 记录指令执行结束的时间
    const endTime = Date.now()
    // 记录开始更新统计的时间，用于计算更新开销
    const updateStartTime = Date.now()

    const stackEntry = this.instructionStats.executionStack.pop()!
    const totalExecutionTime = endTime - stackEntry.startTime
    const netExecutionTime = Math.max(0, totalExecutionTime - stackEntry.nestedTime)

    // 更新父指令的嵌套时间
    const stackDepth = this.instructionStats.executionStack.length
    if (stackDepth > 0) {
      const parentEntry = this.instructionStats.executionStack[stackDepth - 1]
      parentEntry.nestedTime += totalExecutionTime
    }

    // 更新指令性能统计
    this.updateInstructionStats(
      node.type,
      totalExecutionTime,
      netExecutionTime,
      node,
      getLocationKey
    )

    // 记录更新统计的开销
    this.instructionStats.updateStatsOverhead += Date.now() - updateStartTime
  }

  /**
   * 获取执行栈深度（内部检查是否启用）
   * @returns 当前执行栈的深度，如果未启用监控则返回 0
   */
  getExecutionStackDepth(): number {
    if (!this.enableInstructionMonitoring) return 0
    return this.instructionStats.executionStack.length
  }

  /**
   * 获取执行栈（内部检查是否启用）
   * @returns 当前执行栈的副本，如果未启用监控则返回空数组
   */
  getExecutionStack(): Array<{ startTime: number; nestedTime: number }> {
    if (!this.enableInstructionMonitoring) return []
    return this.instructionStats.executionStack
  }

  /**
   * 更新指令性能统计（简化版，接收预计算的时间）
   * @param instructionType - 指令类型（如 'CallExpression', 'IfStatement' 等）
   * @param totalExecutionTime - 总执行时间（包含嵌套调用，毫秒）
   * @param netExecutionTime - 净执行时间（排除嵌套调用，毫秒）
   * @param node - 正在处理的 AST 节点
   * @param getLocationKey - 用于生成位置唯一键的函数
   */
  updateInstructionStats(
    instructionType: string,
    totalExecutionTime: number,
    netExecutionTime: number,
    node: any,
    getLocationKey: (node: any, instructionType: string) => string
  ): void {
    if (!this.enableInstructionMonitoring) return

    // 使用位置+类型创建唯一键
    const locationKey = getLocationKey(node, instructionType)

    // 更新总指令时间（包含嵌套调用）
    if (!this.instructionStats.instructionTimes.has(locationKey)) {
      this.instructionStats.instructionTimes.set(locationKey, [])
    }
    this.instructionStats.instructionTimes.get(locationKey)!.push(totalExecutionTime)

    // 更新净指令时间（排除嵌套调用）
    if (!this.instructionStats.instructionNetTimes.has(locationKey)) {
      this.instructionStats.instructionNetTimes.set(locationKey, [])
    }
    this.instructionStats.instructionNetTimes.get(locationKey)!.push(netExecutionTime)

    // 更新指令计数
    const currentCount = this.instructionStats.instructionCounts.get(locationKey) || 0
    this.instructionStats.instructionCounts.set(locationKey, currentCount + 1)
  }


  /**
   * 重置所有计时器
   */
  reset(): void {
    this.startTime = 0
    this.stages = {}
    this.instructionStats.instructionTimes.clear()
    this.instructionStats.instructionCounts.clear()
    this.instructionStats.instructionNetTimes.clear()
    this.instructionStats.totalExecutionTime = 0
    this.instructionStats.startTime = 0
    this.instructionStats.monitoringOverhead = 0
    this.instructionStats.updateStatsOverhead = 0
    this.instructionStats.executionStack = []
  }
}

/**
 * 创建性能追踪器实例
 * 
 * @returns PerformanceTracker 实例
 */
function createPerformanceTracker(): PerformanceTracker {
  return new PerformanceTracker()
}

module.exports = {
  PerformanceTracker: createPerformanceTracker,
}
