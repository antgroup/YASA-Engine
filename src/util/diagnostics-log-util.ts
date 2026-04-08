/* eslint-disable @typescript-eslint/no-require-imports, import/no-commonjs */
const fs = require('fs')
const path = require('path')
const os = require('os')
const Config = require('../config')
const { loadJSONfile } = require('./file-util')
const { YASA_VERSION } = require('./constant')

// 保持文件句柄打开，避免频繁开关影响性能
let logFileDescriptor: number | null = null
let currentReportDir: string | null = null // 记录当前使用的 reportDir

/**
 * 获取报告目录路径（从 Config.reportDir 动态获取）
 * @returns {string} 报告目录的完整路径
 */
function getReportDir(): string {
  // 从 Config 获取 reportDir，如果不存在或为空，使用默认值
  let reportDir = Config.reportDir || './report/'

  // 如果是相对路径，转换为绝对路径
  if (!path.isAbsolute(reportDir)) {
    reportDir = path.resolve(process.cwd(), reportDir)
  }

  return reportDir
}

/**
 * 获取日志文件路径（从 Config.reportDir 动态获取）
 * @returns {string} 日志文件的完整路径
 */
function getLogFilePath(): string {
  return path.join(getReportDir(), 'yasa-diagnostics-log.txt')
}

/**
 * 确保文件句柄打开
 * @returns {number} 文件描述符
 */
function ensureFileOpen(): number {
  const logFilePath = getLogFilePath()
  const reportDir = path.dirname(logFilePath)

  // 如果 reportDir 改变了，需要关闭旧文件并打开新文件
  if (logFileDescriptor !== null && currentReportDir !== reportDir) {
    try {
      fs.closeSync(logFileDescriptor)
    } catch (e) {
      // 忽略关闭错误
    }
    logFileDescriptor = null
    currentReportDir = null
  }

  if (logFileDescriptor === null) {
    // 确保 report 目录存在
    try {
      if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir, { recursive: true })
      } else {
        const stats = fs.statSync(reportDir)
        if (!stats.isDirectory()) {
          // 如果存在但不是目录，删除后重新创建
          fs.unlinkSync(reportDir)
          fs.mkdirSync(reportDir, { recursive: true })
        }
      }
    } catch (error) {
      // 如果创建目录失败，记录错误但不阻止日志写入尝试
      console.error(`Failed to create report directory: ${error}`)
    }

    // 打开文件（追加模式），保持打开
    try {
      logFileDescriptor = fs.openSync(logFilePath, 'a')
      currentReportDir = reportDir // 记录当前使用的 reportDir
    } catch (error) {
      console.error(`Failed to open log file: ${error}`)
      throw error
    }
  }
  if (logFileDescriptor === null) {
    throw new Error('Failed to open log file: file descriptor is null')
  }
  return logFileDescriptor
}

/**
 * 通用诊断日志工具
 * @param log_key - 日志类型/名称（必需）
 * @param options - 可选参数对象
 * @param options.string1 - 字符串参数1，默认为 null
 * @param options.string2 - 字符串参数2，默认为 null
 * @param options.string3 - 字符串参数3，默认为 null
 * @param options.number1 - 数字参数1，默认为 null
 * @param options.number2 - 数字参数2，默认为 null
 * @param options.number3 - 数字参数3，默认为 null
 * @param options.date1 - 日期参数1，类型为 Date 或 number（时间戳），默认为 null（内部会格式化为 yyyy-mm-dd hh:mm:ss）
 * @param options.date2 - 日期参数2，类型为 Date 或 number（时间戳），默认为 null（内部会格式化为 yyyy-mm-dd hh:mm:ss）
 */
