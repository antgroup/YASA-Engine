/* eslint-disable @typescript-eslint/no-require-imports, import/no-commonjs */
const { logDiagnostics } = require('./diagnostics-log-util')
const { yasaLog, yasaWarning, yasaSeparator } = require('./format-util')
/* eslint-enable @typescript-eslint/no-require-imports, import/no-commonjs */

/**
 * 性能追踪器接口
 */
export interface IPerformanceTracker {
  // 如果不传 stage，自动创建 'total' 阶段；支持层级结构（'A.B.C'）
  start(stage?: string): void
  end(stage: string): void
  // 累加模式：如果在 start/end 之间调用，会自动转换为 record 模式
  record(stage: string, duration: number): void

  setEnableDetailedInstructionStats(enabled?: boolean): void
  startInstructionMonitor(): void
  startInstruction(): void
  endInstructionAndUpdateStats(node: any, getLocationKey: (node: any, instructionType: string) => string): void

  logPerformance(analyzer: any): void
  getTimings(): Record<string, number | null>
}

/**
 * 性能追踪器 - 记录 YASA 分析各个阶段的性能数据
 * 支持层级结构（'A.B.C'），树形输出，自动计算 other cost
 * 混合模式：start 后调用 record 会自动转换，end 时使用 record 累加的总时间
 */
class PerformanceTracker {
  private static readonly OTHER_COST_LABEL = 'other cost'

  private startTime: number = 0

  private enableDetailedInstructionStats: boolean = false

  private hasTotalStage: boolean = false

