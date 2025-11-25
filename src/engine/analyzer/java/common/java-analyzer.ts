/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-unused-vars, @typescript-eslint/no-use-before-define */
import JavaTypeRelatedInfoResolver from '../../../../resolver/java/java-type-related-info-resolver'

const _ = require('lodash')
const fs = require('fs')
const path = require('path')
const flatted = require('flatted')
const UastSpec = require('@ant-yasa/uast-spec')
const FileUtil = require('../../../../util/file-util')
const logger = require('../../../../util/logger')(__filename)
const Scope = require('../../common/scope')
const Parsing = require('../../../parser/parsing')
const JavaInitializer = require('./java-initializer')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const {
  ValueUtil: { FunctionValue, Scoped, PackageValue, PrimitiveValue },
} = require('../../../util/value-util')
const { Analyzer } = require('../../common')
const CheckerManager = require('../../common/checker-manager')
const CurrentEntryPoint = require('../../common/current-entrypoint')
const Constant = require('../../../../util/constant')
const Config = require('../../../../config')
const { handleException } = require('../../common/exception-handler')
const UndefinedValue = require('../../common/value/undefine')
const { md5 } = require('../../../../util/hash-util')
const { yasaLog } = require('../../../../util/format-util')

/**
 * Java 代码分析器
 */
class JavaAnalyzer extends (Analyzer as any) {
  /**
   * 构造函数
   * @param options - 分析器选项
   */
  constructor(options: any) {
    const checkerManager = new CheckerManager(
      options,
      options.checkerIds,
      options.checkerPackIds,
      options.printers,
      BasicRuleHandler
    )
    super(checkerManager, options)
    this.classMap = new Map()
    this.typeResolver = new JavaTypeRelatedInfoResolver()
  }

  /**
   * 预处理单个文件
   * @param source - 源代码内容
   * @param fileName - 文件名
   */
  preProcess4SingleFile(source: any, fileName: any) {
    // init global scope
    JavaInitializer.initGlobalScope(this.topScope)

    // time-out control
    ;(this as any).thisIterationTime = 0
    ;(this as any).prevIterationTime = new Date().getTime()

    this.preloadFileToPackage(source, fileName)
    for (const unprocessedFileScope of (this as any).unprocessedFileScopes) {
      if (unprocessedFileScope.isProcessed) continue
      const state = this.initState(unprocessedFileScope)
      this.processInstruction(unprocessedFileScope, unprocessedFileScope.ast, state)
    }
    ;(this as any).unprocessedFileScopes.clear()
    delete (this as any).unprocessedFileScopes

    JavaInitializer.initPackageScope(this.topScope.packageManager)

    this.assembleClassMap(this.topScope.packageManager)
  }

