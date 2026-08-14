const constant = require('../../../../util/constant')

/**
 * 入口点规则配置的跨语言通用字段
 */
export interface EntryPointRuleConfig {
  functionName?: string
  filePath?: string
  attribute?: string
  /** 函数定义起始行号，用于精确匹配 overloaded 同名函数 */
  funcLocStart?: number
  /** 函数定义结束行号，用于精确匹配 overloaded 同名函数 */
  funcLocEnd?: number
}

export interface AstSourceLocation {
  start?: { line?: number }
  end?: { line?: number }
}

/**
 * EntryPoint接口 - 描述入口点的类型结构
 */
export interface EntryPoint {
  type?: string
  scopeVal?: any
  argValues?: any[]
  entryPointSymVal?: {
    ast?: {
      node?: {
        loc?: any
      }
    }
    [key: string]: any
  }
  functionName?: string
  filePath?: string
  attribute?: string
  framework?: string
  funcReceiverType?: string
  /** 函数定义起始行号，用于精确匹配 overloaded 同名函数 */
  funcLocStart?: number
  /** 函数定义结束行号，用于精确匹配 overloaded 同名函数 */
  funcLocEnd?: number
  /** 入口点执行时跳过装饰器，直接执行原始方法体。
   *  适用于 Tornado handler 等场景：自定义装饰器（如 @error_catch）包裹方法后，
   *  引擎执行 wrapper 而非原始方法体，导致 self.request.body 等 source 从未触发。
   */
  skipDecorators?: boolean
  [key: string]: any
}

/**
 * EntryPoint类 - 用于创建入口点实例
 */
class EntryPointClass implements EntryPoint {
  type: string

  scopeVal: any

  argValues: any[]

  entryPointSymVal: any

  functionName: string

  filePath: string

  attribute: string

  funcReceiverType: string

  /** 函数定义起始行号，用于精确匹配 overloaded 同名函数 */
  funcLocStart: number | undefined

  /** 函数定义结束行号，用于精确匹配 overloaded 同名函数 */
  funcLocEnd: number | undefined

  /** 入口点执行时跳过装饰器，直接执行原始方法体 */
  skipDecorators: boolean | undefined

  /**
   *
   * @param type
   */
  constructor(type?: string) {
    this.type = type || constant.ENGIN_START_FILE_BEGIN
    this.scopeVal = {}
    this.argValues = []
    this.entryPointSymVal = {}
    this.functionName = ''
    this.filePath = ''
    this.attribute = ''
    this.funcReceiverType = ''
    this.funcLocStart = undefined
    this.funcLocEnd = undefined
    this.skipDecorators = undefined
  }
}

module.exports = EntryPointClass
