/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, import/no-commonjs, @typescript-eslint/no-use-before-define */

import v8 from 'v8'
import { yasaLog, yasaSeparator } from "../util/format-util"
import { printMemorial } from '../util/memorial'

const fs = require('fs-extra')
const path = require('path')
// eslint-disable-next-line @typescript-eslint/naming-convention
const _ = require('lodash')
const { Command } = require('commander')
const Config = require('../config')
const Parser = require('../engine/parser/parser')
const Stat = require('../util/statistics')
const logger = require('../util/logger')(__filename)
const FileUtil = require('../util/file-util')
const { ErrorCode, Errors, setExitCode } = require('../util/error-code')
const FrameworkUtil = require('../util/framework-util')
const { handleException } = require('../engine/analyzer/common/exception-handler')
const OutputStrategyAutoRegister = require('../engine/analyzer/common/output-strategy-auto-register')
const { yasaWarning } = require('../util/format-util')
const { logScanSummary, logScanInit } = require('../util/diagnostics-log-util')
const { performanceTracker } = require('../util/performance-tracker')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { YASA_VERSION } = require('../util/constant')
type IncrementalManagerModule = typeof import('../incremental/incremental-manager')

function loadIncrementalManager(): IncrementalManagerModule {
  return require('../incremental/incremental-manager') as IncrementalManagerModule
}

function validateIncrementalModeLazy(mode: string | undefined): import('../config').IncrementalMode {
  return loadIncrementalManager().validateIncrementalMode(mode)
}

const CALL_SUMMARY_MODES = ['off', 'only-preprocess', 'on'] as const

type CallSummaryMode = (typeof CALL_SUMMARY_MODES)[number]
type CallSummaryStageStrategy = 'bypass' | 'skip-only'
type CallSummaryStageName = 'processModule' | 'symbolInterpret'
type CallSummaryStageStrategies = Partial<Record<CallSummaryStageName, CallSummaryStageStrategy>>

type DataflowDbMode = 'full' | 'incremental-facts'

const DATAFLOW_INTERNAL_OPTION_NAMES = [
  '--dataflowLruDiag',
  '--dataflowEpCacheClear',
  '--dataflowEpEdgeDedupClear',
  '--dataflowPruneDeadSlots',
] as const

const CLI_HELP_COMMON_EXAMPLE = [
  'yasa2 --sourcePath <项目目录> \\',
  '  --checkerPackIds <规则包> \\',
  '  --language <语言> \\',
  '  --ruleConfigFile <规则配置.json> \\',
  '  --report <输出目录> \\',
  '  [--analyzer <分析器>] \\',
  '  [--entrypointMode ONLY_CUSTOM] \\',
  '  [--workerCount 0]',
].join('\n')

function getDataflowInternalOptionNames(): readonly string[] {
  return DATAFLOW_INTERNAL_OPTION_NAMES
}

function configureCliHelp(program: typeof Command.prototype): void {
  program
    .name('yasa2')
    .usage('')
}

function normalizeHelpText(helpText: string): string {
  return `常用示例:\n${CLI_HELP_COMMON_EXAMPLE}\n\n${helpText.replace(/^Usage:.*\n\n/, '')}`
}

function resetDataflowCliConfig(): void {
  Config.dataflowDb = false
  Config.dataflowDbMode = 'incremental-facts'
}

function isCallSummaryMode(value: string): value is CallSummaryMode {
  return CALL_SUMMARY_MODES.includes(value as CallSummaryMode)
}

function parseCallSummaryMode(mode: string): CallSummaryStageStrategies | undefined {
  // 命令行模式只改会话策略，保证预处理和解释阶段共享同一套边界语义。
  if (!isCallSummaryMode(mode)) return undefined
  if (mode === 'off') return { processModule: 'bypass', symbolInterpret: 'bypass' }
  if (mode === 'only-preprocess') return { processModule: 'skip-only', symbolInterpret: 'bypass' }
  return { processModule: 'skip-only', symbolInterpret: 'skip-only' }
}

function applyCallSummaryStrategies(strategies: CallSummaryStageStrategies): void {
  Config.callSummaryStageStrategies = {
    ...(Config.callSummaryStageStrategies || {}),
    ...strategies,
  }
}

function displayMainFile(mainFile: string | undefined): string {
  if (!mainFile) return 'unknown'
  const normalized = mainFile.replace(/\\/g, '/')
  if (normalized.includes('/snapshot/')) return '/snapshot/yasa/dist/main.js'
  return mainFile
}

function isDataflowDbMode(mode: string): mode is DataflowDbMode {
  return mode === 'full' || mode === 'incremental-facts'
}

/**
 * the main entry point of the usual scan
 * @param {any} dir - Source directory or file path
 * @param {any[]} args - Command line arguments (default: [])
 * @param {any} printf - Print function for output (optional)
 * @returns {Promise<any>} Analyzer results or undefined
 */
