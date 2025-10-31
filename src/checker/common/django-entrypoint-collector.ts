const Checker = require('./checker')
const IntroduceTaint = require('../taint/common-kit/source-util')
const { findDjangoEntryPointAndSource } = require('../../engine/analyzer/python/django/entrypoint-collector/django-default-entrypoint')
const extractRelativePath = require('../../util/file-util').extractRelativePath
const astUtil = require('../../util/ast-util')
const EntryPoint = require('../../engine/analyzer/common/entrypoint')
const entryPointConfig = require('../../engine/analyzer/common/current-entrypoint')
const constValue = require('../../util/constant')
const _ = require('lodash')
const config = require('../../config')
const logger = require('../../util/logger')(__filename)

// 注意：已改为静态收集方式，不再需要这些常量

// 已处理的entrypoint集合，避免重复采集同一个entrypoint
// 使用Set存储已处理的entrypoint位置信息，防止重复创建
const processedRouteRegistry = new Set()

// 删除未使用的 getSourceFile，避免无效代码保留

/**
 * 判断是否是urls.py文件
 * @param {string} filePath - 文件路径
 * @returns {boolean}
 */
function isUrlsFile(filePath) {
  if (!filePath) return false
  return filePath.endsWith('urls.py') || filePath.includes('/urls.py')
}

/**
 * Django Entrypoint Collector
 *两个关键点：
 * 1识别路由注册方式并自采集被注册的路由函数作为entrypoint
 * 2将外部可控的数据结构标为source
 * 参考Go mux的gorilla-mux-entrypoint-collect-checker.js实现
 * 适配Django框架特有的路由注册模式
 */
class DjangoEntrypointCollector extends Checker {
  constructor(resultManager) {
    super(resultManager, 'django-entrypoint-collector')
    this.desc = 'Django entrypoint collector'
    this.entryPoints = []
    // 存储需要标记 URL 路径参数的 entrypoint（在运行时标记）
    this.entryPointsToMarkParams = []
  }
  /**
   * 静态收集 Django entrypoints（在分析开始前）
   * 在 triggerAtStartOfAnalyze 中调用，扫描所有文件，预先收集所有路由注册
   *
   * @param {Object} analyzer - 分析器实例
   * @param {Object} scope - 作用域信息（未使用）
   * @param {Object} node - AST节点（未使用）
   * @param {Object} state - 分析状态（未使用）
   * @param {Object} info - 分析信息（未使用）
   */
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
    // 断点A：Django collector 开始工作
    // 在 ONLY_CUSTOM 模式下不进行自采集
    if (config.entryPointMode === 'ONLY_CUSTOM') {
      logger.info(`ONLY_CUSTOM mode, skipping self-collection`)
      return
    }

    const { moduleManager, fileManager } = analyzer
    if (!fileManager || !moduleManager) {
      logger.warn(`[DjangoCollector] fileManager or moduleManager not available`)
      return
    }

