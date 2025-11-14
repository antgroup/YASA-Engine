/**
 * Config接口 - 定义YASA配置对象的结构
 */
export interface IConfig {
  // General
  YASA_MEMORY?: number
  envMode?: string
  fpRate?: string
  error_tolerance_factor?: number

  // AST Dump
  dumpAST?: boolean
  dumpAllAST?: boolean
  intermediateDir?: string // 中间文件缓存目录路径
  incremental?: string | boolean // 增量分析模式 (true|false|force)

  // Paths
  ASTFileOutput?: string
  reportDir?: string
  logDir?: string
  maindirPrefix?: string
  prefixPath?: string

  // Parsing
  language?: string
  analyzer?: string
  uastSDKPath?: string

  // Subject
  ignoredDirs?: string[]

  // Runtime
  invokeCallbackOnUnknownFunction?: number
  maxIterationTime?: number
  shareSourceLineSet?: boolean

  // Analysis
  stateUnionLevel?: number

  // Report
  i18n?: string
  format?: string
  dumpCG?: boolean
  dumpAllCG?: boolean
  needBenchmarkJson?: boolean

  // Rules
  loadDefaultRule?: boolean
  loadExternalRule?: boolean
  ruleConfigFile?: string
  checkerIds?: string[]
  checkerPackIds?: string[]
  entryPointAndSourceAtSameTime?: boolean
  entryPointMode?: string

  // Allow additional properties
  [key: string]: any
}

const configObject: IConfig = {
  //* *****************************  general ***************************
  YASA_MEMORY: 8192,
  envMode: 'debug', // debug|release
  fpRate: 'low', // false positive rate
  error_tolerance_factor: 5, // 0-10, the higher number means greater tolerance (0 for no tolerance, default is 5)

  //* ***************************** only dumpAST ***************************

  dumpAST: false, // dump ast to json format
  dumpAllAST: false, // dump all ast to json format
  intermediateDir: '', // 中间文件缓存目录路径（默认使用 reportDir/ast-output）
  incremental: false, // 增量分析模式（默认禁用，需要显式配置）

  //* *****************************  path and so on ***************************

  // output directory for trigger_lib files
  ASTFileOutput: '',
  reportDir: './report/',

  // log configuration
  logDir: './logs/yasa',
  // logLevel: 'info',

  //* *****************************  parsing *********************************
  // javascript | golang | java | python
  language: '',
  // EggAnalyzer | JavaScriptAnalyzer | JavaAnalyzer | SpringAnalyzer | GoAnalyzer | PythonAnalyzer
  analyzer: '',
  uastSDKPath: '',
  //* *****************************  subject  *********************************

  // ignored directories
  ignoredDirs: ['.git', 'libraries'],

  //* *****************************  runtime  *********************************
  // invoke the call-back functions if they appear in the arguments of a unknown function call
  // 0: don't invoke  1: invoke with ACL 2: always invoke
  invokeCallbackOnUnknownFunction: 1,

  // maximum execution time (in milliseconds) for a function-based iteration
  maxIterationTime: 4001,

  // multiple objects with the same source may share the same source line trace
  shareSourceLineSet: false,

  //* *****************************  analysis  ***************************

  stateUnionLevel: 2,

  //* *****************************  report  ***************************
  i18n: 'ch', // ch | en
  format: 'sarif', // sarif | json | plaintext | html
  dumpCG: false,
  needBenchmarkJson: true,
  //* ***************************** rules *****************
  loadDefaultRule: true,
  loadExternalRule: true,
  ruleConfigFile: '',
  checkerIds: [],
  checkerPackIds: [],
  entryPointAndSourceAtSameTime: true,
  entryPointMode: 'BOTH', // BOTH or ONLY_CUSTOM or SELF_COLLECT
}

module.exports = configObject