  private stages: {
    [key: string]: {
      startTime: number
      endTime: number
      totalTime: number // 用于累加场景（如 parseCode、preload）
      currentStartTime: number
      hasRecorded: boolean // 标记是否在 start/end 之间调用了 record
    }
  } = {}

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
   * 输出阶段结束日志
   * @param stage - 阶段名称
   * @param duration - 耗时（毫秒）
   */
  private logStageEnd(stage: string, duration: number): void {
    if (stage === 'total') {
      yasaLog(`Execution completed, cost: ${duration}ms`)
    } else {
      const leafName = this.getStageLeafName(stage)
      if (leafName && leafName !== 'undefined') {
        const stages = this.getStageArray(stage)
        yasaLog(`Completed ${leafName}, cost: ${duration}ms`, stages)
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
   * @param duration - 耗时（毫秒）
   */
  record(stage: string, duration: number): void {
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

    // forceEnd 为 true 时，强制结束正在运行的阶段（仅在 logPerformance 时使用）
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
  private collectAnalysisOverview(
    analyzer: any,
    timings: Record<string, number | null>
  ): {
    // summary1
    language: string
    fileCount: number
    lineCount: number
    // summary2
    totalTime: number
    totalInstruction: number
    executedInstruction: number
    executionCount: number
    // configure
    sourceCount: number
    sinkCount: number
    entryPointCount: number
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

    // 获取要统计的文件列表（单文件分析时只统计匹配的文件）
    let filesToCount: string[] = []
    if (analyzer?.fileManager) {
      const sourcePath =
        analyzer?.options?.sourcePath ||
        analyzer?.options?.sourceFile ||
        Config.sourcePath ||
        (Config.single && Config.maindir ? Config.maindir : null)
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
    }

    let fileCount = filesToCount.length
    if (fileCount === 0) {
      const Statistics = require('./statistics')
      fileCount = Statistics.numProcessedFiles || 0
    }

    let totalLines = 0
    try {
      const SourceLine = require('../engine/analyzer/common/source-line')
      if (analyzer?.fileManager && SourceLine.getCodeBySourceFile) {
        for (const filename of filesToCount) {
          try {
            const code = SourceLine.getCodeBySourceFile(filename)
            if (code) {
              totalLines += code.split('\n').length
            }
          } catch (e) {
            // 忽略单个文件的错误
          }
        }
      }
    } catch (e) {
      // SourceLine 可能不存在，使用 AST 估算作为后备
    }
    if (totalLines === 0 && analyzer?.fileManager) {
      for (const filename of filesToCount) {
        const { ast } = analyzer.fileManager[filename] || {}
        if (ast) {
          if (ast.loc?.end?.line) {
            totalLines += ast.loc.end.line
          } else if (ast._meta?.endLine) {
            totalLines += ast._meta.endLine
          }
        }
      }
    }

    // 使用被执行的指令位置数量作为总指令数的近似值
    const executedInstruction = this.instructionStats.instructionCounts.size
    let executionCount = 0
    for (const count of this.instructionStats.instructionCounts.values()) {
      executionCount += count
    }
    const totalInstruction = executedInstruction
    let sourceCount = 0
    let sinkCount = 0
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

      for (const checker of checkers) {
        const checkerAny = checker as any
        const { checkerRuleConfigContent } = checkerAny || {}
        if (checkerRuleConfigContent?.sources) {
          sourceCount += this.countConfigItems(checkerRuleConfigContent.sources)
        }
        if (checkerRuleConfigContent?.sinks) {
          sinkCount += this.countConfigItems(checkerRuleConfigContent.sinks)
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

    const instructionDetails = this.getInstructionDetails()

    return {
      language,
      fileCount,
      lineCount: totalLines,
      totalTime: timings.total || 0,
      totalInstruction,
      executedInstruction,
      executionCount,
      sourceCount,
      sinkCount,
      entryPointCount,
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
   * 记录性能数据并输出摘要
   * @param analyzer - 可选的 analyzer 对象
   */
  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity
  logPerformance(analyzer?: any): void {
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

    const timings = this.getTimings()
    const analysisOverview = analyzer ? this.collectAnalysisOverview(analyzer, timings) : null
    if (analysisOverview) {
      logDiagnostics('summary1', {
        string1: analysisOverview.language,
        string2: 'fileCount',
        string3: 'lineCount',
        number1: analysisOverview.fileCount,
        number2: analysisOverview.lineCount > 0 ? analysisOverview.lineCount : null,
        number3: null,
      })

      logDiagnostics('summary2', {
        string1: 'totalTime',
        string2: 'totalInstruction',
        string3: 'executedInstruction',
        number1: analysisOverview.totalTime,
        number2: analysisOverview.totalInstruction,
        number3: analysisOverview.executedInstruction,
      })

      logDiagnostics('configure', {
        string1: 'sourceCount',
        string2: 'sinkCount',
        string3: 'entryPoints',
        number1: analysisOverview.sourceCount,
        number2: analysisOverview.sinkCount,
        number3: analysisOverview.entryPointCount,
      })
    }

    logDiagnostics('stageTime', {
      string1: 'preProcessTime',
      string2: 'preAnalyzeTime',
      string3: 'symbolInterpretTime',
      number1: timings.preProcess || 0,
      number2: timings.startAnalyze || 0,
      number3: timings.symbolInterpret || 0,
    })

    const parseCodeStage = this.stages['preProcess.parseCode']
    const preloadStage = this.stages['preProcess.preload']
    const processModuleStage = this.stages['preProcess.processModule']
    logDiagnostics('preprocessDetail1', {
      string1: 'parseTime',
      string2: 'preloadTime',
      string3: 'processModuleTime',
      number1: parseCodeStage?.totalTime || 0,
      number2: preloadStage?.totalTime || 0,
      number3: processModuleStage?.totalTime || 0,
    })

    if (analysisOverview) {
      logDiagnostics('symbolInterpretDetail1', {
        string1: 'executionCount',
        string2: 'avgExecutionTimePerInstruction',
        string3: 'avgInstructionExecutionCount',
        number1: analysisOverview.executionCount,
        number2: analysisOverview.avgExecutionTimePerInstruction,
        number3: analysisOverview.avgInstructionExecutionCount,
      })

      logDiagnostics('symbolInterpretDetail2', {
        string1: 'executionTime70Percent',
        string2: 'executionTime99Percent',
        string3: 'executionTime100Percent',
        number1: analysisOverview.executionTime70Percent,
        number2: analysisOverview.executionTime99Percent,
        number3: analysisOverview.executionTime100Percent,
      })

      logDiagnostics('symbolInterpretDetail3', {
        string1: 'executionTimes70Percent',
        string2: 'executionTimes99Percent',
        string3: 'executionTimes100Percent',
        number1: analysisOverview.executionTimes70Percent,
        number2: analysisOverview.executionTimes99Percent,
        number3: analysisOverview.executionTimes100Percent,
      })
    }

    let unifiedMaxLabelLength = 0
    if (analyzer && analysisOverview) {
      const labels = [
        'Language',
        'Files analyzed',
        'Lines of code',
        'Total time',
        'Total instruction',
        'Executed instruction',
        'Execution count',
        'Sources configured',
        'Sinks configured',
        'Valid entrypoints',
        'Avg execution time per instruction',
        'Avg instruction execution count',
        'Execution time 70%/99%/100%',
        'Execution times 70%/99%/100%',
      ]
      unifiedMaxLabelLength = Math.max(...labels.map((label) => label.length)) + 1
    }

    if (analyzer && analysisOverview) {
      this.outputOverview(analysisOverview, unifiedMaxLabelLength)
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

    this.outputOverviewLine('Total time', `${analysisOverview.totalTime}ms`, maxLabelLength)
    this.outputOverviewLine('Total instruction', String(analysisOverview.totalInstruction), maxLabelLength)
    this.outputOverviewLine('Executed instruction', String(analysisOverview.executedInstruction), maxLabelLength)
    this.outputOverviewLine('Execution count', String(analysisOverview.executionCount), maxLabelLength)

    this.outputOverviewLine('Sources configured', String(analysisOverview.sourceCount), maxLabelLength)
    this.outputOverviewLine('Sinks configured', String(analysisOverview.sinkCount), maxLabelLength)
    this.outputOverviewLine('Valid entrypoints', String(analysisOverview.entryPointCount), maxLabelLength)

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
  outputSummary(): void {
    const timings = this.getTimings()

    yasaSeparator('Performance Statistics')

    const rootStages = Object.keys(this.stages).filter((stage) => {
      return !this.getParentStage(stage) && stage !== 'total'
    })

    if (this.hasTotalStage && timings.total != null) {
      console.log(`total cost: ${timings.total}ms`)
    }

    const maxDepth = Infinity
    rootStages.forEach((stage) => {
      if (timings[stage] != null) {
        this.outputStageTree(stage, timings, 0, maxDepth)
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
        console.log(`${PerformanceTracker.OTHER_COST_LABEL}: ${otherTime}ms`)
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
   */
  private outputStageTree(
    stage: string,
    timings: Record<string, number | null>,
    indent: number,
    maxDepth: number = Infinity
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
    console.log(`${indentStr}${leafName} cost: ${stageTime}ms`)

    const childStages = this.getChildStages(stage)
      .filter((childStage) => {
        const childTime = timings[childStage]
        return childTime != null && childTime > 0
      })
      .sort()

    if (childStages.length > 0) {
      if (indent + 1 < maxDepth) {
        childStages.forEach((childStage) => {
          this.outputStageTree(childStage, timings, indent + 1, maxDepth)
        })
      }

      const subTotal = childStages.reduce((sum, childStage) => {
        const childTime = timings[childStage]
        return sum + (childTime || 0)
      }, 0)

      // 计算 other cost（父阶段时间减去所有子阶段时间）
      const otherCost = stageTime - subTotal
      if (otherCost > 0) {
        console.log(`${indentStr}  ${PerformanceTracker.OTHER_COST_LABEL}: ${otherCost}ms`)
      }
    }
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

    // 注意：不再在这里输出日志，避免与 logPerformance 中的输出重复
    // 日志输出统一在 logPerformance 方法中处理

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

// eslint-disable-next-line import/no-commonjs
module.exports = {
  PerformanceTracker,
}