async function execute(dir: any, args: any[] = [], printf?: any) {
  // 启动 banner：版本 / heap 限制 / 主入口，放在 Begin execution 之前
  yasaSeparator('Yet Another Static Analyzer (YASA)')
  const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)
  console.log(`Version   : ${YASA_VERSION}`)
  console.log(`Heap size : ${heapLimitMb} MB`)
  console.log(`main file : ${displayMainFile(require.main?.filename)}`)
  yasaSeparator('')

  // 记录整个程序开始时间（端到端时间）
  performanceTracker.start()
  let result: any

  // 为了保证兼容性，目前 analyzer 只有 yasa analyzer 和 null 两种
  const analyzer = await initAnalyzer(dir, args, printf)

  if (Config.incrementalRuntime?.cacheDir) {
    const { tryCompleteIncrementalConsumerRun } = loadIncrementalManager()
    const incrementalConsumerResult = tryCompleteIncrementalConsumerRun(Config.incrementalRuntime, Config.maindir, Config.reportDir)
    if (incrementalConsumerResult.completed) {
      performanceTracker.outputPerformanceReport()
      return result
    }
  }

  if (analyzer) {
    // dataflow 显式模式才加载统计模块；默认全量扫描不加载 SQLite/数据流统计模块。
    if (Config.dataflowDb && Config.reportDir) {
      const dfStats = require('../engine/analyzer/common/dataflow-edge-stats')
      dfStats.enableDataflowDb({
        mode: Config.dataflowDbMode,
      })
      dfStats.initSqlite(Config.reportDir, Config.maindirPrefix)
    }
    const processingDir = Config.maindir
    const exitCode = await executeAnalyzer(analyzer, processingDir)
    setExitCode(exitCode)
    if (exitCode === 0) {
      try {
        result = await outputAnalyzerResult(analyzer, printf)
        if (Config.incrementalRuntime?.cacheDir) {
          const { completeIncrementalRun } = loadIncrementalManager()
          completeIncrementalRun(Config.incrementalRuntime, Config.maindir, Config.reportDir, typeof analyzer.getEntryPointMetrics === 'function' ? analyzer.getEntryPointMetrics() : [])
          performanceTracker.collectAnalysisData(analyzer)
        }
      } catch (e: any) {
        const detail = e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
        handleException(e, `Error occurred in outputAnalyzerResult: ${detail}`, `Error occurred in outputAnalyzerResult`)
        setExitCode(ErrorCode.fail_to_generate_report)
      }
    }
  }

  // 输出性能报告（如果执行过 collectAnalysisData(analyzer) 则输出 overview，否则只输出 summary）
  performanceTracker.outputPerformanceReport()

  if (analyzer) {
    logScanSummary(analyzer, performanceTracker)
  }

  return result
}

/**
 * output all the findings of all registered checker
 * @param {any} analyzer - The analyzer instance
 * @param {any} printf - Print function for output
 * @returns {any} All findings or null
 */