function logDiagnostics(
  log_key: string,
  options?: {
    string1?: string | null
    string2?: string | null
    string3?: string | null
    number1?: number | null
    number2?: number | null
    number3?: number | null
    date1?: Date | number | null
    date2?: Date | number | null
  }
): void {
  if (!log_key || typeof log_key !== 'string') {
    throw new Error('log_key parameter is required and must be a string')
  }

  // 设置默认值：string 和 number 默认为 null
  const string1 = options?.string1 ?? null
  const string2 = options?.string2 ?? null
  const string3 = options?.string3 ?? null
  const number1 = options?.number1 ?? null
  const number2 = options?.number2 ?? null
  const number3 = options?.number3 ?? null

  /**
   * 格式化当前时间为 yyyy-mm-dd hh:mm:ss
   * @param date - 日期对象或时间戳
   * @returns {string} 格式化后的日期时间字符串
   */
  function formatDateTime(date: Date | number): string {
    // 如果传入的是数字（时间戳），转换为 Date 对象
    const dateObj = date instanceof Date ? date : new Date(date)
    const year = dateObj.getFullYear()
    const month = String(dateObj.getMonth() + 1).padStart(2, '0')
    const day = String(dateObj.getDate()).padStart(2, '0')
    const hours = String(dateObj.getHours()).padStart(2, '0')
    const minutes = String(dateObj.getMinutes()).padStart(2, '0')
    const seconds = String(dateObj.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  /**
   * 辅助函数：处理日期格式化，消除重复代码
   * @param dateValue - 日期值
   * @returns {string | null} 格式化后的日期字符串或null
   */
  function formatDateIfPresent(dateValue: Date | number | null | undefined): string | null {
    if (dateValue !== null && dateValue !== undefined) {
      return formatDateTime(dateValue)
    }
    return null
  }

  // 处理 date1 和 date2
  const date1 = formatDateIfPresent(options?.date1)
  const date2 = formatDateIfPresent(options?.date2)

  // 记录当前时间作为 logTime
  const logTime = formatDateTime(new Date())

  // 构建日志对象
  const logEntry = {
    log_key,
    log_time: logTime,
    string1,
    string2,
    string3,
    number1,
    number2,
    number3,
    date1,
    date2,
  }

  // 将日志对象转换为JSON格式（每行一个JSON对象）
  const logLine = `${JSON.stringify(logEntry)}\n`

  // 写入日志并立即 flush（文件句柄保持打开，提升性能）
  try {
    const fd = ensureFileOpen()
    fs.writeSync(fd, logLine)
    fs.fsyncSync(fd) // 强制刷新到磁盘，确保即使工具崩溃日志也不会丢失
    // 不关闭文件句柄，保持打开状态以提升性能
  } catch (error) {
    // 如果出错，尝试重新打开文件
    if (logFileDescriptor !== null) {
      try {
        fs.closeSync(logFileDescriptor)
      } catch (e) {
        // 忽略关闭错误
      }
      logFileDescriptor = null
      currentReportDir = null // 重置 reportDir，下次会重新打开
    }
    // 记录错误并尝试再次写入
    console.error(`Failed to write diagnostics log: ${error}`)
    const fd = ensureFileOpen()
    fs.writeSync(fd, logLine)
    fs.fsyncSync(fd)
  }
}

/**
 * 获取项目名称（从项目路径获取最后一个文件夹名，单文件用文件名）
 * @param projectPath - 项目路径
 * @returns {string} 项目名称
 */
function getProjectName(projectPath: string | null | undefined): string {
  if (!projectPath) {
    return 'unknown'
  }
  const normalizedPath = projectPath.replace(/\\/g, '/')
  const parts = normalizedPath.split('/').filter((p) => p)
  if (parts.length === 0) {
    return 'unknown'
  }
  const lastPart = parts[parts.length - 1]
  // 如果是文件，返回文件名（不含扩展名）
  if (lastPart.includes('.')) {
    return path.basename(lastPart, path.extname(lastPart))
  }
  // 如果是目录，返回目录名
  return lastPart
}

/**
 * 获取 ruleconfig 全文
 * @returns {string} ruleconfig 的 JSON 字符串，如果不存在则返回空字符串
 */
function getRuleConfigContent(): string {
  try {
    if (Config.ruleConfigFile && Config.ruleConfigFile !== '') {
      const ruleConfig = loadJSONfile(Config.ruleConfigFile)
      return JSON.stringify(ruleConfig)
    }
  } catch (error) {
    // 忽略错误，返回空字符串
  }
  return ''
}

/**
 * 生成扫描摘要（紧凑的 JSON 字符串）
 * @param analyzer - analyzer 对象
 * @param performanceTracker - performance tracker 对象
 * @param programStartTime - 整个程序开始时间（端到端时间）
 * @param programEndTime - 整个程序结束时间（端到端时间）
 * @returns {string} 紧凑的 JSON 字符串
 */
// eslint-disable-next-line complexity
function generateScanSummary(
  analyzer: any,
  performanceTracker: any,
  programStartTime?: Date | number | null,
  programEndTime?: Date | number | null
): string {
  const timings = performanceTracker?.getTimings?.() || {}
  // 使用 performanceTracker 的 collectAnalysisOverview 获取完整数据
  const analysisData =
    analyzer && performanceTracker?.collectAnalysisOverview
      ? performanceTracker.collectAnalysisOverview(analyzer, timings)
      : null

  // 获取项目路径
  const projectPath =
    analyzer?.options?.sourcePath ||
    analyzer?.options?.sourceFile ||
    Config.sourcePath ||
    (Config.single && Config.maindir ? Config.maindir : null) ||
    Config.maindir ||
    process.cwd()

  // 从 constant 文件获取版本号
  const yasaVersion = YASA_VERSION && typeof YASA_VERSION === 'string' ? YASA_VERSION : 'unknown'

  // 计算实际的 worker 数量：如果 Config.workerCount > 0 则使用配置值，否则自动计算
  let parallelCount = 0
  if (Config.workerCount && Config.workerCount > 0) {
    parallelCount = Config.workerCount
  } else {
    // 自动计算：min(CPU核心数 * 0.4, 16)
    try {
      const cpuCount = os.cpus().length
      const physicalCores = Math.ceil(cpuCount * 0.4)
      parallelCount = Math.min(physicalCores, 16)
      // 确保至少为 1（如果 CPU 核心数很少）
      if (parallelCount === 0 && cpuCount > 0) {
        parallelCount = 1
      }
    } catch (error) {
      // 如果获取 CPU 信息失败，使用默认值 1
      parallelCount = 1
    }
  }
  const cgAlgo = Config.cgAlgo || 'unknown'
  const dumpAllCG = Config.dumpAllCG || false
  const dumpAST = Config.dumpAST || false

  // 使用传入的端到端时间，如果没有则从 performanceTracker 计算
  let startTime: number | null = null
  let endTime: number | null = null
  let totalTime = 0

  if (programStartTime && programEndTime) {
    // 使用端到端时间
    startTime = programStartTime instanceof Date ? programStartTime.getTime() : programStartTime
    endTime = programEndTime instanceof Date ? programEndTime.getTime() : programEndTime
    totalTime = endTime - startTime
  } else if (timings.total) {
    // 回退到从 performanceTracker 计算
    startTime = Date.now() - (timings.total || 0)
    endTime = Date.now()
    totalTime = timings.total
  }

  // 获取 parse 相关时间
  const parseTime = timings.preProcess || 0
  const parseCodeTime = timings['preProcess.parseCode'] || 0
  const preloadTime = timings['preProcess.preload'] || 0
  const processModuleTime = timings['preProcess.processModule'] || 0

  // 获取其他时间
  const startAnalyzeTime = timings.startAnalyze || 0
  const symbolInterpretTime = timings.symbolInterpret || 0

  // 构建扫描摘要对象（使用简写：exec=Execution, inst=Instruction）
  const scanSummary: Record<string, any> = {
    projectName: getProjectName(projectPath),
    projectPath: projectPath || '',
    yasaVersion,
    parallelWorkers: parallelCount,
    cgAlgorithm: cgAlgo,
    dumpAllCG,
    dumpAST,
    scanStartTime: startTime ? new Date(startTime).toISOString() : null,
    scanEndTime: endTime ? new Date(endTime).toISOString() : null,
    findingCount: analysisData?.findingCount || 0,
    language: analysisData?.language || Config.language || 'unknown',
    fileCount: analysisData?.fileCount || 0,
    lineCount: analysisData?.lineCount || 0,
    totalTimeMs: totalTime,
    markedSourceCount: analysisData?.markedSourceCount || 0,
    matchedSinkCount: analysisData?.matchedSinkCount || 0,
    entryPointCount: analysisData?.entryPointCount || 0,
    parseMs: parseTime,
    parseCodeMs: parseCodeTime,
    preloadMs: preloadTime,
    processModuleMs: processModuleTime,
    startAnalyzeMs: startAnalyzeTime,
    symbolInterpretMs: symbolInterpretTime,
    execCount: analysisData?.executionCount || 0,
    execInstCount: analysisData?.executedInstruction || 0,
    avgExecTimePerInst: analysisData?.avgExecutionTimePerInstruction || 0,
    avgInstExecCount: analysisData?.avgInstructionExecutionCount || 0,
    execTimeP70Ms: analysisData?.executionTime70Percent || 0,
    execTimeP99Ms: analysisData?.executionTime99Percent || 0,
    execTimeP100Ms: analysisData?.executionTime100Percent || 0,
    execTimesP70: analysisData?.executionTimes70Percent || 0,
    execTimesP99: analysisData?.executionTimes99Percent || 0,
    execTimesP100: analysisData?.executionTimes100Percent || 0,
  }

  // 返回紧凑的 JSON 字符串（无空格）
  return JSON.stringify(scanSummary)
}

/**
 * 计算开始和结束时间
 * @param performanceTracker - performance tracker 对象
 * @param startTime - 开始时间（Date 或 number 时间戳）
 * @param endTime - 结束时间（Date 或 number 时间戳）
 * @returns {Object} 包含 finalStartTime 和 finalEndTime 的对象
 */
function calculateTimes(
  performanceTracker: any,
  startTime?: Date | number | null,
  endTime?: Date | number | null
): { finalStartTime: Date | number | null; finalEndTime: Date | number | null } {
  let finalStartTime: Date | number | null = startTime !== undefined ? startTime : null
  let finalEndTime: Date | number | null = endTime !== undefined ? endTime : null

  if (!finalStartTime || !finalEndTime) {
    const timings = performanceTracker?.getTimings?.() || {}
    if (timings.total) {
      const totalTime = timings.total
      if (!finalEndTime) {
        finalEndTime = Date.now()
      }
      if (!finalStartTime) {
        finalStartTime = (finalEndTime as number) - totalTime
      }
    }
  }

  return { finalStartTime, finalEndTime }
}

/**
 * 记录扫描初始化信息
 * @param performanceTracker - performance tracker 对象
 */
function logScanInit(performanceTracker: any): void {
  const projectPath =
    Config.sourcePath ||
    (Config.single && Config.maindir ? Config.maindir : null) ||
    Config.maindir ||
    process.cwd()
  const projectName = getProjectName(projectPath)
  const yasaVersion = YASA_VERSION && typeof YASA_VERSION === 'string' ? YASA_VERSION : 'unknown'
  const { finalStartTime } = calculateTimes(performanceTracker)
  const scanStartTime = finalStartTime
    ? new Date(finalStartTime instanceof Date ? finalStartTime.getTime() : finalStartTime).toISOString()
    : new Date().toISOString()
  const language = Config.language || 'unknown'

  logDiagnostics('scan_init', {
    string1: yasaVersion,
    string2: projectName,
    string3: language,
    number1: null,
    number2: null,
    number3: null,
    date1: null,
    date2: null,
  })
}

/**
 * 生成 scan_summary.json 文件
 * @param scanSummary - 扫描摘要 JSON 字符串
 * @param ruleConfigContent - 规则配置 JSON 字符串
 */
function writeScanSummaryJson(scanSummary: string, ruleConfigContent: string): void {
  try {
    const reportDir = getReportDir()
    // 确保目录存在
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true })
    }

    // 解析扫描摘要
    let scanSummaryObj: any = {}
    let ruleConfigObj: any = null

    try {
      scanSummaryObj = JSON.parse(scanSummary)
    } catch (e) {
      // 如果解析失败，使用空对象
      console.error(`Failed to parse scanSummary JSON: ${e}`)
    }

    if (ruleConfigContent) {
      try {
        ruleConfigObj = JSON.parse(ruleConfigContent)
      } catch (e) {
        // 如果解析失败，保持为 null
        console.error(`Failed to parse ruleConfigContent JSON: ${e}`)
      }
    }

    // 合并对象：scanSummary 在前，ruleConfig 在后
    const summaryJson = {
      ...scanSummaryObj,
      ruleConfig: ruleConfigObj,
    }

    // 写入 JSON 文件（格式化，2 空格缩进）
    const summaryFilePath = path.join(reportDir, 'scan_summary.json')
    fs.writeFileSync(summaryFilePath, JSON.stringify(summaryJson, null, 2), 'utf8')
  } catch (error) {
    // 如果生成 JSON 文件失败，记录错误但不影响主流程
    console.error(`Failed to write scan_summary.json: ${error}`)
    if (error instanceof Error) {
      console.error(`Error stack: ${error.stack}`)
    }
  }
}

