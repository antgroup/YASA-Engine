/* eslint-disable max-classes-per-file */
/* eslint-disable complexity */
const fs = require('fs-extra')
const path = require('path')
const globby = require('fast-glob')
const { fork } = require('child_process')
const os = require('os')
const FileUtil = require('../../util/file-util')
const { md5 } = require('../../util/hash-util')
const Config = require('../../config')
const logger = require('../../util/logger')(__filename)
const { performanceTracker } = require('../../util/performance-tracker')
const { yasaLog } = require('../../util/format-util')
const {
  parseFile: parseFileCore,
  processParsedAst: processParsedAstCore,
  processProjectAst: processProjectAstCore,
  loadAstFromCache: loadAstFromCacheCore,
  saveAstToCache: saveAstToCacheCore,
  dumpAllAST: dumpAllASTCore,
} = require('./parser-core')
const SourceLine = require('../analyzer/common/source-line')

// ===================== 常量定义 =====================
const PREPROCESS_PARSE_CODE_STAGE = 'preProcess.parseCode'
const CPU_COUNT = os.cpus().length
const DEFAULT_WORKER_COUNT = Math.min(Math.ceil(CPU_COUNT * 0.4), 16)
const MAX_CONCURRENCY = Math.max(CPU_COUNT, 16) * 2

// ================ 语言解析器配置接口 ================

/**
 * 语言解析器配置接口
 */
interface LanguageParserConfig {
  /** 语言标识：'java' 或 ['js', 'javascript'] */
  language: string | string[]
  /** 分析单元类型 */
  unit: 'file' | 'package'
  /** 是否支持增量解析 */
  supportsIncremental: boolean
  /** 文件匹配模式，使用 glob 模式 */
  filePatterns: string[]
  /** 单文件解析回调 */
  parseSingleFile?: (code: string, options: Record<string, any>) => any
  /** 项目解析回调 */
  parseProject?: (rootDir: string, options: Record<string, any>) => Promise<any>

  /**
   * 是否需要设置 loc.sourcefile（默认 true）
   * - false: 外部工具已设置 sourcefile，不需要覆盖（如 Go）
   * - true: 需要设置 loc.sourcefile（如 Java/JS/Python）
   */
  needsSourcefile?: boolean

  /**
   * 是否按文件逐个解析（默认 true）
   * - true: 按文件逐个解析（如 Java/JS，使用 parseProjectAsFiles）
   * - false: 直接解析整个项目，返回文件映射需要转换（如 Python）
   */
  parseAsFiles?: boolean
}

// =================== 解析器注册表 ===================

/**
 * 解析器注册表
 */
class ParserRegistry {
  private parsers: Map<string, LanguageParserConfig> = new Map()

  /**
   * 注册语言解析器
   * @param config - 语言解析器配置
   */
  register(config: LanguageParserConfig): void {
    const languages = Array.isArray(config.language) ? config.language : [config.language]
    for (const lang of languages) {
      this.parsers.set(lang, config)
    }
  }

  /**
   * 获取语言配置
   * @param language - 语言标识
   * @returns {LanguageParserConfig | undefined} 语言配置，如果不存在则返回 undefined
   */
  get(language: string): LanguageParserConfig | undefined {
    return this.parsers.get(language)
  }

  /**
   * 检查语言是否支持增量
   * @param language - 语言标识
   * @returns {boolean} 是否支持增量解析
   */
  supportsIncremental(language: string): boolean {
    const config = this.get(language)
    return config ? config.supportsIncremental : false
  }

  /**
   * 获取所有已注册的语言
   * @returns {string[]} 所有已注册的语言标识数组
   */
  getRegisteredLanguages(): string[] {
    return Array.from(this.parsers.keys())
  }
}

// =================== Worker Pool 管理 ===================

/**
 * 智能 Worker 路径解析：使用 child_process.fork 启动子进程
 * 子进程退出后 OS 立即回收内存，解决 worker_threads 共享 RSS 不释放问题
 * @param {string} workerName - Worker 文件名
 * @returns {any} 子进程实例
 */