function writeDataflowSourceFiles(sourcePath: string | undefined): void {
  if (!sourcePath) return
  try {
    if (fs.statSync(sourcePath).isFile()) return
    const { recordSourceFiles } = require('../engine/analyzer/common/dataflow-edge-stats')
    const { collectProjectSourceFiles } = require('../dataflow/source-files')
    recordSourceFiles(collectProjectSourceFiles(sourcePath))
  } catch (error) {
    logger.warn(`Failed to record source files for dataflow.db: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function outputAnalyzerResult(analyzer: any, printf: any) {
  if (!printf || typeof printf !== 'function') {
    printf = logger.info.bind(logger)
  }
  let allFindings = null
  const { resultManager } = analyzer.getCheckerManager()
  if (resultManager && Config.reportDir) {
    const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
    outputStrategyAutoRegister.autoRegisterAllStrategies()
    allFindings = resultManager.getFindings()
    const { yasaSeparator } = require('../util/format-util')
    yasaSeparator('outputFindings')
    for (const outputStrategyId in allFindings) {
      const strategy = outputStrategyAutoRegister.getStrategy(outputStrategyId)
      if (strategy && typeof strategy.outputFindings === 'function') {
        const strategyStartedAt = Date.now()
        const strategyFindings = allFindings[outputStrategyId]
        const rawFindingCount = Array.isArray(strategyFindings) ? strategyFindings.length : 0
        strategy.outputFindings(resultManager, strategy.getOutputFilePath(), Config, printf)
        logger.info(`[outputFindings] strategy=${outputStrategyId} phase=total raw=${rawFindingCount} elapsed=${Date.now() - strategyStartedAt}ms`)
      }
    }
    if (Object.keys(allFindings).length === 0) {
      const taintStrategy = outputStrategyAutoRegister.getStrategy('taintflow')
      if (taintStrategy && typeof taintStrategy.outputFindings === 'function') {
        taintStrategy.outputFindings(resultManager, taintStrategy.getOutputFilePath(), Config, printf)
      }
    }
    yasaSeparator('')
  }
  logger.info('analyze done')
  if (Config.dataflowDb) {
    const { SQLITE_ENABLED, getSqliteStats, closeSqlite } = require('../engine/analyzer/common/dataflow-edge-stats')

    // SQLite 数据流图统计 + 源文件写入
    if (SQLITE_ENABLED) {
      try {
        const stats = getSqliteStats()
        if (stats) {
          const buildCost = stats.insertNodeTimeMs + stats.insertEdgeTimeMs
          yasaLog(
            `DB built: ${stats.nodes} nodes, ${stats.edges} edges, mode ${stats.dbMode}, cost ${buildCost}ms (insert ${stats.insertNodeCount}n/${stats.insertEdgeCount}e, filtered ${stats.selfEdgeFiltered}self/${stats.edgeDedupFiltered}dup, ${stats.incrementalEdgeSkipped} inc-skip)`,
            'dataflowDb'
          )
          // Lazy slot_bind 统计来自 unit-audit.ts
          try {
            const { getLazySlotStats } = require('../engine/analyzer/common/value/unit-audit')
            const ls = getLazySlotStats()
            if (ls && (ls.buffered > 0 || ls.flushed > 0)) {
              yasaLog(
                `slot_bind: ${ls.buffered.toLocaleString()} buffered / ${ls.flushed.toLocaleString()} flushed / ${ls.discarded.toLocaleString()} discarded`,
                'dataflowDb'
              )
            }
          } catch (_e) { /* 忽略 */ }
        }

        writeDataflowSourceFiles(Config.maindir)
      } finally {
        closeSqlite()
      }
    }
  }

  return allFindings
}

/**
 * Initialize the analyzer with command line arguments
 * @param {any} dir - Source directory or file path
 * @param {any[]} args - Command line arguments (default: [])
 * @param {any} printf - Print function for output (optional, unused, kept for compatibility)
 * @returns {Promise<any>} Analyzer instance
 * @note High complexity function - refactoring deferred per user request
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars, complexity
async function initAnalyzer(dir: any, args: any[] = [], printf?: any) {
  let sourcePath: any
  if (dir) {
    sourcePath = dir
  }
  // 标记初始化是否遇到致命错误
  let initError = false
  // 标记是否显式设置了 --intermediate-dir
  let intermediateDirExplicitlySet = false
  // 标记是否显式设置了 --context-environment-dir
  let contextEnvironmentDirExplicitlySet = false

  // load the basic configuration from e.g. 'config.json'
  resetDataflowCliConfig()
  loadConfig(Config.configFilePath)
  const program = new Command()
  let reportPath = ''
  configureCliHelp(program)
  // 定义命令行选项
  program
    .optionsGroup('常用扫描')
    .option('--sourcePath <dir>', '指定源代码目录（支持文件或目录）', (d: any) => {
      try {
        if (!fs.existsSync(d)) {
          handleException(null, `Error !! no such file or directory: ${d}`, `Error !! no such file or directory: ${d}`)
          initError = true
          setExitCode(ErrorCode.config_error)
          return
        }
        const stats = fs.statSync(d)
        if (stats.isFile()) {
          Config.single = true
        }
        sourcePath = d
      } catch (err: any) {
        handleException(
          err,
          'ERROR: an error occurred while reading source path',
          'ERROR: an error occurred while reading source path'
        )
        initError = true
        setExitCode(ErrorCode.config_error)
      }
    })
    .option('--language <lang>', '指定语言（支持: javascript/typescript/golang/python/java）', (lang: any) => {
      const supported = ['javascript', 'typescript', 'js', 'ts', 'go', 'golang', 'python', 'java', 'php']
      if (!supported.includes(lang)) {
        handleException(
          null,
          'Unknown language!! Only support javascript/typescript/golang/python/java/php',
          'Unknown language!! Only support javascript/typescript/golang/python/java/php'
        )
        initError = true
        setExitCode(ErrorCode.config_error)
        return
      }
      if (['typescript', 'ts', 'js', 'javascript'].includes(lang)) {
        lang = 'javascript'
      }
      if (['golang', 'go'].includes(lang)) {
        lang = 'golang'
      }
      Config.language = lang
    })
    .option('--analyzer <analyzer>', '指定框架', (f: any) => {
      Config.analyzer = f
    })
    .option('--single', '单文件模式', () => {
      Config.single = true
    })
    .option('--report <dir>', '指定报告输出目录或文件', (rdir: any) => {
      reportPath = rdir
    })
    .option('--ruleConfigFile <file>', '指定规则配置文件', (file: any) => {
      const ruleConfigFile = path.isAbsolute(file) ? file : path.resolve(path.join(process.cwd(), file))
      Config.ruleConfigFile = ruleConfigFile
      yasaLog(`Using rule config file: ${ruleConfigFile}`, 'init')
    })
    .option('--entrypointMode <mode>', '指定入口点模式（BOTH/SELF_COLLECT/ONLY_CUSTOM）', (mode: any) => {
      const validModes = ['BOTH', 'SELF_COLLECT', 'ONLY_CUSTOM']
      if (!validModes.includes(mode)) {
        handleException(
          null,
          'EntrypointMode must be BOTH/SELF_COLLECT/ONLY_CUSTOM',
          'EntrypointMode must be BOTH/SELF_COLLECT/ONLY_CUSTOM'
        )
      } else {
        Config.entryPointMode = mode
      }
      yasaLog(`EntrypointMode set: ${mode}`, 'init')
    })
    .option('--checkerIds <list>', '指定检查器id列表（逗号分隔）', (list: any) => {
      const checkerIds = list.split(',')
      Config.checkerIds = _.assign(Config.checkerIds, checkerIds)
      yasaLog(`Specified checker IDs: [${checkerIds.join(', ')}]`, 'init')
    })
    .option('--checkerPackIds <list>', '指定检查器组id列表（逗号分隔）', (list: any) => {
      const checkerPackIds = list.split(',')
      Config.checkerPackIds = _.assign(Config.checkerPackIds, checkerPackIds)
      yasaLog(`Specified checker pack IDs: [${checkerPackIds.join(', ')}]`, 'init')
    })
    .optionsGroup('DB / Dataflow')
    .option('--dataflowDb', '生成离线数据流 SQLite 数据库（默认 incremental-facts，输出 <reportDir>/dataflow.db）', () => {
      Config.dataflowDb = true
      if (!Config.dataflowDbMode) Config.dataflowDbMode = 'incremental-facts'
    })
    .option('--dataflowDbMode <mode>', '指定 dataflow.db 记录模式（incremental-facts|full；full 支持路径查询）', (mode: string) => {
      if (!isDataflowDbMode(mode)) {
        handleException(
          null,
          'ERROR: --dataflowDbMode must be full or incremental-facts',
          'ERROR: --dataflowDbMode must be full or incremental-facts'
        )
        initError = true
        setExitCode(ErrorCode.config_error)
        return
      }
      Config.dataflowDbMode = mode
      Config.dataflowDb = true
    })
    .optionsGroup('输出与导出')
    .option('--dumpAST', 'dump单文件AST', () => {
      Config.dumpAST = true
    })
    .option('--dumpAllAST', 'dump整个项目AST', () => {
      Config.dumpAllAST = true
    })
    .option('--dumpCG', '输出函数调用图', () => {
      Config.dumpCG = true
      if (!Config.checkerIds) Config.checkerIds = []
      Config.checkerIds = Array.isArray(Config.checkerIds) ? Config.checkerIds : [Config.checkerIds]
      Config.checkerIds.push('callgraph')
    })
    .option('--dumpAllCG', '输出完整调用图输出', () => {
      Config.dumpAllCG = true
      if (!Config.checkerIds) Config.checkerIds = []
      Config.checkerIds = Array.isArray(Config.checkerIds) ? Config.checkerIds : [Config.checkerIds]
      Config.checkerIds.push('callgraph')
    })
    .option('--dumpEntrypoint', '输出入口点信息到 entrypoints.json', () => {
      Config.dumpEntrypoint = true
    })
    .optionsGroup('解析器运行依赖')
    .option('--uastSDKPath <dir>', 'UAST二进制文件路径', (uastDir: any) => {
      Config.uastSDKPath = path.isAbsolute(uastDir) ? uastDir : path.resolve(path.join(process.cwd(), uastDir))
    })
    .optionsGroup('QL / AntQL 位置配置')
    .option('--source <locations>', '指定source位置（QL专用）', (locations: any) => {
      if (!Config.FlowConfig) {
        Config.FlowConfig = {}
      }
      if (!Config.FlowConfig.source) {
        Config.FlowConfig.source = []
        Config.FlowConfig.sourcefiles = {}
      }

      const sourceLocs = locations.split(',')
      for (const sourceLoc of sourceLocs) {
        Config.FlowConfig.source.push(sourceLoc)
        const sourcefile = sourceLoc.split(':')[0]
        Config.FlowConfig.sourcefiles[sourcefile] = 0
      }
    })
    .option('--sink <locations>', '指定sink位置（QL专用）', (locations: any) => {
      if (!Config.FlowConfig) {
        Config.FlowConfig = {}
      }
      if (!Config.FlowConfig.sink) {
        Config.FlowConfig.sink = []
        Config.FlowConfig.sinkfiles = {}
      }

      const sinkLocs = locations.split(',')
      for (const sinkLoc of sinkLocs) {
        Config.FlowConfig.sink.push(sinkLoc)
        const sinkFile = sinkLoc.split(':')[0]
        Config.FlowConfig.sinkfiles[sinkFile] = 0
      }
    })
    .option('--prefixPath <path>', '指定临时前缀位置（QL专用）', (prefixPath: any) => {
      Config.prefixPath = prefixPath
    })
    .optionsGroup('配置文件')
    .option('--configFilePath <configFilePath>', '指定config配置文件路径（JSON格式）', (configFilePath: any) => {
      loadConfig(configFilePath)
    })
    .optionsGroup('增量分析')
    .option('--intermediate-dir <directory>', '指定中间文件缓存目录路径', (intermediateDir: any) => {
      intermediateDirExplicitlySet = true
      // 检查如果目录为空，提示错误并禁用增量分析
      if (!intermediateDir || intermediateDir.trim() === '') {
        handleException(
          null,
          'ERROR: --intermediate-dir cannot be empty. Incremental analysis will be disabled.',
          'ERROR: --intermediate-dir cannot be empty. Incremental analysis will be disabled.'
        )
        Config.incremental = false
        Config.intermediateDir = ''
      } else {
        Config.intermediateDir = intermediateDir
      }
    })
    .option('--incremental <mode>', '增量分析模式 (true|false|force)', (mode: string | boolean | number) => {
      if (mode === 'force') {
        Config.incremental = 'force'
      } else {
        Config.incremental = mode === 'true' || mode === true || mode === '1' || mode === 1
      }
    })
    .option('--incrementalCache <dir>', '增量产品缓存目录', (dirPath: string) => {
      Config.incrementalCache = path.isAbsolute(dirPath) ? dirPath : path.resolve(path.join(process.cwd(), dirPath))
    })
    .option('--incrementalDiff <file>', 'base 到 head 的 git diff 文件', (filePath: string) => {
      Config.incrementalDiff = path.isAbsolute(filePath) ? filePath : path.resolve(path.join(process.cwd(), filePath))
    })
    .option('--incrementalMode <mode>', '增量产品模式 baseline|auto|full-on-fallback|ep-only', (mode: string) => {
      Config.incrementalMode = validateIncrementalModeLazy(mode)
    })
    .option('--impactEntrypointFile <file>', '调试用 EP changes/allowlist 文件', (filePath: string) => {
      Config.impactEntrypointFile = path.isAbsolute(filePath) ? filePath : path.resolve(path.join(process.cwd(), filePath))
    })
    .optionsGroup('算法与分析策略')
    .option('--cgAlgo <cgAlgo>', '指定构建CallGraph的算法', (cgAlgo: any) => {
      Config.cgAlgo = cgAlgo
    })
    .option('--taintTraceOutputStrategy <strategy>', '污点追踪输出策略（callstack-only/full）', (strategy: any) => {
      Config.taintTraceOutputStrategy = strategy
    })
    .option('--call-summary <mode>', 'call summary模式：off|only-preprocess|on', (mode: string) => {
      const strategies = parseCallSummaryMode(mode)
      if (!strategies) {
        handleException(
          null,
          'ERROR: --call-summary must be off|only-preprocess|on',
          'ERROR: --call-summary must be off|only-preprocess|on'
        )
        initError = true
        setExitCode(ErrorCode.config_error)
        return
      }
      applyCallSummaryStrategies(strategies)
    })
    .optionsGroup('运行与性能')
    .option('--workerCount <count>', '指定Worker数量（0表示自动计算，>0表示使用设置的值）', (count: any) => {
      const workerCount = parseInt(count, 10)
      if (Number.isNaN(workerCount) || workerCount < 0) {
        handleException(
          null,
          'ERROR: --workerCount must be a non-negative integer',
          'ERROR: --workerCount must be a non-negative integer'
        )
        initError = true
        setExitCode(ErrorCode.config_error)
        return
      }
      Config.workerCount = workerCount
    })
    .option('--enablePerformanceLogging', '启用性能监控日志输出', () => {
      Config.enablePerformanceLogging = true
    })
    .optionsGroup('上下文缓存')
    .option('--contextEnvironmentDir <directory>', '指定上下文环境缓存目录路径', (contextEnvironmentDir: any) => {
      contextEnvironmentDirExplicitlySet = true
      // 检查如果目录为空，提示错误并禁用上下文环境功能
      if (!contextEnvironmentDir || contextEnvironmentDir.trim() === '') {
        handleException(
          null,
          'ERROR: --contextEnvironmentDir cannot be empty. Context environment features will be disabled.',
          'ERROR: --contextEnvironmentDir cannot be empty. Context environment features will be disabled.'
        )
        Config.saveContextEnvironment = false
        Config.miniSaveContextEnvironment = false
        Config.loadContextEnvironment = false
        Config.contextEnvironmentDir = ''
      } else {
        Config.contextEnvironmentDir = contextEnvironmentDir
      }
    })
    .option('--saveContextEnvironment', '保存上下文环境模式', () => {
      Config.saveContextEnvironment = true
    })
    .option('--miniSaveContextEnvironment', '保存上下文环境模式', () => {
      Config.miniSaveContextEnvironment = true
    })
    .option('--loadContextEnvironment', '加载上下文环境模式', () => {
      Config.loadContextEnvironment = true
    })
    .option('--loadContextEnvironmentId <id>', '加载上下文环境模式', (id: any) => {
      Config.loadContextEnvironmentId = id
    })
  // 处理非选项参数（如直接传入的目录）
  program.arguments('[paths...]').action((paths: any) => {
    if (paths.length > 0) {
      for (const pathItem of paths) {
        try {
          if (fs.existsSync(pathItem)) {
            const stats = fs.statSync(pathItem)
            if (stats.isFile()) {
              Config.single = true
            }
            sourcePath = pathItem
          }
        } catch (err: any) {
          handleException(
            err,
            'ERROR: an error occurred while reading path',
            'ERROR: an error occurred while reading path'
          )
          initError = true
          setExitCode(ErrorCode.config_error)
        }
      }
    }
  })

  // 处理未知选项
  program.allowUnknownOption(true)
  program.allowExcessArguments()

  // echo：与 --version 同型——commander 解析到此选项立即打印并退出，不进入 analyzer
  program.optionsGroup('帮助与版本')
  program.version(YASA_VERSION, '-V, --version', '显示版本号')
  program.helpOption('-h, --help', '显示帮助信息')
  program.option('--echo', '致曾同行者', () => {
    printMemorial()
    process.exit(0)
  })

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(normalizeHelpText(program.helpInformation()))
    process.exit(0)
  }

  // 解析命令行参数
  program.parse(args, { from: 'user' })

  // commander 回调中遇到致命错误，直接返回
  if (initError) return null

  if (Config.incrementalCache) {
    if (Config.incrementalDiff && !fs.existsSync(Config.incrementalDiff)) {
      handleException(null, `ERROR: --incrementalDiff not found: ${Config.incrementalDiff}`, `ERROR: --incrementalDiff not found: ${Config.incrementalDiff}`)
      setExitCode(ErrorCode.config_error)
      return null
    }
    Config.incrementalRuntime = {
      cacheDir: Config.incrementalCache,
      diffFile: Config.incrementalDiff || undefined,
      mode: validateIncrementalModeLazy(Config.incrementalMode),
      impactEntrypointFile: Config.impactEntrypointFile || undefined,
    }
  }

  // 检查如果启用了 AST 缓存增量分析，但 --intermediate-dir 未设置或为空，则禁用增量分析
  if (
    !Config.incrementalRuntime?.cacheDir &&
    Config.incremental !== false &&
    Config.incremental !== 'false' &&
    (!intermediateDirExplicitlySet || !Config.intermediateDir || Config.intermediateDir.trim() === '')
  ) {
    yasaWarning(
      '--intermediate-dir must be specified when incremental analysis is enabled. Incremental analysis will be disabled.'
    )
    Config.incremental = false
    Config.intermediateDir = ''
  }

  // 检查如果启用了保存或加载上下文环境，但 --context-environment-dir 未设置或为空，则禁用相关功能
  if (
    (Config.saveContextEnvironment || Config.loadContextEnvironment || Config.miniSaveContextEnvironment) &&
    (!contextEnvironmentDirExplicitlySet || !Config.contextEnvironmentDir || Config.contextEnvironmentDir.trim() === '')
  ) {
    yasaWarning(
      '--context-environment-dir must be specified when save-context-environment or load-context-environment is enabled. Context environment features will be disabled.'
    )
    Config.saveContextEnvironment = false
    Config.loadContextEnvironment = false
    Config.miniSaveContextEnvironment = false
    Config.contextEnvironmentDir = ''
  }

  Stat.parsingTime = 0

  // 解析分析目标
  if (sourcePath) {
    try {
      let maindir: any
      if (path.isAbsolute(sourcePath)) {
        maindir = sourcePath
      } else {
        maindir = path.resolve(path.join(process.cwd(), sourcePath))
      }
      if (!maindir.endsWith('/') && !Config.single) {
        maindir += '/'
      }
      // record the main directory
      yasaLog(`Source path: ${maindir}`, 'init')
      Config.maindir = maindir
      Config.maindirPrefix = maindir.substring(0, maindir.lastIndexOf('/'))
    } catch (e: any) {
      logger.info(e)
      logger.info(`directory = [${dir}]`)
      return
    }
  }
  if (Config.maindir && Config.maindir !== '') {
    if (Config.single) {
      const lang = detectFileLanguage(Config.maindir)
      if (lang) {
        Config.language = lang
      } else {
        logger.info(
          'Unknown command or unknown language!! Note the command using -- , and language support javascript/typescript/golang/python/java.'
        )
        setExitCode(ErrorCode.config_error)
        return null
      }
    }
  } else {
    handleException(null, 'There is no sourcePath specified to analyze', 'There is no sourcePath specified to analyze')
    setExitCode(ErrorCode.config_error)
    return null
  }

  if (reportPath && reportPath !== '') {
    const reportPathAbs = path.isAbsolute(reportPath) ? reportPath : path.resolve(path.join(process.cwd(), reportPath))
    if (Config.dumpAST) {
      Config.ASTFileOutput = reportPathAbs
      const parentDir = path.dirname(reportPathAbs)
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true })
      }
      if (!fs.existsSync(reportPathAbs)) {
        fs.writeFileSync(reportPathAbs, '')
      } else {
        const stats = fs.statSync(reportPathAbs)
        if (!stats.isFile()) {
          fs.rmSync(reportPathAbs, { recursive: true, force: true })
          fs.writeFileSync(reportPathAbs, '')
        }
      }
      logger.info('Report File:', Config.ASTFileOutput)
    } else {
      Config.reportDir = reportPathAbs
      if (!fs.existsSync(reportPathAbs)) {
        fs.mkdirSync(reportPathAbs, { recursive: true })
      } else {
        const stats = fs.statSync(reportPathAbs)
        if (!stats.isDirectory()) {
          fs.unlinkSync(reportPathAbs)
          fs.mkdirSync(reportPathAbs, { recursive: true })
        }
      }
      yasaLog(`Report directory: ${Config.reportDir}`, 'init')
    }
  }

  // dump AST
  if (Config.dumpAST) {
    if (!Config.single) {
      Errors.ParseError('Only support dump AST for single file, but given a dir')
      setExitCode(ErrorCode.config_error)
      return null
    }
    // read and parse the source file(s)
    const apps = loadSource(Config.maindir)
    // logger.info("apps: " + JSON.stringify(apps));
    if (apps.length === 0) {
      const ecode = ErrorCode.no_valid_source_file
      handleException(null, `ERROR: ${ErrorCode.toString(ecode)}`, `ERROR: ${ErrorCode.toString(ecode)}`)
      process.exitCode = ecode
      return
    }
    if (Config.ASTFileOutput) {
      await dumpAST(apps, fs.writeFileSync)
    } else {
      await dumpAST(apps, logger.info.bind(logger))
    }
    setExitCode(ErrorCode.normal)
    return null
  }

  // dump all AST
  if (Config.dumpAllAST) {
    try {
      // 确保 reportDir 存在
      if (!Config.reportDir) {
        Config.reportDir = './uastParseDir'
      }

      // 使用统一接口导出所有 AST
      await Parser.dumpAllAST(Config.maindir, Config.reportDir, Config)

      logger.info('parseDirectory UAST success!')
      setExitCode(ErrorCode.normal)
      return null
    } catch (e: any) {
      handleException(e, 'Error occurred in dumpAllAST!!!!', `Error occurred in dumpAllAST!!!!${e}`)
      setExitCode(ErrorCode.engine_failure)
      return null
    }
  }

  // prepare the output and report directories
  cleanReportDir(Config.reportDir)

  const JavaScriptAnalyzer = require('../engine/analyzer/javascript/common/js-analyzer')
  const EggAnalyzer = require('../engine/analyzer/javascript/egg/egg-analyzer')

  const JavaAnalyzer = require('../engine/analyzer/java/common/java-analyzer')
  const SpringAnalyzer = require('../engine/analyzer/java/spring/spring-analyzer')

  const GoAnalyzer = require('../engine/analyzer/golang/common/go-analyzer')

  const PythonAnalyzer = require('../engine/analyzer/python/common/python-analyzer')

  const PhpAnalyzer = require('../engine/analyzer/php/common/php-analyzer')

  const analyzerEnum = {
    EggAnalyzer,
    JavaScriptAnalyzer,
    JavaAnalyzer,
    GoAnalyzer,
    SpringAnalyzer,
    PythonAnalyzer,
    PhpAnalyzer,
  }
  const analyzerLanguage = {
    EggAnalyzer: 'javascript',
    JavaScriptAnalyzer: 'javascript',
    JavaAnalyzer: 'java',
    SpringAnalyzer: 'java',
    GoAnalyzer: 'golang',
    PythonAnalyzer: 'python',
    PhpAnalyzer: 'php',
  }

  let Analyzer: any
  if (Config.analyzer && Config.analyzer !== '') {
    Analyzer = (analyzerEnum as any)[Config.analyzer]
    Config.language = (analyzerLanguage as any)[Config.analyzer]
    if (!Analyzer || Analyzer === '') {
      handleException(
        null,
        'analyzer set failed,now YASA supported EggAnalyzer|JavaScriptAnalyzer|JavaAnalyzer|SpringAnalyzer|GoAnalyzer|PythonAnalyzer|PhpAnalyzer',
        'analyzer set failed,now YASA supported EggAnalyzer|JavaScriptAnalyzer|JavaAnalyzer|SpringAnalyzer|GoAnalyzer|PythonAnalyzer|PhpAnalyzer'
      )
      return
    }
  } else {
    if (!Config.language || Config.language === '') {
      handleException(null, 'language or analyzer must be set', 'language or analyzer must be set')
      return
    }
    let f = FrameworkUtil.detectAnalyzer(Config.language, Config.maindir)
    if (!f || f === '') {
      logger.info('analyzer detect failed, use default language analyzer')
      switch (Config.language) {
        case 'golang':
          f = 'GoAnalyzer'
          break
        case 'javascript':
          f = 'JavaScriptAnalyzer'
          break
        case 'java':
          f = 'JavaAnalyzer'
          break
        case 'python':
          f = 'PythonAnalyzer'
          break
        case 'php':
          f = 'PhpAnalyzer'
          break
        default:
          handleException(null, 'default analyzer set failed', 'default analyzer set failed')
          return
      }
    }
    Config.analyzer = f
    Analyzer = (analyzerEnum as any)[Config.analyzer]
  }
  yasaLog(`Analysis language: ${Config.language}`, 'init')
  yasaLog(`Analysis analyzer: ${Config.analyzer}`, 'init')
  logScanInit(performanceTracker)
  return new Analyzer(Config)
}

/**
 * Execute analyzer
 * @param {any} analyzer - The analyzer instance
 * @param {any} processingDir - Directory to process
 * @returns {Promise<number>} Exit code: 0 for success, 1 for failure
 */
async function executeAnalyzer(analyzer: any, processingDir: any): Promise<number> {
  try {
    if (Config.single) {
      const source = fs.readFileSync(processingDir, 'utf8')
      const singleFileResult = await analyzer.analyzeSingleFile(source, processingDir)
      if (!singleFileResult) {
        return (process.exitCode as number) || ErrorCode.engine_failure
      }
    } else if (!(await analyzer.analyzeProject(processingDir))) {
      return (process.exitCode as number) || ErrorCode.engine_failure
    }
    return (process.exitCode as number) || ErrorCode.normal
  } catch (e: any) {
    handleException(e, 'Error occurred in executeAnalyzer!!!!', 'Error occurred in executeAnalyzer!!!!')
    return ErrorCode.engine_failure
  }
}

// 递归函数，用于删除对象及其子对象中的 'parent' 属性
// 注意：此函数已不再使用，保留用于历史兼容性
/**
 * Remove parent property from object recursively (deprecated)
 * @param {any} obj - Object to process
 * @returns {any} Processed object
 * @deprecated This function is no longer used
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function removeParentProperty(obj: any) {
  if (typeof obj !== 'object' || obj === null) {
    return obj
  }

  // 删除当前对象的 'parent' 属性
  delete obj.parent

  // 递归遍历子对象
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      obj[key] = removeParentProperty(obj[key])
    }
  }

  return obj
}
/**
 * Load source files from directory
 * @param {any} absdirs - Absolute directory paths
 * @returns {Array} Array of source file objects with file and content
 */
function loadSource(absdirs: any) {
  if (!Config.language) {
    throw new Error('Config.language is not set')
  }
  let fext: any = ['.sol']
  const dirFilter: any[] = []
  switch (Config.language) {
    case 'golang':
      fext = ['go']
      dirFilter.push('vendor')
      break
    case 'javascript':
    case 'js':
    case 'typescript':
    case 'ts':
    case 'jsx':
    case 'tsx':
      fext = ['js', 'ts', 'cjs', 'mjs', 'jsx', 'tsx']
      dirFilter.push('node_modules')
      break
    case 'java':
      fext = ['java']
      break
    case 'python':
      fext = ['py']
      break
    case 'php':
      fext = ['php']
      break
    default:
      // Keep default .sol extension for unknown languages
      break
  }

  const res: any[] = []
  if (absdirs && !Array.isArray(absdirs)) {
    absdirs = [absdirs]
  }
  for (const dir of absdirs) {
    const srcTxts = FileUtil.loadAllFileText(dir, fext, dirFilter)
    for (const txt of srcTxts) {
      // txt: { file: ..., content: ... }
      res.push(txt)
    }
  }
  return res
}

/**
 * load the configuration file from the disk
 * @param {any} configfile - Path to configuration file
 */
function loadConfig(configfile: any) {
  let file = configfile || 'config.json'
  if (!path.isAbsolute(file)) file = `${process.cwd()}/${file}`
  if (file) {
    try {
      if (!fs.existsSync(file)) return
      const cf = FileUtil.loadJSONfile(file)
      if (cf) {
        for (const x in cf) {
          Config[x] = cf[x]
        }
      }
    } catch (e: any) {
      handleException(
        e,
        `ERROR: loading the configuration file failed: ${configfile}`,
        `ERROR: loading the configuration file failed: ${configfile}`
      )
    }
  }
}

/**
 * clean or create the directory for report for external usage
 * @param odir target directory
 * @note High complexity function - refactoring deferred per user request
 */
// eslint-disable-next-line complexity
function cleanReportDir(odir: any) {
  // handle the trigger output directory
  if (odir) {
    try {
      if (!fs.existsSync(odir))
        // create the output directory
        fs.mkdirSync(odir)
      else {
        // clean up the output directory
        const files = fs.readdirSync(odir)
        for (let i = 0; i < files.length; i++) {
          const fname = files[i]
          if (fname.startsWith('findings')) {
            const filePath = `${odir}/${fname}`
            if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath)
          } else if (fname === 'html') {
            const subPath = `${odir}/${fname}`
            cleanReportDir(subPath)
          }
        }
      }
    } catch (e: any) {
      handleException(
        e,
        'ERROR: an error occurred while cleanReportDir.',
        'ERROR: an error occurred while cleanReportDir.'
      )
      setExitCode(ErrorCode.fail_to_generate_report)
    }
  }
}

//* *****************************  Command-line hints**********************************

/**
 * command line help information
 */
/**
 * Dump AST to file or console
 * @param {any} apps - Array of application objects with file and content
 * @param {any} printf - Print function for output
 */
async function dumpAST(apps: any, printf: any) {
  const { deleteParent } = require('../util/ast-util')
  for (const app of apps) {
    if (!Config.ASTFileOutput) {
      printf('dump file AST:', app.file)
    }
    Config.sourcefile = app.file
    // 使用统一接口 parseSingleFile，传入源代码缓存对象，然后删除 parent 指针
    // 创建 sourceCodeCache 对象，将文件路径映射到内容（存储为行数组）
    const sourceCodeCache = new Map<string, string[]>()
    sourceCodeCache.set(app.file, app.content.split(/\n/))
    // eslint-disable-next-line no-await-in-loop
    const ast = Parser.parseSingleFile(app.file, Config, sourceCodeCache)
    deleteParent(ast)
    if (Config.language !== 'golang') {
      const parseResult = JSON.stringify(ast)
      if (Config.ASTFileOutput) {
        printf(Config.ASTFileOutput, parseResult)
      } else {
        printf(parseResult)
      }
    } else if (!Config.ASTFileOutput) {
      printf('Report File: ./uast.json')
    }
  }
}

/**
 * Filter findings based on trace criteria (deprecated)
 * @param {any} findings - Findings array to filter
 * @returns {any} Filtered findings or null
 * @deprecated This function is no longer used
 * @note High complexity function - refactoring deferred per user request
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars, complexity
function filtrateFindings(findings: any) {
  if (findings && Array.isArray(findings)) {
    return findings.filter((element: any) => {
      const trace = element?.trace
      if (trace && Array.isArray(trace)) {
        for (const t of trace) {
          if (!t.str?.toString().includes('SOURCE:') && !t.affectedNodeName) {
            return false
          }
        }
        return true
      }
      return false
    })
  }
  return null
}

/**
 * Detect programming language from file extension
 * @param {any} filename - File path or name
 * @returns {string|null} Detected language or null
 */
function detectFileLanguage(filename: any) {
  const ext = filename.split('.').pop().toLowerCase()
  switch (ext) {
    case 'ts':
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'tsx':
    case 'jsx':
      return 'javascript'
    case 'go':
      return 'golang'
    case 'java':
      return 'java'
    case 'py':
      return 'python'
    case 'php':
      return 'php'
    default:
      return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  execute,
  initAnalyzer,
  getDataflowInternalOptionNames,
}
