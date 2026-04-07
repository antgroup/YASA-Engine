/* eslint-disable @typescript-eslint/no-require-imports, import/no-commonjs */
const { yasaLog, yasaWarning, yasaSeparator } = require('./format-util')

/**
 * 性能追踪器接口
 */
export interface IPerformanceTracker {
  // 如果不传 stage，自动创建 'total' 阶段；支持层级结构（'A.B.C'）
  start(stage?: string): void
  end(stage: string): void
  // 累加模式：如果在 start/end 之间调用，会自动转换为 record 模式
  record(stage: string, duration?: number): void | { start: () => void; end: () => void }

  setEnableDetailedInstructionStats(enabled?: boolean): void
  startInstructionMonitor(): void
  startInstruction(): void
  endInstructionAndUpdateStats(node: any, getLocationKey: (node: any, instructionType: string) => string): void

  collectAnalysisData(analyzer: any): void
  outputPerformanceReport(): void
  getTimings(): Record<string, number | null>
}

/**
 * 性能追踪器 - 记录 YASA 分析各个阶段的性能数据
 * 支持层级结构（'A.B.C'），树形输出，自动计算 other cost
 * 混合模式：start 后调用 record 会自动转换，end 时使用 record 累加的总时间
 */
class PerformanceTracker {
  private static readonly OTHER_COST_LABEL = 'other cost'

  private static readonly OVERVIEW_LABELS = [
    'Language',
    'Files analyzed',
    'Lines of code',
    'Total time',
    'Total instruction',
    'Executed instruction',
    'Execution count',
    'Valid entrypoints',
    'Avg execution time per instruction',
    'Avg instruction execution count',
    'Execution time 70%/99%/100%',
    'Execution times 70%/99%/100%',
  ]

  private startTime: number = 0

  private enableDetailedInstructionStats: boolean = false

  private hasTotalStage: boolean = false

  private hasLoggedPerformance: boolean = false

  private cachedAnalysisOverview: ReturnType<typeof this.collectAnalysisOverview> | null = null

  private stages: {
    [key: string]: {
      startTime: number
      endTime: number
      totalTime: number // 用于累加场景（如 parseCode、preload）
      currentStartTime: number
      hasRecorded: boolean // 标记是否在 start/end 之间调用了 record
    }
  } = {}

  private timers: Map<string, { start: () => void; end: () => void }> = new Map()