function loadWorker(workerName: string): any {
  const isCompiled = __dirname.includes('/dist/') || __dirname.includes('\\dist\\')
  // pkg 打包后 execPath 指向二进制自身，不支持 execArgv 中的 V8 flag
  const isPkg = !!(process as any).pkg

  if (isCompiled) {
    const workerPath = path.join(__dirname, `${workerName}.js`)
    if (fs.existsSync(workerPath)) {
      return fork(path.resolve(workerPath), [], isPkg
        ? { execArgv: [], env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=2048' } }
        : { execArgv: ['--max-old-space-size=2048'] })
    }
    throw new Error(`Worker file not found: ${workerPath}`)
  }

  // 开发环境：使用 tsx 加载 .ts
  const workerTsPath = path.join(__dirname, `${workerName}.ts`)
  if (fs.existsSync(workerTsPath)) {
    let tsxModulePath: string | null = null
    try {
      tsxModulePath = require.resolve('tsx/cjs')
    } catch (error) {
      const projectRoot = path.resolve(__dirname, '../../..')
      const tsxPath = path.join(projectRoot, 'node_modules', 'tsx', 'cjs', 'index.mjs')
      if (fs.existsSync(tsxPath)) {
        tsxModulePath = tsxPath
      }
    }

    if (tsxModulePath) {
      return fork(workerTsPath, [], {
        execArgv: ['--max-old-space-size=2048', '-r', 'tsx/cjs'],
      })
    }
    throw new Error(
      `Cannot load TypeScript worker: tsx module not found. Please install tsx (npm install tsx) or compile TypeScript first (npx tsc).`
    )
  }

  throw new Error(`Worker file not found: ${workerTsPath}`)
}

/**
 * Worker Pool 类：管理多个子进程
 */
class WorkerPool {
  private workers: Array<{ worker: any; busy: boolean; id: number }> = []

  private taskQueue: Array<{ type: string; task: any; taskId: number; resolve: any; reject: any }> = []

  private taskIdCounter = 0

  private _maxWorkers: number

  private stats = {
    totalTasks: 0,
    totalWorkTime: 0,
    workerStartTime: 0,
    workerWorkTimes: new Map<number, number>(),
  }

  private lastWorkerIndex: number = 0

  private pendingTasks: Map<number, any> = new Map()

  private terminated: boolean = false

  /** 子进程 OOM 计数 */
  oomCount: number = 0

  /** 子进程连续失败计数，超过阈值停止重建 */
  private consecutiveFailures: number = 0
  private static readonly MAX_CONSECUTIVE_FAILURES = 3

  /**
   * 构造函数
   * @param {number} [maxWorkers] - 最大 worker 数量
   */
  constructor(maxWorkers?: number) {
    this._maxWorkers = maxWorkers || DEFAULT_WORKER_COUNT

    if (this._maxWorkers === 0) {
      return
    }

    const startTime = Date.now()
    for (let i = 0; i < this._maxWorkers; i++) {
      this.createWorker(i)
    }
    this.stats.workerStartTime = Date.now() - startTime
  }

  /**
   * 创建子进程
   * @param {number} id - Worker ID
   */
  private createWorker(id: number): void {
    try {
      const worker = loadWorker('parser-worker')

      worker.on('message', (message: any) => {
        this.handleWorkerMessage(id, message)
      })

      worker.on('error', (error: Error) => {
        console.error(`Worker ${id} error:`, error)
        if (error.message.includes('Cannot find module') || error.message.includes('ERR_MODULE_NOT_FOUND')) {
          console.error(`Worker script not found or cannot be loaded: parser-worker`)
          console.error(
            'Falling back to single-threaded mode. Please compile TypeScript first or use --disable-workers flag.'
          )
          if (this.workers[id]) {
            this.workers[id].busy = false
          }
          return
        }
        if (this.workers[id] && this.workers[id].worker) {
          this.workers[id].worker.kill()
          this.createWorker(id)
        }
      })

      worker.on('exit', (code: number) => {
        if (this.terminated) {
          return
        }
        if (code !== 0) {
          console.warn(`Worker ${id} exited with code ${code}`)
          this.oomCount++
          this.consecutiveFailures++
          // 子进程非正常退出，reject 该 worker 所有 pending 任务
          for (const [taskId, task] of this.pendingTasks.entries()) {
            if (this.workers[id]?.busy) {
              this.pendingTasks.delete(taskId)
              task.reject(new Error(`Worker ${id} exited with code ${code} (possible OOM)`))
            }
          }
          if (this.workers[id]) {
            this.workers[id].busy = false
          }
          if (this.consecutiveFailures >= WorkerPool.MAX_CONSECUTIVE_FAILURES) {
            console.error(`Worker consecutive failures reached ${this.consecutiveFailures}, stopping worker recreation`)
            return
          }
          this.createWorker(id)
        }
      })

      if (this.workers[id]) {
        this.workers[id] = { worker, busy: false, id }
      } else {
        this.workers.push({ worker, busy: false, id })
      }
    } catch (error) {
      console.error(`Failed to create worker ${id}:`, error)
    }
  }

  /**
   * 处理 worker 消息
   * @param {number} workerId - Worker ID
   * @param {any} message - 消息
   */
  private handleWorkerMessage(workerId: number, message: any): void {
    const worker = this.workers[workerId]
    if (!worker) return

    const task = this.pendingTasks.get(message.taskId)
    if (!task) return

    this.consecutiveFailures = 0

    this.pendingTasks.delete(message.taskId)
    worker.busy = false

    if (message.workTime !== undefined && message.workTime > 0) {
      this.stats.totalWorkTime += message.workTime
      const currentWorkerTime = this.stats.workerWorkTimes.get(workerId) || 0
      this.stats.workerWorkTimes.set(workerId, currentWorkerTime + message.workTime)
    }

    if (message.success) {
      task.resolve(message.result)
    } else {
      task.reject(new Error(message.error || 'Unknown error'))
    }

    this.processNextTask()
  }

  /**
   * 处理下一个任务
   */
  private processNextTask(): void {
    if (this.taskQueue.length === 0) return

    const idleWorkers = this.workers.filter((w) => !w.busy)
    if (idleWorkers.length === 0) return

    const selectedWorker = idleWorkers[this.lastWorkerIndex % idleWorkers.length]
    this.lastWorkerIndex = (this.lastWorkerIndex + 1) % idleWorkers.length
    const idleWorker = selectedWorker

    const task = this.taskQueue.shift()
    if (!task) return

    idleWorker.busy = true
    this.pendingTasks.set(task.taskId, task)

    idleWorker.worker.send({
      type: task.type,
      task: task.task,
      taskId: task.taskId,
    })
  }

  /**
   * 提交任务
   * @param {string} type - 任务类型
   * @param {any} task - 任务数据
   * @returns {Promise<T>} 任务结果
   */
  async submitTask<T>(type: string, task: any): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const taskId = ++this.taskIdCounter

      this.stats.totalTasks++

      const taskItem = {
        type,
        task,
        taskId,
        resolve,
        reject,
      }

      this.taskQueue.push(taskItem)
      this.processNextTask()
    })
  }

  /**
   * 终止所有 worker
   */
  async terminate(): Promise<void> {
    if (this.terminated) return

    this.terminated = true
    for (const [index, w] of this.workers.entries()) {
      if (w.worker) {
        try {
          w.worker.removeAllListeners('message')
          w.worker.removeAllListeners('error')
          w.worker.removeAllListeners('exit')
          if (w.worker.connected) w.worker.disconnect()
          w.worker.kill()
        } catch (error) {
          logger.warn(`Failed to terminate worker ${index}:`, error)
        }
      }
    }
    this.workers = []
    this.taskQueue = []
    this.pendingTasks.clear()
  }

  /**
   * 获取活跃任务数
   * @returns {number} 活跃任务数
   */
  getActiveTaskCount(): number {
    return this.taskQueue.length + this.workers.filter((w) => w.busy).length
  }

  /**
   * 获取最大 worker 数
   * @returns {number} 最大 worker 数
   */
  getMaxWorkers(): number {
    return this._maxWorkers
  }

  /**
   * 获取统计信息
   * @returns {any} 统计信息
   */
  getStats() {
    const workerStats: { [key: number]: number } = {}
    for (let i = 0; i < this._maxWorkers; i++) {
      workerStats[i] = this.stats.workerWorkTimes.get(i) || 0
    }

    return {
      workerCount: this._maxWorkers,
      totalTasks: this.stats.totalTasks,
      workerStartTime: this.stats.workerStartTime,
      totalWorkTime: this.stats.totalWorkTime,
      workerWorkTimes: workerStats,
      avgWorkTime: this.stats.totalTasks > 0 ? this.stats.totalWorkTime / this.stats.totalTasks : 0,
    }
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      totalTasks: 0,
      totalWorkTime: 0,
      workerStartTime: this.stats.workerStartTime,
      workerWorkTimes: new Map(),
    }
  }
}

