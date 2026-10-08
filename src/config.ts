type CallSummaryStrategy = 'skip-only' | 'bypass' | 'return-clone' | 'summary-replay'

type CallSummaryStageStrategies = {
  processModule?: CallSummaryStrategy
  symbolInterpret?: CallSummaryStrategy
  unknown?: CallSummaryStrategy
}

/**
 * Config接口 - 定义YASA配置对象的结构
 */
export type IncrementalMode = 'baseline' | 'auto' | 'full-on-fallback' | 'ep-only'

export interface IncrementalRuntimeConfig {
  cacheDir?: string
  diffFile?: string
  mode: IncrementalMode
  impactEntrypointFile?: string
}

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
  incremental?: string | boolean // AST 缓存增量模式 (true|false|force)
  incrementalCache?: string
  incrementalDiff?: string
  incrementalMode?: IncrementalMode
  impactEntrypointFile?: string
  incrementalRuntime?: IncrementalRuntimeConfig

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
  saveContextEnvironment?: boolean
  miniSaveContextEnvironment?: boolean
  loadContextEnvironment?: boolean
  contextEnvironmentDir?: string
  pythonProcessModuleSkipEarlyCallgraphRecord?: boolean
  minEntryPointToEnablePrune?: number
  entryPointTimeoutMs?: number
  entryPointTimeoutQuickMs?: number
  maxCallstackDepth?: number
  enableCoarseTaintPropagation?: boolean
  scanTimeoutMs?: number
  // 单入口内存护栏：超阈值提前 stop 当前入口，flush 已分析入口 finding，跳下一入口
  entrypointMemoryGuard?: boolean
  // @deprecated 单入口堆使用上限（MB），绝对模式阈值。delta 模式下沉后全语言不再使用，字段保留兼容
  entrypointMemoryLimitMB?: number
  // 单入口 heap growth delta 上限（MB），delta 模式阈值，超过即触发护栏 abort 当前入口。
  // delta 模式只看本入口增长，不受前序入口累积影响，比绝对模式更公平。默认 2048（2GB）。
  // 高 baseline 项目（如多 controller builder pattern 项目）需调小至 1024MB，避免 baseline 累积后 delta 允许堆涨到 V8 上限才触发。
  entrypointMemoryLimitDeltaMB?: number
  // Go delta 模式 alias：优先读 Go 专用环境变量，fallback 到 entrypointMemoryLimitDeltaMB
  goEntrypointMemoryLimitDeltaMB?: number
  single?: boolean
  maindir?: string
  configFilePath?: string
  FlowConfig?: {
    source?: string[]
    sourcefiles?: Record<string, number>
    sink?: string[]
    sinkfiles?: Record<string, number>
  }
  enablePerformanceLogging?: boolean
  invokeCallbackOnUnknownFunction?: number
  maxIterationTime?: number
  // 方法体内 builtin 循环迭代预算上限，超过则提前 break，防止 stream pipeline 路径爆炸耗尽 timeout
  maxMethodBodyInstructionLimit?: number
  // 每次 builtin 回调迭代的预算消耗
  builtinIterationCost?: number
  shareSourceLineSet?: boolean
  workerCount?: number // Worker数量：0表示自动计算，>0表示使用设置的worker数量

  // Analysis
  stateUnionLevel?: number
  callSummaryStageStrategies?: CallSummaryStageStrategies

  // Report
  i18n?: string
  format?: string
  dumpCG?: boolean
  dumpAllCG?: boolean
  dumpEntrypoint?: boolean
  needBenchmarkJson?: boolean

  // Rules
  loadDefaultRule?: boolean
  loadExternalRule?: boolean
  ruleConfigFile?: string
  checkerIds?: string[]
  checkerPackIds?: string[]
  entryPointAndSourceAtSameTime?: boolean
  entryPointMode?: string
  cgAlgo: string
  taintTraceOutputStrategy?: string

  dataflowDb?: boolean
  dataflowDbMode?: 'full' | 'incremental-facts'
  enableLibCallDiagnostics?: boolean
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
  intermediateDir: '', // 增量扫描缓存目录路径（默认使用 reportDir/ast-output）
  incremental: false, // AST 缓存增量模式（默认禁用，需要显式配置）
  incrementalCache: '',
  incrementalDiff: '',
  incrementalMode: 'auto',
  impactEntrypointFile: '',
  incrementalRuntime: undefined,
  saveContextEnvironment: false, // 保存上下文缓存模式
  miniSaveContextEnvironment: false, // 极简保存上下文缓存模式
  loadContextEnvironment: false, // 加载上下文缓存模式
  contextEnvironmentDir: '', // 上下文缓存文件目录

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

  // 方法体内 builtin 循环迭代预算上限（每次 builtin 回调累加 builtinIterationCost，超过即停止迭代）
  maxMethodBodyInstructionLimit: 3000,
  // 每次 builtin 回调迭代的预算消耗
  builtinIterationCost: 500,

  // multiple objects with the same source may share the same source line trace
  shareSourceLineSet: false,

  // Worker数量：0表示自动计算，>0表示使用设置的worker数量
  workerCount: 1,

  //* *****************************  analysis  ***************************

  stateUnionLevel: 2,

  //* *****************************  report  ***************************
  i18n: 'ch', // ch | en
  format: 'sarif', // sarif | json | plaintext | html
  dumpCG: false,
  dumpEntrypoint: false,
  needBenchmarkJson: true,
  //* ***************************** rules *****************
  loadDefaultRule: true,
  loadExternalRule: true,
  ruleConfigFile: '',
  checkerIds: [],
  checkerPackIds: [],
  entryPointAndSourceAtSameTime: true,
  entryPointMode: 'BOTH', // BOTH or ONLY_CUSTOM or SELF_COLLECT

  // Taint trace output strategy: 'full' | 'callstack-only' (legacy alias: 'folded')
  taintTraceOutputStrategy: 'callstack-only',

  dataflowDb: false,
  dataflowDbMode: 'incremental-facts',
  enableLibCallDiagnostics: false,

  // CallGraph
  cgAlgo: 'DEFAULT',

  // 通用 call summary 策略配置：默认跳过预处理重复调用，解释与未知阶段保持透传。
  callSummaryStageStrategies: {
    processModule: 'skip-only',
    symbolInterpret: 'bypass',
    unknown: 'bypass',
  },
  // Python processModule 优化默认关闭，避免改变发布模式 callgraph 行为。
  pythonProcessModuleSkipEarlyCallgraphRecord: false,

  // Pruning
  minEntryPointToEnablePrune: 200,

  // Timeout
  entryPointTimeoutMs: 600000, // 重跑时每个入口点的超时上限（10 分钟）
  entryPointTimeoutQuickMs: 120000, // 首遍每个入口点的超时（2 分钟）
  scanTimeoutMs: 28800000, // 全局扫描超时预算（8 小时），超时 entrypoint 重跑的时间来源

  // Memory guard: 单入口堆超阈提前 stop，flush 已分析入口 finding，跳下一入口（零污染，不改 clone）
  entrypointMemoryGuard: true,
  // @deprecated 绝对模式阈值，delta 模式下沉后全语言不再使用；字段保留兼容旧 override
  entrypointMemoryLimitMB: Number(process.env.YASA_EP_MEM_LIMIT_MB) || 10240,
  // delta 模式阈值：per-entrypoint heap growth delta 上限（MB），YASA_EP_MEM_LIMIT_DELTA_MB 环境变量可配置
  entrypointMemoryLimitDeltaMB: Number(process.env.YASA_EP_MEM_LIMIT_DELTA_MB) || 2048,
  // Go delta 模式 alias：优先读 Go 专用环境变量，fallback 到通用 delta 阈值
  goEntrypointMemoryLimitDeltaMB:
    Number(process.env.YASA_GO_EP_MEM_LIMIT_DELTA_MB) ||
    Number(process.env.YASA_EP_MEM_LIMIT_DELTA_MB) ||
    2048,

  // Prune parameters for aggressive prune mode
  maxCallstackDepth: 12, // max callstack depth in aggressive prune mode

  // 粗粒度污点传播：参数或 receiver 含 taint 时跳过方法体执行，改用 ARG/THIS→RET 传播；
  // 无 taint 且 sink 不可达时裁剪。既省性能又防漏报。
  enableCoarseTaintPropagation: process.env.YASA_ENABLE_COARSE_TAINT_PROPAGATION !== 'false',
}

module.exports = configObject