  private instructionStats: {
    instructionTimes: Map<string, number[]> // 总执行时间（包含嵌套调用）
    instructionCounts: Map<string, number>
    instructionNetTimes: Map<string, number[]> // 净执行时间（排除嵌套调用）
    totalExecutionTime: number
    startTime: number
    monitoringOverhead: number
    updateStatsOverhead: number
    executionStack: Array<{ startTime: number; nestedTime: number }> // 用于跟踪嵌套调用
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
        hasRecorded: false,
      }
    }
  }

  /**
   * 开始整个分析流程，或开始某个阶段
   * @param stage - 可选，不传则创建 'total' 阶段；传入则开始指定阶段（支持 'A.B.C' 层级结构）
   */
  start(stage?: string): void {
    if (stage === undefined) {
      if (!this.hasTotalStage) {
        this.startTime = Date.now()
        this.hasTotalStage = true
        this.startStage('total')
      }
    } else {
      this.startStage(stage)
    }
  }

  /**
   * 获取阶段名称的最后一部分
   * @param stage - 阶段名称
   * @returns {string} 最后一部分的显示名称
   */
  private getStageLeafName(stage: string): string {
    const parts = stage.split('.')
    return parts[parts.length - 1]
  }

  /**
   * 获取阶段层级数组
   * @param stage - 阶段名称
   * @returns {string[] | undefined} 阶段层级数组，顶层阶段返回 undefined
   */
  private getStageArray(stage: string): string[] | undefined {
    const parentStage = this.getParentStage(stage)
    if (!parentStage) {
      return undefined
    }
    return parentStage.split('.')
  }

  /**
   * 获取父阶段名称
   * @param stage - 阶段名称
   * @returns {string | null} 父阶段名称，如果没有父阶段则返回 null
   */
  private getParentStage(stage: string): string | null {
    const lastDotIndex = stage.lastIndexOf('.')
    if (lastDotIndex === -1) {
      return null
    }
    return stage.substring(0, lastDotIndex)
  }

  /**
   * 获取所有直接子阶段
   * @param parentStage - 父阶段名称
   * @returns {string[]} 所有直接子阶段的名称数组
   */
  private getChildStages(parentStage: string): string[] {
    const prefix = `${parentStage}.`
    return Object.keys(this.stages).filter((stage) => {
      return stage.startsWith(prefix) && !stage.substring(prefix.length).includes('.')
    })
  }

  /**
   * 开始某个阶段
   * @param stage - 阶段名称
   */
  private startStage(stage: string): void {
    if (!stage || typeof stage !== 'string') {
      return
    }
    this.initStage(stage)
    const stageData = this.stages[stage]
    if (stageData.currentStartTime === 0) {
      stageData.currentStartTime = Date.now()
      if (stage === 'total') {
        yasaLog('Begin execution')
      } else {
        const leafName = this.getStageLeafName(stage)
        if (leafName && leafName !== 'undefined') {
          const stages = this.getStageArray(stage)
          yasaLog(`Executing ${leafName}`, stages)
        }
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
   * 获取内存使用情况的格式化字符串
   * @returns {string} 格式化的内存使用字符串，如 "heap: 1024/4096 MB"
   */
  private getMemoryUsageString(): string {
    const memUsage = process.memoryUsage()
    const heapUsedMB = Math.round((memUsage.heapUsed / 1024 / 1024) * 100) / 100
    const heapTotalMB = Math.round((memUsage.heapTotal / 1024 / 1024) * 100) / 100
    const rssMB = Math.round((memUsage.rss / 1024 / 1024) * 100) / 100
    const arrayBuffersMB = Math.round((memUsage.arrayBuffers / 1024 / 1024) * 100) / 100
    return `heap: ${heapUsedMB}/${heapTotalMB} MB, rss: ${rssMB} MB, arrayBuffers: ${arrayBuffersMB} MB`
  }

  /**
   * 输出阶段结束日志
   * @param stage - 阶段名称
   * @param duration - 耗时（毫秒）
   */
  private logStageEnd(stage: string, duration: number): void {
    const memoryInfo = this.getMemoryUsageString()
    if (stage === 'total') {
      yasaLog(`Execution completed, cost: ${duration}ms, ${memoryInfo}`)
    } else {
      const leafName = this.getStageLeafName(stage)
      if (leafName && leafName !== 'undefined') {
        const stages = this.getStageArray(stage)
        yasaLog(`Completed ${leafName}, cost: ${duration}ms, ${memoryInfo}`, stages)
      }
    }
  }

  /**
   * 结束某个阶段
   * @param stage - 阶段名称
   */
  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity
  private endStage(stage: string): void {
    if (!stage || typeof stage !== 'string') {
      return
    }
    this.initStage(stage)
    const stageData = this.stages[stage]

    // record 模式：使用 totalTime 作为总耗时（忽略 start/end 间隔）
    if (stageData.hasRecorded) {
      if (stageData.currentStartTime > 0) {
        stageData.currentStartTime = 0
      }
      stageData.endTime = Date.now()
      this.logStageEnd(stage, stageData.totalTime)
    } else if (stageData.currentStartTime > 0) {
      // start/end 模式：使用 currentStartTime 计算持续时间
      const duration = Date.now() - stageData.currentStartTime
      stageData.totalTime += duration
      if (stageData.startTime === 0) {
        stageData.startTime = stageData.currentStartTime
      }
      stageData.endTime = Date.now()
      stageData.currentStartTime = 0
      this.logStageEnd(stage, duration)
    }
  }

  /**
   * 计算分位数
   * @param values - 数值数组
   * @param percentile - 分位数（0-100）
   * @returns {number} 分位数值
   */
  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) {
      return 0
    }
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.ceil((percentile / 100) * sorted.length) - 1
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))]
  }

  /**
   * 记录一段时间的耗时（用于累加场景）
   * 混合模式：start() 后调用 record() 自动转换为 record 模式，end() 时使用 record 累加的 totalTime
   * @param stage - 阶段名称
   * @param duration - 可选，耗时（毫秒）。如果不传，返回一个计时器对象，可以调用 start() 和 end()
   * @returns {void | {start: () => void; end: () => void}} 如果 duration 未提供，返回包含 start() 和 end() 方法的对象；否则返回 void
   */
  record(stage: string, duration?: number): void | { start: () => void; end: () => void } {
    // 如果提供了 duration，使用原有的记录方式
    if (duration !== undefined) {
      this.initStage(stage)
      const stageData = this.stages[stage]
      stageData.totalTime += duration
      stageData.hasRecorded = true

      // 如果正在 start/end 计时，停止计时并转换为 record 模式
      if (stageData.currentStartTime > 0) {
        stageData.currentStartTime = 0
      }

      if (stageData.startTime === 0) {
        stageData.startTime = Date.now()
      }
      stageData.endTime = Date.now()
      return
    }

    // 如果没有提供 duration，返回一个计时器对象（每个 stage 共享同一个计时器）
    if (!this.timers.has(stage)) {
      let startTime: number | null = null
      const timer = {
        start: () => {
          startTime = Date.now()
        },
        end: () => {
          if (startTime === null) {
            return
          }
          const elapsed = Date.now() - startTime
          this.initStage(stage)
          const stageData = this.stages[stage]
          stageData.totalTime += elapsed
          stageData.hasRecorded = true

          // 如果正在 start/end 计时，停止计时并转换为 record 模式
          if (stageData.currentStartTime > 0) {
            stageData.currentStartTime = 0
          }

          if (stageData.startTime === 0) {
            stageData.startTime = startTime
          }
          stageData.endTime = Date.now()
          startTime = null
        },
      }
      this.timers.set(stage, timer)
    }
    return this.timers.get(stage)!
  }

  /**
   * 获取某个阶段的耗时
   * @param stage - 阶段名称
   * @param forceEnd - 是否强制结束正在运行的阶段
   * @returns {number | null} 阶段耗时（毫秒），未开始或未结束则返回 null
   */
  getStageTime(stage: string, forceEnd: boolean = false): number | null {
    this.initStage(stage)
    const stageData = this.stages[stage]

    // forceEnd 为 true 时，强制结束正在运行的阶段（仅在 outputPerformanceReport 时使用）
    if (forceEnd && stageData.currentStartTime > 0) {
      this.end(stage)
      return this.getStageTime(stage, false)
    }

    if (stageData.currentStartTime > 0) {
      const currentTime = Date.now() - stageData.currentStartTime
      return stageData.totalTime > 0 ? stageData.totalTime + currentTime : currentTime
    }

    if (stageData.totalTime > 0) {
      return stageData.totalTime
    }

    if (stageData.endTime > 0 && stageData.startTime > 0) {
      return stageData.endTime - stageData.startTime
    }

    return null
  }

  /**
   * 分析概览数据收集器
   * @param analyzer - analyzer 对象
   * @param timings - 阶段耗时数据
   * @returns {Object} 分析概览数据对象
   */
  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity
  collectAnalysisOverview(
    analyzer: any,
    timings: Record<string, number | null>
  ): {
    // summary1
    language: string
    fileCount: number
    lineCount: number
    // summary2
    totalTime: number
    executedInstruction: number
    executionCount: number
    // configure
    markedSourceCount: number
    matchedSinkCount: number
    entryPointCount: number
    findingCount: number
    // symbolInterpretDetail1
    avgExecutionTimePerInstruction: number
    avgInstructionExecutionCount: number
    // symbolInterpretDetail2
    executionTime70Percent: number
    executionTime99Percent: number
    executionTime100Percent: number
    // symbolInterpretDetail3
    executionTimes70Percent: number
    executionTimes99Percent: number
    executionTimes100Percent: number
  } {
    const Config = require('../config')

    const language = analyzer?.options?.language || Config.language || 'unknown'

    // 使用 sourceCodeCache 获取精确的文件数量和代码行数
    let fileCount = 0
    let totalLines = 0

    if (analyzer?.sourceCodeCache && analyzer.sourceCodeCache instanceof Map) {
      // 直接从 sourceCodeCache 获取精确数据
      fileCount = analyzer.sourceCodeCache.size
      for (const lines of analyzer.sourceCodeCache.values()) {
        if (Array.isArray(lines)) {
          totalLines += lines.length
        }
      }
    } else if (analyzer?.fileManager) {
      // 回退到旧的统计方式
      const sourcePath =
        analyzer?.options?.sourcePath ||
        analyzer?.options?.sourceFile ||
        Config.sourcePath ||
        (Config.single && Config.maindir ? Config.maindir : null)
      let filesToCount: string[] = []
      if (sourcePath && Config.single) {
        const sourcePathNormalized = sourcePath.replace(/\\/g, '/')
        const allFiles = Object.keys(analyzer.fileManager)
        filesToCount = allFiles.filter((filename) => {
          const filenameNormalized = filename.replace(/\\/g, '/')
          return filenameNormalized === sourcePathNormalized || filenameNormalized.endsWith(sourcePathNormalized)
        })
        if (filesToCount.length === 0) {
          filesToCount = allFiles
        }
      } else {
        filesToCount = Object.keys(analyzer.fileManager)
      }

      fileCount = filesToCount.length
      if (fileCount === 0) {
        const Statistics = require('./statistics')
        fileCount = Statistics.numProcessedFiles || 0
      }

      // 使用 AST 估算代码行数
      for (const filename of filesToCount) {
        const { ast } = analyzer.symbolTable.get(analyzer.fileManager[filename]) || {}
        if (ast) {
          if (ast.loc?.end?.line) {
            totalLines += ast.loc.end.line
          } else if (ast._meta?.endLine) {
            totalLines += ast._meta.endLine
          }
        }
      }
    }

    // 统计逻辑统一：都是按节点数量统计
    // executedInstruction: 执行过的不同指令位置数量（节点数量，通过执行时记录）
    const executedInstruction = this.instructionStats.instructionCounts.size
    // executionCount: 所有指令执行次数的总和（同一节点可能执行多次）
    let executionCount = 0
    for (const count of this.instructionStats.instructionCounts.values()) {
      executionCount += count
    }
    let entryPointCount = 0
    if (analyzer?.checkerManager) {
      const { checkerManager } = analyzer
      const checkers = new Set()
      for (const checkpointName in checkerManager.checkpoints) {
        const checkpoint = checkerManager.checkpoints[checkpointName]
        if (Array.isArray(checkpoint)) {
          checkpoint.forEach((checker: any) => checkers.add(checker))
        }
      }
      if (checkerManager.registered_checkers) {
        for (const checkerId in checkerManager.registered_checkers) {
          checkers.add(checkerManager.registered_checkers[checkerId])
        }
      }

      if (analyzer.entryPoints && Array.isArray(analyzer.entryPoints)) {
        entryPointCount = analyzer.entryPoints.length
      } else if (analyzer.mainEntryPoints && Array.isArray(analyzer.mainEntryPoints)) {
        entryPointCount = analyzer.mainEntryPoints.length
      }
      if (entryPointCount === 0) {
        for (const checker of checkers) {
          const checkerAny = checker as any
          if (checkerAny?.entryPoints && Array.isArray(checkerAny.entryPoints)) {
            entryPointCount += checkerAny.entryPoints.length
          }
        }
      }
    }

    // 获取 findings 数量（只统计 taintflow，不包括 callgraph）
    let findingCount = 0
    if (analyzer?.checkerManager?.resultManager) {
      const findings = analyzer.checkerManager.resultManager.getFindings?.() || {}
      // 只统计实际的 findings，排除 callgraph（callgraph 是调用图数据，不是 findings）
      for (const key in findings) {
        if (key !== 'callgraph' && Array.isArray(findings[key])) {
          findingCount += findings[key].length
        }
      }
    }

    const instructionDetails = this.getInstructionDetails()

    // 获取实际标记的 source 和匹配的 sink 数量（延迟加载以避免循环依赖）
    let markedSourceCount = 0
    let matchedSinkCount = 0
    try {
      const sourceUtil = require('../checker/taint/common-kit/source-util')
      const sinkUtil = require('../checker/taint/common-kit/sink-util')
      markedSourceCount = sourceUtil?.getMarkedSourceCount ? sourceUtil.getMarkedSourceCount() : 0
      matchedSinkCount = sinkUtil?.getMatchedSinkCount ? sinkUtil.getMatchedSinkCount() : 0
    } catch (e) {
      // 模块可能不存在或循环依赖，忽略
    }

    return {
      language,
      fileCount,
      lineCount: totalLines,
      totalTime: timings.total || 0,
      executedInstruction,
      executionCount,
      markedSourceCount,
      matchedSinkCount,
      entryPointCount,
      findingCount,
      avgExecutionTimePerInstruction: instructionDetails.avgExecutionTimePerInstruction,
      avgInstructionExecutionCount: instructionDetails.avgInstructionExecutionCount,
      executionTime70Percent: instructionDetails.executionTime70Percent,
      executionTime99Percent: instructionDetails.executionTime99Percent,
      executionTime100Percent: instructionDetails.executionTime100Percent,
      executionTimes70Percent: instructionDetails.executionTimes70Percent,
      executionTimes99Percent: instructionDetails.executionTimes99Percent,
      executionTimes100Percent: instructionDetails.executionTimes100Percent,
    }
  }

  /**
   * 从 analyzer 收集分析概览数据
   * @param analyzer - analyzer 对象
   */
  collectAnalysisData(analyzer: any): void {
    const timings = this.getTimings()
    this.cachedAnalysisOverview = this.collectAnalysisOverview(analyzer, timings)
    this.hasLoggedPerformance = true
  }

  /**
   * 输出性能报告（包括 overview 和 summary）
   * 如果之前执行过 collectAnalysisData(analyzer)，则输出 overview，否则只输出 summary
   */
  outputPerformanceReport(): void {
    if (!this.hasTotalStage) {
      this.start()
    }

    // 强制结束所有进行中的阶段
    Object.keys(this.stages).forEach((stage) => {
      if (this.stages[stage].currentStartTime > 0) {
        this.end(stage)
      }
    })

    if (this.hasTotalStage) {
      this.end('total')
    }

    // 如果之前执行过 collectAnalysisData(analyzer)，则输出 overview
    if (this.hasLoggedPerformance && this.cachedAnalysisOverview) {
      const unifiedMaxLabelLength = Math.max(...PerformanceTracker.OVERVIEW_LABELS.map((label) => label.length)) + 1
      this.outputOverview(this.cachedAnalysisOverview, unifiedMaxLabelLength)
    }

    this.outputSummary()
  }

  /**
   * 格式化并输出概览行
   * @param label - 标签文本
   * @param value - 值文本
   * @param maxLabelLength - 最大标签长度（用于对齐）
   */
  private outputOverviewLine(label: string, value: string, maxLabelLength: number): void {
    console.log(`${label.padEnd(maxLabelLength)}: ${value}`)
  }

  /**
   * 输出分析概览
   * @param analysisOverview - 分析概览数据对象
   * @param maxLabelLength - 最大标签长度（用于对齐）
   */
  private outputOverview(
    analysisOverview: ReturnType<typeof this.collectAnalysisOverview>,
    maxLabelLength: number
  ): void {
    yasaSeparator('Analysis Overview')

    this.outputOverviewLine('Language', analysisOverview.language, maxLabelLength)
    this.outputOverviewLine('Files analyzed', String(analysisOverview.fileCount), maxLabelLength)
    this.outputOverviewLine(
      'Lines of code',
      analysisOverview.lineCount > 0 ? analysisOverview.lineCount.toLocaleString() : 'N/A',
      maxLabelLength
    )

    this.outputOverviewLine('Total time', this.formatTime(analysisOverview.totalTime), maxLabelLength)
    this.outputOverviewLine('Executed instruction', String(analysisOverview.executedInstruction), maxLabelLength)
    this.outputOverviewLine('Execution count', String(analysisOverview.executionCount), maxLabelLength)

    this.outputOverviewLine('Sources marked', String(analysisOverview.markedSourceCount), maxLabelLength)
    this.outputOverviewLine('Sinks matched', String(analysisOverview.matchedSinkCount), maxLabelLength)
    this.outputOverviewLine('Valid entrypoints', String(analysisOverview.entryPointCount), maxLabelLength)
    this.outputOverviewLine('Findings', String(analysisOverview.findingCount), maxLabelLength)

    this.outputOverviewLine(
      'Avg execution time per instruction',
      `${analysisOverview.avgExecutionTimePerInstruction.toFixed(2)}ms`,
      maxLabelLength
    )
    this.outputOverviewLine(
      'Avg instruction execution count',
      analysisOverview.avgInstructionExecutionCount.toFixed(2),
      maxLabelLength
    )

    this.outputOverviewLine(
      'Execution time 70%/99%/100%',
      `${analysisOverview.executionTime70Percent.toFixed(2)}ms/${analysisOverview.executionTime99Percent.toFixed(2)}ms/${analysisOverview.executionTime100Percent.toFixed(2)}ms`,
      maxLabelLength
    )

    this.outputOverviewLine(
      'Execution times 70%/99%/100%',
      `${analysisOverview.executionTimes70Percent.toFixed(2)}/${analysisOverview.executionTimes99Percent.toFixed(2)}/${analysisOverview.executionTimes100Percent.toFixed(2)}`,
      maxLabelLength
    )

    yasaSeparator('')
  }

  /** 输出性能统计（树形结构，自动计算 other cost） */
  // eslint-disable-next-line complexity
  private outputSummary(): void {
    const timings = this.getTimings()

    yasaSeparator('Performance Statistics')

    const rootStages = Object.keys(this.stages)
      .filter((stage) => {
        return !this.getParentStage(stage) && stage !== 'total'
      })
      .sort((a, b) => {
        // 按照 startTime 排序
        return this.stages[a].startTime - this.stages[b].startTime
      })

    if (this.hasTotalStage && timings.total != null) {
      console.log(`total cost: ${this.formatTime(timings.total)}`)
    }

    const maxDepth = Infinity
    rootStages.forEach((stage) => {
      if (timings[stage] != null) {
        // 根阶段的父时间是 total
        const parentTime = this.hasTotalStage && timings.total != null ? timings.total : null
        this.outputStageTree(stage, timings, 0, maxDepth, parentTime)
      }
    })

    // 计算并输出 other cost（总时间减去所有根阶段时间）
    if (this.hasTotalStage && timings.total != null) {
      const totalTime = timings.total
      const allStagesTotal = rootStages
        .map((stage) => timings[stage])
        .filter((time): time is number => time != null && time > 0)
        .reduce((sum, time) => sum + time, 0)

      const otherTime = totalTime - allStagesTotal
      if (otherTime > 0) {
        const percentage = ((otherTime / totalTime) * 100).toFixed(1)
        console.log(`${PerformanceTracker.OTHER_COST_LABEL}: ${this.formatTime(otherTime)} (${percentage}%)`)
      }
    }

    if (this.enableDetailedInstructionStats) {
      this.outputInstructionStats(timings)
    }

    yasaSeparator('')
  }

  /**
   * 递归输出阶段树
   * @param stage - 阶段名称
   * @param timings - 所有阶段的耗时数据
   * @param indent - 缩进级别
   * @param maxDepth - 最大深度
   * @param parentTime - 父阶段的耗时（用于计算百分比）
   */
  private outputStageTree(
    stage: string,
    timings: Record<string, number | null>,
    indent: number,
    maxDepth: number = Infinity,
    parentTime: number | null = null
  ): void {
    if (indent >= maxDepth) {
      return
    }
    const stageTime = timings[stage]
    if (stageTime == null) {
      return
    }

    const indentStr = '  '.repeat(indent)
    const leafName = this.getStageLeafName(stage)

    // 如果有父阶段时间，计算并显示百分比
    let percentageStr = ''
    if (parentTime != null && parentTime > 0) {
      const percentage = ((stageTime / parentTime) * 100).toFixed(1)
      percentageStr = ` (${percentage}%)`
    }

    console.log(`${indentStr}${leafName} cost: ${this.formatTime(stageTime)}${percentageStr}`)

    const childStages = this.getChildStages(stage)
      .filter((childStage) => {
        const childTime = timings[childStage]
        return childTime != null && childTime > 0
      })
      .sort((a, b) => {
        // 按照 startTime 排序
        return this.stages[a].startTime - this.stages[b].startTime
      })

    if (childStages.length > 0) {
      if (indent + 1 < maxDepth) {
        childStages.forEach((childStage) => {
          // 子阶段的父时间是当前阶段的时间
          this.outputStageTree(childStage, timings, indent + 1, maxDepth, stageTime)
        })
      }

      const subTotal = childStages.reduce((sum, childStage) => {
        const childTime = timings[childStage]
        return sum + (childTime || 0)
      }, 0)

      // 计算 other cost（父阶段时间减去所有子阶段时间）
      const otherCost = stageTime - subTotal
      if (otherCost > 0) {
        const percentage = ((otherCost / stageTime) * 100).toFixed(1)
        console.log(
          `${indentStr}  ${PerformanceTracker.OTHER_COST_LABEL}: ${this.formatTime(otherCost)} (${percentage}%)`
        )
      }
    }
  }

  /**
   * Format milliseconds to international standard format (minutes:seconds.milliseconds)
   * @param ms - Milliseconds
   * @returns {string} Formatted time string, e.g. "0m12s203ms" or "12s203ms"
   */
  private formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    const milliseconds = ms % 1000

    if (minutes > 0) {
      return `${minutes}m${seconds}s${milliseconds}ms`
    }
    return `${seconds}s${milliseconds}ms`
  }

  /**
   * 统计配置项数量（sources 或 sinks）
   * @param items - 配置项对象
   * @returns {number} 配置项总数
   */
  private countConfigItems(items: Record<string, any>): number {
    let count = 0
    for (const key in items) {
      if (Array.isArray(items[key])) {
        count += items[key].length
      } else if (items[key]) {
        count += 1
      }
    }
    return count
  }

  /**
   * 计算总指令数（所有 locationKey 的计数之和）
   * @returns {number} 总指令数
   */
  private calculateTotalInstructions(): number {
    let totalInstructions = 0
    for (const count of this.instructionStats.instructionCounts.values()) {
      totalInstructions += count
    }
    return totalInstructions
  }

  /**
   * 计算数组平均值
   * @param values - 数值数组
   * @returns {number} 平均值，如果数组为空则返回 0
   */
  private calculateAverage(values: number[]): number {
    return values.length > 0 ? values.reduce((sum, val) => sum + val, 0) / values.length : 0
  }

  /**
   * 计算平均净执行时间
   * @returns {{ avgExecutionTimePerInstruction: number; totalNetInstructionCount: number }} 平均执行时间和总净指令数
   */
  private calculateAvgNetExecutionTime(): {
    avgExecutionTimePerInstruction: number
    totalNetInstructionCount: number
  } {
    let totalAvgNetTime = 0
    let totalNetInstructionCount = 0
    if (this.enableDetailedInstructionStats) {
      for (const [locationKey, netTimes] of this.instructionStats.instructionNetTimes) {
        const count = this.instructionStats.instructionCounts.get(locationKey) || 0
        const avgNetTime = this.calculateAverage(netTimes)
        totalAvgNetTime += avgNetTime * count
        totalNetInstructionCount += count
      }
    }
    const avgExecutionTimePerInstruction = totalNetInstructionCount > 0 ? totalAvgNetTime / totalNetInstructionCount : 0
    return { avgExecutionTimePerInstruction, totalNetInstructionCount }
  }

  /**
   * 获取指令统计详情数据
   * @returns {Object} 指令统计详情数据
   */
  // eslint-disable-next-line complexity
  private getInstructionDetails(): {
    avgExecutionTimePerInstruction: number
    avgInstructionExecutionCount: number
    executionTime70Percent: number
    executionTime99Percent: number
    executionTime100Percent: number
    executionTimes70Percent: number
    executionTimes99Percent: number
    executionTimes100Percent: number
  } {
    const totalInstructions = this.calculateTotalInstructions()
    const { avgExecutionTimePerInstruction } = this.calculateAvgNetExecutionTime()

    const totalInstructionLocations = this.instructionStats.instructionCounts.size
    const avgInstructionExecutionCount =
      totalInstructionLocations > 0 ? totalInstructions / totalInstructionLocations : 0

    // 注意：不再在这里输出日志，避免与 outputPerformanceReport 中的输出重复
    // 日志输出统一在 outputPerformanceReport 方法中处理

    // 计算所有指令执行时间的分位数（基于净执行时间）
    const allExecutionTimes: number[] = []
    if (this.enableDetailedInstructionStats) {
      for (const netTimes of this.instructionStats.instructionNetTimes.values()) {
        allExecutionTimes.push(...netTimes)
      }
    }
    allExecutionTimes.sort((a, b) => a - b)
    const executionTime70Percent = this.calculatePercentile(allExecutionTimes, 70)
    const executionTime99Percent = this.calculatePercentile(allExecutionTimes, 99)
    const executionTime100Percent = this.calculatePercentile(allExecutionTimes, 100)

    const allExecutionCounts: number[] = []
    for (const count of this.instructionStats.instructionCounts.values()) {
      allExecutionCounts.push(count)
    }
    allExecutionCounts.sort((a, b) => a - b)
    const executionTimes70Percent = this.calculatePercentile(allExecutionCounts, 70)
    const executionTimes99Percent = this.calculatePercentile(allExecutionCounts, 99)
    const executionTimes100Percent = this.calculatePercentile(allExecutionCounts, 100)

    return {
      avgExecutionTimePerInstruction,
      avgInstructionExecutionCount,
      executionTime70Percent,
      executionTime99Percent,
      executionTime100Percent,
      executionTimes70Percent,
      executionTimes99Percent,
      executionTimes100Percent,
    }
  }

  /**
   * 输出 Top 指令列表
   * @param entries - 指令条目数组
   * @param title - 标题
   * @param avgKey - 平均时间字段名
   * @param maxKey - 最大时间字段名
   */
  private outputTopInstructions(
    entries: Array<{ locationKey: string; count: number; [key: string]: any }>,
    title: string,
    avgKey: string,
    maxKey: string
  ): void {
    if (entries.length > 0) {
      console.log(`  ${title}`)
      entries.forEach((entry, index) => {
        const { instructionType, location } = this.parseLocationKey(entry.locationKey)
        console.log(
          `    ${index + 1}. ${instructionType} at ${location} (Count: ${entry.count}, Avg: ${entry[avgKey].toFixed(2)}ms, Max: ${entry[maxKey].toFixed(2)}ms)`
        )
      })
    }
  }

  /**
   * 解析 locationKey，提取指令类型和位置
   * @param locationKey - 位置键（格式：'instructionType:location'）
   * @returns {{ instructionType: string; location: string }} 指令类型和位置
   */
  private parseLocationKey(locationKey: string): { instructionType: string; location: string } {
    const [instructionType, ...locationParts] = locationKey.split(':')
    const location = locationParts.join(':')
    return { instructionType, location }
  }

  /**
   * 输出指令性能统计
   * @param timings - 阶段耗时数据，用于获取总时间
   */
  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity
  private outputInstructionStats(timings: Record<string, number | null>): void {
    const totalTime = timings.total || 0
    const totalOverhead = this.instructionStats.updateStatsOverhead
    const overheadPercent = totalTime > 0 ? ((totalOverhead / totalTime) * 100).toFixed(1) : '0.0'

    if (this.instructionStats.instructionTimes.size === 0) {
      console.log('\nInstruction Statistics: No instruction data available')
      return
    }

    const numProcessedInstructions = this.calculateTotalInstructions()
    const { avgExecutionTimePerInstruction: overallAvgTime } = this.calculateAvgNetExecutionTime()

    console.log('\nInstruction Statistics:')
    console.log(
      `  Time: ${totalTime}ms | Instructions: ${numProcessedInstructions} | Overhead: ${totalOverhead.toFixed(1)}ms (${overheadPercent}%) | Locations: ${this.instructionStats.instructionTimes.size} | Avg: ${overallAvgTime.toFixed(2)}ms`
    )

    const executionTimeEntries = Array.from(this.instructionStats.instructionNetTimes.entries())
      .map(([locationKey, netTimes]) => {
        if (netTimes.length === 0) {
          return null
        }
        const netMaxTime = Math.max(...netTimes)
        const netAvgTime = this.calculateAverage(netTimes)
        return {
          locationKey,
          netMaxTime,
          netAvgTime,
          count: this.instructionStats.instructionCounts.get(locationKey) || 0,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.netMaxTime - a.netMaxTime)
      .slice(0, 5)

    this.outputTopInstructions(
      executionTimeEntries,
      'Top 5 Slowest Instructions (by Net Time):',
      'netAvgTime',
      'netMaxTime'
    )

    const executionCountEntries = Array.from(this.instructionStats.instructionCounts.entries())
      .map(([locationKey, count]) => {
        const netTimes = this.instructionStats.instructionNetTimes.get(locationKey) || []
        return {
          locationKey,
          count,
          avgTime: this.calculateAverage(netTimes),
          maxTime: netTimes.length > 0 ? Math.max(...netTimes) : 0,
        }
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    this.outputTopInstructions(executionCountEntries, 'Top 5 Most Frequent Instructions:', 'avgTime', 'maxTime')
  }

  /**
   * 获取各阶段耗时（毫秒）
   * @param forceEnd - 是否强制结束正在运行的阶段（默认 false）
   * @returns {Record<string, number | null>} 包含所有阶段耗时的对象
   */
  getTimings(forceEnd: boolean = false): Record<string, number | null> {
    const timings: Record<string, number | null> = {}

    Object.keys(this.stages).forEach((stage) => {
      timings[stage] = this.getStageTime(stage, forceEnd)
    })

    if (!this.hasTotalStage && this.startTime > 0) {
      timings.total = Date.now() - this.startTime
    }

    return timings
  }

  /**
   * 启用详细的指令统计（输出 top 信息）
   * @param enabled - 是否启用（默认 false，传入 true 则启用）
   */
  setEnableDetailedInstructionStats(enabled: boolean | undefined = false): void {
    this.enableDetailedInstructionStats = enabled === true
  }

  /**
   * 开始指令级别的性能监控（默认开启，总是初始化计数统计）
   */
  startInstructionMonitor(): void {
    const startTime = Date.now()
    this.instructionStats.startTime = startTime
    this.instructionStats.totalExecutionTime = 0
    // 详细统计时才清空时间数据，计数数据总是保留
    if (this.enableDetailedInstructionStats) {
      this.instructionStats.instructionTimes.clear()
      this.instructionStats.instructionNetTimes.clear()
    }
    this.instructionStats.instructionCounts.clear()
    this.instructionStats.monitoringOverhead = 0
    this.instructionStats.updateStatsOverhead = 0
    this.instructionStats.executionStack = []
  }

  /**
   * 开始指令执行（默认开启，总是记录计数；详细统计时才记录时间）
   */
  startInstruction(): void {
    if (this.enableDetailedInstructionStats) {
      const startTime = Date.now()
      this.instructionStats.executionStack.push({ startTime, nestedTime: 0 })
    }
  }

  /**
   * 结束指令执行并更新统计（默认开启，总是更新计数；详细统计时才更新时间）
   * @param node - AST 节点（包含 type 属性）
   * @param getLocationKey - 生成位置唯一键的函数
   */
  endInstructionAndUpdateStats(node: any, getLocationKey: (node: any, instructionType: string) => string): void {
    const locationKey = getLocationKey(node, node.type)

    // 总是更新指令计数（性能开销小）
    const currentCount = this.instructionStats.instructionCounts.get(locationKey) || 0
    this.instructionStats.instructionCounts.set(locationKey, currentCount + 1)

    if (this.enableDetailedInstructionStats) {
      // 检查执行栈是否为空，避免不平衡调用导致的错误
      if (this.instructionStats.executionStack.length === 0) {
        yasaWarning(
          'endInstructionAndUpdateStats called but execution stack is empty. This may indicate a mismatch between startInstruction and endInstruction calls.'
        )
        return
      }

      const endTime = Date.now()
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

      this.updateInstructionStats(node.type, totalExecutionTime, netExecutionTime, node, getLocationKey)
      this.instructionStats.updateStatsOverhead += Date.now() - updateStartTime
    }
  }

  /**
   * 获取执行栈深度
   * @returns {number} 当前执行栈的深度，如果未启用详细统计则返回 0
   */
  getExecutionStackDepth(): number {
    if (!this.enableDetailedInstructionStats) return 0
    return this.instructionStats.executionStack.length
  }

  /**
   * 获取执行栈
   * @returns {Array<{ startTime: number; nestedTime: number }>} 当前执行栈的副本，如果未启用详细统计则返回空数组
   */
  getExecutionStack(): Array<{ startTime: number; nestedTime: number }> {
    if (!this.enableDetailedInstructionStats) return []
    return this.instructionStats.executionStack
  }

  /**
   * 更新指令性能统计（仅在启用详细统计时调用）
   * @param instructionType - 指令类型（如 'CallExpression', 'IfStatement'）
   * @param totalExecutionTime - 总执行时间（包含嵌套调用，毫秒）
   * @param netExecutionTime - 净执行时间（排除嵌套调用，毫秒）
   * @param node - AST 节点
   * @param getLocationKey - 生成位置唯一键的函数
   */
  updateInstructionStats(
    instructionType: string,
    totalExecutionTime: number,
    netExecutionTime: number,
    node: any,
    getLocationKey: (node: any, instructionType: string) => string
  ): void {
    const locationKey = getLocationKey(node, instructionType)

    if (!this.instructionStats.instructionTimes.has(locationKey)) {
      this.instructionStats.instructionTimes.set(locationKey, [])
    }
    this.instructionStats.instructionTimes.get(locationKey)!.push(totalExecutionTime)

    if (!this.instructionStats.instructionNetTimes.has(locationKey)) {
      this.instructionStats.instructionNetTimes.set(locationKey, [])
    }
    this.instructionStats.instructionNetTimes.get(locationKey)!.push(netExecutionTime)
  }

  /** 重置所有计时器 */
  reset(): void {
    this.startTime = 0
    this.hasTotalStage = false
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

// 创建单例实例
const performanceTrackerInstance = new PerformanceTracker()

module.exports = {
  PerformanceTracker,
  performanceTracker: performanceTrackerInstance, // 导出单例实例
}