// =================== 缓存列表管理 ===================

/**
 * 获取缓存目录路径
 * @returns {string} 缓存目录路径
 */
function getCacheDir(): string {
  let outputDir = Config.intermediateDir
  if (!outputDir) {
    outputDir = Config.reportDir || './report/'
    if (!path.isAbsolute(outputDir)) {
      outputDir = path.resolve(process.cwd(), outputDir)
    }
    outputDir = path.join(outputDir, 'ast-output')
  } else if (!path.isAbsolute(outputDir)) {
    outputDir = path.resolve(process.cwd(), outputDir)
  }
  return outputDir
}

/**
 * 获取文件相对于源目录的相对路径
 * @param {string} filename - 文件路径
 * @returns {string} 相对路径
 */
function getRelativePath(filename: string): string {
  const sourceDir = Config.maindir || ''
  if (!sourceDir || !filename) {
    return filename
  }
  const normalizedSource = path.normalize(sourceDir).replace(/\\/g, '/')
  const normalizedFile = path.normalize(filename).replace(/\\/g, '/')
  if (normalizedFile.startsWith(normalizedSource)) {
    let relative = normalizedFile.substring(normalizedSource.length)
    if (relative.startsWith('/')) {
      relative = relative.substring(1)
    }
    return relative
  }
  return filename
}

/**
 * 加载缓存列表
 * @returns {Promise<Map<string, { jsonFile: string; crc: string; time?: string }>>} 缓存列表的 Map
 */
async function loadCacheList(): Promise<Map<string, { jsonFile: string; crc: string; time?: string }>> {
  return new Promise((resolve) => {
    const cacheDir = getCacheDir()
    const listPath = path.join(cacheDir, 'ast-cache-list.json')

    fs.readFile(listPath, 'utf8', (err: NodeJS.ErrnoException | null, content: string) => {
      if (err) {
        resolve(new Map())
        return
      }

      try {
        const listData = JSON.parse(content)
        const cacheMap = new Map<string, { jsonFile: string; crc: string; time?: string }>()

        if (Array.isArray(listData)) {
          for (const item of listData) {
            if (item.path && item.jsonFile && item.crc) {
              cacheMap.set(item.path, {
                jsonFile: item.jsonFile,
                crc: item.crc,
                time: item.time,
              })
            }
          }
        }

        resolve(cacheMap)
      } catch (error) {
        logger.warn(`Failed to parse cache list: ${(error as Error).message}`)
        resolve(new Map())
      }
    })
  })
}

// ================= 统一的解析器基类 =================

/**
 * 统一的解析器基类
 */
class BaseParser {
  protected registry: ParserRegistry

  private workerPool: any = null

  private useWorkers: boolean = true // 是否使用 worker 模式

  /**
   * 构造函数，初始化解析器注册表并注册默认解析器
   * Worker pool 将在第一次使用时创建（延迟初始化）
   */
  constructor() {
    this.registry = new ParserRegistry()
    this.registerDefaultParsers()
  }

  /**
   * 获取或创建 Worker Pool
   * @returns {any} Worker Pool 实例
   */
  private getWorkerPool(): any {
    // eslint-disable-next-line sonarjs/no-duplicate-string
    const SINGLE_THREADED_FALLBACK_MSG = 'falling back to single-threaded mode'
    if (!this.workerPool && this.useWorkers) {
      try {
        // 检查 worker 文件是否存在（支持 .ts 和 .js）
        // __dirname 已经是 src/engine/parser，检查 .ts（开发环境）或 .js（生产环境）
        const workerTsPath = path.join(__dirname, 'parser-worker.ts')
        const workerJsPath = path.join(__dirname, 'parser-worker.js')

        if (!fs.existsSync(workerTsPath) && !fs.existsSync(workerJsPath)) {
          logger.warn(`Worker script not found at ${workerTsPath} or ${workerJsPath}, ${SINGLE_THREADED_FALLBACK_MSG}`)
          this.useWorkers = false
          return null
        }

        // 从配置读取 workerCount：0表示自动计算，>0表示使用设置的值
        const workerCount = Config.workerCount || 0
        const maxWorkers = workerCount > 0 ? workerCount : undefined
        this.workerPool = new WorkerPool(maxWorkers)

        const maxWorkersValue = this.workerPool.getMaxWorkers()

        let WORKER_INIT_MESSAGE: string
        if (workerCount > 0) {
          // 手动设置worker数量
          WORKER_INIT_MESSAGE = `Using ${maxWorkersValue} workers (manually configured)`
        } else {
          // 自动计算worker数量
          WORKER_INIT_MESSAGE = `Auto-calculated ${maxWorkersValue} workers from ${CPU_COUNT} CPU cores (min(${CPU_COUNT}*0.4,16) = ${maxWorkersValue})`
        }
        yasaLog(WORKER_INIT_MESSAGE, PREPROCESS_PARSE_CODE_STAGE)
      } catch (error) {
        logger.warn(`Failed to create worker pool: ${(error as Error).message}, ${SINGLE_THREADED_FALLBACK_MSG}`)
        this.useWorkers = false
        this.workerPool = null
      }
    }
    return this.workerPool
  }

