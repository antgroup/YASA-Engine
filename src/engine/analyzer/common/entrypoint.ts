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
      loc?: any
    }
    [key: string]: any
  }
  functionName?: string
  filePath?: string
  attribute?: string
  funcReceiverType?: string
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
  }
}

module.exports = EntryPointClass
