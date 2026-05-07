const constant = require('../../../util/constant')

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
  funcReceiverType?: string
  /** 函数定义起始行号，用于精确匹配 overloaded 同名函数 */
  funcLocStart?: number
  /** 函数定义结束行号，用于精确匹配 overloaded 同名函数 */
  funcLocEnd?: number
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
  }
}

module.exports = EntryPointClass