  /**
   * 清理 Worker Pool（私有方法）
   */
  private async cleanupWorkerPool(): Promise<void> {
    if (this.workerPool) {
      try {
        await this.workerPool.terminate()
        this.workerPool = null
      } catch (error) {
        logger.warn(`Failed to cleanup worker pool: ${(error as Error).message}`)
      }
    }
  }

  /**
   * 清理 Worker Pool（公开方法，供外部调用）
   */
  async cleanup(): Promise<void> {
    await this.cleanupWorkerPool()
  }

  /**
   * 注册默认的语言解析器（Java, JavaScript, Python, Go）
   */
  protected registerDefaultParsers(): void {
    // 注册 Java 解析器
    this.registry.register({
      language: 'java',
      unit: 'file',
      supportsIncremental: true,
      parseAsFiles: true,
      filePatterns: ['**/*.java', '!target/**', '!**/src/test/**'],
      parseSingleFile: (code, options) => {
        const JavaAstBuilder = require('./java/java-ast-builder')
        return JavaAstBuilder.parseSingleFile(code, options)
      },
      parseProject: async (rootDir, options) => {
        const JavaAstBuilder = require('./java/java-ast-builder')
        return JavaAstBuilder.parseProject(rootDir, options)
      },
      needsSourcefile: true,
    })

    // 注册 JavaScript 解析器（支持多个别名：javascript, js）
    this.registry.register({
      language: ['javascript', 'js'],
      unit: 'file',
      supportsIncremental: true,
      parseAsFiles: true,
      filePatterns: [
        '**/*.(js|ts|mjs|cjs)',
        '!**/*.test.(js|ts|mjs|cjs|jsx)',
        '!**/node_modules',
        '!web',
        '!**/public/**',
        '!**/*.d.ts',
        '!**/*.d.js',
      ],
      parseSingleFile: (code, options) => {
        const JSAstBuilder = require('./javascript/js-ast-builder')
        return JSAstBuilder.parseSingleFile(code, {
          sanity: options.sanity,
          sourcefile: options.sourcefile,
        })
      },
      parseProject: async (rootDir, options) => {
        const JSAstBuilder = require('./javascript/js-ast-builder')
        return JSAstBuilder.parseProject(rootDir, options)
      },
      needsSourcefile: true,
    })

    // 注册 Python 解析器
    this.registry.register({
      language: 'python',
      unit: 'file',
      supportsIncremental: false,
      parseAsFiles: false,
      filePatterns: ['**/*.(py)', '!**/.venv/**', '!**/vendor/**', '!**/node_modules/**', '!**/site-packages/**'],
      parseSingleFile: (code, options) => {
        const PythonParser = require('./python/python-ast-builder')
        return PythonParser.parseSingleFile(code, options)
      },
      parseProject: async (rootDir, options) => {
        const PythonParser = require('./python/python-ast-builder')
        return PythonParser.parseProject(rootDir, options)
      },
      needsSourcefile: true,
    })

    // 注册 Go 解析器
    this.registry.register({
      language: 'golang',
      unit: 'package',
      supportsIncremental: false,
      filePatterns: ['**/*.(go)'],
      parseSingleFile: (code, options) => {
        const GoParser = require('./golang/go-ast-builder')
        const filepath = options.sourcefile
        if (!filepath) {
          throw new Error('Go single file parsing requires sourcefile in options')
        }
        return GoParser.parseSingleFile(filepath, options)
      },
      parseProject: async (rootDir, options) => {
        const GoParser = require('./golang/go-ast-builder')
        return GoParser.parseProject(rootDir, options)
      },
      needsSourcefile: false,
    })

    // 注册 PHP 解析器
    this.registry.register({
      language: 'php',
      unit: 'file',
      supportsIncremental: false,
      parseAsFiles: true,
      filePatterns: ['**/*.php'],
      parseSingleFile: (code, options) => {
        const PhpParser = require('./php/php-ast-builder')
        return PhpParser.parseSingleFile(code, options)
      },
      parseProject: async (rootDir, options) => {
        const PhpParser = require('./php/php-ast-builder')
        await PhpParser.ensureInitialized()
        return null
      },
      needsSourcefile: true,
    })
  }

  /**
   * 解析单个文件（用户操作接口）
   * @param {string} filepath - 文件路径
   * @param {Record<string, any>} options - 解析选项，必须包含 language
   * @param {string} options.language - 语言标识（必填）
   * @param {Map<string, string>} [sourceCodeCache] - 可选的源代码缓存，如果提供则优先从缓存获取，读取后自动填充
   * @returns {any} 解析后的 AST
   */
  parseSingleFile(
    filepath: string,
    options: { language?: string; [key: string]: any },
    sourceCodeCache?: Map<string, string[]>
  ): any {
    const language = options.language!
    const config = this.registry.get(language)!

    // 获取文件内容：优先从 sourceCodeCache 获取，否则读取文件并填充到缓存
    let fileContent
    if (sourceCodeCache && sourceCodeCache.get(filepath)) {
      fileContent = sourceCodeCache.get(filepath)!.join('\n')
    } else {
      fileContent = fs.readFileSync(filepath, 'utf8')
      // 如果提供了 sourceCodeCache，自动填充
      if (sourceCodeCache) {
        sourceCodeCache.set(filepath, fileContent.split(/\n/))
      }
    }
    options.sourcefile = options.sourcefile || filepath

    return this.parseFile(filepath, fileContent, options, config, sourceCodeCache)
  }

  /**
   * 解析文件（BaseParser 的基本动作）
   * @param {string} filepath - 文件路径
   * @param {string} code - 源代码内容
   * @param {Record<string, any>} options - 解析选项
   * @param {LanguageParserConfig} config - 语言配置
   * @param {Map<string, string>} [sourceCodeCache] - 可选的源代码缓存
   * @returns {any} 解析后的 AST
   */
  private parseFile(
    filepath: string,
    code: string,
    options: Record<string, any>,
    config: LanguageParserConfig,
    sourceCodeCache?: Map<string, string[]>
  ): any {
    const parseResult = parseFileCore(filepath, code, options.language!, options, {
      unit: config.unit,
      needsSourcefile: config.needsSourcefile,
    })
    const { ast } = parseResult

    // 如果 parse 失败返回 null，清理 sourceCodeCache，避免后续代码误认为文件已处理
    if (!ast && sourceCodeCache && sourceCodeCache.get(filepath)) {
      sourceCodeCache.delete(filepath)
    }

    return ast
  }

