import type { IOutputStrategy } from './output-strategy'

const path = require('path')
const { glob } = require('fast-glob')
const logger = require('../../../util/logger')(__filename)

type StrategyRegistry = Record<string, IOutputStrategy>

interface StrategyClass {
  new (): IOutputStrategy
  outputStrategyId?: string
  prototype: any
}

/**
 *
 */
class OutputStrategyAutoRegister {
  strategyRegistry: StrategyRegistry

  strategiesDirectory: string

  /**
   *
   */
  constructor() {
    this.strategyRegistry = {}
    this.strategiesDirectory = path.join(__dirname, '../../../checker/common/output/')
  }

  /**
   * 自动注册所有输出策略
   */
  autoRegisterAllStrategies(): StrategyRegistry {
    try {
      // 查找所有的JS文件（排除自身和基类）
      const jsFiles = glob.sync('**/*.{js,ts}', {
        cwd: this.strategiesDirectory,
        absolute: true,
        ignore: ['**/node_modules/**', '**/OutputStrategyAutoRegister.{js,ts}', '**/OutputStrategy.{js,ts}'],
      })

      logger.info(`Found ${jsFiles.length} potential output strategy files`)

      let registeredCount = 0

      for (const filePath of jsFiles) {
        const isRegistered = this.registerStrategyFromFile(filePath)
        if (isRegistered) {
          registeredCount++
        }
      }

      logger.info(`Successfully registered ${registeredCount} output strategies`)
      return this.strategyRegistry
    } catch (error) {
      logger.error('Error auto-registering output strategies:', error)
      throw error
    }
  }

  /**
   * 从单个文件注册策略
   * @param filePath
   */
  registerStrategyFromFile(filePath: string): boolean {
    try {
      // 清除require缓存，确保每次都是最新版本
      delete require.cache[require.resolve(filePath)]

      // 动态导入策略类
      const StrategyModule = require(filePath)

      // 获取默认导出或第一个导出的类
      // const StrategyClass = this.findStrategyClass(strategyModule)

      if (!StrategyModule) {
        logger.info(`No class found in ${path.basename(filePath)}`)
        return false
      }

      // 检查是否继承自OutputStrategy
      if (!this.isSubclassOfOutputStrategy(StrategyModule)) {
        logger.info(`Class in ${path.basename(filePath)} does not inherit from OutputStrategy`)
        return false
      }

      // 检查是否有outputStrategyId静态属性
      if (!StrategyModule.hasOwnProperty('outputStrategyId')) {
        logger.info(`Class in ${path.basename(filePath)} missing outputStrategyId static property`)
        return false
      }

      const strategyId = StrategyModule.outputStrategyId

      if (!strategyId || typeof strategyId !== 'string') {
        logger.info(`Invalid outputStrategyId in ${path.basename(filePath)}: ${strategyId}`)
        return false
      }

      // 创建策略实例并注册
      const strategyInstance = new StrategyModule()
      this.registerStrategy(strategyId, strategyInstance)

      logger.info(`Registered strategy: ${strategyId} from ${path.basename(filePath)}`)
      return true
    } catch (error: any) {
      logger.error(`Error registering strategy from ${path.basename(filePath)}:`, error.message)
      return false
    }
  }

  /**
   * 从模块中查找策略类
   * @param moduleExports
   */
  findStrategyClass(moduleExports: Record<string, any>): StrategyClass | null {
    // 优先检查默认导出
    if (moduleExports.default && typeof moduleExports.default === 'function') {
      return moduleExports.default as StrategyClass
    }

    // 查找所有导出的类
    const exportedClasses = Object.values(moduleExports).filter(
      (exportItem: any) => typeof exportItem === 'function' && /^[A-Z]/.test(exportItem.name)
    )

    return exportedClasses.length > 0 ? (exportedClasses[0] as StrategyClass) : null
  }

  /**
   * 检查类是否继承自OutputStrategy
   * @param StrategyClass
   */
  isSubclassOfOutputStrategy(StrategyClass: StrategyClass): boolean {
    let currentProto = StrategyClass.prototype

    while (currentProto !== null) {
      if (currentProto.constructor.name === 'OutputStrategy') {
        return true
      }
      currentProto = Object.getPrototypeOf(currentProto)
    }

    return false
  }

  /**
   * 注册单个策略
   * @param strategyId
   * @param strategy
   */
  registerStrategy(strategyId: string, strategy: IOutputStrategy): void {
    if (this.strategyRegistry[strategyId]) {
      logger.warn(`Strategy ID ${strategyId} already registered, overwriting`)
    }
    this.strategyRegistry[strategyId] = strategy
  }

  /**
   * 获取所有已注册的策略
   */
  getStrategyRegistry(): StrategyRegistry {
    return { ...this.strategyRegistry }
  }

  /**
   * 根据ID获取策略
   * @param strategyId
   */
  getStrategy(strategyId: string): IOutputStrategy | undefined {
    return this.strategyRegistry[strategyId]
  }
}

module.exports = OutputStrategyAutoRegister