/**
 * 生成并记录扫描摘要日志
 * @param analyzer - analyzer 对象
 * @param performanceTracker - performance tracker 对象
 * @param startTime - 开始时间（Date 或 number 时间戳）
 * @param endTime - 结束时间（Date 或 number 时间戳）
 */
function logScanSummary(
  analyzer: any,
  performanceTracker: any,
  startTime?: Date | number | null,
  endTime?: Date | number | null
): void {
  // 获取项目路径
  const projectPath =
    analyzer?.options?.sourcePath ||
    analyzer?.options?.sourceFile ||
    Config.sourcePath ||
    (Config.single && Config.maindir ? Config.maindir : null) ||
    Config.maindir ||
    process.cwd()

  const projectName = getProjectName(projectPath)
  const scanSummary = generateScanSummary(analyzer, performanceTracker, startTime, endTime)
  const ruleConfigContent = getRuleConfigContent()
  const { finalStartTime, finalEndTime } = calculateTimes(performanceTracker, startTime, endTime)

  // 解析 scanSummary 获取关键字段
  let yasaVersion = 'unknown'
  let totalTime = 0
  let lineCount = 0
  let findingCount = 0

  try {
    const summaryObj = JSON.parse(scanSummary)
    yasaVersion = summaryObj.yasaVersion || 'unknown'
    totalTime = summaryObj.totalTimeMs || 0
    lineCount = summaryObj.lineCount || 0
    findingCount = summaryObj.findingCount || 0
  } catch (e) {
    // 解析失败时使用默认值
  }

  // 记录到诊断日志（不包含 ruleConfig）
  logDiagnostics('scan_summary', {
    string1: yasaVersion,
    string2: projectName,
    string3: scanSummary,
    number1: totalTime,
    number2: lineCount,
    number3: findingCount,
    date1: finalStartTime || null,
    date2: finalEndTime || null,
  })

  // 生成 scan_summary.json 文件（包含 ruleConfig）
  writeScanSummaryJson(scanSummary, ruleConfigContent)
}

// eslint-disable-next-line import/no-commonjs
module.exports = {
  logDiagnostics,
  logScanSummary,
  logScanInit,
}