  /**
   * 解析项目/包（用户操作接口）
   * @param rootDir - 项目根目录
   * @param options - 解析选项，必须包含 language
   * @param options.language - 语言标识（必填）
   * @param sourceCodeCache - 可选的源代码缓存，如果提供则优先从缓存获取，读取后自动填充
   * @returns {Promise<any>} 解析结果，根据 unit 类型返回不同格式
   */
  async parseProject(
    rootDir: string,
    options: { language?: string; [key: string]: any },
    sourceCodeCache?: Map<string, string[]>
  ): Promise<any> {
    const language = options.language!
    const config = this.registry.get(language)!

    let result: any

    switch (config.unit) {
      case 'file': {
        if (config.parseAsFiles === false) {
          result = await config.parseProject!(rootDir, options)
        } else {
          const parseResult = await this.parseProjectAsFiles(rootDir, config, options, sourceCodeCache)
          result = parseResult.result
          // parseProjectAsFiles 路径中，AST 已经处理过了，不需要额外处理
          return result
        }
        break
      }

      case 'package': {
        result = await config.parseProject!(rootDir, options)
        break
      }

      default:
        throw new Error(`Unsupported unit type: ${config.unit}`)
    }

    // 对于需要后处理的情况（parseAsFiles === false 或 package 类型），处理 AST
    const needsPostProcess = config.unit === 'package' || config.parseAsFiles === false
    if (result && needsPostProcess) {
      if (!sourceCodeCache) {
        sourceCodeCache = new Map()
      }

      // 从解析结果中提取实际被解析的文件列表
      const parsedFiles = new Set<string>()
      if (config.unit === 'package' && result.packageInfo) {
        this.extractFilesFromPackage(result.packageInfo, parsedFiles)
      } else if (config.unit === 'file' && typeof result === 'object' && !Array.isArray(result)) {
        for (const filename of Object.keys(result)) {
          parsedFiles.add(filename)
        }
      }

      // 只加载实际被解析的文件到 sourceCodeCache（按需加载）
      for (const filename of parsedFiles) {
        if (!sourceCodeCache.get(filename) && filename && fs.existsSync(filename)) {
          try {
            const content = fs.readFileSync(filename, 'utf8')
            sourceCodeCache.set(filename, content.split(/\n/))
          } catch (err) {
            logger.warn(`Failed to load source for ${filename}: ${(err as Error).message}`)
          }
        }
      }

      // 转换 Map 为 Record，传给 processProjectAstCore
      const sourceCodeCacheRecord: Record<string, string> = {}
      for (const [filepath, lines] of sourceCodeCache.entries()) {
        sourceCodeCacheRecord[filepath] = lines.join('\n')
      }

      processProjectAstCore(result, config, options, sourceCodeCacheRecord)
    }

    return result
  }

