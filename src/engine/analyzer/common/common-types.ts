/**
 * 通用类型定义文件
 * 集中管理项目中共享的TypeScript类型定义
 */

/**
 * 打印函数类型
 */
export type PrintFunction = (...args: any[]) => void

/**
 * 响应对象接口
 */
export interface ResponseObject {
  body: string
}

/**
 * 通用Finding接口 - 用于checker输出结果
 */
export interface Finding {
  output?: string
  [key: string]: any
}

/**
 * 污点分析Finding接口 - 用于taint flow checker输出结果
 */
export interface TaintFinding {
  type?: string
  subtype?: string
  issue?: string
  desc?: string
  sourcefile?: string
  node?: any
  argNode?: any
  sinkRule?: string
  sinkAttribute?: string
  entrypoint?: any
  sinkInfo?: any
  format?: any
  line?: number
  trace?: any[]
  severity?: number
  matchedSanitizerTags?: any
  issuecause?: string
  entry_fclos?: any
  [key: string]: any
}
