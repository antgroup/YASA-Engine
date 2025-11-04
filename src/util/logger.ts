const path = require('path')
const process = require('process')

const log4jsLogger = require('log4js')
const configLogger = require('../config')

interface Logger {
  trace(...args: any[]): void
  debug(...args: any[]): void
  info(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
  fatal(...args: any[]): void
  isTraceEnabled(): boolean
  isDebugEnabled(): boolean
  isInfoEnabled(): boolean
  isWarnEnabled(): boolean
  isErrorEnabled(): boolean
  isFatalEnabled(): boolean
}

const defaultLogLevel = configLogger.envMode === 'debug' ? 'debug' : 'info'
let { logLevel } = configLogger
if (!logLevel) {
  logLevel = defaultLogLevel
}

const isConfigAbsolutePath = path.isAbsolute(configLogger.logDir)
const ERROR_PATH = '-error'
const configAbsoluteLogFilePath = configLogger.logDir + ERROR_PATH
const logFilePath = isConfigAbsolutePath ? configLogger.logDir : path.resolve(process.cwd(), configLogger.logDir)
const errorLogFilePath = isConfigAbsolutePath
  ? configAbsoluteLogFilePath
  : path.resolve(process.cwd(), configLogger.logDir + ERROR_PATH)

log4jsLogger.configure({
  replaceConsole: true,
  pm2: true,
  appenders: {
    stdout: {
      type: 'stdout',
      layout: { type: 'messagePassThrough' },
    },
    file: {
      type: 'dateFile',
      filename: logFilePath,
      pattern: 'yyyy-MM-dd.log',
      alwaysIncludePattern: true,
      layout: {
        type: 'pattern',
        pattern: '%d{yyyy-MM-dd hh:mm:ss.SSS} %p %c %m',
        timezone: 'Asia/Shanghai',
      },
      compress: true,
    },
    errorFile: {
      type: 'dateFile',
      filename: errorLogFilePath,
      pattern: 'yyyy-MM-dd.log',
      alwaysIncludePattern: true,
      layout: {
        type: 'pattern',
        pattern: '%d{yyyy-MM-dd hh:mm:ss.SSS} %p %c %m',
        timezone: 'Asia/Shanghai',
      },
      compress: true,
    },
    stdoutFilter: { type: 'logLevelFilter', appender: 'stdout', level: logLevel, maxLevel: 'warn' },
    clientStdoutFilter: { type: 'logLevelFilter', appender: 'stdout', level: 'error', maxLevel: 'error' },
    infoFilter: { type: 'logLevelFilter', appender: 'file', level: logLevel, maxLevel: 'warn' },
    errFilter: { type: 'logLevelFilter', appender: 'errorFile', level: 'error' },
  },
  categories: {
    default: { appenders: ['stdoutFilter', 'infoFilter', 'errFilter'], level: logLevel },
  },
})

module.exports = function (category: string): Logger {
  return log4jsLogger.getLogger(category || 'default')
}