  /**
   * 并发控制：限制同时执行的 Promise 数量
   * @param tasks - 任务数组
   * @param concurrency - 最大并发数
   * @returns {Promise<T[]>} 所有任务的结果（保持输入顺序）
   */
  private async limitConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length)
    let index = 0

    const executeTask = async (taskIndex: number) => {
      // parseFile 内部已经捕获异常并返回 null，任务不会抛出异常
      const result = await tasks[taskIndex]()
      results[taskIndex] = result
    }

    const workers: Array<Promise<void>> = []

    const createWorker = () => {
      return (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const currentIndex = index
          if (currentIndex >= tasks.length) {
            break
          }
          index = currentIndex + 1
          // eslint-disable-next-line no-await-in-loop
          await executeTask(currentIndex)
        }
      })()
    }

    for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
      workers.push(createWorker())
    }

    await Promise.all(workers)
    return results
  }

  /**
   * 将项目作为文件集合解析（单文件语言）
   * @param rootDir - 项目根目录
   * @param config - 语言配置
   * @param options - 解析选项
   * @param sourceCodeCache - 可选的源代码缓存，如果提供则优先从缓存获取，读取后自动填充
   * @returns {Promise<{ result: Record<string, any> }>} 文件解析结果映射
   */
  private async parseProjectAsFiles(
    rootDir: string,
    config: LanguageParserConfig,
    options: Record<string, any>,
    sourceCodeCache?: Map<string, string[]>
  ): Promise<{ result: Record<string, any> }> {
    const language = options.language!
    const enableIncremental = this.shouldEnableIncremental(language)

    // parseAsFiles 模式下，先调用 config.parseProject 做语言特定的初始化（如 PHP tree-sitter WASM 加载）
    if (config.parseProject) {
      await config.parseProject(rootDir, options)
    }

    performanceTracker.record('preProcess.parseCode.loadFiles').start()
    // 1. 先获取文件列表（使用 globby，只获取路径，不读取内容）
    const filePaths = globby.sync(config.filePatterns, { cwd: rootDir })
    const fullFilePaths = filePaths.map((file: string) => path.join(rootDir, file))

    // 2. 批量异步并行读取所有文件内容（限制并发数）
    type FileContent = { file: string; content: string }
    const fileContents: FileContent[] = await this.limitConcurrency<FileContent>(
      fullFilePaths.map((filepath: string) => async () => {
        // 优先从 sourceCodeCache 获取，否则读取文件
        if (sourceCodeCache && sourceCodeCache.get(filepath)) {
          return { file: filepath, content: sourceCodeCache.get(filepath)!.join('\n') }
        }
        try {
          const content = await fs.promises.readFile(filepath, 'utf8')
          // 如果提供了 sourceCodeCache，自动填充
          if (sourceCodeCache) {
            sourceCodeCache.set(filepath, content.split(/\n/))
          }
          return { file: filepath, content }
        } catch (err) {
          logger.warn(`Failed to read file: ${filepath}, error: ${(err as Error).message}`)
          return { file: filepath, content: '' }
        }
      }),
      MAX_CONCURRENCY
    )

    performanceTracker.record('preProcess.parseCode.loadFiles').end()

    // 过滤掉读取失败的文件
    const files: FileContent[] = fileContents.filter((f: FileContent) => f.content !== '')

    // 3. 检查缓存并分离需要解析的文件
    let filesToParse: Array<{ file: string; content: string }> = []
    let cachedResults: Map<string, any> = new Map()
    let cacheList: Map<string, { jsonFile: string; crc: string; time?: string }> | undefined

    // 判断是否需要加载缓存：false 模式和 force 模式不读取缓存
    const shouldLoadCache = enableIncremental && Config.incremental !== 'force'
    if (shouldLoadCache) {
      performanceTracker.record('preProcess.parseCode.loadCache').start()
      const result = await this.loadCache(files)
      filesToParse = result.filesToParse
      cachedResults = result.cachedResults
      cacheList = result.cacheList
      performanceTracker.record('preProcess.parseCode.loadCache').end()
    } else {
      // false 模式和 force 模式：不读取缓存，所有文件都需要重新解析
      filesToParse = [...files]
    }

    // 4. 并发解析需要解析的文件
    performanceTracker.record('preProcess.parseCode.parseFiles').start()
    const parsedResults = await this.parseFilesConcurrently(filesToParse, language, options, config, sourceCodeCache)
    performanceTracker.record('preProcess.parseCode.parseFiles').end()

    // 4. 合并缓存结果和解析结果
    // 注意：最终返回的 AST 必须包含 parent 属性（用于后续分析）
    const results = files.map((file: FileContent) => {
      const cached = cachedResults.get(file.file)
      if (cached) {
        // 从缓存加载的 AST 没有 parent（因为保存时跳过了）
        // 需要重新添加 parent、sourcefile 和 hash
        // 确保 sourceCodeCache 被填充，即使是从缓存加载的 AST
        if (sourceCodeCache && !sourceCodeCache.get(file.file)) {
          sourceCodeCache.set(file.file, file.content.split(/\n/))
        }
        const fileOptions = { ...options, sourcefile: file.file }
        // processParsedAstCore 会调用 annotateAST，重新添加 parent 属性
        // 优化：从缓存加载的 AST 如果已有 hash，跳过重新计算
        const ast = processParsedAstCore(cached, file.content, fileOptions, config, true)
        return {
          file: file.file,
          content: file.content,
          ast, // 此时 ast 已包含 parent
        }
      }
      // 新解析的 AST 已经通过 processParsedAstCore 处理，包含 parent
      return (
        parsedResults.find((r) => r.file === file.file) || {
          file: file.file,
          content: file.content,
          ast: null,
        }
      )
    })

    // 6. 保存新解析的 AST 到缓存（增量模式）
    // force 模式：强制重新解析所有文件，不使用缓存，但解析完成后要保存缓存（下次可用）
    if (enableIncremental && parsedResults.length > 0) {
      performanceTracker.record('preProcess.parseCode.saveCache').start()
      await this.saveCache(cacheList, parsedResults)
      performanceTracker.record('preProcess.parseCode.saveCache').end()
    }

    return { result: this.buildResultMap(results) }
  }

  /**
   * 并发解析文件（使用 Worker 线程或 Promise 并发）
   * @param files - 要解析的文件列表（已经过滤掉缓存命中的文件）
   * @param language - 编程语言
   * @param options - 解析选项
   * @param config - 语言配置
   * @param sourceCodeCache - 源代码缓存（可选，如果提供则会被填充）
   * @returns {Promise<Array<{ file: string; content: string; ast: any }>>} 解析结果数组
   */
  private async parseFilesConcurrently(
    files: Array<{ file: string; content: string }>,
    language: string,
    options: Record<string, any>,
    config: LanguageParserConfig,
    sourceCodeCache?: Map<string, string[]>
  ): Promise<Array<{ file: string; content: string; ast: any }>> {
    type FileContent = { file: string; content: string }
    type ParseResult = { file: string; content: string; ast: any }

    if (files.length === 0) {
      return []
    }

    // 根据文件数量决定使用 Worker 线程还是 Promise 并发解析
    const MIN_FILES_FOR_WORKER = 10
    const shouldUseWorkers = this.useWorkers && files.length >= MIN_FILES_FOR_WORKER
    const workerPool = shouldUseWorkers ? this.getWorkerPool() : null

    let parsedResults: ParseResult[] = []

    if (shouldUseWorkers && workerPool) {
      // 使用子进程模式
      const parsePromises = files.map(async (file: FileContent): Promise<ParseResult> => {
        // OOM 降级：累计 2 次非正常退出后，后续文件走主线程
        if (workerPool.oomCount >= 2) {
          const fileOptions = { ...options, sourcefile: file.file }
          const ast = this.parseFile(file.file, file.content, fileOptions, config, sourceCodeCache)
          return { file: file.file, content: file.content, ast }
        }

        const minimalOptions: Record<string, any> = { sourcefile: file.file }
        if (language === 'javascript' || language === 'js') {
          minimalOptions.sanity = options.sanity
        }

        SourceLine.storeCode(file.file, file.content)

        try {
          const parseResult = await workerPool.submitTask('parse', {
            filepath: file.file,
            content: file.content,
            language,
            options: minimalOptions,
            config: {
              unit: config.unit,
              needsSourcefile: config.needsSourcefile,
              maindirPrefix: Config.maindirPrefix,
            },
          })

          if (parseResult.error) {
            logger.warn(`Failed to parse ${file.file} in worker: ${parseResult.error}`)
            return { file: file.file, content: file.content, ast: null }
          }

          // 子进程已做完整 processAst，但 IPC 序列化丢了 parent，补回来
          const fileOptions = { ...minimalOptions, sourcefile: file.file }
          const ast = processParsedAstCore(parseResult.ast, file.content, fileOptions, config, true)
          return { file: file.file, content: file.content, ast }
        } catch (error) {
          // 子进程崩溃（OOM 等），回退到主线程重试
          logger.warn(`Worker failed for ${file.file}: ${(error as Error).message}, retrying on main thread`)
          const fileOptions = { ...options, sourcefile: file.file }
          const ast = this.parseFile(file.file, file.content, fileOptions, config, sourceCodeCache)
          return { file: file.file, content: file.content, ast }
        }
      })

      parsedResults = await Promise.all(parsePromises)

      // 打印子进程性能统计
      const workerStats = workerPool.getStats()
      if (workerStats.workerWorkTimes) {
        const workerTimeStr = Object.entries(workerStats.workerWorkTimes)
          .map(([workerId, time]) => `W${workerId}:${(time as number).toFixed(0)}ms`)
          .join(', ')
        yasaLog(`Work time: ${workerTimeStr}`, PREPROCESS_PARSE_CODE_STAGE)
      }
      if (workerPool.oomCount > 0) {
        yasaLog(`OOM fallbacks: ${workerPool.oomCount}`, PREPROCESS_PARSE_CODE_STAGE)
      }

      // 解析完成后立即释放子进程池
      await this.cleanupWorkerPool()
    } else {
      // 使用 Promise 并发解析
      parsedResults = await this.limitConcurrency<ParseResult>(
        files.map((file: FileContent) => async () => {
          const fileOptions = { ...options, sourcefile: file.file }
          const ast = this.parseFile(file.file, file.content, fileOptions, config, sourceCodeCache)
          return {
            file: file.file,
            content: file.content,
            ast,
          }
        }),
        MAX_CONCURRENCY
      )
    }

    return parsedResults
  }

  /**
   * 构建结果映射
   * @param results - 文件解析结果数组
   * @returns {Record<string, any>} 文件路径到 AST 的映射
   */
  private buildResultMap(results: Array<{ file: string; content?: string; ast: any }>): Record<string, any> {
    const resultMap: Record<string, any> = {}
    for (const result of results) {
      resultMap[result.file] = result.ast
    }
    return resultMap
  }

  /**
   * 从缓存加载 AST 并分离需要解析的文件
   * @param files - 已加载的文件内容数组
   * @returns {Promise<{filesToParse: Array<{file: string; content: string}>, cachedResults: Map<string, any>, cacheList: Map<string, {jsonFile: string; crc: string; time?: string}> | undefined}>} 需要解析的文件、缓存的 AST 和缓存列表
   */
  private async loadCache(files: Array<{ file: string; content: string }>): Promise<{
    filesToParse: Array<{ file: string; content: string }>
    cachedResults: Map<string, any>
    cacheList: Map<string, { jsonFile: string; crc: string; time?: string }> | undefined
  }> {
    const filesToParse: Array<{ file: string; content: string }> = []
    const cachedResults: Map<string, any> = new Map()

    // 读取缓存列表
    const cacheList = await loadCacheList()
    const cacheDir = getCacheDir()

    // 限制并发加载缓存文件数量，避免 "too many open files" 错误
    const MAX_CONCURRENT_CACHE_LOADS = Math.max(require('os').cpus().length, 16)
    const cacheCheckTasks = files.map((file: { file: string; content: string }) => {
      return async () => {
        const relativePath = getRelativePath(file.file)
        const cacheInfo = cacheList.get(relativePath)

        if (cacheInfo) {
          const sourceCrc = md5(file.content)
          if (cacheInfo.crc === sourceCrc) {
            // 尝试加载缓存
            const jsonPath = path.join(cacheDir, cacheInfo.jsonFile)
            const ast = await loadAstFromCacheCore(jsonPath)
            if (ast) {
              return { file: file.file, ast, cached: true }
            }
            // 缓存加载失败，需要重新解析
          }
        }
        return { file: file.file, ast: null, cached: false }
      }
    })

    const cacheCheckResults = await this.limitConcurrency(cacheCheckTasks, MAX_CONCURRENT_CACHE_LOADS)
    for (const result of cacheCheckResults) {
      if (result.cached && result.ast) {
        cachedResults.set(result.file, result.ast)
      } else {
        const file = files.find((f) => f.file === result.file)
        if (file) {
          filesToParse.push(file)
        }
      }
    }

    // 输出缓存命中率
    const cachedFilesCount = cachedResults.size
    const cacheHitRate = files.length > 0 ? ((cachedFilesCount / files.length) * 100).toFixed(1) : '0.0'
    yasaLog(`hit Cache: ${cachedFilesCount}/${files.length} (${cacheHitRate}%)`, PREPROCESS_PARSE_CODE_STAGE)

    return { filesToParse, cachedResults, cacheList }
  }

  /**
   * 保存缓存（保存新解析的 AST 到缓存文件，并更新缓存列表文件）
   *
   * 重要：保存到缓存文件的 AST 不包含 parent 属性（序列化时跳过）
   * - parent 是循环引用，无法序列化
   * - 保存时跳过 parent 可以避免序列化问题和减少文件大小
   * - 从缓存加载后，会通过 processParsedAstCore 重新添加 parent
   *
   * @param existingCacheList - 现有的缓存列表（可能为 undefined）
   * @param parsedResults - 解析结果数组（AST 包含 parent，但保存时会跳过）
   */
  private async saveCache(
    existingCacheList: Map<string, { jsonFile: string; crc: string; time?: string }> | undefined,
    parsedResults: Array<{ file: string; content: string; ast: any }>
  ): Promise<void> {
    try {
      // 限制并发保存缓存文件数量，避免 "too many open files" 错误
      // 1. 并行保存所有 AST 到缓存文件（限制并发数）
      // 注意：parsedResults 中的 AST 包含 parent，但保存时会跳过（通过 skipParentReplacer）
      const cacheSaveTasks = parsedResults
        .filter((result) => result.ast)
        .map((result) => {
          return async () => {
            try {
              // 计算缓存路径
              const relativePath = getRelativePath(result.file)
              const cacheDir = getCacheDir()
              const astCacheSubDir = 'astcache'
              const jsonFileName = `${md5(relativePath)}.json`
              const jsonFile = path.join(astCacheSubDir, jsonFileName)
              const jsonPath = path.join(cacheDir, jsonFile)

              // 直接保存 AST（saveAstToCacheCore 内部会使用 skipParentReplacer 跳过 parent 属性）
              // 序列化时跳过 parent，但原 AST 对象保持不变（仍然有 parent，用于返回给用户）
              // 避免先序列化再解析，减少内存使用
              const success = await saveAstToCacheCore(result.ast, jsonPath)
              if (success) {
                const sourceCrc = md5(result.content)
                const timestamp = new Date().toISOString()
                return {
                  relativePath,
                  jsonFile,
                  crc: sourceCrc,
                  time: timestamp,
                }
              }
              return null
            } catch (error) {
              logger.warn(`Failed to save cache for ${result.file}: ${(error as Error).message}`)
              return null
            }
          }
        })

      const cacheInfos = await this.limitConcurrency(cacheSaveTasks, MAX_CONCURRENCY)
      const validCacheInfos = cacheInfos.filter(
        (info): info is { relativePath: string; jsonFile: string; crc: string; time: string } => info !== null
      )

      if (validCacheInfos.length === 0) {
        return
      }

      // 2. 合并现有缓存列表和新缓存信息
      const cacheListArray: Array<{ path: string; jsonFile: string; crc: string; time?: string }> = []

      if (existingCacheList) {
        for (const [cachePath, info] of existingCacheList.entries()) {
          const willBeUpdated = validCacheInfos.some((newInfo) => newInfo.relativePath === cachePath)
          if (!willBeUpdated) {
            cacheListArray.push({
              path: cachePath,
              jsonFile: info.jsonFile,
              crc: info.crc,
              time: info.time,
            })
          }
        }
      }

      for (const cacheInfo of validCacheInfos) {
        cacheListArray.push({
          path: cacheInfo.relativePath,
          jsonFile: cacheInfo.jsonFile,
          crc: cacheInfo.crc,
          time: cacheInfo.time,
        })
      }

      // 3. 保存缓存列表文件
      const cacheDir = getCacheDir()
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true })
      }
      const listPath = path.join(cacheDir, 'ast-cache-list.json')
      await fs.promises.writeFile(listPath, JSON.stringify(cacheListArray, null, 2), 'utf8')
    } catch (error) {
      logger.warn(`Failed to save cache list: ${(error as Error).message}`)
    }
  }

  /**
   * 检查是否应该启用增量解析
   * @param language - 语言标识
   * @returns {boolean} 是否启用增量解析
   */
  private shouldEnableIncremental(language: string): boolean {
    const config = this.registry.get(language)
    if (!config || !config.supportsIncremental) return false
    return Config.incremental !== false && Config.incremental !== 'false'
  }

  /**
   * 从 package 信息中递归提取文件路径
   * @param packageInfo - package 信息对象
   * @param filesSet - 文件路径集合（用于收集结果）
   */
  private extractFilesFromPackage(packageInfo: any, filesSet: Set<string>): void {
    if (packageInfo.files) {
      for (const filename of Object.keys(packageInfo.files)) {
        filesSet.add(filename)
      }
    }
    if (packageInfo.subs) {
      for (const subPackage of Object.values(packageInfo.subs)) {
        this.extractFilesFromPackage(subPackage, filesSet)
      }
    }
  }

  // =================== 增量缓存管理 ===================

  /**
   * 导出所有 AST 到文件
   * @param {string} rootDir - 项目根目录
   * @param {string} reportDir - 输出目录
   * @param {Record<string, any>} options - 解析选项，必须包含 language
   * @param {string} options.language - 语言标识（必填）
   * @returns {Promise<void>}
   */
  async dumpAllAST(
    rootDir: string,
    reportDir: string,
    options: { language?: string; [key: string]: any }
  ): Promise<void> {
    const language = options.language!
    const config = this.registry.get(language)!

    const results = await this.parseProject(rootDir, options)
    await dumpAllASTCore(results, reportDir, config)
  }
}