  /**
   * 扫描项目目录，解析 Java 文件并预构建包作用域
   *
   * @param dir - 项目目录
   */
  // eslint-disable-next-line complexity
  async scanPackages(dir: any) {
    const packageFiles = FileUtil.loadAllFileTextGlobby(['**/*.java', '!target/**', '!**/src/test/**'], dir)
    if (packageFiles.length === 0) {
      handleException(
        null,
        'find no target compileUnit of the project : no java file found in source path',
        'find no target compileUnit of the project : no java file found in source path'
      )
      process.exit(1)
    }
    ;(this as any).unprocessedFileScopes = new Set()
    const PARSE_CODE_STAGE = 'preProcess.parseCode'
    const PRELOAD_STAGE = 'preProcess.preload'
    this.performanceTracker.start(PARSE_CODE_STAGE)
    this.performanceTracker.start(PRELOAD_STAGE)

    // 根据配置决定是否使用缓存优化
    // incremental: true/false/force
    // - false: 完全不生成和读取 json（禁用缓存，默认值）
    // - true: 正常流程（读取缓存，如果变化则重新解析并更新）
    // - force: 无论有无变化，都重新生成然后存储 json（强制重新解析但保存缓存）
    const incremental = Config.incremental !== false && Config.incremental !== 'false' // 需要显式配置为 true 或 force 才启用
    const forceReparse = Config.incremental === 'force' // 强制重新解析
    const disableCache = Config.incremental === false || Config.incremental === 'false' // 禁用缓存

    // 加载缓存 list 文件（只有在启用缓存且不是 force 模式时才加载）
    const cacheList = !disableCache && !forceReparse ? await this.loadCacheList() : new Map()

    if (disableCache) {
      // 禁用缓存模式：完全不生成和读取 json
      for (const packageFile of packageFiles) {
        this.preloadFileToPackage(packageFile.content, packageFile.file, null)
      }
    } else if (forceReparse) {
      // force 模式：无论有无变化，都重新生成然后存储 json
      const cacheEntries: Array<{ path: string; jsonFile: string; crc: string; time?: string }> = []
      const savePromises: Array<
        Promise<{ relativePath: string; jsonFile: string; crc: string; time?: string } | null>
      > = []

      for (const packageFile of packageFiles) {
        // 强制重新解析，但保存缓存
        const savePromise = this.preloadFileToPackageAsync(packageFile.content, packageFile.file)
        savePromises.push(savePromise)
      }

      // 等待所有保存完成后再更新 list 文件
      if (savePromises.length > 0) {
        Promise.all(savePromises)
          .then((savedInfos) => {
            for (const info of savedInfos) {
              if (info) {
                cacheEntries.push({
                  path: info.relativePath,
                  jsonFile: info.jsonFile,
                  crc: info.crc,
                  time: info.time,
                })
              }
            }
            if (cacheEntries.length > 0) {
              return this.saveCacheList(cacheEntries)
            }
          })
          .catch((err) => {
            logger.warn(`Failed to save cache list: ${err.message}`)
          })
      }
    } else if (incremental) {
      // 并发加载所有文件的缓存（优化模式）
      const cacheLoadStart = Date.now()
      const cacheLoadPromises = packageFiles.map((packageFile: any) =>
        this.loadAstFromCache(packageFile.content, packageFile.file, cacheList)
      )
      const cacheResults = await Promise.all(cacheLoadPromises)
      const cacheLoadTime = Date.now() - cacheLoadStart

      // 统计从缓存加载的文件数量
      const cachedCount = cacheResults.filter((r) => r.loadedFromCache).length
      const totalCount = packageFiles.length

      // 记录缓存加载时间作为 parseCode 的子步骤
      if (cacheLoadTime > 0) {
        this.performanceTracker.record('preProcess.parseCode.loadCache', cacheLoadTime)
      }

      // 处理所有文件（使用缓存的 AST 或重新解析）
      // 同时收集需要保存的缓存信息
      const cacheEntries: Array<{ path: string; jsonFile: string; crc: string; time?: string }> = []
      const savePromises: Array<
        Promise<{ relativePath: string; jsonFile: string; crc: string; time?: string } | null>
      > = []

      for (let i = 0; i < packageFiles.length; i++) {
        const packageFile = packageFiles[i]
        const cacheResult = cacheResults[i]

        if (!cacheResult.loadedFromCache || cacheResult.needsUpdate) {
          // 需要重新解析（包括 CRC 变化的情况），解析后保存缓存
          const savePromise = this.preloadFileToPackageAsync(packageFile.content, packageFile.file)
          savePromises.push(savePromise)
        } else {
          // 从缓存加载，直接使用
          this.preloadFileToPackage(packageFile.content, packageFile.file, cacheResult.ast)

          // 保留 list 中的记录（即使从缓存加载，也保留原有记录）
          const relativePath = this.getRelativePath(packageFile.file)
          const existingInfo = cacheList.get(relativePath)
          if (existingInfo) {
            cacheEntries.push({
              path: relativePath,
              jsonFile: existingInfo.jsonFile,
              crc: existingInfo.crc,
              time: existingInfo.time,
            })
          }
        }
      }

      // 等待所有缓存保存完成（异步等待，不阻塞主流程）
      Promise.all(savePromises)
        .then((savedInfos) => {
          // 收集所有保存成功的缓存信息（包括新保存的和需要更新的）
          for (const info of savedInfos) {
            if (info) {
              // 查找是否已存在相同路径的记录，如果存在则更新
              const existingIndex = cacheEntries.findIndex((e) => e.path === info.relativePath)
              if (existingIndex >= 0) {
                // 更新现有记录（CRC 变化的情况）
                cacheEntries[existingIndex] = {
                  path: info.relativePath,
                  jsonFile: info.jsonFile,
                  crc: info.crc,
                  time: info.time,
                }
              } else {
                // 添加新记录
                cacheEntries.push({
                  path: info.relativePath,
                  jsonFile: info.jsonFile,
                  crc: info.crc,
                  time: info.time,
                })
              }
            }
          }
          // 保存更新后的 list 文件
          if (cacheEntries.length > 0) {
            return this.saveCacheList(cacheEntries)
          }
        })
        .catch((err) => {
          logger.warn(`Failed to save cache list: ${err.message}`)
        })

      // 输出缓存加载统计（不输出每个文件的详细信息）
      if (cachedCount > 0) {
        yasaLog(`Loaded ${cachedCount}/${totalCount} AST files from cache (${cacheLoadTime}ms)`, 'preProcess')
      }
    }

    this.performanceTracker.end(PRELOAD_STAGE)
    this.performanceTracker.end(PARSE_CODE_STAGE)
    // 开始 ProcessModule 阶段：处理所有文件作用域（分析 AST）
    const PROCESS_MODULE_STAGE = 'preProcess.processModule'
    this.performanceTracker.start(PROCESS_MODULE_STAGE)
    for (const unprocessedFileScope of (this as any).unprocessedFileScopes) {
      if (unprocessedFileScope.isProcessed) continue
      // unprocessedFileScope.isProcessed = true;
      const state = this.initState(unprocessedFileScope)
      this.processInstruction(unprocessedFileScope, unprocessedFileScope.ast, state)
    }
    ;(this as any).unprocessedFileScopes.clear()
    delete (this as any).unprocessedFileScopes
    this.performanceTracker.end('preProcess.processModule')

    // 输出时间统计（performanceTracker 已自动输出各阶段耗时）
  }

  /**
   * preload built-in packages
   */
  preloadBuiltinToPackage() {
    // this._preloadBuiltinToPackage('java.util', 'ArrayList', (arrayList as any))
  }