    this.prepareEntryPoints(analyzer, config.maindir, moduleManager, fileManager)
    if (this.entryPoints && this.entryPoints.length > 0) {
      analyzer.entryPoints.push(...this.entryPoints)
      logger.info(`[DjangoCollector]Collected ${this.entryPoints.length} Django entrypoints statically`)
      // 断点B：查看收集到的 entrypoints 和需要标记的参数
      // this.entryPoints: [ { filePath, functionName, attribute: 'HTTP' } ]
      // this.entryPointsToMarkParams: [ { entryPoint, funcArg } ]
    }
  }

  /**
   * 准备 entrypoints：静态扫描所有文件，收集 Django 路由注册
   *
   * @param {Object} analyzer - 分析器实例
   * @param {string} dir - 主目录路径
   * @param {Object} moduleManager - 模块管理器
   * @param {Object} fileManager - 文件管理器
   */
  prepareEntryPoints(analyzer, dir, moduleManager, fileManager) {
    // 断点C：开始准备 entrypoints
    // 构建 filenameAstObj 用于静态扫描
    // 参考 python-entrypoint.js 的实现方式
    const filenameAstObj = {}
    let fileCount = 0
    for (const filename in fileManager) {
      // 跳过非文件条目（如 'parent'）
      if (filename === 'parent' || !filename.includes('.')) {
        continue
      }
      const modClos = fileManager[filename]
      if (modClos && modClos.hasOwnProperty('ast')) {
        filenameAstObj[filename] = modClos.ast
        fileCount++
      }
    }

    logger.info(`[DjangoCollector] Scanned ${fileCount} files from fileManager`)

    // 使用已有的静态扫描函数
    const { djangoEntryPointArray } = findDjangoEntryPointAndSource(filenameAstObj, dir)
    // 断点D：查看静态扫描结果
    // djangoEntryPointArray: [ { filePath, functionName, attribute: 'HTTP' } ]

    if (!djangoEntryPointArray || djangoEntryPointArray.length === 0) {
      logger.warn(`[DjangoCollector] No Django entrypoints found in static scan`)
      return
    }

    logger.info(`[DjangoCollector] Found ${djangoEntryPointArray.length} Django routes in static scan`)

    // 将静态扫描得到的 entrypoint 信息转换为完整的 entrypoint 对象
    for (const epInfo of djangoEntryPointArray) {
      if (!epInfo.filePath || !epInfo.functionName) {
        continue
      }

      // 过滤掉 urls.py 文件中的函数
      if (isUrlsFile(epInfo.filePath)) {
        logger.debug(`[DjangoCollector] Skipping urls.py file: ${epInfo.filePath}`)
        continue
      }

      // 从 moduleManager 中查找对应的 fclos
      let valFuncs = astUtil.satisfy(
          moduleManager,
          (n) =>
              n.vtype === 'fclos' &&
              extractRelativePath(n?.ast?.loc?.sourcefile, dir) === epInfo.filePath &&
              n?.ast?.id?.name === epInfo.functionName,
          (node, prop) => prop === 'field',
          null,
          true
      )

      if (_.isEmpty(valFuncs)) {
        logger.debug(`[DjangoCollector] Cannot find fclos for ${epInfo.filePath}.${epInfo.functionName}`)
        continue
      }

      if (Array.isArray(valFuncs)) {
        valFuncs = _.uniqBy(valFuncs, (value) => value.fdef)
      } else {
        valFuncs = [valFuncs]
      }

      // 为每个找到的函数创建 entrypoint
      for (const valFunc of valFuncs) {
        if (!valFunc || !valFunc.ast || !valFunc.ast.loc) {
          continue
        }

        const hash = JSON.stringify(valFunc.ast.loc)
        if (processedRouteRegistry.has(hash)) {
          logger.debug(`[DjangoCollector] Entrypoint already processed: ${epInfo.filePath}.${epInfo.functionName}`)
          continue
        }
        processedRouteRegistry.add(hash)

        // 创建完整的 entrypoint
        const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
        entryPoint.filePath = epInfo.filePath
        entryPoint.functionName = epInfo.functionName
        entryPoint.attribute = epInfo.attribute || 'HTTP'
        entryPoint.entryPointSymVal = valFunc
        entryPoint.scopeVal = valFunc.parent

        this.entryPoints.push(entryPoint)
        // 保存需要标记 URL 路径参数的 entrypoint（在运行时标记）
        this.entryPointsToMarkParams.push({
          entryPoint: entryPoint,
          funcArg: valFunc
        })

        logger.debug(`[DjangoCollector] Created entrypoint: ${epInfo.filePath}.${epInfo.functionName}`)
      }
    }
  }

  /**
   * 在 entrypoint 执行前标记 URL 路径参数为 source
   * 这个方法在运行时调用，可以访问 state 和 analyzer
   *
   * @param {Object} analyzer - 分析器实例
   * @param {Object} scope - 作用域信息
   * @param {Object} node - AST节点
   * @param {Object} state - 分析状态
   * @param {Object} info - 分析信息（可能为 null）
   */
  triggerAtSymbolInterpretOfEntryPointBefore(analyzer, scope, node, state, info) {
    // 从 entryPointConfig 获取当前 entrypoint（Python analyzer 调用时 info 可能为 null）
    const currentEntryPoint = entryPointConfig.getCurrentEntryPoint()
    if (!currentEntryPoint || !currentEntryPoint.functionName) {
      return
    }

    // 查找这个 entrypoint 是否需要标记 URL 路径参数
    // currentEntryPoint 使用 filepath（小写），我们的 entryPoint 使用 filePath（驼峰）
    const entryPointInfo = this.entryPointsToMarkParams.find(
        ep => (ep.entryPoint.filePath === currentEntryPoint.filePath ||
                ep.entryPoint.filePath === currentEntryPoint.filepath) &&
            ep.entryPoint.functionName === currentEntryPoint.functionName
    )

    if (entryPointInfo && entryPointInfo.funcArg) {
      // 仅标记 URL 路径参数（第二个及之后），避免将 request 本身作为来源
      IntroduceTaint.introduceFuncArgTaintBySelfCollection(
          entryPointInfo.funcArg,
          state,
          analyzer,
          '1:',
          'PYTHON_INPUT'
      )
      logger.debug(`[DjangoCollector]Marked URL path parameters for ${currentEntryPoint.functionName}`)
    }
  }

  /**
   * 在函数调用时检测Django路由注册（已废弃）
   * @deprecated 已改为静态收集方式（triggerAtStartOfAnalyze），此方法不再用于收集 entrypoint
   * 保留此方法仅用于兼容，实际上不会执行
   */
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    // 不再在运行时动态收集 entrypoint，已在 triggerAtStartOfAnalyze 中静态收集
    // 此方法保留但为空，避免影响其他功能
    return
  }

  /**
   * 每次运行完main后清空hash
   *
   * 按照官方教程实现：每次运行完main后清空hash
   * 对应官方教程中的triggerAtSymbolInterpretOfEntryPointAfter方法
   *
   * 官方教程说明：
   * "每次运行完main后清空hash"
   *
   * @param {Object} analyzer - 分析器实例
   * @param {Object} scope - 作用域信息
   * @param {Object} node - AST节点
   * @param {Object} state - 分析状态
   * @param {Object} info - 分析信息
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer, scope, node, state, info) {
    if (info?.entryPoint.functionName === 'main') processedRouteRegistry.clear()
  }

}

module.exports = DjangoEntrypointCollector