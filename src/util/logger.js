const path = require('path')
const process = require('process')

const log4js = require('log4js')
const config = require('../config')

const defaultLogLevel = config.envMode === 'debug' ? 'debug' : 'info'
let { logLevel } = config
if (!logLevel) {
  logLevel = defaultLogLevel
}

const isConfigAbsolutePath = path.isAbsolute(config.logDir)
const ERROR_PATH = '-error'
const configAbsoluteLogFilePath = config.logDir + ERROR_PATH
const logFilePath = isConfigAbsolutePath ? config.logDir : path.resolve(process.cwd(), config.logDir)
const errorLogFilePath = isConfigAbsolutePath
  ? configAbsoluteLogFilePath
  : path.resolve(process.cwd(), config.logDir + ERROR_PATH)

log4js.configure({
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
    infoFilter: { type: 'logLevelFilter', appender: 'file', level: logLevel, maxLevel: 'warn' },
    errFilter: { type: 'logLevelFilter', appender: 'errorFile', level: 'error' },
  },
  categories: {
    default: { appenders: ['stdoutFilter', 'infoFilter', 'errFilter'], level: logLevel },
    [this.category]: { appenders: ['stdoutFilter', 'infoFilter', 'errFilter'], level: logLevel },
  },
})

module.exports = function (category) {
  this.category = category
  return log4js.getLogger(category || 'default')
}