// =============== 创建单例并导出接口 ==============

const parser = new BaseParser()

/**
 * 解析单个文件（用户操作接口）
 * @param filepath - 文件路径
 * @param options - 解析选项，必须包含 language
 * @param options.language - 语言标识（必填）
 * @param sourceCodeCache - 可选的源代码缓存，如果提供则优先从缓存获取，读取后自动填充
 * @returns {any} 解析后的 AST
 * @throws {Error} 如果解析失败
 */
function parseSingleFile(
  filepath: string,
  options: { language?: string; [key: string]: any },
  sourceCodeCache?: Map<string, string[]>
): any {
  return parser.parseSingleFile(filepath, options, sourceCodeCache)
}

/**
 * 解析项目/包（用户操作接口）
 * @param {string} rootDir - 项目根目录
 * @param {Record<string, any>} options - 解析选项，必须包含 language
 * @param {string} options.language - 语言标识（必填）
 * @param {Map<string, string>} [sourceCodeCache] - 可选的源代码缓存，如果提供则优先从缓存获取，读取后自动填充
 * @returns {Promise<any>} 解析结果，根据 unit 类型返回不同格式
 */
async function parseProject(
  rootDir: string,
  options: { language?: string; [key: string]: any },
  sourceCodeCache?: Map<string, string[]>
): Promise<any> {
  return parser.parseProject(rootDir, options, sourceCodeCache)
}

/**
 * 导出所有 AST 到文件
 * @param {string} rootDir - 项目根目录
 * @param {string} reportDir - 输出目录
 * @param {Record<string, any>} options - 解析选项，必须包含 language
 * @param {string} options.language - 语言标识（必填）
 * @returns {Promise<void>}
 */
async function dumpAllAST(
  rootDir: string,
  reportDir: string,
  options: { language?: string; [key: string]: any }
): Promise<void> {
  return parser.dumpAllAST(rootDir, reportDir, options)
}

// ================== 导出接口 ====================

module.exports = {
  parseSingleFile,
  parseProject,
  dumpAllAST,
}
