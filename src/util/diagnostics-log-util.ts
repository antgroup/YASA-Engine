import fs from 'fs'
import path from 'path'
const Config = require('../config')

// 保持文件句柄打开，避免频繁开关影响性能
let logFileDescriptor: number | null = null
let currentReportDir: string | null = null // 记录当前使用的 reportDir

// 获取日志文件路径（从 Config.reportDir 动态获取）
function getLogFilePath(): string {
  // 从 Config 获取 reportDir，如果不存在或为空，使用默认值
  let reportDir = Config.reportDir || './report/'
  
  // 如果是相对路径，转换为绝对路径
  if (!path.isAbsolute(reportDir)) {
    reportDir = path.resolve(process.cwd(), reportDir)
  }
  
  return path.join(reportDir, 'yasa-diagnostics-log.txt')
}

// 确保文件句柄打开
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
  return logFileDescriptor
}

/**
 * 关闭日志文件句柄
 * 在进程退出时调用，确保文件句柄被正确关闭
 */
function closeLogFile(): void {
  if (logFileDescriptor !== null) {
    try {
      fs.closeSync(logFileDescriptor)
      logFileDescriptor = null
    } catch (error) {
      // 忽略关闭时的错误
    }
  }
}

/**
 * 注册进程退出处理器，确保文件句柄被正确关闭
 * 
 * 注意：在进程正常退出、接收到 SIGINT（Ctrl+C）或 SIGTERM 信号时，
 * 都会调用 closeLogFile 确保文件句柄被正确关闭，避免资源泄漏。
 */
// 进程退出时关闭文件句柄
process.on('exit', () => {
  closeLogFile()
})

// 进程异常退出时也关闭文件句柄（SIGINT：Ctrl+C）
process.on('SIGINT', () => {
  closeLogFile()
  process.exit(0)
})

// 进程终止时也关闭文件句柄（SIGTERM：kill 命令发送的终止信号）
process.on('SIGTERM', () => {
  closeLogFile()
  process.exit(0)
})

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

  // 格式化当前时间为 yyyy-mm-dd hh:mm:ss
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

  // 处理 date1：如果传入 Date，格式化；如果传入 null，使用 null；如果未传，使用 null
  let date1: string | null
  if (options && 'date1' in options && options.date1 !== null && options.date1 !== undefined) {
    date1 = formatDateTime(options.date1)
  } else {
    date1 = null
  }

  // 处理 date2：如果传入 Date，格式化；如果传入 null，使用 null；如果未传，使用 null
  let date2: string | null
  if (options && 'date2' in options && options.date2 !== null && options.date2 !== undefined) {
    date2 = formatDateTime(options.date2)
  } else {
    date2 = null
  }

  // 记录当前时间作为 log_time
  const log_time = formatDateTime(new Date())

  // 构建日志对象
  const logEntry = {
    log_key,
    log_time,
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
  const logLine = JSON.stringify(logEntry) + '\n'

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
    try {
      const fd = ensureFileOpen()
      fs.writeSync(fd, logLine)
      fs.fsyncSync(fd)
    } catch (retryError) {
      throw retryError
    }
  }
}

module.exports = {
  logDiagnostics,
}
