/**
 * 颜色函数接口
 */
export interface ColorFunctions {
  red: (text: string) => string
  green: (text: string) => string
  yellow: (text: string) => string
  blue: (text: string) => string
  magenta: (text: string) => string
  cyan: (text: string) => string
  white: (text: string) => string
  gray: (text: string) => string
  bold: (text: string) => string
  underline: (text: string) => string
  italic: (text: string) => string
}

/**
 * 检测终端是否支持颜色输出
 * @returns {boolean} 如果支持颜色返回 true，否则返回 false
 */
export function supportsColor(): boolean {
  if (!process.stdout.isTTY) return false
  if (process.env.NO_COLOR) return false
  if (process.env.TERM === 'dumb') return false
  if (process.platform === 'win32') {
    const tty = require('tty')
    return tty.WriteStream.prototype.hasColors && process.stdout.hasColors()
  }
  return true
}

/**
 * 创建颜色函数集合
 * @param enableColor - 是否启用颜色，默认自动检测
 * @returns {ColorFunctions} 颜色函数对象，如果不支持颜色则返回空函数（直接返回原文）
 */
export function createColorFunctions(enableColor: boolean = supportsColor()): ColorFunctions {
  if (!enableColor) {
    const noop = (text: string): string => text
    return {
      red: noop,
      green: noop,
      yellow: noop,
      blue: noop,
      magenta: noop,
      cyan: noop,
      white: noop,
      gray: noop,
      bold: noop,
      underline: noop,
      italic: noop,
    }
  }

  const codes = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    underline: '\x1b[4m',
    italic: '\x1b[3m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
  }

  const colorFns: ColorFunctions = {} as ColorFunctions
  for (const [name, code] of Object.entries(codes)) {
    if (name === 'reset') continue
    colorFns[name as keyof ColorFunctions] = (text: string): string => {
      return `${code}${text}${codes.reset}`
    }
  }

  return colorFns
}

export const color: ColorFunctions = createColorFunctions()

/**
 * 构建 YASA 日志前缀
 * @param stages - 阶段名称数组或点号分隔的层级字符串（如 'preProcess.parseCode'）
 * @returns {string} 格式化的前缀字符串，如 '[YASA]' 或 '[YASA][preProcess][parseCode]'
 */
function buildYasaPrefix(stages?: string | string[]): string {
  let prefix = '[YASA]'
  if (stages) {
    const stageArray =
      typeof stages === 'string' ? stages.split('.').filter((s) => s.length > 0) : stages.filter((s) => s.length > 0)
    if (stageArray.length > 0) {
      const stagePrefixes = stageArray.map((stage) => `[${stage}]`).join('')
      prefix = `[YASA]${stagePrefixes}`
    }
  }
  return prefix
}

/**
 * YASA 日志内部实现
 * @param message - 日志消息
 * @param stages - 阶段名称数组或点号分隔的层级字符串
 * @param level - 日志级别
 * @param colorFn - 颜色函数
 * @param outputStream - 输出流
 */
function yasaLogInternal(
  message: string,
  stages: string | string[] | undefined,
  level: 'info' | 'warn' | 'error',
  colorFn: (text: string) => string,
  outputStream: NodeJS.WriteStream
): void {
  const prefix = buildYasaPrefix(stages)
  const plainMessage = `${prefix} ${message}`
  const coloredMessage = `${colorFn(prefix)} ${message}`

  const getLogger = require('./logger')
  const logger = getLogger('console')
  logger[level](plainMessage)

  outputStream.write(`${coloredMessage}\n`)
}

/**
 * YASA 日志输出函数
 * @param message - 日志消息
 * @param stages - 阶段名称数组或点号分隔的层级字符串（如 'preProcess.parseCode'）
 */
export function yasaLog(message: string, stages?: string | string[]): void {
  yasaLogInternal(message, stages, 'info', color.gray, process.stdout)
}

/**
 * YASA 错误输出函数
 * @param message - 错误消息
 * @param stages - 阶段名称数组或点号分隔的层级字符串（如 'preProcess.parseCode'）
 */
export function yasaError(message: string, stages?: string | string[]): void {
  yasaLogInternal(message, stages, 'error', color.red, process.stderr)
}

/**
 * YASA 警告输出函数
 * @param message - 警告消息
 * @param stages - 阶段名称数组或点号分隔的层级字符串（如 'preProcess.parseCode'）
 */
export function yasaWarning(message: string, stages?: string | string[]): void {
  yasaLogInternal(message, stages, 'warn', color.yellow, process.stderr)
}

/**
 * 生成居中的分隔线（总长度64字符，文字居中，== 和文字间隔2个空格）
 * @param text - 要居中的文字，如果为空字符串则返回64个等号
 * @returns {string} 格式化的分隔线字符串（默认加粗显示）
 */
export function formatSeparator(text: string): string {
  const totalLength = 64
  const spaceAround = 2

  if (!text || text.length === 0) {
    const separator = '='.repeat(totalLength)
    return color.bold(color.gray(`${separator}\n`))
  }

  const fixedLength = text.length + spaceAround * 2
  const remaining = totalLength - fixedLength
  const left = Math.ceil(remaining / 2)
  const right = remaining - left
  const separator = `${'='.repeat(left)}  ${text}  ${'='.repeat(right)}`
  return color.bold(color.gray(`\n${separator}`))
}

/**
 * YASA 分隔线输出函数（直接输出到控制台）
 * @param text - 要居中的文字，如果为空字符串则输出64个等号
 */
export function yasaSeparator(text: string): void {
  console.log(formatSeparator(text))
}