  /**
   * 预加载内置包到包管理器
   * @param packageName - 包名
   * @param className - 类名
   * @param methods - 方法集合
   */
  _preloadBuiltinToPackage(packageName: string, className: string, methods: any) {
    const packageScope = this.packageManager.getSubPackage(packageName, true)
    const classScope = Scope.createSubScope(className, packageScope, 'class')
    if (!packageScope.exports) {
      packageScope.exports = Scoped({
        sid: 'exports',
        id: 'exports',
        parent: packageScope,
      })
    }
    packageScope.exports.value[className] = classScope
    const qualifiedName = Scope.joinQualifiedName(packageScope.qid, className)
    classScope.sort = qualifiedName
    classScope.qid = qualifiedName
    for (const prop in methods) {
      const method = methods[prop]
      const targetQid = `${classScope.qid}.${prop}`
      classScope.value[prop] = FunctionValue({
        sid: prop,
        qid: targetQid,
        parent: classScope,
        execute: method.bind(this),
        _this: classScope,
      })
      ;(this as any).funcSymbolTable[targetQid] = classScope.value[prop]
    }
  }

  /**
   * 获取缓存目录路径
   * @returns {string} 缓存目录的绝对路径
   */
  getCacheDir(): string {
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
   * 获取相对于 sourcePath 的路径
   * @param filename - 文件的绝对路径
   * @returns {string} 相对路径
   */
  getRelativePath(filename: string): string {
    const sourceDir = Config.maindir || ''
    if (!sourceDir || !filename) {
      return filename
    }
    // 标准化路径，确保使用统一的分隔符
    const normalizedSource = path.normalize(sourceDir).replace(/\\/g, '/')
    const normalizedFile = path.normalize(filename).replace(/\\/g, '/')
    if (normalizedFile.startsWith(normalizedSource)) {
      let relative = normalizedFile.substring(normalizedSource.length)
      // 移除开头的斜杠
      if (relative.startsWith('/')) {
        relative = relative.substring(1)
      }
      return relative
    }
    // 如果不在 sourceDir 下，返回原路径
    return filename
  }

  /**
   * 从缓存 list 文件加载所有缓存信息
   * @returns {Promise<Map<string, {jsonFile: string, crc: string, time?: string}>>} 相对路径到缓存信息的映射
   */
  async loadCacheList(): Promise<Map<string, { jsonFile: string; crc: string; time?: string }>> {
    return new Promise((resolve) => {
      const cacheDir = this.getCacheDir()
      const listPath = path.join(cacheDir, 'ast-cache-list.json')

      fs.readFile(listPath, 'utf8', (err: NodeJS.ErrnoException | null, content: string) => {
        if (err) {
          // list 文件不存在，返回空映射
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

  /**
   * 保存缓存 list 文件
   * @param cacheList - 缓存列表数据（包含 path, jsonFile, crc, time）
   */
  async saveCacheList(cacheList: Array<{ path: string; jsonFile: string; crc: string; time?: string }>): Promise<void> {
    return new Promise((resolve) => {
      try {
        const cacheDir = this.getCacheDir()
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true })
        }

        const listPath = path.join(cacheDir, 'ast-cache-list.json')
        // list 文件要格式化，方便人阅读
        fs.writeFile(listPath, JSON.stringify(cacheList, null, 2), 'utf8', (err: NodeJS.ErrnoException | null) => {
          if (err) {
            logger.warn(`Failed to save cache list: ${err.message}`)
          }
          resolve()
        })
      } catch (error) {
        logger.warn(`Failed to save cache list: ${(error as Error).message}`)
        resolve()
      }
    })
  }

  /**
   * 从缓存加载 AST（异步，支持并发）
   * @param source - 源代码内容
   * @param filename - 文件的绝对路径
   * @param cacheList - 缓存列表映射
   * @returns {Promise<{ast: any, loadedFromCache: boolean, needsUpdate: boolean}>} AST、是否从缓存加载、是否需要更新
   */
  async loadAstFromCache(
    source: any,
    filename: any,
    cacheList: Map<string, { jsonFile: string; crc: string; time?: string }>
  ): Promise<{ ast: any; loadedFromCache: boolean; needsUpdate: boolean }> {
    return new Promise((resolve) => {
      const relativePath = this.getRelativePath(filename)
      const cacheInfo = cacheList.get(relativePath)

      // 计算源代码的 CRC（使用 MD5）
      const sourceCrc = md5(source)

      if (!cacheInfo) {
        // list 中没有记录，需要重新解析并更新
        resolve({ ast: null, loadedFromCache: false, needsUpdate: true })
        return
      }

      // 检查 CRC 是否匹配
      if (cacheInfo.crc !== sourceCrc) {
        // CRC 不匹配，需要重新解析并更新 list
        resolve({ ast: null, loadedFromCache: false, needsUpdate: true })
        return
      }

      // CRC 匹配，从 JSON 文件加载 AST
      const cacheDir = this.getCacheDir()
      // jsonFile 可能包含子目录路径（如 "astcache/filename.json"），直接使用
      const jsonPath = path.join(cacheDir, cacheInfo.jsonFile)

      fs.readFile(jsonPath, 'utf8', (err: NodeJS.ErrnoException | null, astContent: string) => {
        if (err) {
          // JSON 文件不存在，需要重新解析并更新
          resolve({ ast: null, loadedFromCache: false, needsUpdate: true })
          return
        }

        try {
          // JSON 文件只包含 flatted 格式的 AST 字符串（未格式化，更快）
          const ast = flatted.parse(astContent)
          resolve({ ast, loadedFromCache: true, needsUpdate: false })
        } catch (error) {
          // JSON 文件损坏，需要重新解析并更新
          logger.warn(`Failed to parse AST cache for ${relativePath}: ${(error as Error).message}`)
          resolve({ ast: null, loadedFromCache: false, needsUpdate: true })
        }
      })
    })
  }

  /**
   * 保存 AST 到缓存（异步）
   * @param ast - AST 对象
   * @param source - 源代码内容
   * @param filename - 文件的绝对路径
   * @returns {Promise<{relativePath: string, jsonFile: string, crc: string, time: string}>} 缓存信息
   */
  async saveAstToCache(
    ast: any,
    source: any,
    filename: any
  ): Promise<{ relativePath: string; jsonFile: string; crc: string; time: string } | null> {
    return new Promise((resolve) => {
      try {
        const cacheDir = this.getCacheDir()

        // 确保目录存在
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true })
        }

        // 获取相对路径
        const relativePath = this.getRelativePath(filename)

        // 使用 hash 生成 JSON 文件名（避免文件名过长）
        // JSON 文件保存在 astcache 子目录中
        const astCacheSubDir = 'astcache'
        const jsonFileName = `${md5(relativePath)}.json`
        const jsonFile = path.join(astCacheSubDir, jsonFileName)
        const astCacheDir = path.join(cacheDir, astCacheSubDir)

        // 确保 astcache 子目录存在
        if (!fs.existsSync(astCacheDir)) {
          fs.mkdirSync(astCacheDir, { recursive: true })
        }

        const jsonPath = path.join(astCacheDir, jsonFileName)

        // 计算源代码的 CRC
        const sourceCrc = md5(source)

        // 使用 flatted 序列化 AST（只保存 AST，不包含其他信息，不格式化以提升性能）
        const astSerialized = flatted.stringify(ast)

        // 生成时间戳
        const timestamp = new Date().toISOString()

        // 保存 AST 到 JSON 文件（不格式化，提升序列化/反序列化速度）
        fs.writeFile(jsonPath, astSerialized, 'utf8', (err: NodeJS.ErrnoException | null) => {
          if (err) {
            logger.warn(`Failed to write AST cache for ${relativePath}: ${err.message}`)
            resolve(null)
            return
          }

          // 返回缓存信息，用于更新 list 文件
          resolve({
            relativePath,
            jsonFile,
            crc: sourceCrc,
            time: timestamp,
          })
        })
      } catch (error) {
        logger.warn(`Failed to write AST cache for ${filename}: ${(error as Error).message}`)
        resolve(null)
      }
    })
  }

  /**
   * 解析文件并预加载到包管理器（异步版本，返回缓存信息）
   * @param source - 源代码内容
   * @param filename - 文件名
   * @returns {Promise<{relativePath: string, jsonFile: string, crc: string, time: string} | null>} 缓存信息
   */
  async preloadFileToPackageAsync(
    source: any,
    filename: any
  ): Promise<{ relativePath: string; jsonFile: string; crc: string; time: string } | null> {
    return new Promise((resolve) => {
      this.preloadFileToPackage(source, filename, undefined, (cacheInfo) => {
        resolve(cacheInfo)
      })
    })
  }

  /**
   * 解析文件并预加载到包管理器
   *
   * 注意：此方法在循环中被调用多次，每个文件的 parseCode 和 preload 时间都会累加到总时间中。
   *
   * @param source - 源代码内容
   * @param filename - 文件名
   * @param cachedAst - 从缓存加载的 AST（如果存在）
   * @param onCacheSaved - 缓存保存后的回调函数
   * @returns {any} 包作用域和文件作用域
   */
  preloadFileToPackage(
    source: any,
    filename: any,
    cachedAst?: any,
    onCacheSaved?: (cacheInfo: { relativePath: string; jsonFile: string; crc: string; time: string } | null) => void
  ) {
    const { options } = this
    options.sourcefile = filename
    options.language = 'java'

    // 使用传入的缓存 AST，如果没有则重新解析
    // cachedAst 为 undefined 表示强制重新解析（force 模式），null 表示不使用缓存
    let ast = cachedAst
    const shouldSaveCache = cachedAst !== null // null 表示禁用缓存，undefined 表示强制重新解析但保存缓存
    if (!ast) {
      // 记录解析时间（parse 子步骤）
      const parseStart = Date.now()
      ast = Parsing.parseCode(source, options)
      const parseTime = Date.now() - parseStart
      this.performanceTracker.record('preProcess.parseCode.parse', parseTime)

      // 异步保存 AST 到缓存（不阻塞主流程）
      // 只有在启用缓存或 force 模式时才保存
      if (ast && shouldSaveCache) {
        const saveStart = Date.now()
        this.saveAstToCache(ast, source, filename)
          .then((cacheInfo) => {
            // 记录保存缓存时间（saveCache 子步骤）
            const saveTime = Date.now() - saveStart
            if (saveTime > 0) {
              this.performanceTracker.record('preProcess.parseCode.saveCache', saveTime)
            }
            if (onCacheSaved) {
              onCacheSaved(cacheInfo)
            }
          })
          .catch((err) => {
            logger.warn(`Failed to save AST cache for ${filename}: ${err.message}`)
            if (onCacheSaved) {
              onCacheSaved(null)
            }
          })
      } else if (onCacheSaved) {
        onCacheSaved(null)
      }
    } else if (onCacheSaved) {
      // 从缓存加载，不需要保存
      onCacheSaved(null)
    }

    this.sourceCodeCache[filename] = source
    if (!ast) {
      handleException(
        null,
        `JavaAnalyzer.preloadFileToPackage: parse failed: ${filename}`,
        `JavaAnalyzer.preloadFileToPackage: parse failed: ${filename}`
      )
      return
    }
    if (!ast || ast.type !== 'CompileUnit') {
      handleException(
        null,
        `JavaAnalyzer.preloadFileToPackage: node type should be CompileUnit, but ${ast?.type}`,
        `JavaAnalyzer.preloadFileToPackage: node type should be CompileUnit, but ${ast?.type}`
      )
      return undefined
    }
    const packageName = ast._meta.qualifiedName ?? ''

    const packageScope = this.packageManager.getSubPackage(packageName, true)

    // 开始记录 preload 时间：初始化文件作用域、处理类定义等
    const preloadStart = Date.now()

    // file scope init
    // value specifies what module exports, closure specifies file closure
    const fileScope = this.initFileScope(ast, filename, packageScope)
    ;(this as any).unprocessedFileScopes = (this as any).unprocessedFileScopes ?? new Set()
    ;(this as any).unprocessedFileScopes.add(fileScope)

    const { body } = ast
    ;(this as any).entry_fclos = fileScope
    ;(this as any).thisFClos = fileScope

    const state = this.initState(fileScope)
    // prebuild
    body.forEach((childNode: any) => {
      if (childNode.type === 'ExportStatement') {
        // the argument of ExportStatement is must be a ClassDefinition
        const classDef = childNode.argument
        if (classDef?.type !== 'ClassDefinition') {
          logger.fatal(`the argument of ExportStatement must be a ClassDefinition, check violation in ${filename}`)
        }
        const { className, classClos } = this.preprocessClassDefinitionRec(classDef, fileScope, fileScope, packageScope)
        if (classDef._meta.isPublic) {
          packageScope.exports =
            packageScope.exports ??
            Scoped({
              id: 'exports',
              sid: 'export',
              parent: null,
            })
          packageScope.exports.setFieldValue(className, classClos)
        }
        packageScope.setFieldValue(className, classClos)
      } else if (childNode.type === 'ClassDefinition') {
        const { className, classClos } = this.preprocessClassDefinitionRec(childNode, fileScope, fileScope)
        packageScope.setFieldValue(className, classClos)
      }
    })

    // post handle module for module export
    // const moduleExports = modClos.getFieldValue('module.exports');
    // if (moduleExports !== {}) {
    //     modScope.value = moduleExports;
    // }

    if (this.checkerManager && this.checkerManager.checkAtEndOfCompileUnit) {
      this.checkerManager.checkAtEndOfCompileUnit(this, null, null, state, null)
    }
    this.fileManager[filename] = fileScope

    // 记录 preload 时间：累加到总 preload 时间中
    const preloadTime = Date.now() - preloadStart
    this.performanceTracker.record('preProcess.preload', preloadTime)

    return { packageScope, fileScope }
  }

  /**
   * 递归预处理类定义
   * @param node - AST 节点
   * @param scope - 作用域
   * @param fileScope - 文件作用域
   * @param packageScope - 包作用域
   * @returns {any} 类作用域
   */
  preprocessClassDefinitionRec(node: any, scope: any, fileScope: any, packageScope?: any) {
    const className = node.id?.name

    const classClos = Scope.createSubScope(className, scope, 'class')
    const qualifiedName = Scope.joinQualifiedName(scope.qid, className)
    classClos.sort = qualifiedName
    classClos.qid = qualifiedName
    classClos.exports = Scoped({
      id: 'exports',
      sid: 'exports',
      parent: null,
    })
    if (node._meta.isPublic) {
      scope.exports =
        scope.exports ??
        Scoped({
          id: 'exports',
          sid: 'exports',
          parent: null,
        })
      scope.exports.setFieldValue(className, classClos)
    }
    classClos.fdef = node
    classClos.ast = node
    classClos.fileScope = fileScope
    classClos.packageScope = packageScope
    const { body } = node
    if (!body) {
      return { className, classClos }
    }
    body.forEach((child: any) => {
      if (child.type === 'ClassDefinition') {
        this.preprocessClassDefinitionRec(child, classClos, fileScope, packageScope)
      }
    })
    return { className, classClos }
  }

  /**
   * 处理编译单元
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 处理结果
   */
  processCompileUnit(scope: any, node: any, state: any) {
    scope.isProcessed = true
    return super.processCompileUnit(scope, node, state)
  }

  /**
   * 处理变量声明
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 变量值
   */
  processVariableDeclaration(scope: any, node: any, state: any) {
    const initVal = super.processVariableDeclaration(scope, node, state)
    if (initVal && node.varType !== null && node.varType !== undefined) {
      initVal.rtype = { type: undefined }
      const val = this.getMemberValueNoCreate(scope, node.varType.id, state)
      if (val) {
        initVal.rtype.definiteType = UastSpec.identifier(val._qid)
      } else {
        initVal.rtype.definiteType = node.varType.id
      }
    }
    return initVal
  }

  /**
   * 处理标识符
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 标识符值
   */
  processIdentifier(scope: any, node: any, state: any) {
    const res = super.processIdentifier(scope, node, state)

    if (res && !res.rtype) {
      res.rtype = { type: undefined }
      if (res.vtype === 'class') {
        res.rtype.definiteType = UastSpec.identifier(res._qid)
      } else {
        res.rtype.definiteType = node
      }
    }

    const { fileScope } = res
    if (fileScope && !fileScope.isProcessed) {
      this.processInstruction(fileScope, fileScope.ast, this.initState(fileScope))
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  /**
   * 处理成员访问
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 成员值
   */
  // eslint-disable-next-line complexity
  processMemberAccess(scope: any, node: any, state: any) {
    const defscope = this.processInstruction(scope, node.object, state)
    const prop = node.property
    let resolvedProp = prop
    // important, prop should be eval by scope rather than defscope
    if (node.computed || (prop.type !== 'Identifier' && prop.type !== 'Literal')) {
      resolvedProp = this.processInstruction(scope, prop, state)
    }
    let res = this.getMemberValue(defscope, resolvedProp, state)
    if (this.checkerManager && this.checkerManager.checkAtMemberAccess) {
      this.checkerManager.checkAtMemberAccess(this, defscope, node, state, { res })
    }

    if (node.property.type === 'ThisExpression' && defscope.vtype === 'class' && defscope._qid) {
      const ancestorInstance = this.getAncestorScopeByQid(scope, `${defscope._qid}<instance>`)
      if (ancestorInstance) {
        res = ancestorInstance
      }
    }
    if (defscope.vtype === 'fclos' && defscope._sid?.includes('anonymous') && res.vtype === 'symbol') {
      res = defscope
    }

    if (defscope.rtype && defscope.rtype !== 'DynamicType' && res.rtype === undefined) {
      res.rtype = { type: undefined }
      res.rtype.definiteType = defscope.rtype.type ? defscope.rtype.type : defscope.rtype.definiteType
      res.rtype.vagueType = defscope.rtype.vagueType
        ? `${defscope.rtype.vagueType}.${resolvedProp.name}`
        : resolvedProp.name
    }
    const { fileScope } = res
    if (fileScope && !fileScope.isProcessed) {
      this.processInstruction(fileScope, fileScope.ast, this.initState(fileScope))
    }

    if (node.object?.type !== 'SuperExpression') {
      if (res.vtype !== 'union') {
        res._this = defscope
      } else {
        const thisUnion = defscope
        if (thisUnion?.value) {
          for (const f of res.value) {
            for (const thisObj of thisUnion.value) {
              if (!f._sid || !thisObj.value) {
                continue
              }
              if (f === thisObj.value[f._sid]) {
                f._this = thisObj
              }
            }
          }
        }
      }
    }
    res._this = defscope

    return res
  }

  /**
   * 处理模块导入：import "module"
   * @param scope - 作用域
   * @param node - AST 节点
   * @param _state - 状态（未使用）
   * @returns {any} 导入结果
   */
  processImportDirect(scope: any, node: any, _state: any) {
    node = node.from
    const fname = node?.value

    // check cached imports first
    let packageName = ''
    const classNames: string[] = []
    if (fname) {
      if (fname.includes('.')) {
        const lastDotIndex = fname.lastIndexOf('.')
        packageName = fname.substring(0, lastDotIndex)
        classNames.push(fname.substring(lastDotIndex + 1))
      } else {
        classNames.push(fname)
      }
    }

    let packageScope = this.packageManager.getSubPackage(packageName, true)
    // if package is not created from import statement, but from full qualified name access
    if (packageScope.vtype !== 'package') {
      packageScope = PackageValue({
        vtype: 'package',
        sid: fname,
        qid: packageName,
        exports: Scoped({
          sid: 'exports',
          id: 'exports',
          parent: null,
        }),
        parent: this,
      })
    }
    let classScope = packageScope
    for (const className of classNames) {
      classScope = Scope.createSubScope(className, packageScope, 'class')
      packageScope.exports.value[className] = classScope
      const qualifiedName = Scope.joinQualifiedName(packageScope.qid, className)
      classScope.sort = qualifiedName
      classScope.qid = qualifiedName
    }

    classScope.sort = classScope.sort ?? fname
    return classScope
  }

  /**
   * 处理类定义
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 类定义结果
   */
  // eslint-disable-next-line complexity
  processClassDefinition(scope: any, node: any, state: any) {
    const { annotations } = node._meta
    const annotationValues: any[] = []
    annotations?.forEach((annotation: any) => {
      annotationValues.push(this.processInstruction(scope, annotation, state))
    })

    // adjust the order of the class body, so that static field comes last
    const { body } = node
    let bodyStmt: any
    if (body?.type === 'ScopedStatement') {
      bodyStmt = body.body
    } else if (Array.isArray(body)) {
      bodyStmt = body
    }
    bodyStmt?.sort((a: any, b: any) => {
      return (a._meta?.isStatic ? 1 : 0) - (b._meta?.isStatic ? 1 : 0)
    })

    const res = super.processClassDefinition(scope, node, state)
    // TODO
    res.annotations = annotationValues
    for (const annotation of annotationValues) {
      if (annotation.sort === 'lombok.Data') {
        const value = res.getRawValue()
        for (const prop in value) {
          const fieldValue = value[prop]
          if (fieldValue.vtype !== 'fclos') {
            const getterName = `get${getUpperCase(prop)}`
            if (value[getterName] === undefined) {
              const targetQid = `${scope.qid}.${getterName}`
              value[getterName] = FunctionValue({
                sid: getterName,
                qid: targetQid,
                parent: scope,
                execute: JavaInitializer.builtin.lombok.processGetter(getterName, prop),
              })
              ;(this as any).funcSymbolTable[targetQid] = value[getterName]
            }
            const setterName = `set${getUpperCase(prop)}`
            if (value[setterName] === undefined) {
              const targetQid = `${scope.qid}.${setterName}`
              value[setterName] = FunctionValue({
                sid: setterName,
                qid: targetQid,
                parent: scope,
                execute: JavaInitializer.builtin.lombok.processSetter(setterName, prop),
              })
              ;(this as any).funcSymbolTable[targetQid] = value[getterName]
            }
          }
        }
      }
    }
    return res
  }

  /**
   * 处理赋值表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 赋值结果
   */
  processAssignmentExpression(scope: any, node: any, state: any) {
    const { left } = node
    const oldVal = this.processInstruction(scope, left, state)

    const res = super.processAssignmentExpression(scope, node, state)

    if (
      node.operator === '=' &&
      oldVal?.parent === (this as any).thisFClos &&
      (this as any).thisFClos?.field?.super &&
      !this.checkFieldDefinedInClass(oldVal._id, (this as any).thisFClos.sort)
    ) {
      this.saveVarInScopeRec((this as any).thisFClos.field.super, left.property, res, state)
    }

    return res
  }

  /**
   * 处理二元表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 表达式结果
   */
  processBinaryExpression(scope: any, node: any, state: any) {
    let res = super.processBinaryExpression(scope, node, state)

    if (
      res?.left?.vtype === 'primitive' &&
      res?.right?.vtype === 'primitive' &&
      ['>', '<', '==', '!=', '>=', '<='].includes(res?.operator)
    ) {
      const leftPrimitive = res.left.value
      const rightPrimitive = res.right.value
      const expr = leftPrimitive + res.operator + rightPrimitive
      try {
        // eslint-disable-next-line no-eval
        const result = eval(expr)
        if (result != null) {
          res = PrimitiveValue({ type: 'Literal', value: result, loc: node.loc })
        }
      } catch (e) {
        // 忽略 eval 错误
      }
    }

    return res
  }

  /**
   * 处理函数调用表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 调用结果
   */
  // eslint-disable-next-line complexity
  processCallExpression(scope: any, node: any, state: any) {
    /* { callee,
        arguments,
      }
   */
    if (this.checkerManager && this.checkerManager.checkAtFuncCallSyntax)
      this.checkerManager.checkAtFuncCallSyntax(node, {
        pcond: state.pcond,
        einfo: state.einfo,
      })

    const fclos = this.processInstruction(scope, node.callee, state)
    if (!fclos) return UndefinedValue()

    // prepare the function arguments
    let argvalues: any[] = []
    let sameArgs = true // minor optimization to save memory
    for (const arg of node.arguments) {
      let argv = this.processInstruction(scope, arg, state)
      // 处理参数是 箭头函数或匿名函数
      // 参数类型必须是函数定义,且fclos找不到定义或未建模适配
      // 如果参数适配建模，则会进入相应的逻辑模拟执行，例如array.push
      if (arg?.type === 'FunctionDefinition' && arg?.name === '<anonymous>' && !fclos?.fdef && !fclos?.execute) {
        // let subscope = Scope.createSubScope(argv.sid + '_scope', scope,'scope')
        argv = this.processAndCallFuncDef(scope, arg, argv, state)
      }
      if (argv !== arg) sameArgs = false
      if ((logger as any).isTraceEnabled()) (logger as any).trace(`arg: ${this.formatScope(argv)}`)
      if (Array.isArray(argv)) {
        argvalues.push(...argv)
      } else {
        argvalues.push(argv)
      }
    }
    if (sameArgs) argvalues = node.arguments

    // analyze the resolved function closure and the function arguments
    let res = this.executeCall(node, fclos, argvalues, state, scope)
    if (res) {
      res.rtype = fclos.rtype
    }

    if (res instanceof UndefinedValue && fclos._sid?.includes('<anonymous') && fclos.fdef?.body?.body?.length === 1) {
      const oldBodyExpr = fclos.fdef.body.body[0]
      try {
        fclos.fdef.body.body[0] = UastSpec.returnStatement(fclos.fdef.body.body[0])
        res = this.executeCall(node, fclos, argvalues, state, scope)
      } catch (e) {
        // 忽略错误
      } finally {
        fclos.fdef.body.body[0] = oldBodyExpr
      }
    }

    // function definition not found
    if (fclos.vtype !== 'fclos') {
      // examine possible call-back functions in the arguments
      if (Config.invokeCallbackOnUnknownFunction) {
        this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
      }
      if (fclos._this?.field?._functionNotFoundCallback_?.vtype === 'fclos') {
        this.executeCall(node, fclos._this.field._functionNotFoundCallback_, argvalues, state, scope)
      }
    }

    if (fclos?._this?.vtype === 'fclos' && (fclos._sid === 'accept' || fclos._sid === 'apply')) {
      this.executeCall(node, fclos._this, argvalues, state, scope)
    }

    if (res && this.checkerManager?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        argvalues,
        fclos,
        ret: res,
        pcond: state.pcond,
        einfo: state.einfo,
        callstack: state.callstack,
      })
    }

    return res
  }

  /**
   * 处理 new 表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} new 表达式结果
   */
  processNewExpression(scope: any, node: any, state: any) {
    if (node._meta && node._meta.isEnumImpl) {
      this.processInstruction(scope, node.callee, state)
    } else {
      return super.processNewExpression(scope, node, state)
    }
  }

  /**
   * 处理一元表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 一元表达式结果
   */
  processUnaryExpression(scope: any, node: any, state: any) {
    let res = super.processUnaryExpression(scope, node, state)

    if (res.argument?.vtype === 'primitive' && res.argument?.literalType === 'number') {
      const argValueNum = Number(res.argument.value)
      if (node.operator === '++') {
        res = PrimitiveValue({ type: 'Literal', value: argValueNum + 1, loc: node.loc })
        this.saveVarInScope(scope, node.argument, res, state)
      } else if (node.operator === '--') {
        res = PrimitiveValue({ type: 'Literal', value: argValueNum - 1, loc: node.loc })
        this.saveVarInScope(scope, node.argument, res, state)
      }
    }

    return res
  }

  /**
   * 预处理项目目录
   * @param dir - 项目目录
   */
  // eslint-disable-next-line complexity
  async preProcess(dir: any) {
    // init global scope
    JavaInitializer.initGlobalScope(this.topScope)

    // time-out control
    ;(this as any).thisIterationTime = 0
    ;(this as any).prevIterationTime = new Date().getTime()

    await this.scanPackages(dir)

    JavaInitializer.initPackageScope(this.topScope.packageManager)

    this.assembleClassMap(this.topScope.packageManager)
  }

  /**
   * 符号解释
   * @returns {boolean} 是否成功
   */
  // eslint-disable-next-line complexity
  symbolInterpret() {
    const { entryPoints } = this as any
    const state = this.initState(this.topScope)
    if (_.isEmpty(entryPoints)) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }
    const hasAnalysised: any[] = []
    // 自定义source入口方式，并根据入口自主加载source
    for (const entryPoint of entryPoints) {
      if (entryPoint.type === Constant.ENGIN_START_FUNCALL) {
        if (
          hasAnalysised.includes(
            `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?._qid}#${entryPoint.entryPointSymVal.ast.parameters}.${entryPoint.attribute}`
          )
        ) {
          continue
        }

        hasAnalysised.push(
          `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?._qid}#${entryPoint.entryPointSymVal.ast.parameters}.${entryPoint.attribute}`
        )
        CurrentEntryPoint.setCurrentEntryPoint(entryPoint)
        logger.info(
          'EntryPoint [%s.%s] is executing',
          entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
          entryPoint.functionName ||
            `<anonymousFunc_${entryPoint.entryPointSymVal?.ast.loc.start.line}_$${
              entryPoint.entryPointSymVal?.ast.loc.end.line
            }>`
        )

        this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)

        const argValues: any[] = []
        try {
          for (const key in entryPoint.entryPointSymVal?.ast?.parameters) {
            argValues.push(
              this.processInstruction(
                entryPoint.entryPointSymVal,
                entryPoint.entryPointSymVal?.ast?.parameters[key]?.id,
                state
              )
            )
          }
        } catch (e) {
          handleException(
            e,
            'Error occurred in JavaAnalyzer.symbolInterpret: process argValue err',
            'Error occurred in JavaAnalyzer.symbolInterpret: process argValue err'
          )
        }

        try {
          this.executeCall(
            entryPoint.entryPointSymVal?.ast,
            entryPoint.entryPointSymVal,
            argValues,
            state,
            entryPoint.scopeVal
          )
        } catch (e) {
          handleException(
            e,
            `[${entryPoint.entryPointSymVal?.ast?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
            `[${entryPoint.entryPointSymVal?.ast?.id?.name} symbolInterpret failed. Exception message saved in error log file`
          )
        }
        this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
      }
    }
    return true
  }

  /**
   * 判断值是否为 null 字面量
   * @param val - 值
   * @returns {boolean} 是否为 null 字面量
   */
  isNullLiteral(val: any) {
    return val.getRawValue() === 'null' && val.type === 'Literal'
  }

  /**
   * 从模块作用域获取导出作用域
   * @param scope - 作用域
   * @returns {any[]} 导出作用域数组
   */
  getExportsScope(scope: any) {
    return [scope.exports, scope]
  }

  /**
   * 组装类映射
   * @param obj - 对象
   */
  assembleClassMap(obj: any) {
    if (!obj) {
      return
    }
    if (obj.sort && typeof obj.sort === 'string') {
      this.classMap.set(obj.sort, obj)
    } else if (obj.field) {
      for (const key in obj.field) {
        this.assembleClassMap(obj.field[key])
      }
    }
  }

  /**
   * 检查字段是否在类中定义
   * @param fieldName - 字段名
   * @param fullClassName - 完整类名
   * @returns {boolean} 是否定义
   */
  checkFieldDefinedInClass(fieldName: string, fullClassName: string) {
    if (!fieldName || !fullClassName || !this.classMap.has(fullClassName)) {
      return false
    }

    const classObj = this.classMap.get(fullClassName)
    if (!classObj.ast || !classObj.ast.body) {
      return false
    }
    for (const bodyItem of classObj.ast.body) {
      if (bodyItem.type !== 'VariableDeclaration') {
        continue
      }
      if (bodyItem.id.name === fieldName) {
        return true
      }
    }

    return false
  }

  /**
   * 根据 qid 获取祖先作用域
   * @param scope - 作用域
   * @param qid - 限定标识符
   * @returns {any} 祖先作用域
   */
  getAncestorScopeByQid(scope: any, qid: string) {
    if (!qid) {
      return null
    }
    while (scope) {
      if (scope._qid === qid) {
        return scope
      }
      scope = scope.parent
    }
    return null
  }
}

;(JavaAnalyzer as any).prototype.initFileScope = JavaInitializer.initFileScope
;(JavaAnalyzer as any).prototype.initInPackageScope = JavaInitializer.initInPackageScope

export = JavaAnalyzer

/**
 * 将字符串首字母转为大写
 * @param str - 输入字符串
 * @returns {string} 首字母大写的字符串
 */
function getUpperCase(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
