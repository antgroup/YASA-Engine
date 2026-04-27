import { primitiveToString } from '../../../util/variable-util'
import type { ISymbolTableManager } from './symbol-table-interface'
import type { Invocation } from '../../../resolver/common/value/invocation'
import type {
  BaseNode,
  Node,
  Identifier,
  Literal,
  CompileUnit,
  IfStatement,
  SwitchStatement,
  ForStatement,
  WhileStatement,
  RangeStatement,
  ReturnStatement,
  BreakStatement,
  ContinueStatement,
  ThrowStatement,
  TryStatement,
  ExpressionStatement,
  ScopedStatement,
  BinaryExpression,
  UnaryExpression,
  AssignmentExpression,
  ConditionalExpression,
  SuperExpression,
  ThisExpression,
  MemberAccess,
  SliceExpression,
  TupleExpression,
  ObjectExpression,
  CallExpression,
  CastExpression,
  NewExpression,
  FunctionDefinition,
  ClassDefinition,
  VariableDeclaration,
  ImportExpression,
  SpreadElement,
  YieldExpression,
  ExportStatement,
} from '../../../types/uast'
import type {
  Scope as ScopeType,
  State,
  Value,
  SymbolValue as SymbolValueType,
  VoidValue as VoidValueType,
  SpreadValue as SpreadValueType,
} from '../../../types/analyzer'
import { BaseAnalyzer } from './base-analyzer'
import { BinaryExprValue } from './value/binary-expr'
import { UnaryExprValue } from './value/unary-expr'
import { CallExprValue } from './value/call-expr'
import { AnalysisContext } from './analysis-context'

const _ = require('lodash')
const Uuid = require('node-uuid')
const logger = require('../../../util/logger')(__filename)
const Config = require('../../../config')
const Initializer = require('./initializer')
const NativeResolver = require('./native-resolver')
import type { CallArg, CallArgs, CallInfo, BoundParam, BoundCall } from './call-args'
import { getLegacyArgValues, INTERNAL_CALL } from './call-args'
const MemState = require('./memState')
const Scope = require('./scope')
const SourceLine = require('./source-line')
const AstUtil = require('../../../util/ast-util')
const StateUtil = require('../../util/state-util')
const SymAddress = require('./sym-address')
const { unionAllValues } = require('./memStateBVT')
const { shallowCopyValue, buildNewValueInstance, lodashCloneWithTag } = require('../../../util/clone-util')
const { handleException } = require('./exception-handler')
const {
  ValueUtil: {
    ObjectValue,
    Scoped,
    PrimitiveValue,
    UndefinedValue,
    UnionValue,
    SymbolValue,
    PackageValue,
    VoidValue,
    SpreadValue,
  },
} = require('../../util/value-util')

const { filterDataFromScope, shallowEqual } = require('../../../util/common-util')
const Rules = require('../../../checker/common/rules-basic-handler')
const { getAbsolutePath, loadJSONfile } = require('../../../util/file-util')
const { saveAnalyzerCache, loadAnalyzerCache, generateCacheId } = require('./analyzer-cache')
const { matchSinkAtFuncCallWithCalleeType } = require('../../../checker/taint/common-kit/sink-util')
const { moveExistElementsToBuffer, addElementToBuffer } = require('../java/common/builtins/buffer')
const { performanceTracker } = require('../../../util/performance-tracker')
const { checkInvocationMatchSink } = require('../../../checker/taint/common-kit/sink-util')
const OutputStrategyAutoRegister = require('./output-strategy-auto-register')

const ASTManager = require('./ast-manager')
const SymbolTableManager = require('./symbol-table-manager')
const { setGlobalASTManager, setGlobalSymbolTable, getGlobalSymbolTable } = require('../../../util/global-registry')
const { prettyPrint } = require('../../../util/ast-util')

/**
 * 临时符号表管理器：包装原始符号表，在执行 symbolInterpretFn 期间自动拷贝符号值
 * 实现 ISymbolTableManager 接口，与 SymbolTableManager 具有相同的接口
 */
class TemporarySymbolTableManager {
  private originalSymbolTable: InstanceType<typeof SymbolTableManager> // SymbolTableManager 实例

  private tmpSymbolTableManager: InstanceType<typeof SymbolTableManager> // SymbolTableManager 实例，其 symbolMap 作为临时符号表存储，同时提供 UUID 引用管理功能

  private copiedUnits: Map<string, any> // 记录已拷贝的 Unit 对象，避免重复拷贝

  /**
   *
   * @param originalSymbolTable SymbolTableManager 实例
   */
  constructor(originalSymbolTable: InstanceType<typeof SymbolTableManager>) {
    this.originalSymbolTable = originalSymbolTable
    // 使用 tmpSymbolTableManager 的 symbolMap 作为临时符号表存储，同时使用其 UUID 引用管理功能
    this.tmpSymbolTableManager = new SymbolTableManager()
    this.copiedUnits = new Map()
  }

  /**
   * 获取临时符号表的 symbolMap（直接访问私有属性）
   * @private
   */
  private getTmpSymbolMap(): Map<string, any> {
    // 通过反射访问私有属性 symbolMap
    return (this.tmpSymbolTableManager as any).symbolMap
  }

  /**
   * 拷贝 Unit 对象（按需拷贝，只拷贝当前对象，不递归拷贝 parent 和 field 中的引用）
   * _parentRef 和 field 中的 uuid 保持原样，当真正访问时再按需拷贝
   * 直接复制内存中的属性值，不触发 getter/setter，避免循环调用
   * @param unit
   */
  private tmpTableCopyUnit(unit: any): any {
    if (!unit || typeof unit !== 'object') {
      return unit
    }

    // 如果已经拷贝过，直接返回
    if (unit.uuid && this.copiedUnits.has(unit.uuid)) {
      return this.copiedUnits.get(unit.uuid)
    }

    // 创建新对象，保持原型链
    const copiedUnit = shallowCopyValue(unit)

    // 确保 _parentRef 被正确拷贝（ValueRef 不可变，可安全共享引用）
    const originalParentRef = unit._parentRef
    if (originalParentRef && !copiedUnit._parentRef) {
      copiedUnit._parentRef = originalParentRef
    }

    // 注册到临时符号表（直接存储到 tmpSymbolTableManager 的 symbolMap）
    if (copiedUnit.uuid) {
      this.getTmpSymbolMap().set(copiedUnit.uuid, copiedUnit)
      this.copiedUnits.set(copiedUnit.uuid, copiedUnit)
    }

    return copiedUnit
  }

  /**
   * 获取 Unit 对象：如果存在于临时符号表，直接返回；否则从原始符号表获取并拷贝
   * 如果临时符号表中的符号值没有 parent，但从原始符号表查有 parent，则重新完整拷贝
   * @param uuid
   */
  get(uuid: string | null | undefined): any {
    if (!uuid) {
      return null
    }

    // 先检查临时符号表（使用 tmpSymbolTableManager 的 symbolMap）
    const tmpUnit = this.getTmpSymbolMap().get(uuid) || null
    if (tmpUnit) {
      // 检查临时符号表中的符号值是否有 parent（通过 _parentRef 判断）
      if (!tmpUnit._parentRef) {
        // 临时符号表中没有 parent，检查原始符号表中是否有
        const originalUnit = this.originalSymbolTable.get(uuid)
        if (originalUnit?._parentRef) {
          // 从临时符号表中删除旧的拷贝
          this.getTmpSymbolMap().delete(uuid)
          this.copiedUnits.delete(uuid)
          // 重新完整拷贝（包括 _parentRef）
          return this.tmpTableCopyUnit(originalUnit)
        }
      }
      return tmpUnit
    }

    // 从原始符号表获取
    const originalUnit = this.originalSymbolTable.get(uuid)
    if (!originalUnit) {
      return null
    }

    // 深拷贝并注册到临时符号表
    return this.tmpTableCopyUnit(originalUnit)
  }

  /**
   * 注册 Unit 对象到临时符号表
   * 当 UUID 变化时，自动更新所有引用该 UUID 的地方
   * @param unit
   */
  register(unit: any): string | null {
    if (!unit || typeof unit !== 'object') {
      return null
    }

    // 使用临时符号表管理器计算 UUID
    const uuid = this.tmpSymbolTableManager.calculateUUID(unit)
    if (!uuid) {
      return null
    }

    // 设置 UUID
    unit.uuid = uuid

    // 直接存储到 tmpSymbolTableManager 的 symbolMap（而不是调用 register，因为 register 会重新计算 UUID）
    if (uuid) {
      this.getTmpSymbolMap().set(uuid, unit)
    }

    return uuid
  }

  /**
   * 检查 UUID 是否存在
   * @param uuid
   */
  has(uuid: string | null | undefined): boolean {
    if (!uuid) {
      return false
    }
    return this.getTmpSymbolMap().has(uuid) || this.originalSymbolTable.has(uuid)
  }

  /**
   * 计算 UUID
   * @param unit
   * @param qidSuffix
   */
  calculateUUID(unit: any, qidSuffix?: any): string | null {
    return this.tmpSymbolTableManager.calculateUUID(unit, qidSuffix)
  }

  /**
   * 删除 Unit 对象
   * @param uuid
   */
  delete(uuid: string | null | undefined): void {
    if (uuid) {
      this.getTmpSymbolMap().delete(uuid)
    }
  }

  /**
   * 清空临时符号表
   */
  clear(): void {
    this.getTmpSymbolMap().clear()
    this.copiedUnits.clear()
  }

  /**
   * 获取临时符号表大小
   */
  size(): number {
    return this.getTmpSymbolMap().size
  }

  /**
   * 获取临时符号表
   */
  getMap(): Map<string, any> {
    return this.tmpSymbolTableManager.getMap()
  }
}

/**
 * The main AST analyzer with checker invoking
 * @param checker
 * @constructor
 */
class Analyzer extends BaseAnalyzer {
  options: any

  checkerManager: any

  enablePerformanceLogging: boolean

  lastReturnValue: any

  _thisFClos: any // 内部存储，通过 getter/setter 访问

  _entry_fclos: any // 内部存储，通过 getter/setter 访问

  inRange: boolean

  ainfo: Record<string, any>

  sourceCodeCache: Map<string, string[]>

  _lastProcessedNode: any // 内部存储，通过 getter/setter 访问

  thisIterationTime: number

  prevIterationTime: number

  statistics: { numProcessedInstructions: number }

  entryPoints: any[]

  libFuncTagPropagationRuleArray: any[]

  context!: AnalysisContext

  libArgToThisSidBlacklistKeywords: string[]

  fileManager!: Record<string, any>

  funcSymbolTable!: Record<string, any>

  topScope: any

  astManager: any

  // 操作符号表：基于analyzer中使用this.symbolTable，基于符号值使用getSymbolTable()
  symbolTable!: ISymbolTableManager

  preprocessState: boolean | undefined

  performanceTracker: import('../../../util/performance-tracker').IPerformanceTracker

  backUpSymbolTable: any

  tmpSymbolTable: any

  isTmpSymbolTableOpen: boolean

  /**
   *
   * @param checkerManager
   * @param options
   */
  constructor(checkerManager: any, options?: any) {
    super()
    this.options = options || {}
    this.isTmpSymbolTableOpen = false
    this.checkerManager = checkerManager // 关联的检查器管理器
    this.performanceTracker = performanceTracker // 使用单例
    this.enablePerformanceLogging = this.options.enablePerformanceLogging || false // 默认关闭
    // 启用详细指令统计（如果启用了性能日志，输出 top 信息）
    this.performanceTracker.setEnableDetailedInstructionStats(this.enablePerformanceLogging)
    this.lastReturnValue = null // 记录最后一次函数调用的返回值
    this._thisFClos = null // 当前分析函数的闭包（存储 UUID）
    this._entry_fclos = null // 最外层函数的闭包（存储 UUID）
    this.inRange = false // 范围语句标志
    this.ainfo = {} // 整个分析过程中的信息
    this.sourceCodeCache = new Map<string, string[]>() // 缓存的源代码（文件路径 -> 代码行数组）
    // 设置全局 analyzer 引用，使 source-line.ts 可以访问 sourceCodeCache
    SourceLine.setGlobalAnalyzer(this)
    this._lastProcessedNode = null // 最后处理的节点（存储 UUID 或 AST 节点）
    // 超时控制
    this.thisIterationTime = 0
    this.prevIterationTime = 0
    this.statistics = {
      numProcessedInstructions: 0,
    }

    this.initValTreeStruct()
    this.entryPoints = []
    this.libFuncTagPropagationRuleArray = this.loadLibFuncTagPropagationRule()
    this.libArgToThisSidBlacklistKeywords = this.loadLibArgToThisSidBlacklistKeywords()
  }

  /**
   * thisFClos getter: 如果存储的是 UUID，从符号表中获取对象
   */
  get thisFClos() {
    if (this._thisFClos === null || this._thisFClos === undefined) {
      return null
    }
    // 如果是 UUID，从符号表中获取对象
    if (typeof this._thisFClos === 'string' && this._thisFClos.startsWith('symuuid_')) {
      const unit = this.symbolTable.get(this._thisFClos)
      return unit || null
    }
    // 如果不是 UUID，直接返回（向后兼容）
    return this._thisFClos
  }

  /**
   * thisFClos setter: 如果值是符号值对象，转换为 UUID 存储
   */
  set thisFClos(val) {
    if (val === null || val === undefined) {
      this._thisFClos = null
      return
    }
    // 如果是符号值对象，转换为 UUID 存储
    if (val && typeof val === 'object' && val.vtype && val.qid) {
      const uuid = this.symbolTable.register(val)
      this._thisFClos = uuid
    } else {
      // 如果不是符号值对象，直接存储（向后兼容）
      this._thisFClos = val
    }
  }

  /**
   * entry_fclos getter: 如果存储的是 UUID，从符号表中获取对象
   */
  get entry_fclos() {
    if (this._entry_fclos === null || this._entry_fclos === undefined) {
      return null
    }
    // 如果是 UUID，从符号表中获取对象
    if (typeof this._entry_fclos === 'string' && this._entry_fclos.startsWith('symuuid_')) {
      const unit = this.symbolTable.get(this._entry_fclos)
      return unit || null
    }
    // 如果不是 UUID，直接返回（向后兼容）
    return this._entry_fclos
  }

  /**
   * entry_fclos setter: 如果值是符号值对象，转换为 UUID 存储
   */
  set entry_fclos(val) {
    if (val === null || val === undefined) {
      this._entry_fclos = null
      return
    }
    // 如果是符号值对象，转换为 UUID 存储
    if (val && typeof val === 'object' && val.vtype && val.qid) {
      const uuid = this.symbolTable.register(val)
      this._entry_fclos = uuid
    } else {
      // 如果不是符号值对象，直接存储（向后兼容）
      this._entry_fclos = val
    }
  }

  /**
   * lastProcessedNode getter: 如果存储的是 nodehash，从 AST 管理器中获取 AST 节点
   */
  get lastProcessedNode() {
    if (this._lastProcessedNode === null || this._lastProcessedNode === undefined) {
      return null
    }
    // 如果是字符串，尝试从 AST 管理器中获取 AST 节点（可能是 nodehash）
    if (typeof this._lastProcessedNode === 'string') {
      const astNode = this.astManager?.get(this._lastProcessedNode)
      if (astNode) {
        return astNode
      }
      // 如果获取不到，可能是其他字符串，直接返回（向后兼容）
      return this._lastProcessedNode
    }
    // 如果不是字符串，直接返回（向后兼容）
    return this._lastProcessedNode
  }

  /**
   * lastProcessedNode setter: 如果值是 AST 节点，转换为 nodehash 存储
   */
  set lastProcessedNode(val) {
    if (val === null || val === undefined) {
      this._lastProcessedNode = null
      return
    }
    // 如果是 AST 节点（有 type 属性），注册并存储 nodehash
    if (val && typeof val === 'object' && val.type && this.astManager) {
      const nodehash = this.astManager.register(val)
      this._lastProcessedNode = nodehash
    } else {
      // 如果不是 AST 节点，直接存储（向后兼容）
      this._lastProcessedNode = val
    }
  }

  /**
   * return checkerManager
   */
  getCheckerManager() {
    return this.checkerManager
  }

  /**
   * 基于位置和类型生成指令的唯一键
   * @param node - 正在处理的AST节点
   * @param instructionType - 指令类型
   * @returns 唯一键字符串
   */
  getLocationKey(node: any, instructionType: string): string {
    if (!node || !node.loc) {
      return `${instructionType}:unknown_location`
    }

    let sourceFile = node.loc.sourcefile || 'unknown_file'

    // 如果存在项目路径前缀，则移除
    if (this.options && this.options.maindir) {
      const projectPath = this.options.maindir
      if (sourceFile.startsWith(projectPath)) {
        sourceFile = sourceFile.substring(projectPath.length)
        // 移除可能存在的开头斜杠
        if (sourceFile.startsWith('/')) {
          sourceFile = sourceFile.substring(1)
        }
      }
    }

    const startLine = node.loc.start?.line || 0
    const startColumn = node.loc.start?.column || 0
    const endLine = node.loc.end?.line || 0
    const endColumn = node.loc.end?.column || 0

    return `${instructionType}:${sourceFile}:${startLine}:${startColumn}:${endLine}:${endColumn}`
  }

  /**
   *
   * 初始化符号值树
   */
  initValTreeStruct() {
    this.astManager = new ASTManager()
    this.symbolTable = new SymbolTableManager()
    setGlobalASTManager(this.astManager)
    setGlobalSymbolTable(this.symbolTable)

    const moduleManager = new Scoped('<global>', {
      sid: 'moduleManager',
    })

    const packageManager = new PackageValue('<global>', {
      parent: null,
      sid: 'packageManager',
      name: 'packageManager',
    })

    this.fileManager = {}

    const funcSymbolTableTarget: Record<string, any> = {}
    const { symbolTable } = this
    this.funcSymbolTable = new Proxy(funcSymbolTableTarget, {
      get: (target, prop: string | symbol) => {
        if (typeof prop === 'symbol') {
          return (target as any)[prop]
        }
        if (prop === 'toString' || prop === 'valueOf' || prop === 'constructor') {
          return (target as any)[prop]
        }
        const value = target[prop]
        if (value && typeof value === 'string' && value.startsWith('symuuid_')) {
          const unit = symbolTable.get(value)
          return unit || null
        }
        return value
      },
      set: (target, prop: string, value: any) => {
        if (value && typeof value === 'object' && value.vtype && value.qid) {
          const uuid = symbolTable.register(value)
          target[prop] = uuid
          ;(symbolTable as any).addFuncSymbolTableRef?.(uuid, prop)
        } else {
          target[prop] = value
        }
        return true
      },
      deleteProperty: (target, prop: string) => {
        delete target[prop]
        return true
      },
      ownKeys: (target) => {
        return Reflect.ownKeys(target)
      },
      has: (target, prop) => {
        return prop in target
      },
    }) as Record<string, any>

    this.topScope = new Scoped('', {
      sid: '<global>',
      qid: '<global>',
      parent: null,
    })

    this.context = new AnalysisContext()
    this.context.ast = this.astManager
    this.context.symbols = this.symbolTable
    this.context.modules = moduleManager
    this.context.packages = packageManager
    this.context.files = this.fileManager
    this.context.funcs = this.funcSymbolTable
    this.topScope.context = this.context

    moduleManager.parent = this.topScope
    packageManager.parent = this.topScope

    this.thisFClos = this.topScope
  }

  /**
   * 切换到临时符号表，在执行 symbolInterpretFn 期间自动拷贝符号值
   */
  protected switchToTemporarySymbolTable(): void {
    // 确保当前 symbolTable 是 SymbolTableManager，不是 TemporarySymbolTableManager
    // 如果已经是 TemporarySymbolTableManager，说明存在嵌套调用，这是不支持的
    if (this.symbolTable instanceof TemporarySymbolTableManager) {
      throw new Error(
        'Nested TemporarySymbolTableManager is not supported. symbolInterpretFn should not be called recursively.'
      )
    }

    // 创建临时符号表，在执行 symbolInterpretFn 期间自动拷贝符号值
    const tmpSymbolTable = new TemporarySymbolTableManager(this.symbolTable as InstanceType<typeof SymbolTableManager>)
    const originalGlobalSymbolTable = getGlobalSymbolTable()
    const originalAnalyzerSymbolTable = this.symbolTable
    const originalTopScopeSymbolTable = (this.topScope?.context?.symbols as ISymbolTableManager | null) || null

    setGlobalSymbolTable(tmpSymbolTable)
    this.symbolTable = tmpSymbolTable
    if (this.topScope?.context) {
      this.topScope.context.symbols = tmpSymbolTable
    }
    this.isTmpSymbolTableOpen = true
    this.tmpSymbolTable = tmpSymbolTable
    this.backUpSymbolTable = {
      originalGlobalSymbolTable,
      originalAnalyzerSymbolTable,
      originalTopScopeSymbolTable,
    }
  }

  /**
   * 恢复原始符号表引用，并清理临时符号表
   */
  protected restoreSymbolTable(): void {
    // 恢复所有符号表引用
    setGlobalSymbolTable(this.backUpSymbolTable.originalGlobalSymbolTable)
    this.symbolTable = this.backUpSymbolTable.originalAnalyzerSymbolTable
    if (this.topScope?.context) {
      this.topScope.context.symbols = this.backUpSymbolTable.originalTopScopeSymbolTable
    }
    this.isTmpSymbolTableOpen = false
    // 清理临时符号表
    this.tmpSymbolTable.clear()
  }

  /**
   * 执行分析流程的通用方法，统一处理性能追踪
   * @param initAfterUsingCache
   * @param preProcessFn - 执行同步 preProcess 的函数（必须返回 void，不能返回 Promise）
   * @returns {Promise<any>} 分析结果
   */
  private async executeAnalysisPipeline(
    initAfterUsingCache: () => void,
    preProcessFn: () => void | Promise<void>
  ): Promise<any> {
    // 开始整体性能追踪
    this.performanceTracker.start()
    this.performanceTracker.start('preProcess')

    Rules.setPreprocessReady(false)
    // 启用指令级别的性能监控（如果已启用性能日志）
    this.performanceTracker.startInstructionMonitor()

    // 尝试加载缓存
    let cacheLoaded = false
    let shouldPreProcess = true
    if (Config.loadContextEnvironment) {
      shouldPreProcess = false
      this.performanceTracker.start('loadContextEnvironment')
      try {
        // 根据源路径查找缓存文件夹（基于 repoName 和 hashPrefix）
        const sourcePath = this.options?.maindir || Config.prefixPath || process.cwd()
        cacheLoaded = loadAnalyzerCache(this, Config.loadContextEnvironmentId, sourcePath)
        if (cacheLoaded) {
          logger.info('Analyzer cache loaded successfully')
        }
        if (cacheLoaded && Config.maindirPrefix) {
          const name = Config.maindirPrefix.split('/').pop() || Config.maindirPrefix
          if (!Config.loadContextEnvironmentId || !Config.loadContextEnvironmentId.startsWith(`${name}_`)) {
            shouldPreProcess = true
          }
        }
        if (!shouldPreProcess && typeof initAfterUsingCache === 'function') {
          initAfterUsingCache()
        }
      } catch (err: any) {
        logger.warn(`Failed to load analyzer cache: ${err.message}`)
      }
      this.performanceTracker.end('loadContextEnvironment')
    }

    if (shouldPreProcess) {
      const result = preProcessFn()
      if (result instanceof Promise) {
        await result
      }
    }

    this.performanceTracker.end('preProcess')

    // 保存缓存（在 startAnalyze 之前）
    if (Config.saveContextEnvironment || Config.miniSaveContextEnvironment) {
      try {
        this.performanceTracker.start('saveContextEnvironment')
        const sourcePath = this.options?.maindir
        const cacheId = generateCacheId(sourcePath)
        saveAnalyzerCache(this, cacheId)
        logger.info('Analyzer cache saved successfully')
        // 保存完成后结束分析
        this.performanceTracker.end('saveContextEnvironment')
        return
      } catch (err: any) {
        logger.warn(`Failed to save analyzer cache: ${err.message}`)
      }
    }

    this.performanceTracker.start('startAnalyze')

    this.startAnalyze()

    this.performanceTracker.end('startAnalyze')
    Rules.setPreprocessReady(true)

    this.performanceTracker.start('symbolInterpret')

    // 切换到临时符号表
    this.switchToTemporarySymbolTable()

    try {
      this.symbolInterpret()
    } finally {
      // 恢复原始符号表
      this.restoreSymbolTable()
    }
    this.performanceTracker.end('symbolInterpret')
    this.endAnalyze()

    // 记录性能数据并输出摘要（会自动输出指令统计）
    performanceTracker.collectAnalysisData(this)

    return this.recordCheckerFindings()
  }

  /**
   * 分析单个文件
   * @param source - 源代码内容
   * @param fileName - 文件名
   * @returns 分析结果
   */
  async analyzeSingleFile(source: any, fileName: any) {
    try {
      // 单文件就不要用缓存了
      Config.loadContextEnvironment = false
      Config.saveContextEnvironment = false
      Config.miniSaveContextEnvironment = false
      if (typeof this.preProcess4SingleFile === 'function' && typeof this.symbolInterpret === 'function') {
        return await this.executeAnalysisPipeline(
          () => {},
          () => this.preProcess4SingleFile(source, fileName)
        )
      }
      logger.info(`this analyzer has not support analyzeSingleFile yet`)
      return this.recordCheckerFindings()
    } catch (e) {
      handleException(e, 'Error occurred in analyzer analyzeSingleFile', 'Error occurred in analyzer analyzeSingleFile')
      return false
    }
  }

  /**
   * 分析项目
   * @param processingDir - 要分析的项目目录
   * @returns 分析结果
   */
  async analyzeProject(processingDir: any) {
    try {
      if (typeof this.preProcess === 'function' && typeof this.symbolInterpret === 'function') {
        if (typeof this.initAfterUsingCache !== 'function') {
          this.initAfterUsingCache = () => {}
        }
        return await this.executeAnalysisPipeline(
          () => this.initAfterUsingCache(),
          () => this.preProcess(processingDir)
        )
      }
      return this.recordCheckerFindings()
    } catch (e: any) {
      const errorMsg = e?.message || String(e)
      const errorStack = e?.stack || ''
      handleException(
        e,
        `Error occurred in analyzer analyzeProject: ${errorMsg}\n${errorStack}`,
        `Error occurred in analyzer analyzeProject: ${errorMsg}`
      )
      return false
    }
  }

  /**
   *
   */
  recordCheckerFindings() {
    const resultManager = this.checkerManager.getResultManager()
    if (resultManager) {
      return resultManager.getFindings()
    }
    return null
  }

  /**
   *
   */
  initTopScope() {}

  /**
   *
   * @param uast
   * @param fileName
   */
  initModuleScope(uast: any, fileName: any) {}

  /**
   *
   */
  startAnalyze() {
    if (this.checkerManager && this.checkerManager.checkAtStartOfAnalyze) {
      this.checkerManager.checkAtStartOfAnalyze(this, null, null, null, null)
    }
  }

  /**
   *
   */
  endAnalyze() {
    if (this.checkerManager && this.checkerManager.checkAtEndOfAnalyze) {
      this.checkerManager.checkAtEndOfAnalyze(this, null, null, null, null)
    }
  }

  /**
   *
   * @param instructionType
   */
  loadInstruction(instructionType: any) {
    /**
     *
     * @param obj
     */
    function load(obj: any) {
      if (!obj) return
      // 使用 hasOwnProperty 方法检查 obj 是否拥有名为 instructionType 的属性。如果有，返回该属性的值
      if (obj.hasOwnProperty(instructionType)) {
        return obj[instructionType]
      }
      // 如果当前对象没有该属性，则调用 Object.getPrototypeOf 获取 obj 的原型对象
      // 并在该原型对象上递归调用 load 函数。
      return load(Object.getPrototypeOf(obj))
    }

    return load(this)
  }

  // prePostFlag
  /**
   *
   * @param scope
   * @param node
   * @param state
   * @param prePostFlag
   */
  processInstruction(scope: any, node: any, state: any, prePostFlag?: any): any {
    if (!node || !scope) {
      return new UndefinedValue()
    }
    if (node.vtype) {
      return node
    }
    this.lastProcessedNode = node

    if (scope.vtype === 'union') {
      const res = new UnionValue(
        undefined,
        undefined,
        `${scope.qid}.<union@PI:${node.loc?.start?.line}:${node.loc?.start?.column}>`,
        node
      )
      for (const scp of scope.value) {
        const val = this.processInstruction(scp, node, state, prePostFlag)
        res.appendValue(val)
      }
      return res
    }

    if (Array.isArray(node)) {
      let res
      for (const s of node) {
        res = this.processInstruction(scope, s, state, prePostFlag)
      }
      return res
    }
    const action = prePostFlag ? `${prePostFlag}Process` : 'process'
    const inst = this.loadInstruction(action + node.type)
    if (!inst) {
      if (Config.saveContextEnvironment || Config.miniSaveContextEnvironment) {
        return new SymbolValue(scope.qid, { sid: '<unknownProcessTypeNode>' })
      }
      return new SymbolValue(scope.qid, { ...node, sid: '<unknownProcessTypeNode>' })
    }
    // TODO 添加判断，后续指令是否是跟在return或throw后且在同一个scope内无法执行的指令 4+
    this.statistics.numProcessedInstructions++

    // 如果启用了性能日志（enablePerformanceLogging），会自动记录指令执行时间和次数
    this.performanceTracker.startInstruction()

    let val
    try {
      val = inst.call(this, scope, node, state)
    } catch (e) {
      const locInfo = node.loc
        ? `${node.loc.sourcefile}::${node.loc.start?.line}_${node.loc.end?.line}`
        : '<unknown location>'
      handleException(e, '', `process${node.type} error! loc is${locInfo}`)
      val = new UndefinedValue()
    }

    // 性能追踪：结束指令执行并更新统计（内部会检查是否启用）
    this.performanceTracker.endInstructionAndUpdateStats(node, (node: any, instructionType: string) =>
      this.getLocationKey(node, instructionType)
    )
    if (!this.preprocessState && val?.__preprocess) {
      delete val.__preprocess
      this.processPre(val, state)
    }
    if (this.checkerManager && this.checkerManager.checkAtEndOfNode)
      this.checkerManager.checkAtEndOfNode(this, scope, node, state, { val })
    return val
  }

  /**
   *
   * @param val
   * @param state
   */
  processPre(val: any, state: any) {
    switch (val?.vtype) {
      case 'class':
        this.processClassDefinition(val.parent, val.ast.cdef, state)
        break
      case 'fclos':
        this.processFunctionDefinition(val.parent, val.ast.fdef, state)
        break
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processNoop(scope: any, node: any, state: any) {
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processLiteral(scope: ScopeType, node: Literal, state: State): SymbolValueType {
    return new PrimitiveValue(
      scope.qid,
      primitiveToString(node.value),
      node.value,
      node.literalType,
      node.type,
      node.loc,
      node
    )
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processIdentifier(scope: ScopeType, node: Identifier, state: State): SymbolValueType {
    if (node.name === 'undefined') {
      return new PrimitiveValue(scope.qid, 'undefined', undefined, null, 'Literal')
    }
    let res
    if (state?.findIdInCurScope) {
      res = this.getMemberValueInCurrentScope(scope, node, state)
    } else {
      res = this.getMemberValue(scope, node, state)
    }
    if (res.vtype === 'fclos') {
      res._this = this.topScope
    }
    if (res.vtype === 'undefine' || res.vtype === 'uninitialized' || res.vtype === 'symbol') {
      res.sid = node.name
    }
    const info = { res }
    this.checkerManager.checkAtIdentifier(this, scope, node, state, info)
    return info.res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCompileUnit(scope: ScopeType, node: CompileUnit, state: State): Value {
    if (this.checkerManager && this.checkerManager.checkAtCompileUnit) {
      this.checkerManager.checkAtCompileUnit(this, scope, node, state, {
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
      })
    }

    // node.body.forEach(n => this.processInstruction(scope, n, state));
    this.preprocessState = true
    node.body
      .filter((n: any) => needCompileFirst(n.type))
      .forEach((n: any) => this.processInstruction(scope, n, state, 'pre'))
    delete this.preprocessState
    // node.body.filter(n => !needCompileFirst(n.type)).forEach(n => this.processInstruction(scope, n, state));
    // node.body.filter(n => needCompileFirst(n.type)).forEach(n => this.processInstruction(scope, n, state));
    // process Compile First twice in order to handle elements which can't be correctly compiled once first
    node.body.forEach((n: any) => this.processInstruction(scope, n, state))
    return new VoidValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processExportStatement(scope: ScopeType, node: ExportStatement, state: State): VoidValueType {
    // locate exports
    const exports = this.getExportsScope(scope)
    const val = this.processInstruction(scope, node.argument, state)
    if (Array.isArray(exports)) {
      exports.forEach((exp) => this.saveVarInCurrentScope(exp, node.alias, val, state))
    } else if (exports) {
      this.saveVarInCurrentScope(exports, node.alias, val, state)
    }
    return new VoidValue()
  }

  /**
   *
   * @param lstate
   * @param rstate
   * @param state
   * @param test
   */
  processLRScopeInternal(lstate: any, rstate: any, state: any, test: any) {
    if (test) lstate.pcond.push(test)
    const { binfo } = state
    lstate.binfo = _.clone(binfo)
    if (test) {
      const rtest = _.clone(test)
      rtest.is_neg = true
      rstate.pcond.push(rtest)
    }
    rstate.binfo = _.clone(binfo)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processIfStatement(scope: ScopeType, node: IfStatement, state: State): VoidValueType {
    /*
      { test,
        consequent,
        alternative
      }
      */
    const test = this.processInstruction(scope, node.test, state)
    if (this.checkerManager && this.checkerManager.checkAtIfCondition) {
      this.checkerManager.checkAtIfCondition(this, scope, node.test, state, {
        nvalue: test,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
      })
    }

    let b: string = 'U' // abstraction.evaluate(test, state.pcond);
    if (test?.type === 'Literal' && test.value === true) {
      b = 'T'
    } else if (test?.type === 'Literal' && test.value === false) {
      b = 'F'
    }

    switch (b) {
      case 'T':
        this.processInstruction(scope, node.consequent, state)
        break
      case 'F':
        if (node.alternative) this.processInstruction(scope, node.alternative, state)
        break
      default: {
        if (node.alternative && node.alternative.type != 'Noop') {
          // two branches

          const rscope = MemState.cloneScope(scope, state)
          const substates = MemState.forkStates(state)
          const lstate = substates[0]
          const rstate = substates[1]
          this.processLRScopeInternal(lstate, rstate, state, test)

          this.processInstruction(scope, node.consequent, lstate)
          this.processInstruction(rscope, node.alternative, rstate)

          MemState.unionValues([scope, rscope], substates, state.brs)

          // union branch related information
          this.postBranchProcessing(node, test, state, lstate, rstate)
        } else {
          // only one branch
          const substates = MemState.forkStates(state, 1)
          const lstate = substates[0]
          const { pcond } = state
          lstate.pcond = pcond.slice(0)
          lstate.parent = state
          if (test) lstate.pcond.push(test)
          lstate.binfo = _.clone(state.binfo)

          this.processInstruction(scope, node.consequent, lstate)

          MemState.unionValues([scope, scope], substates, lstate.brs)

          this.postBranchProcessing(node, test, state, lstate)
        }
      }
    }
    return new VoidValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSwitchStatement(scope: ScopeType, node: SwitchStatement, state: State): VoidValueType {
    // cases: [ SwitchCase ]
    const test = this.processInstruction(scope, node.discriminant, state)
    if (test && test.type === 'Literal') {
      const testValue = (test as any as Literal).value
      for (const caseClause of node.cases) {
        if (
          !caseClause.test || // FIXME
          (caseClause.test.type === 'Literal' && (caseClause.test as any as Literal).value === testValue)
        ) {
          return this.processInstruction(scope, caseClause.body, state)
        }
      }
      return new UndefinedValue()
    }

    const scopes = []
    const n = node.cases.length
    const substates = MemState.forkStates(state, n)
    let i = 0
    for (const caseClause of node.cases) {
      const scope1 = MemState.cloneScope(scope, state)
      scopes.push(scope1)
      const st = substates[i++] || substates[0]
      this.processInstruction(scope1, caseClause.body, st)
    }
    MemState.unionValues(scopes, substates, state.brs)
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processForStatement(scope: ScopeType, node: ForStatement, state: State): VoidValueType {
    StateUtil.pushLoopInfo(state, node)
    if (node.init) {
      this.processInstruction(scope, node.init, state)
    }

    let test = node.test ? this.processInstruction(scope, node.test, state) : null
    if (test && test.type === 'Literal') {
      if (test.value) {
        this.processInstruction(scope, node.body, state)
      }
    } else {
      this.processInstruction(scope, node.body, state)
    }
    if (node.update) {
      this.processInstruction(scope, node.update, state)
    }
    test = this.processInstruction(scope, node.test, state)
    if (test && test.type === 'Literal') {
      if (test.value) this.processInstruction(scope, node.body, state)
    } else this.processInstruction(scope, node.body, state)

    StateUtil.popLoopInfo(state)
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processWhileStatement(scope: ScopeType, node: WhileStatement, state: State): VoidValueType {
    /*
    { test,
     body,
     isPostTest
    }
    */
    StateUtil.pushLoopInfo(state, node)
    // TODO node.isPostTest
    let test = this.processInstruction(scope, node.test, state)
    if (test && test.type === 'Literal') {
      if (test.value) this.processInstruction(scope, node.body, state)
    } else this.processInstruction(scope, node.body, state)

    // unroll one more time
    test = this.processInstruction(scope, node.test, state)
    if (test && test.type === 'Literal') {
      if (test.value) this.processInstruction(scope, node.body, state)
    } else this.processInstruction(scope, node.body, state)

    StateUtil.popLoopInfo(state)
    // // fixed-point on values (with scopes) for data-flow calculation
    // scope.value = MemState.computeValueFixedPoint(scope).value;

    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processRangeStatement(scope: ScopeType, node: RangeStatement, state: State): any {
    const { key, value, right, body } = node
    scope = Scope.createSubScope(
      `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
      scope
    )
    const rightVal = this.processInstruction(scope, right, state)
    if (
      !Array.isArray(rightVal) &&
      (this.inRange ||
        rightVal?.vtype === 'primitive' ||
        Object.keys(rightVal.getRawValue()).filter((key) => !key.startsWith('__yasa')).length === 0 ||
        rightVal?.vtype === 'union')
    ) {
      if (value) {
        if (value.type === 'VariableDeclaration') {
          this.saveVarInCurrentScope(scope, value.id, rightVal, state)
        } else if (value.type === 'TupleExpression') {
          for (const ele of value.elements) {
            // Runtime may have 'name' property even if not in type definition
            this.saveVarInCurrentScope(scope, ele.name, rightVal, state)
          }
        } else {
          this.saveVarInScope(scope, value, rightVal, state)
        }
      }
      if (key) {
        // TODO js存到value，go存到key。且需要考虑既有key 又有value的场景
        this.saveVarInScope(scope, key, rightVal, state)
      }
      this.processInstruction(scope, body, state)
    } else {
      this.inRange = true
      if (this.isNullLiteral(rightVal)) {
        this.inRange = false
        return undefined as any // 保持历史行为（25282dbd）
      }
      const itr = this.getValueIterator(rightVal, filterDataFromScope)
      let countLimit = 30
      for (let { value: field, done } = itr.next(); !done; { value: field, done } = itr.next()) {
        if (countLimit-- === 0) {
          break
        }
        if (!field) continue
        let { k, v } = field
        if (key) {
          if (key.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, key.id, k, state)
          } else {
            // 如果是string，将其构造出符号值再存储
            // TODO 250731 将符号的字面量(而非符号值)作为key存储是否合适，有待商榷。
            if (_.isString(k)) k = new PrimitiveValue(scope.qid, k, k, null, key.type, key.loc, key)
            this.saveVarInScope(scope, key, k, state)
          }
        }
        if (value) {
          if (value.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, value.id, v, state)
          } else if (value.type === 'TupleExpression') {
            for (let i = 0; i < value.elements.length; i++) {
              const eleVal = v?.members?.get(String(i)) ?? v
              this.saveVarInCurrentScope(scope, value.elements[i].name, eleVal, state)
            }
          } else {
            this.saveVarInScope(scope, value, v, state)
          }
        }
        this.processInstruction(scope, body, state)
      }
      this.inRange = false
    }
    return new VoidValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processReturnStatement(scope: ScopeType, node: ReturnStatement, state: State): VoidValueType {
    // { expression }
    // lastReturnValue should be treated as union since there are multi return points in one func
    if (node.argument) {
      const returnValue = this.processInstruction(scope, node.argument, state)
      if (!node.isYield) {
        if (!this.lastReturnValue) {
          this.lastReturnValue = returnValue
        } else if (this.lastReturnValue.vtype === 'union') {
          if (returnValue === this.lastReturnValue || returnValue.value === this.lastReturnValue.value) {
            const newReturnValue = buildNewValueInstance(
              this,
              returnValue,
              node,
              scope,
              () => {
                return false
              },
              (v: any) => {
                return !v
              }
            )
            this.lastReturnValue.appendValue(newReturnValue, false)
          } else {
            this.lastReturnValue.appendValue(returnValue, false)
          }
        } else {
          const tmp = new UnionValue(undefined, undefined, `${scope.qid}.<union@ret:${node.loc?.start?.line}>`, node)
          tmp.appendValue(this.lastReturnValue)
          tmp.appendValue(returnValue)
          this.lastReturnValue = tmp
        }
        if (node.loc && this.lastReturnValue)
          this.lastReturnValue = SourceLine.addSrcLineInfo(
            this.lastReturnValue,
            node,
            node.loc.sourcefile,
            'Return Value: ',
            '[return value]'
          )
      }
      return returnValue
    }
    return new PrimitiveValue(scope.qid, 'undefined', null, null, 'Literal', node.loc)
  }

  // TODO break statement
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processBreakStatement(scope: ScopeType, node: BreakStatement, state: State): VoidValueType {
    return new UndefinedValue()
  }

  // TODO continue statement
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processContinueStatement(scope: ScopeType, node: ContinueStatement, state: State): VoidValueType {
    return new UndefinedValue()
  }

  // TODO throw
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processThrowStatement(scope: ScopeType, node: ThrowStatement, state: State): VoidValueType {
    // 原本是注释的，打开了，throw和return 还是有很大区别的
    // throw会沿着调用栈传递，return 只会传到调用层 没处理就结束了
    // const ret = this.processReturnStatement(scope, node, state);
    // ret.throwed = true;
    // return ret;
    let throw_value
    if (node.argument) {
      throw_value = this.processInstruction(scope, node.argument, state)
      if (throw_value && state.throwstack) {
        throw_value = SourceLine.addSrcLineInfo(
          throw_value,
          node,
          node.loc && node.loc.sourcefile,
          'Throw Pass: ',
          (node.argument.type === 'Identifier' ? node.argument.name : null) ||
            AstUtil.prettyPrintAST(node.argument).slice(0, 50)
        )
        // 没有被try处理的异常
        state.throwstack = state.throwstack ?? []
        state.throwstack.push(throw_value)
        return throw_value
      }
      state.throwstackScopeAndState = state.throwstackScopeAndState ?? []
      state.throwstackScopeAndState.push({ scope, state })
    }
    return new PrimitiveValue(
      scope.qid,
      `<throwVariable_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
      node.argument,
      null,
      'Literal',
      node.loc
    )
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processTryStatement(scope: ScopeType, node: TryStatement, state: State): VoidValueType {
    // 此处processInstruction的返回值是undefine 因此无法拿到try里面是否抛出异常的信息
    this.processInstruction(scope, node.body, state)
    const { handlers } = node
    if (handlers) {
      for (const clause of handlers) {
        if (!clause) continue
        scope = Scope.createSubScope(
          `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
          scope
        )
        clause.parameter.forEach((param: any) => this.processInstruction(scope, param, state))
        this.processInstruction(scope, clause.body, state)
      }
    }
    if (node.finalizer) this.processInstruction(scope, node.finalizer, state)
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processExpressionStatement(scope: ScopeType, node: ExpressionStatement, state: State): VoidValueType {
    // { expression }
    return this.processInstruction(scope, node.expression, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processScopedStatement(scope: ScopeType, node: ScopedStatement, state: State): any {
    /*
    { statements }
    */
    const { loc } = node
    let scopeName
    if (loc) {
      if (!scope.qid) {
        const prefix = loc.sourcefile?.substring(Config.maindirPrefix.length)
        const lastDotIndex = prefix?.lastIndexOf('.') ?? -1
        const relateFileName = lastDotIndex >= 0 ? prefix?.substring(0, lastDotIndex) : prefix
        scopeName = `${relateFileName}<block_${loc.start?.line}_${loc.start?.column}_${loc.end?.line}_${loc.end?.column}>`
      } else {
        scopeName = `<block_${loc.start?.line}_${loc.start?.column}_${loc.end?.line}_${loc.end?.column}>`
      }
    } else {
      scopeName = `<block_${Uuid.v4()}>`
    }
    const block_scope = Scope.createSubScope(scopeName, scope, 'scope')
    // definition hoisting handle definion first
    node.body
      .filter((n: any) => needCompileFirst(n.type))
      .forEach((s: any) => this.processInstruction(block_scope, s, state))
    node.body
      .filter((n: any) => !needCompileFirst(n.type))
      .forEach((s: any) => this.processInstruction(block_scope, s, state))

    if (this.checkerManager && this.checkerManager.checkAtEndOfBlock) {
      this.checkerManager.checkAtEndOfBlock(this, scope, node, state, {})
    }
    return new VoidValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processBinaryExpression(scope: ScopeType, node: BinaryExpression, state: State): BinaryExprValue {
    const new_left = this.processInstruction(scope, node.left, state)
    const new_right = this.processInstruction(scope, node.right, state)

    const has_tag = (new_left && new_left.taint?.isTaintedRec) || (new_right && new_right.taint?.isTaintedRec)

    // checkerManager 需要 newNode 兼容对象
    const newNode: any = { ...node, ast: node, left: new_left, right: new_right, isTainted: has_tag || null }
    if (this.checkerManager && this.checkerManager.checkAtBinaryOperation)
      this.checkerManager.checkAtBinaryOperation(this, scope, node, state, { newNode })

    const result = new BinaryExprValue(scope.qid, node.operator, new_left, new_right, node, node.loc)
    if (has_tag) {
      result.taint?.mergeFrom([new_left, new_right])
    }
    return result
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processUnaryExpression(scope: ScopeType, node: UnaryExpression, state: State): UnaryExprValue {
    const unaryArg = this.processInstruction(scope, node.argument, state)
    const result = new UnaryExprValue(scope.qid, node.operator, unaryArg, node, node.loc, node.isSuffix)
    const hasTags = unaryArg && unaryArg.taint?.isTaintedRec
    if (hasTags) result.taint?.mergeFrom([unaryArg])
    return result
  }

  /**
   * "left = right", "left *= right", etc.
   * @param scope
   * @param node
   * @param state
   */
  processAssignmentExpression(scope: ScopeType, node: AssignmentExpression, state: State): any {
    /*
    { operator,
      left,
      right,
      cloned
    }
    */
    switch (node.operator) {
      case '=': {
        const { left } = node
        const { right } = node
        let tmpVal = this.processInstruction(scope, right, state)
        const oldVal = this.processInstruction(scope, left, state)

        // TODO: clean the following up
        if (left.type === 'TupleExpression') {
          for (let k = 0; k < left.elements.length; k++) {
            const x = left.elements[k]
            if (!x) continue
            const xName = x.type === 'Identifier' ? x.name : undefined
            if (xName === '_') continue

            let val = tmpVal && tmpVal.type === 'TupleExpression' ? tmpVal.elements[k] : tmpVal
            const oldV = oldVal && oldVal.type === 'TupleExpression' ? oldVal.elements[k] : oldVal
            val = SourceLine.addSrcLineInfo(val, node, node.loc && node.loc.sourcefile, 'Var Pass:', val.name)
            this.saveVarInScope(scope, x, val, state, oldV)

            if (this.checkerManager && this.checkerManager.checkAtAssignment) {
              const lscope = this.getDefScope(scope, x)
              const mindex = this.resolveIndices(scope, x, state)
              this.checkerManager.checkAtAssignment(this, scope, node, state, {
                lscope,
                lvalue: oldVal,
                rvalue: val,
                pcond: state.pcond,
                binfo: state.binfo,
                entry_fclos: this.entry_fclos,
                mindex,
                einfo: state.einfo,
                state,
              })
            }
          }
        } else {
          if (!tmpVal) {
            tmpVal = new PrimitiveValue(scope.qid, 'undefined', null, null, 'Literal', right.loc)
          }
          if (typeof tmpVal !== 'object') {
            tmpVal = new PrimitiveValue(scope.qid, `<literal_${tmpVal}>`, tmpVal, null, 'Literal', right.loc)
          }
          const sid = SymAddress.toStringID(node.left)
          if (
            tmpVal.sid === undefined ||
            tmpVal.sid === null ||
            (typeof tmpVal.sid === 'string' && tmpVal.sid.includes('<object'))
          ) {
            tmpVal.sid = sid
          }
          if (this.checkerManager && this.checkerManager.checkAtAssignment) {
            const lscope = this.getDefScope(scope, left)
            const mindex = this.resolveIndices(scope, left, state)
            this.checkerManager.checkAtAssignment(this, scope, node, state, {
              lscope,
              lvalue: oldVal,
              rvalue: tmpVal,
              pcond: state.pcond,
              binfo: state.binfo,
              entry_fclos: this.entry_fclos,
              mindex,
              einfo: state.einfo,
              state,
              ainfo: this.ainfo,
            })
          }
          // Runtime may have 'name' property even if not in type definition
          const leftAsAny = left as any
          if (!leftAsAny.name && sid) {
            leftAsAny.name = sid
          }
          tmpVal = SourceLine.addSrcLineInfo(tmpVal, node, node.loc && node.loc.sourcefile, 'Var Pass:', leftAsAny.name)
          this.saveVarInScope(scope, left, tmpVal, state, oldVal)
        }
        return tmpVal
      }
      case '&=':
      case '^=':
      case '<<=':
      case '>>=':
      case '+=':
      case '-=':
      case '*=':
      case '/=':
      case '%=': {
        const binLeft = this.processInstruction(scope, node.left, state)
        const binRight = this.processInstruction(scope, node.right, state)
        const val = new BinaryExprValue(
          scope.qid,
          node.operator.substring(0, node.operator.length - 1),
          binLeft,
          binRight,
          node,
          node.loc,
          true
        )
        if (node.cloned) {
          const clonedValue = lodashCloneWithTag(val.right!.value)
          val.right = lodashCloneWithTag(val.right)
          val.right!.value = clonedValue
        }
        const { left } = node
        const oldVal = this.getMemberValueNoCreate(scope, left, state)

        const hasTags = (val.left && val.left.taint?.isTaintedRec) || (val.right && val.right.taint?.isTaintedRec)
        if (hasTags) val.taint?.mergeFrom([val.left, val.right])

        this.saveVarInScope(scope, node.left, val, state)

        if (this.checkerManager && this.checkerManager.checkAtAssignment) {
          const lscope = this.getDefScope(scope, node.left)
          const mindex = this.resolveIndices(scope, node.left, state)
          this.checkerManager.checkAtAssignment(this, scope, node, state, {
            lscope,
            lvalue: oldVal,
            rvalue: val,
            pcond: state.pcond,
            binfo: state.binfo,
            entry_fclos: this.entry_fclos,
            mindex,
            einfo: state.einfo,
            state,
            ainfo: this.ainfo,
          })
          // this.recordSideEffect(lscope, node.left, val.left);
        }
        return val
      }
      default: {
        // 其他操作符暂不支持，返回 UndefinedValue
        return new UndefinedValue()
      }
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSequence(scope: any, node: any, state: any) {
    let val
    for (const i in node.expressions) {
      const expr = node.expressions[i]
      val = this.processInstruction(scope, expr, state)
    }
    return val
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processConditionalExpression(scope: ScopeType, node: ConditionalExpression, state: State): SymbolValueType {
    /*
    { test,
      consequent,
      alternative
    }
     */
    const test = this.processInstruction(scope, node.test, state)
    // const rscope = scope;
    const rscope = MemState.cloneScope(scope, state)
    const substates = MemState.forkStates(state)
    const lstate = substates[0]
    const rstate = substates[1]
    this.processLRScopeInternal(lstate, rstate, state, test)

    const res = new UnionValue(
      undefined,
      undefined,
      `${scope.qid}.<union@cond:${node.loc?.start?.line}:${node.loc?.start?.column}>`,
      node
    )
    res.appendValue(this.processInstruction(scope, node.consequent, lstate))
    res.appendValue(this.processInstruction(rscope, node.alternative, rstate))
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSuperExpression(scope: ScopeType, node: SuperExpression, state: State): SymbolValueType {
    return this.getMemberValue(scope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processThisExpression(scope: ScopeType, node: ThisExpression, state: State): SymbolValueType {
    return this.thisFClos
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processMemberAccess(scope: ScopeType, node: MemberAccess, state: State): SymbolValueType {
    /**
     object,
     property,
     computed
     */
    const defscope = this.processInstruction(scope, node.object, state)
    const prop = node.property
    let resolved_prop = prop
    if (node.computed) {
      resolved_prop = this.processInstruction(scope, prop, state) // important, prop should be eval by scope rather than defscope
    } else {
      // non-computed indicates node.property must be identifier
      if (prop.type !== 'Identifier' && prop.type !== 'Literal') {
        // Errors.UnexpectedValue('type should be Identifier when property is non computed', { no_throw: true })
        // try to solve prop in this case though
        resolved_prop = this.processInstruction(scope, prop, state)
      }
    }
    const res = this.getMemberValue(defscope, resolved_prop, state)
    if (node.object.type !== 'SuperExpression' && (res.vtype !== 'union' || !Array.isArray(res.value))) {
      res._this = defscope
    }
    if (this.checkerManager && this.checkerManager.checkAtMemberAccess) {
      this.checkerManager.checkAtMemberAccess(this, defscope, node, state, { res })
    }
    return res
  }

  // TODO slice
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSliceExpression(scope: ScopeType, node: SliceExpression, state: State): SymbolValueType {
    // 返回 undefined 保持历史行为（25282dbd）
    return undefined as any // TODO: 实现 SliceExpression 处理
  }

  // TODO tuple
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processTupleExpression(scope: ScopeType, node: TupleExpression, state: State): SymbolValueType {
    const values = node.elements.map((ele: any) => {
      return this.processInstruction(scope, ele, state)
    })
    return unionAllValues(values, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processObjectExpression(scope: ScopeType, node: ObjectExpression, state: State): SymbolValueType {
    // FIXME
    const objSid = `<object_${node.loc?.start?.line}_${node.loc?.end?.line}>`
    let res = new Scoped(scope.qid, {
      sid: objSid,
      parent: scope,
      ast: node,
      _skipRegister: true,
    })
    if (node.properties) {
      for (const property of node.properties) {
        let name
        let fvalue
        // ObjectMethod may exist in runtime but not in UAST type definition
        const propertyType = (property as any).type
        switch (propertyType) {
          case 'ObjectMethod': {
            // ObjectMethod is not in UAST definition, but may exist in runtime
            const objectMethod = property as any
            name = objectMethod.key?.name
            fvalue = this.createFuncScope(objectMethod, scope)
            fvalue.ast.fdef = _.clone(fvalue.ast.fdef)
            if (fvalue.ast.fdef) {
              fvalue.ast.fdef.type = 'FunctionDefinition'
            }
            if (fvalue.ast?.node) {
              fvalue.ast.node.type = 'FunctionDefinition'
            }
            break
          }
          case 'SpreadElement': {
            this.processInstruction(res, property, state)
            continue
          }
          case 'ObjectProperty':
          default: {
            if (property.type !== 'ObjectProperty') continue
            let { key } = property
            switch (key.type) {
              // FIXME  process ObjectMethod
              case 'Literal':
                name = key.value
                break
              case 'Identifier':
                name = key.name
                break
              default:
                key = this.processInstruction(res, key, state)
                name = key.type === 'Literal' ? key.value : key.type === 'Identifier' ? key.name : undefined
                break
            }
            fvalue = this.processInstruction(res, property.value, state)
            if (fvalue?.taint?.isTaintedRec) res.taint?.propagateFrom(fvalue)
            // FunctionDefinition is both Decl and Expr (double inheritance)
            if (property.value && property.value.type === 'FunctionDefinition') fvalue.parent = res
            break
          }
        }
        res.value[name] = fvalue
        // // call-back
        // if (expressionCallBack) {
        //     expressionCallBack(node, [name, fvalue], this.currentFunction);
        // }
        // if (triggers)
        // //triggers.checkObjectValue(node, property, fvalue, this.currentFunction.sourcefile);
        //     triggers.checkExpression(property, fvalue);
      }
      res.length = node.properties.length
    }
    res = new ObjectValue(scope.qid, { ...res, sid: objSid })
    res.vtype = 'object'
    res._this = res
    return res
  }

  // ==================== CallArgs methods (Step 2) ====================

  /**
   * Build CallArgs from evaluated argvalues and call-site AST node.
   * Base implementation: all args are positional, keyword determined by node.names.
   * Language-specific analyzers can override (e.g. Python buildPythonCallArgs).
   */
  buildCallArgs(node: any, argvalues: any[], fclos: any): CallArgs {
    const args: CallArg[] = []
    for (let i = 0; i < argvalues.length; i++) {
      const name = this.getCallArgName(node, i)
      args.push({
        index: i,
        value: argvalues[i],
        node: node.arguments?.[i],
        name,
        kind: name ? 'keyword' : 'positional',
      })
    }
    const receiver = this.getCallReceiver(fclos, node)
    return { receiver, args }
  }

  /**
   * Get the keyword name for argument at given index from node.names.
   */
  getCallArgName(node: any, index: number): string | undefined {
    if (node.names && Array.isArray(node.names) && index < node.names.length) {
      const name = node.names[index]
      if (name && typeof name === 'string') return name
    }
    return undefined
  }

  /**
   * Get the receiver (this/self) from fclos for MemberAccess calls.
   */
  getCallReceiver(fclos: any, node: any): any {
    if (node?.callee?.type === 'MemberAccess') {
      return fclos?._this || fclos?.getThisObj?.()
    }
    return undefined
  }

  /**
   * 确保 callInfo 有效：缺失时创建空对象，callArgs 缺失时构建空 callArgs。
   */
  ensureCallInfo(node: any, fclos: any, callInfo?: CallInfo): CallInfo {
    const activeCallInfo: CallInfo = callInfo || ({ callArgs: { args: [] } } as CallInfo)
    if (!activeCallInfo.callArgs) {
      activeCallInfo.callArgs = this.buildCallArgs(node, [], fclos)
    }
    return activeCallInfo
  }

  /**
   * Bind CallArgs to function parameters, producing BoundCall.
   * 核心绑定逻辑：将 CallArgs 中的实参绑定到 BoundCall 的形参上。
   * 替代旧的 for-loop + node.names.indexOf 方式。
   */
  bindCallArgs(node: any, fclos: any, fdecl: any, callInfo: CallInfo): BoundCall {
    const callArgs = callInfo.callArgs
    const params = fdecl?.parameters
    const boundCall: BoundCall = {
      receiver: callArgs?.receiver,
      params: [],
    }
    if (!params || !callArgs) return boundCall

    const paramList: any[] = Array.isArray(params) ? params : params.parameters || []
    for (let i = 0; i < paramList.length; i++) {
      const param = paramList[i]
      boundCall.params.push({
        index: i,
        name: param.name || param.id?.name || `_${i}`,
        value: undefined,
        provided: false,
        argIndexes: [],
      })
    }

    const startIndex = this.bindReceiverParam(boundCall, paramList, callArgs, node)
    this.bindPositionalArgs(boundCall, paramList, callArgs, startIndex)
    this.bindKeywordArgs(boundCall, paramList, callArgs)

    return boundCall
  }

  /**
   * 判定形参类型：vararg（*args/rest）、varkw（**kwargs）、keyword_only、positional_only 或普通
   */
  getParamKind(param: any): string {
    if (param?._meta?.parameterKind) {
      return param._meta.parameterKind
    }
    if (param?._meta?.positional_only) {
      return 'positional_only'
    }
    if (param?._meta?.keyword_only) {
      return 'keyword_only'
    }
    if (param?._meta?.varkw) {
      return 'varkw'
    }
    // isRestElement: JS parser; varType._meta.varargs: Java/Go parser
    if (param?._meta?.isRestElement || param?.varType?._meta?.varargs) {
      return 'vararg'
    }
    return 'positional_or_keyword'
  }

  /**
   * 统一赋值：普通参数直接赋值，vararg 收集为数组，varkw 收集为对象
   */
  private assignParamValue(boundCall: BoundCall, params: any[], paramIndex: number, value: any, argIndex: number): void {
    if (paramIndex < 0 || paramIndex >= boundCall.params.length) return
    const target = boundCall.params[paramIndex]
    const paramKind = this.getParamKind(params[paramIndex])
    if (paramKind === 'vararg') {
      if (!target.provided || !Array.isArray(target.value)) {
        target.value = []
        target.provided = true
      }
      target.value.push(value)
      target.argIndexes.push(argIndex)
      return
    }
    if (paramKind === 'varkw') {
      if (!target.provided || !target.value || typeof target.value !== 'object' || Array.isArray(target.value)) {
        target.value = {}
        target.provided = true
      }
    }
    target.value = value
    target.provided = true
    target.argIndexes.push(argIndex)
  }

  /**
   * 展开 *args spread 值为数组
   */
  resolveSpreadValues(value: any): any[] {
    if (Array.isArray(value)) {
      return value
    }
    if (value?._field && Array.isArray(value._field)) {
      return value._field
    }
    if (value?.members && value.members.size > 0) {
      const numericKeys = [...value.members.keys()]
        .filter((key: string) => /^\d+$/.test(key))
        .sort((a: string, b: string) => Number(a) - Number(b))
      if (numericKeys.length > 0) {
        return numericKeys.map((key: string) => value.members.get(key))
      }
    }
    if (value?._field && typeof value._field === 'object') {
      const numericKeys = Object.keys(value._field)
        .filter((key: string) => /^\d+$/.test(key))
        .sort((a: string, b: string) => Number(a) - Number(b))
      if (numericKeys.length > 0) {
        return numericKeys.map((key: string) => value._field[key])
      }
    }
    return [value]
  }

  /**
   * 展开 **kwargs kwspread 值为 [name, value] 对
   */
  resolveKwSpreadEntries(value: any): Array<[string, any]> {
    if (!value) return []
    const entries: Array<[string, any]> = []
    if (value.members && value.members.size > 0) {
      for (const key of value.members.keys()) {
        entries.push([key, value.members.get(key)])
      }
    } else {
      const source = value._field && typeof value._field === 'object' ? value._field : value
      if (source && typeof source === 'object') {
        for (const [key, val] of Object.entries(source)) {
          if (typeof key === 'string') {
            entries.push([key, val])
          }
        }
      }
    }
    return entries
  }

  /**
   * receiver（self/cls/this）绑定到第一个形参，返回 positional 绑定的起始索引
   */
  bindReceiverParam(boundCall: BoundCall, params: any[], callArgs: CallArgs, node: any): number {
    if (!callArgs.receiver || params.length === 0) return 0
    const firstParam = params[0]
    const firstName = firstParam.name || firstParam.id?.name || ''
    if (['self', 'cls', 'this'].includes(firstName)) {
      const bp = boundCall.params[0]
      if (bp) {
        bp.value = callArgs.receiver
        bp.provided = true
      }
      return 1
    }
    return 0
  }

  /**
   * positional/spread 实参绑定到形参，溢出部分收集到 vararg
   */
  bindPositionalArgs(boundCall: BoundCall, params: any[], callArgs: CallArgs, startIndex: number): void {
    let nextPositionalIndex = startIndex
    const findNext = (): number => {
      while (nextPositionalIndex < params.length) {
        const kind = this.getParamKind(params[nextPositionalIndex])
        if (kind === 'keyword_only' || kind === 'varkw') {
          nextPositionalIndex++
          continue
        }
        return nextPositionalIndex
      }
      return -1
    }

    for (const arg of callArgs?.args || []) {
      if (arg.kind === 'keyword' || arg.kind === 'kwspread') continue
      const values = arg.kind === 'spread' ? this.resolveSpreadValues(arg.value) : [arg.value]
      for (const value of values) {
        const paramIndex = findNext()
        if (paramIndex === -1) {
          // 溢出：收集到 vararg 形参
          const varargIndex = params.findIndex((p: any) => this.getParamKind(p) === 'vararg')
          if (varargIndex !== -1) {
            this.assignParamValue(boundCall, params, varargIndex, value, arg.index)
          }
          continue
        }
        this.assignParamValue(boundCall, params, paramIndex, value, arg.index)
        if (this.getParamKind(params[paramIndex]) !== 'vararg') {
          nextPositionalIndex = paramIndex + 1
        }
      }
    }
  }

  /**
   * keyword/kwspread 实参按名称匹配形参，未匹配的收集到 varkw（**kwargs）
   */
  bindKeywordArgs(boundCall: BoundCall, params: any[], callArgs: CallArgs): void {
    const keywordEntries: Array<{ name: string; value: any; argIndex: number }> = []
    for (const arg of callArgs?.args || []) {
      if (arg.kind === 'keyword' && arg.name) {
        keywordEntries.push({ name: arg.name, value: arg.value, argIndex: arg.index })
      } else if (arg.kind === 'kwspread') {
        for (const [name, value] of this.resolveKwSpreadEntries(arg.value)) {
          keywordEntries.push({ name, value, argIndex: arg.index })
        }
      }
    }

    const varkwIndex = params.findIndex((p: any) => this.getParamKind(p) === 'varkw')
    for (const entry of keywordEntries) {
      const paramIndex = params.findIndex((p: any) => (p?.id?.name || p?.name) === entry.name)
      if (paramIndex === -1) {
        // 未匹配的 keyword → **kwargs
        if (varkwIndex !== -1) {
          const target = boundCall.params[varkwIndex]
          if (!target.provided || !target.value || typeof target.value !== 'object' || Array.isArray(target.value)) {
            target.value = {}
            target.provided = true
          }
          target.value[entry.name] = entry.value
          target.argIndexes.push(entry.argIndex)
        }
        continue
      }
      if (this.getParamKind(params[paramIndex]) === 'positional_only') continue
      this.assignParamValue(boundCall, params, paramIndex, entry.value, entry.argIndex)
    }
  }

  // ==================== End CallArgs methods ====================

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCallExpression(scope: ScopeType, node: CallExpression, state: State): any {
    /* { callee,
        arguments,
      }
   */
    if (this.checkerManager && this.checkerManager.checkAtFuncCallSyntax)
      this.checkerManager.checkAtFuncCallSyntax(this, scope, node, state, {
        pcond: state.pcond,
        einfo: state.einfo,
      })

    const fclos = this.processInstruction(scope, node.callee, state)
    if (!fclos) return new UndefinedValue()

    // prepare the function arguments
    let argvalues = []
    let same_args = true // minor optimization to save memory
    for (const arg of node.arguments) {
      let argv = this.processInstruction(scope, arg, state)
      // 处理参数是 箭头函数或匿名函数
      // 参数类型必须是函数定义,且fclos找不到定义或未建模适配
      // 如果参数适配建模，则会进入相应的逻辑模拟执行，例如array.push
      if (arg.type === 'FunctionDefinition' && !fclos?.ast.fdef && !fclos?.runtime?.execute) {
        const funcDef = arg as FunctionDefinition & { name?: string }
        if (funcDef.name?.includes('<anonymous')) {
          // let subscope = Scope.createSubScope(argv.sid + '_scope', scope,'scope')
          argv = this.processAndCallFuncDef(scope, funcDef, argv, state)
        }
      }
      if (argv !== arg) same_args = false
      if (logger.isTraceEnabled()) logger.trace(`arg: ${this.formatScope(argv)}`)
      if (Array.isArray(argv)) {
        argvalues.push(...argv)
      } else {
        argvalues.push(argv)
      }
    }
    if (same_args) argvalues = node.arguments

    // build structured call info
    const callInfo: CallInfo = { callArgs: this.buildCallArgs(node, argvalues, fclos) }

    // analyze the resolved function closure and the function arguments
    const res = this.executeCall(node, fclos, state, scope, callInfo)

    // function definition not found, examine possible call-back functions in the arguments
    if (fclos.vtype !== 'fclos' && Config.invokeCallbackOnUnknownFunction) {
      this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
    }

    if (res && this.checkerManager?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        callInfo,
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
   *
   * @param scope
   * @param fDef
   * @param fClos
   * @param state
   * @param argValues
   */
  processAndCallFuncDef(scope: any, fDef: any, fClos: any, state: any, argValues?: any) {
    if (fDef?.type !== 'FunctionDefinition' || fClos?.vtype !== 'fclos') return fClos

    try {
      if (!argValues) {
        // process FuncDef的参数
        argValues = []
        for (const para of fDef.parameters) {
          const argv = this.processInstruction(scope, para, state)
          if (Array.isArray(argv)) {
            argValues.push(...argv)
          } else {
            argValues.push(argv)
          }
        }
      }

      // execute call
      const callInfo: CallInfo = { callArgs: this.buildCallArgs(fDef, argValues, fClos) }
      return this.executeCall(fDef, fClos, state, scope, callInfo)
    } catch (e) {
      handleException(
        e,
        '',
        `YASA Simulation Execution Error in processAndCallFuncDef. Loc is ${fDef?.loc?.sourcefile} line:${fDef?.loc?.start?.line}`
      )
      return new UndefinedValue()
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCastExpression(scope: ScopeType, node: CastExpression, state: State): SymbolValueType {
    return this.processInstruction(scope, node.expression, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processNewExpression(scope: ScopeType, node: NewExpression, state: State): SymbolValueType {
    /*
  { typeName }
  */
    if (this.checkerManager && this.checkerManager.checkAtNewExpr)
      this.checkerManager.checkAtNewExpr(this, scope, node, state, null)
    return this.processNewObject(scope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  preProcessFunctionDefinition(scope: any, node: any, state: any) {
    if (node.body) {
      // TODO: handle function declaration better
      const ret = this.createFuncScope(node, scope)
      ret.__preprocess = true
      return ret
    }
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processFunctionDefinition(scope: ScopeType, node: FunctionDefinition, state: State): SymbolValueType {
    let fclos
    if (node.body) {
      // TODO: handle function declaration better
      fclos = this.createFuncScope(node, scope)
      const nodeBody = node.body as any
      if (nodeBody?.body && Array.isArray(nodeBody.body)) {
        for (const body of nodeBody.body) {
          if (body.type === 'FunctionDefinition') {
            this.processInstruction(fclos, body, state)
          }
        }
      }
    } else {
      fclos = new UndefinedValue()
    }
    if (this.checkerManager && this.checkerManager.checkAtFunctionDefinition) {
      this.checkerManager.checkAtFunctionDefinition(this, scope, node, state, { fclos })
    }
    this.postProcessFunctionDefinition(fclos, node, scope, state)
    return fclos
  }

  /**
   *
   * @param fclos
   * @param node
   * @param scope
   * @param state
   */
  postProcessFunctionDefinition(fclos: any, node: any, scope: any, state: any) {
    /** build decorator clos * */
    if (node.type === 'FunctionDefinition') {
      const decoratorsNode = node._meta.decorators
      if (decoratorsNode) {
        // notice in this case, scope is class clos, and the decorator clos should be subject to the parent of the class clos
        const parant_scope = scope.parent ?? scope
        const decorators: any[] = []
        decoratorsNode.forEach((d: any) => {
          decorators.push(this.processInstruction(parant_scope, d, state))
        })
        fclos.decorators = decorators
      }
    }
  }

  /**
   *
   * @param scope
   * @param cdef
   * @param state
   */
  preProcessClassDefinition(scope: any, cdef: any, state: any) {
    if (!(cdef && cdef.body)) return new UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = Scope.createSubScope(fname, scope, 'class') // class scope
    cscope.ast = cdef
    cscope.ast.cdef = cdef
    cscope.ast.fdef = cdef
    cscope.__preprocess = true
    return cscope
  }

  /**
   *
   * @param scope
   * @param cdef
   * @param state
   */
  processClassDefinition(scope: ScopeType, cdef: ClassDefinition, state: State): SymbolValueType {
    if (!(cdef && cdef.body)) return new UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = Scope.createSubScope(fname, scope, 'class') // class scope
    cscope.ast = cdef
    cscope.ast.fdef = cdef
    cscope.ast.cdef = cdef
    cscope.modifier = {}
    cscope.inits = new Set() // for storing the variables initialized in the constructor
    this.resolveClassInheritance(cscope, state) // inherit base classes

    if (!cscope.fdata) cscope.fdata = {} // for class-level analysis data

    if (cdef) {
      const oldThisFClos = this.thisFClos
      this.entry_fclos = this.thisFClos = cscope
      // process variable/method declarations and so forth
      this.processInstruction(cscope, cdef.body, state)
      for (const x in cscope.value) {
        const v = cscope.value[x]
        v._this = cscope
      }
      cscope._this = cscope
      this.thisFClos = oldThisFClos
    }

    // post-processing
    // logger.log('Done with class: ', fname);
    return cscope
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processVariableDeclaration(scope: ScopeType, node: VariableDeclaration, state: State): SymbolValueType {
    const initialNode = node.init
    const { id } = node
    const idName = id?.type === 'Identifier' ? id.name : undefined
    if (!id || idName === '_') return new UndefinedValue() // e.g. in Go

    let initVal
    if (!initialNode) {
      initVal = this.createVarDeclarationScope(id, scope)
      initVal.uninit = !initialNode
      initVal = SourceLine.addSrcLineInfo(initVal, id, id.loc && id.loc.sourcefile, 'Var Pass: ', idName || '')
    } else if (node?.parent?.type === 'CatchClause' && node?._meta?.isCatchParam && (state?.throwstack?.length ?? 0) > 0) {
      // 处理throw传递到catch的情况
      initVal = state?.throwstack && state?.throwstack.shift()
      initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', idName || '')
      delete node._meta.isCatchParm
    } else {
      initVal = this.processInstruction(scope, initialNode, state)
      if (initialNode.type === 'ImportExpression') {
        if (initVal?.sid === 'module.exports' && _.keys(initVal?.value).length === 0) {
          initVal = this.processInstruction(scope, initialNode, state)
        }
      }
      initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', idName || '')
    }

    if (this.checkerManager && this.checkerManager.checkAtPreDeclaration)
      this.checkerManager.checkAtPreDeclaration(this, scope, node, state, {
        lnode: id,
        rvalue: null,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        fdef: state.callstack && state.callstack[state.callstack.length - 1],
      })

    this.saveVarInCurrentScope(scope, id, initVal, state)

    // set alias name if val itself has no identifier
    if (initVal && !Array.isArray(initVal) && !(initVal.name || initVal.sid) && idName) {
      initVal.sid = idName
    }

    if (idName) {
      scope.ast.setDecl(idName, id)
    }

    const typeQualifiedName = AstUtil.typeToQualifiedName(node.varType)
    let declTypeVal
    if (typeQualifiedName) {
      declTypeVal = this.getMemberValueNoCreate(scope, typeQualifiedName, state)
    }

    return initVal
  }

  // TODO
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processDereferenceExpression(scope: any, node: any, state: any) {
    const ret = this.processInstruction(scope, node.argument, state)
    if (ret && ret.runtime?.refCount) {
      ret.runtime.refCount--
      if (ret.runtime.refCount === 0) {
        delete ret.runtime.refCount
      }
    }
    return ret
  }

  // TODO
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processReferenceExpression(scope: any, node: any, state: any) {
    const val = this.processInstruction(scope, node.argument, state)
    if (val) {
      if (!val.runtime) val.runtime = {}
      val.runtime.refCount = val.runtime.refCount || 0
      val.runtime.refCount++
    }
    return val
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processImportExpression(scope: ScopeType, node: ImportExpression, state: State): SymbolValueType {
    /* {
        from,
        local,
        imported
    } */
    // const { imported, local, from } = node
    // const importedVal = this.getMemberValue(importScope, imported, state);
    // if (importedVal) {
    //     this.saveVarInCurrentScope(scope, local, importedVal, state);
    // }
    return this.processImportDirect(this.topScope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSpreadElement(scope: ScopeType, node: SpreadElement, state: State): SpreadValueType {
    const val = this.processInstruction(scope, node.argument, state)
    if (!val) {
      return val
    }
    const res = new Set()
    const self = this
    const fields = Array.isArray(val) ? val : val.scope.exports ? val.scope.exports.getRawValue() : val.getRawValue()
    if (Array.isArray(fields)) {
      for (const f of fields) {
        handler(f)
      }
    } else {
      handler(fields)
    }

    /**
     *
     * @param flds
     */
    function handler(flds: any) {
      if (flds?.vtype === 'union' || flds?.vtype === 'bvt') {
        handler(flds.getRawValue())
      } else if (Array.isArray(flds)) {
        for (const f of flds) {
          handler(f)
        }
      } else if (flds.vtype === 'primitive') {
        // do nothing
      } else if (flds.vtype) {
        handler(flds.value)
      } else {
        // 偏移量不是简单当前数组的长度，而是排除内置函数以后当前解构运算符之前元素的长度
        // eg arr1= [1,2,3] arr2=[10,...arr1,...arr1]
        // 第一个...arr1应该加上的偏移量是1，第二个arr1应该加上的偏移量是4
        // TODO 未来数组表达式的ast从ObjectExpression换成ArrayExpression 在这里需要做相应修改
        const offset = scope.members.size
        const isArray = (node.parent as any)?._meta?.isArray
        for (let fname in flds) {
          const fVal = flds[fname]
          // 解构变量field中undefine的值不应该被保存到scope的field中，会清除有污点的变量
          if (!fVal || fVal?.vtype === 'undefine') continue
          res.add(fVal)
          // 当前object expression实际上是数组对象 且key能转换成数字
          if (isArray && Number.isFinite(parseInt(fname))) {
            // 获取历史已有数据长度，避免数组的历史数据被覆盖
            fname = (parseInt(fname) + offset).toString()
            self.saveVarInCurrentScope(scope, fname, fVal, state)
          } else {
            self.saveVarInCurrentScope(scope, fname, fVal, state)
          }
        }
      }
    }

    // 创建 SpreadValue - 返回增强数组（保持向后兼容）
    // 注意：不预先计算 isTainted，让后续逻辑（如 js-analyzer）按需处理
    const spreadValue: any = Array.from(res)
    spreadValue.vtype = 'spread'
    spreadValue.elements = spreadValue // elements 指向自身（因为本身就是数组）
    spreadValue.sid = '<spread>'
    spreadValue.qid = '<spread>'

    return spreadValue as SpreadValueType
  }

  // TODO YieldExpression
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processYieldExpression(scope: ScopeType, node: YieldExpression, state: State): VoidValueType {
    // 保持历史行为（25282dbd）：转换为 ReturnStatement 处理
    // YieldExpression has 'argument' field, not 'expression'
    const returnLike = {
      ...node,
      expression: node.argument,
    } as any as ReturnStatement
    return this.processReturnStatement(scope, returnLike, state)
  }

  /**
   * after a branch is executed: merge branch information and so on
   * @param node
   * @param test
   * @param state
   * @param lstate
   * @param rstate
   */
  postBranchProcessing(node: any, test: any, state: any, lstate: any, rstate?: any): any {
    const terminate_at_left = AstUtil.satisfy(node.consequent, (x: any) => {
      return x.type === 'ReturnStatement' || x.type === 'ThrowStatement'
    })
    if (!rstate) {
      // adopt the condition of the left branch
      if (terminate_at_left && test) {
        // this branch has been terminated
        const rtest = _.clone(test)
        rtest.is_neg = true
        state.pcond.push(rtest)
      }
    }

    // union branch related information
    const { binfo } = state
    if (binfo) {
      const terminate_at_right = AstUtil.satisfy(node.consequent, (x: any) => {
        return (
          x.type === 'ReturnStatement' ||
          x.type === 'ThrowStatement' ||
          (x.type === 'FunctionCall' && x.expression.name === 'revert')
        )
      })
      if (!terminate_at_left) {
        for (const x in lstate.binfo) {
          if (!binfo.hasOwnProperty(x)) {
            binfo[x] = lstate.binfo[x]
          }
        }
      }
      if (rstate && !terminate_at_right) {
        for (const x in rstate.binfo) {
          if (!binfo.hasOwnProperty(x)) {
            binfo[x] = rstate.binfo[x]
          }
        }
      }
    }
  }

  /**
   * process function calls; handle function unions
   * @param node: AST function call node
   * @param fclos: function closure
   * @param argvalues: the arguments
   * @param node
   * @param fclos
   * @param argvalues
   * @param state
   * @param scope
   * @returns {*}
   */
  executeCall(node: any, fclos: any, state: State, scope: any, callInfo: CallInfo): any {
    callInfo = this.ensureCallInfo(node, fclos, callInfo)
    const argvalues = getLegacyArgValues(callInfo)
    if (Config.miniSaveContextEnvironment) {
      return new CallExprValue(scope.qid, fclos, argvalues, node, node.loc, fclos)
    }
    if (Config.makeAllCG && fclos?.ast.fdef?.type === 'FunctionDefinition' && this.ainfo?.callgraph?.nodes) {
      for (const callgraphnode of this.ainfo?.callgraph?.nodes.values()) {
        // 从 nodehash 还原 funcDef
        let callgraphFuncDef = callgraphnode.opts?.funcDef
        if (callgraphnode.opts?.funcDefNodehash && this.astManager) {
          callgraphFuncDef = this.astManager.get(callgraphnode.opts.funcDefNodehash)
        }
        if (
          callgraphFuncDef?.loc?.start?.line &&
          callgraphFuncDef?.loc?.end?.line &&
          callgraphFuncDef?.loc?.sourcefile === fclos.ast.fdef?.loc?.sourcefile &&
          callgraphFuncDef?.loc?.start?.line === fclos.ast.fdef?.loc?.start?.line &&
          callgraphFuncDef?.loc?.end?.line === fclos.ast.fdef?.loc?.end?.line
        ) {
          this.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
            callInfo,
            fclos,
            pcond: state.pcond,
            entry_fclos: this.entry_fclos,
            einfo: state.einfo,
            state,
            analyzer: this,
            ainfo: this.ainfo,
          })
          return new CallExprValue(scope.qid, fclos, argvalues, node, node.loc, fclos)
        }
      }
    }

    // process the function body
    if (fclos.ast.fdef || fclos.runtime?.execute) {
      const { decorators } = fclos
      // const decorators = fclos.ast && fclos.ast.decorators;
      if (decorators && decorators.length > 0) {
        return this.executeCallWithDecorators(_.clone(decorators), fclos, state, node, scope, callInfo)
      }
      return this.executeSingleCall(fclos, state, node, scope, callInfo)
    }
    if (fclos.vtype === 'union') {
      const res: any[] = []
      for (const f of fclos.value) {
        if (!f) continue
        node = node || f.ast?.node
        const v = this.executeCall(node, f, state, scope, callInfo)
        if (v) res.push(v)
      }
      const len = res.length
      if (len === 0) {
      } else if (len === 1) return res[0]
      else
        return new UnionValue(
          res,
          undefined,
          `${scope.qid}.<union@call:${node?.loc?.start?.line}:${node?.loc?.start?.column}>`,
          node
        )
    }

    // now for the function without body
    if (this.checkerManager) {
      this.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        callInfo,
        fclos,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        analyzer: this,
        ainfo: this.ainfo,
      })
    }
    // a native function is built-in with semantics
    const native = NativeResolver.processNativeFunction.call(this, node, fclos, argvalues, state)
    if (native) return native

    const libFuncTagPropagationRuleFound = this.processLibFuncTagPropagation(node, fclos, callInfo, scope, state)
    if (!libFuncTagPropagationRuleFound) {
      // 没有配置的库函数，采用默认处理方式：arg->ret
      const res = this.processLibArgToRet(node, fclos, argvalues, scope, state, callInfo)
      if (this.enableLibArgToThis) {
        this.processLibArgToThis(node, fclos, argvalues, -1, scope, state)
      }
      return res
    }
  }

  /**
   *
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   * @param state
   */
  processLibArgToRet(node: any, fclos: any, argvalues: any, scope: any, state: any, callInfo: CallInfo) {
    // the case without function body, still process the call, e.g. perform taint propagation
    let res = _.clone(node)
    res.expression = fclos
    res.arguments = argvalues
    res.ast = node
    const argsSignature = AstUtil.prettyPrintAST(node.arguments)
    res.sid = `${fclos?.sid}(${argsSignature})`
    res.qid = `${fclos?.qid}(${argsSignature})`
    // res.field = {}
    let isTainted = false
    if (fclos.taint?.isTaintedRec) {
      isTainted = true
    }

    // 检查参数是否携带污点
    for (const arg of argvalues) {
      if (arg) {
        if (arg.taint?.isTaintedRec) {
          isTainted = true
          break
        }
      }
    }

    // e.g. XXInterface token = XXInterface(id) where id is ctorInit
    for (const arg of argvalues) {
      if (arg && arg.runtime?.ctorInit && node.expression && node.expression.value) {
        let top_scope = scope
        while (top_scope.parent) {
          top_scope = top_scope.parent
        }
        if (top_scope.value && top_scope.value[node.expression.value]) {
          if (!res.runtime) res.runtime = {}
          res.runtime.ctorInit = true
        }
      }
    }
    if (node.callee.type === 'MemberAccess') {
      if (fclos?.object?.taint?.isTaintedRec) {
        isTainted = true
      } else {
        /*
          first invoke: JSONObject.toJSONString();
          second invoke: JSONObject obj = new JSONObject(); obj.toJSONString();
         */
        const thisVal = fclos.getThisObj()
        if (
          thisVal &&
          ['symbol', 'object'].includes(thisVal.vtype) &&
          res.expression &&
          !res.expression.object &&
          thisVal.taint?.isTaintedRec
        ) {
          res.expression.object = thisVal
          isTainted = true
        }
      }
    }

    // return { type : 'FunctionCall', expression: fclos, arguments: argvalues,
    //          ast: node };
    res = new SymbolValue('', { sid: res.sid, qid: res.qid, ...res }) // esp. for member getter function
    if (isTainted) {
      res.taint?.markSource()
    }

    // save pass-in arguments for later use
    if (argvalues.length > 0) {
      res.setMisc('pass-in', argvalues)
    }
    return res
  }

  /**
   * process lib func tag propagation
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   * @param state
   */
  processLibFuncTagPropagation(node: any, fclos: any, callInfo: CallInfo | undefined, scope: any, state: any) {
    const argvalues = getLegacyArgValues(callInfo)
    let matchRuleFound = false
    const libFuncTagPropagationRuleArray = this.loadLibFuncTagPropagationRule()
    for (const libFuncTagPropagationRule of libFuncTagPropagationRuleArray) {
      if (
        matchSinkAtFuncCallWithCalleeType(node, fclos, [libFuncTagPropagationRule.func], scope, callInfo)?.length >
          0 ||
        this.findMatchedRuleByCallGraph(node, scope, [libFuncTagPropagationRule.func])?.length > 0
      ) {
        const sourceType = libFuncTagPropagationRule.source?.type
        const targetType = libFuncTagPropagationRule.target?.type
        if (!sourceType || !targetType) {
          continue
        }

        if (sourceType === 'ARG' && targetType === 'ARG') {
          this.processLibArgToArg(
            node,
            fclos,
            argvalues,
            libFuncTagPropagationRule.source.index,
            libFuncTagPropagationRule.target.index,
            scope,
            state
          )
          matchRuleFound = true
        } else if (sourceType === 'ARG' && targetType === 'THIS') {
          this.processLibArgToThis(node, fclos, argvalues, libFuncTagPropagationRule.source.index, scope, state)
          matchRuleFound = true
        } else if (sourceType === 'THIS' && targetType === 'ARG') {
          this.processLibThisToArg(node, fclos, argvalues, libFuncTagPropagationRule.target.index, scope, state)
          matchRuleFound = true
        }
      }
    }

    return matchRuleFound
  }

  /**
   * process lib arg to arg
   * @param node
   * @param fclos
   * @param argvalues
   * @param sourceIndex
   * @param targetIndex
   * @param scope
   * @param state
   */
  processLibArgToArg(
    node: any,
    fclos: any,
    argvalues: any,
    sourceIndex: any,
    targetIndex: any,
    scope: any,
    state: any
  ) {
    if (!argvalues || argvalues.length < 2 || !targetIndex || targetIndex >= argvalues.length) {
      return
    }
    let res = argvalues[targetIndex]

    res.setMisc('precise', false)
    moveExistElementsToBuffer(res)

    const passIn = res.getMisc('buffer') || []
    for (const argIndex in argvalues) {
      if (sourceIndex >= 0 && sourceIndex !== Number(argIndex)) {
        continue
      }
      const arg = argvalues[argIndex]
      passIn.push(arg)
      if (arg.taint?.isTaintedRec) {
        res.taint?.markSource()
        res = SourceLine.addSrcLineInfo(res, node, node.loc && node.loc.sourcefile, 'Var Pass: ', res.sid)
      }
    }

    res.setMisc('buffer', passIn)
  }

  /**
   * process lib arg to this
   * @param node
   * @param fclos
   * @param argvalues
   * @param sourceIndex
   * @param scope
   * @param state
   */
  processLibArgToThis(node: any, fclos: any, argvalues: any, sourceIndex: any, scope: any, state: any) {
    let thisVal = fclos.getThisObj()
    if (
      !argvalues ||
      argvalues.length === 0 ||
      !thisVal ||
      !['symbol', 'object'].includes(thisVal.vtype) ||
      !_.isFunction(thisVal.setMisc) ||
      this.shouldSkipLibArgToThisPropagation(thisVal) ||
      thisVal.injected ||
      thisVal?.parent?.vtype === 'class' ||
      thisVal?.parent?._isConstructor ||
      thisVal?._this?.vtype === 'class' ||
      thisVal?._this?._isConstructor ||
      thisVal.qid?.startsWith('<global>.syslib_from')
    ) {
      return
    }

    thisVal.setMisc('precise', false)
    moveExistElementsToBuffer(thisVal)

    switch (node.callee.type) {
      case 'MemberAccess':
        for (const argIndex in argvalues) {
          if (sourceIndex >= 0 && sourceIndex !== Number(argIndex)) {
            continue
          }
          const arg = argvalues[argIndex]
          addElementToBuffer(thisVal, arg)
          if (arg.taint?.isTaintedRec) {
            thisVal.taint?.markSource()
            if (node?.parent?.type !== 'AssignmentExpression') {
              thisVal = SourceLine.addSrcLineInfo(
                thisVal,
                node,
                node.loc && node.loc.sourcefile,
                'Var Pass: ',
                node?.callee?.object ? prettyPrint(node.callee.object) : thisVal.sid
              )
            }
          }
        }
        break
      case 'Identifier':
        break
      default:
        break
    }
  }

  /**
   * Check whether lib arg->this propagation should be skipped.
   * @param thisVal
   */
  shouldSkipLibArgToThisPropagation(thisVal: any) {
    if (!thisVal || typeof thisVal.sid !== 'string') {
      return false
    }
    const sid = thisVal.sid.toLowerCase()
    const keywords = this.loadLibArgToThisSidBlacklistKeywords()
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return false
    }
    return keywords.some((keyword) => {
      if (typeof keyword !== 'string') {
        return false
      }
      const normalizedKeyword = keyword.trim().toLowerCase()
      return normalizedKeyword.length > 0 && sid.includes(normalizedKeyword)
    })
  }

  /**
   * process lib this to arg
   * @param node
   * @param fclos
   * @param argvalues
   * @param targetIndex
   * @param scope
   * @param state
   */
  processLibThisToArg(node: any, fclos: any, argvalues: any, targetIndex: any, scope: any, state: any) {
    if (!argvalues) {
      return
    }

    switch (node.callee.type) {
      case 'MemberAccess':
        const thisVal = this.processInstruction(scope, node.callee.object, state)
        for (const argIndex in argvalues) {
          if (targetIndex >= 0 && targetIndex !== Number(argIndex)) {
            continue
          }
          let arg = argvalues[argIndex]

          arg.setMisc('precise', false)
          moveExistElementsToBuffer(arg)

          if (thisVal && thisVal.taint?.isTaintedRec) {
            arg.setFieldValue(
              thisVal.sid,
              new ObjectValue(arg.qid, {
                sid: thisVal.sid,
                parent: arg,
                value: thisVal,
              })
            )
            arg.taint?.markSource()
            arg = SourceLine.addSrcLineInfo(arg, node, node.loc && node.loc.sourcefile, 'Var Pass: ', arg.sid)
          }
        }
        break
      case 'Identifier':
        break
      default:
        break
    }
  }

  /**
   * decorator will be executed with fclos as its parameter
   * note: decorators will be executed in order
   * @param decorators
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  executeCallWithDecorators(decorators: any, fclos: any, state: any, node: any, scope: any, callInfo: CallInfo) {
    if (!decorators || decorators.length === 0) {
      return this.executeSingleCall(fclos, state, node, scope, callInfo)
    }

    // The decorator expressions get called top to bottom, and produce decorators,
    // while decorators themselves run in the opposite direction, bottom to top.

    let decorator = decorators.pop()
    let descriptor_fclos = fclos
    const class_obj = fclos.getThisObj() // fclos represents class method, the parent of it is class object

    while (decorator) {
      let descriptor = new ObjectValue(descriptor_fclos.qid, { sid: 'descriptor' })
      descriptor.value.value = lodashCloneWithTag(descriptor_fclos)
      const { name } = decorator // both function decl and identifier have name
      const target = decorator
      decorator._this = class_obj
      let descriptor_res
      // const decorator_clos = this.getMemberValue(scope, decorator, state);
      const decorator_clos = decorator

      // if decorator is not found, just skip it
      // TODO decorators that can't be found should be summary analyzed
      if (decorator_clos?.vtype === 'fclos' && !shallowEqual(decorator_clos.ast?.node, decorator)) {
        const decoratorCallInfo: CallInfo = { callArgs: this.buildCallArgs(node, [target, name, descriptor], decorator) }
        descriptor_res = this.executeCall(node, decorator, state, scope, decoratorCallInfo)
      } else {
        descriptor_res = null
      }

      if (descriptor_res && descriptor_res.value.value) {
        descriptor = descriptor_res
      }

      descriptor_fclos = this.getMemberValue(
        descriptor,
        new PrimitiveValue(scope.qid, '<decoratorValue>', 'value', null, 'Literal'),
        state
      )
      // descriptor_fclos runs with class object as it's [this], which can be located from parent of class method
      descriptor_fclos._this = class_obj
      decorator = decorators.pop()
    }
    return this.executeSingleCall(descriptor_fclos, state, descriptor_fclos.ast?.node, scope, callInfo)
  }

  /**
   * process function calls; go into the function body when it is available
   * @param fclos
   * @param argvalues
   * @param state
   * @param node: for accessing AST information
   * @param node
   * @param scope
   * @returns {undefined|*}
   */
  executeSingleCall(fclos: any, state: State, node: any, scope: any, callInfo: CallInfo) {
    const argvalues = getLegacyArgValues(callInfo)
    let fdecl = fclos.ast.fdef
    let fname // name of the function

    if (fclos && fclos.vtype === 'union') {
      const res = new UnionValue(
        undefined,
        undefined,
        `${scope.qid}.<union@exec:${node?.loc?.start?.line}:${node?.loc?.start?.column}>`,
        node
      )
      for (const fc of fclos.value) {
        node = node || fc.ast?.node
        res.appendValue(this.executeSingleCall(fc, state, node, scope, callInfo))
      }
      return res
    }
    let execute_builtin = false
    if (!fdecl) {
      if (!fclos.runtime?.execute) {
        return new CallExprValue(scope.qid, fclos, argvalues, node, node.loc)
      }
      // execute prepared builtins function
      execute_builtin = true
    } else {
      fname = fdecl.name
      if (fdecl.type === 'StructDefinition') {
        return this.buildNewObject(fdecl, fclos, state, node, scope, callInfo)
      }
      if (fdecl.type === 'ClassDefinition' && fclos.value?._CTOR_ && fclos.value?._CTOR_.vtype === 'fclos') {
        fdecl = fclos?.value?._CTOR_?.ast.fdef
      }
      if (fdecl.type !== 'FunctionDefinition') {
        return new UndefinedValue()
      }
    }
    fname = fname || fclos.sid || ''
    if (fname.includes('<anonymous')) {
      fname = fclos.sid
    }

    let extraFuncDefs = []
    const overloadedNodes = fclos.overloaded.filter(() => true)
    if (overloadedNodes.length > 1) {
      // overloaded functions
      let hasFind = false
      let maxMatchNum = 0
      let maxMatchFdef
      for (const f of overloadedNodes) {
        let matchNum = 0
        let paramLength = 0
        const params = f.parameters
        if (params) {
          paramLength = Array.isArray(params) ? params.length : params.parameters.length
        }
        const literalTypeList = ['String', 'string', 'int', 'Integer', 'Double', 'double', 'float', 'Float']
        let typeMatch = false
        if (paramLength === argvalues.length) {
          typeMatch = true
          for (let i = 0; i < paramLength; i++) {
            const param = params[i]
            if (
              param.varType?.id?.name === argvalues[i].rtype?.definiteType?.name ||
              argvalues[i].rtype?.definiteType?.name?.endsWith(`.${param.varType?.id?.name}`) ||
              (argvalues[i].vtype === 'primitive' && literalTypeList.includes(param.varType?.id?.name))
            ) {
              matchNum++
              continue
            }
            typeMatch = false
          }
          if (matchNum > maxMatchNum) {
            maxMatchNum = matchNum
            maxMatchFdef = f
            extraFuncDefs = []
          } else if (matchNum === maxMatchNum) {
            extraFuncDefs.push(f)
          }
        } else if (
          paramLength < argvalues.length &&
          paramLength > 0 &&
          params[paramLength - 1]?.varType?._meta?.varargs
        ) {
          typeMatch = true
          for (let i = 0; i < argvalues.length; i++) {
            const param = i < paramLength ? params[i] : params[paramLength - 1]
            if (
              param.varType?.id?.name === argvalues[i].rtype?.definiteType?.name ||
              argvalues[i].rtype?.definiteType?.name?.endsWith(`.${param.varType?.id?.name}`) ||
              (argvalues[i].vtype === 'primitive' && literalTypeList.includes(param.varType?.id?.name))
            ) {
              matchNum++
              continue
            }
            typeMatch = false
          }
          if (matchNum > maxMatchNum) {
            maxMatchNum = matchNum
            maxMatchFdef = f
            extraFuncDefs = []
          } else if (matchNum === maxMatchNum) {
            extraFuncDefs.push(f)
          }
        }
        if (typeMatch) {
          hasFind = true
          fclos = lodashCloneWithTag(fclos)
          fdecl = f // adjust to the right function definition
          fclos.ast = fdecl
          fclos.ast.fdef = fdecl
        }
      }
      // 兜底，假设类型完全没匹配到（类型检测没适配好），就走长度匹配
      if (!hasFind) {
        if (maxMatchFdef) {
          fclos = lodashCloneWithTag(fclos)
          fclos.ast = maxMatchFdef
          fclos.ast.fdef = maxMatchFdef
          fdecl = maxMatchFdef
        } else {
          for (const f of overloadedNodes) {
            let paramLength = 0
            const params = f.parameters
            if (params) {
              paramLength = Array.isArray(params) ? params.length : params.parameters.length
            }
            if (
              paramLength === argvalues.length ||
              (paramLength < argvalues.length && paramLength > 0 && params[paramLength - 1]?.varType?._meta?.varargs)
            ) {
              fclos = lodashCloneWithTag(fclos)
              fclos.ast = f
              fclos.ast.fdef = f
              fdecl = f // adjust to the right function definition
              break
            }
          }
        }
      }
    }

    // 在进入 executeFdeclOrExecute 前，预计算形参绑定
    if (callInfo) {
      const boundCall = this.bindCallArgs(node, fclos, fdecl, callInfo)
      callInfo.boundCall = boundCall
    }
    const return_value = this.executeFdeclOrExecute(fclos, state, node, scope, fdecl, fname, execute_builtin, callInfo)
    extraFuncDefs = extraFuncDefs.filter((extraFuncDef) => extraFuncDef !== fclos.ast?.node)
    if (extraFuncDefs.length === 0) {
      return return_value
    }
    const union_return_value = new UnionValue(
      undefined,
      undefined,
      `${scope.qid}.<union@overload:${node?.loc?.start?.line}:${node?.loc?.start?.column}>`,
      node
    )
    union_return_value.appendValue(return_value)
    for (const extraFuncDef of extraFuncDefs) {
      fclos = lodashCloneWithTag(fclos)
      fdecl = extraFuncDef
      fclos.ast = extraFuncDef
      fclos.ast.fdef = extraFuncDef
      // 每个 overload 需要独立绑定
      const extraCallInfo: CallInfo = { callArgs: callInfo?.callArgs }
      const extraBoundCall = this.bindCallArgs(node, fclos, fdecl, extraCallInfo)
      extraCallInfo.boundCall = extraBoundCall
      const extraReturnValue = this.executeFdeclOrExecute(fclos, state, node, scope, fdecl, fname, false, extraCallInfo)
      union_return_value.appendValue(extraReturnValue)
    }
    return union_return_value
  }

  /**
   *
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @param fdecl
   * @param fname
   * @param execute_builtin
   */
  executeFdeclOrExecute(
    fclos: any,
    state: State,
    node: any,
    scope: any,
    fdecl: any,
    fname: any,
    execute_builtin: any,
    callInfo: CallInfo
  ) {
    const argvalues = getLegacyArgValues(callInfo)
    if (logger.isTraceEnabled()) logger.trace(`\nprocessCall: function: ${this.formatScope(fdecl?.id?.name)}`)

    // avoid infinite loops,the re-entry should only less than 3
    if (
      fdecl &&
      state.callstack.reduce((previousValue: any, currentValue: any) => {
        return currentValue.ast.fdef === fdecl ? previousValue + 1 : previousValue
      }, 0) > 0
    ) {
      return new CallExprValue(scope.qid, fclos, argvalues, node, node.loc, fclos)
    }

    // pre-call processing
    const oldThisFClos = this.thisFClos
    this.thisFClos = fclos.getThisObj()

    let fscope = Scope.createSubScope(`${fname}_scope`, fclos) // this is actually named "activation record" in computer science
    fscope._this = fclos._this
    if (fclos.vtype === 'class' || fclos._isConstructor) {
      // for javascript class ctor function
      fscope = fclos
    }

    // prepare execute state
    const new_state = _.clone(state)
    new_state.parent = state
    new_state.callstack = state.callstack ? state.callstack.concat([fclos]) : [fclos]
    new_state.callsites = state.callsites
      ? state.callsites.concat([
          {
            code: AstUtil.getRawCode(node).slice(0, 100),
            nodeHash: node._meta?.nodehash,
            loc: node.loc,
          },
        ])
      : [
          {
            code: AstUtil.getRawCode(node).slice(0, 100),
            nodeHash: node._meta?.nodehash,
            loc: node.loc,
          },
        ]
    new_state.brs = ''
    // this.recordFunctionDefinitions(fscope, fdecl.body, new_state);

    let return_value
    if (execute_builtin) {
      this?.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        callInfo,
        fclos,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        analyzer: this,
        ainfo: this.ainfo,
      })

      // this.lastReturnValue =  fclos.runtime.execute.call(this, fclos, argvalues, new_state, node, scope);
      this.lastReturnValue = null
      for (let i = 0; i < argvalues.length; i++) {
        argvalues[i] = SourceLine.addSrcLineInfo(argvalues[i], node, node.loc && node.loc.sourcefile, 'CALL: ', fname)
      }
      return_value = fclos.runtime!.execute!.call(this, fclos, argvalues, new_state, node, scope)
    } else {
      // now go into the function body
      this?.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        callInfo,
        fclos,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        analyzer: this,
        ainfo: this.ainfo,
      })

      // 基于 boundCall 绑定形参（替代旧的 argvalues[i] + node.names.indexOf 逻辑）
      const activeBoundCall = callInfo?.boundCall
      if (!activeBoundCall) {
        logger.warn('executeFdeclOrExecute: boundCall missing from callInfo')
      }

      // process function arguments
      if (!fdecl.parameters) {
        return new UndefinedValue()
      }
      const params = fdecl.parameters
      // 先执行形参声明（确保 scope 中有位置）
      params?.forEach((param: any) => {
        this.processInstruction(fscope, param, new_state)
      })

      // 遍历 boundCall.params 绑定实参到形参
      for (const boundParam of activeBoundCall?.params || []) {
        if (!boundParam?.provided) continue
        const param = params[boundParam.index]
        const paramName = param?.id?.name
        if (!paramName) continue
        let val = boundParam.value

        // vararg（*args / rest parameter）→ 收集为 ObjectValue
        if (Array.isArray(val) && this.getParamKind(param) === 'vararg') {
          const restVal: any = {}
          val.forEach((element: any, index: number) => {
            restVal[index.toString()] = element
          })
          val = new ObjectValue(fscope.qid, {
            sid: paramName,
            field: restVal,
          })
        } else if (
          val &&
          !Array.isArray(val) &&
          this.getParamKind(param) === 'varkw' &&
          typeof val === 'object' &&
          !val.vtype
        ) {
          // varkw（**kwargs）→ 收集为 ObjectValue
          val = new ObjectValue(fscope.qid, {
            sid: paramName,
            field: val,
          })
        }

        // SourceLine 信息
        if (param.loc && oldThisFClos && node.type !== 'FunctionDefinition') {
          val = SourceLine.addSrcLineInfo(val, node, node.loc && node.loc.sourcefile, 'CALL: ', fname)
          const fdeclParam = Array.isArray(fdecl.parameters) ? fdecl.parameters[0] : fdecl.parameters
          if (fdeclParam.loc.end?.line === param.loc.end?.line)
            val = SourceLine.addSrcLineInfo(val, fdeclParam, fdeclParam.loc.sourcefile, 'ARG PASS: ', paramName)
          else val = SourceLine.addSrcLineInfo(val, param, param.loc && param.loc.sourcefile, 'ARG PASS: ', paramName)
        }

        // checkpoint function parameter declaration
        if (this.checkerManager && this.checkerManager.checkAtPreDeclaration) {
          this.checkerManager.checkAtPreDeclaration(this, scope, param, state, {
            lnode: param,
            rvalue: val,
            fclos: fscope,
            fdef: fdecl,
          })
        }

        this.saveVarInCurrentScope(fscope, param, val, new_state)
      }

      // 未绑定的形参初始化为 UndefinedValue
      params?.forEach((param: any) => {
        const val = this._getMemberValueDirect(fscope, param.id, state, false, 0, new Set())
        if (!val) {
          this.saveVarInCurrentScope(fscope, param.id, new UndefinedValue(), state)
        }
      })

      const pythonReceiverFallback = callInfo?.callArgs?.receiver || fclos?.getThisObj?.()
      if (
        Config.language === 'python' &&
        pythonReceiverFallback &&
        fscope?.value &&
        !Object.prototype.hasOwnProperty.call(fscope.value, 'self')
      ) {
        this.saveVarInCurrentScope(
          fscope,
          { type: 'Identifier', name: 'self', loc: fdecl?.loc },
          pythonReceiverFallback,
          new_state
        )
      }

      let objectVal
      if (node?.callee?.type === 'MemberAccess') {
        // objectVal = this.processInstruction(scope, node.callee.object, state)
        objectVal = SourceLine.addSrcLineInfo(fclos._this, node, node.loc && node.loc.sourcefile, 'CALL: ', fname)
        objectVal = SourceLine.addSrcLineInfo(
          fclos._this,
          node.callee.object,
          node.callee.object.loc.sourcefile,
          'ARG PASS: ',
          node.callee.object.name || AstUtil.prettyPrintAST(node.callee.object).slice(0, 50)
        )
      }

      // return parameters
      if (fdecl.returnParameters) {
        const val_0 = new PrimitiveValue(scope.qid, '<number_0>', 0, null, 'Literal', fdecl.returnParameters.loc)
        const paras = Array.isArray(fdecl.returnParameters) ? fdecl.returnParameters : fdecl.returnParameters.parameters
        if (paras) {
          for (const param of paras) {
            if (!param.name) continue // unused parameters
            // argument passing
            this.saveVarInCurrentScope(fscope, param, val_0, state)
          }
        }
      }

      // execute the body
      const oldReturnValue = this.lastReturnValue
      this.lastReturnValue = undefined
      this.processInstruction(fscope, fdecl.body, new_state)

      // Java lambda 表达式体隐式返回值：匿名函数的 ScopedStatement 无 ReturnStatement 时，取最后一个表达式的值
      if (
        !this.lastReturnValue &&
        Config.language === 'java' &&
        fdecl.body?.type === 'ScopedStatement' &&
        fname?.includes('<anonymous')
      ) {
        const stmts = fdecl.body.body
        if (stmts && stmts.length > 0) {
          const lastStmt = stmts[stmts.length - 1]
          const hasReturn = stmts.some((s: any) => s.type === 'ReturnStatement')
          if (!hasReturn && lastStmt.type !== 'ReturnStatement') {
            this.lastReturnValue = this.processInstruction(fscope, lastStmt, new_state)
          }
        }
      }

      return_value = this.lastReturnValue || new UndefinedValue()
      this.lastReturnValue = oldReturnValue

      const tag = 'CALL RETURN:' // size ? 'RETURN: ' : null;
      return_value = SourceLine.addSrcLineInfo(return_value, node, node.loc && node.loc.sourcefile, tag, fname)
    }

    // post-call processing
    delete fclos.value[fscope.sid]
    // this.setCurrentFunction(old_function);
    this.thisFClos = oldThisFClos

    return return_value
  }

  /**
   * process object creation. Retrieve the function definition
   * @param scope
   * @param node
   * @param state
   * @returns {*}
   */
  processNewObject(scope: any, node: any, state: any) {
    // if (DEBUG) logger.info("processInstruction: NewExpression " + formatNode(node));
    const call = node

    // try obtaining the class/function definition in the current scope
    let fclos = this.processInstruction(scope, node.callee, state)
    if (fclos.vtype === 'union') {
      fclos = fclos.value[0] // FIXME
    }
    // const native = libraryAPIResolver.processNewObject(fclos, argvalues);
    // if (native) return native;

    let argvalues = []
    if (call.arguments) {
      let same_args = true // minor optimization to save memory
      for (const arg of call.arguments) {
        const argv = this.processInstruction(scope, arg, state)
        if (argv !== arg) same_args = false
        argvalues.push(argv)
      }
      if (same_args) argvalues = call.arguments
    }

    const { fdef } = fclos.ast
    // if (analysisutil.isInCallStack(fdef, state.callstack)) return;

    const newCallInfo: CallInfo = { callArgs: this.buildCallArgs(node, argvalues, fclos) }
    const obj = this.buildNewObject(fdef, fclos, state, node, scope, newCallInfo)
    if (logger.isTraceEnabled()) logger.trace(`new expression: ${this.formatScope(obj)}`)

    if (obj && this.checkerManager?.checkAtNewExprAfter) {
      this.checkerManager.checkAtNewExprAfter(this, scope, node, state, {
        callInfo: newCallInfo,
        fclos,
        ret: obj,
        pcond: state.pcond,
        einfo: state.einfo,
        callstack: state.callstack,
      })
    }

    return obj
  }

  /**
   * Create a new object. Record the fields and initialize their values
   * @param fdef
   * @param argvalues
   * @param fclos
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  buildNewObject(fdef: any, fclos: any, state: State, node: any, scope: any, callInfo: CallInfo) {
    const argvalues = getLegacyArgValues(callInfo)
    if (Config.miniSaveContextEnvironment) {
      return new UndefinedValue()
    }

    const obj = buildNewValueInstance(
      this,
      fclos,
      node,
      scope,
      () => {
        return false
      },
      (v: any) => {
        return !v
      },
      1,
      '',
      'object'
    )

    if (_.isFunction(fclos.runtime?.execute)) {
      fclos.runtime!.execute!.call(this, obj, argvalues, state, node, scope)
    }

    if (!argvalues) return obj

    if (!fdef) {
      // function definition not found, examine possible call-back functions in the arguments
      if (Config.invokeCallbackOnUnknownFunction) {
        this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
      }
      // save pass-in arguments for later use
      if (argvalues.length > 0) {
        if (!obj.arguments || (Array.isArray(obj.arguments) && obj.arguments?.length === 0)) {
          obj.arguments = argvalues
        } else {
          obj.setMisc('pass-in', argvalues)
        }
      }
      return obj
    }

    let body
    switch (fdef.type) {
      case 'ObjectExpression':
        body = fdef.properties
        break
      case 'FunctionDefinition':
        fclos._isConstructor = true
      // fall through
      case 'ClassDefinition':
      default:
        body = fdef.body
    }
    if (!body) return obj

    // TODO: record type information

    // Initialize values, e.g. process the constructor parameters
    let paras
    let fconstructor
    let ctorClos
    switch (fdef.type) {
      case 'StructDefinition':
        paras = fdef.members.map(
          (x: any) => new SymbolValue(obj.qid, { sid: x.name, type: 'Parameter', name: x.name, loc: x.loc })
        )
        break
      // for javascript, ctor is itself
      case 'FunctionDefinition':
        paras = fdef.parameters
        fconstructor = fdef
        ctorClos = obj
        break
      default: {
        fconstructor = Initializer.getConstructor(body, fdef.name)
        if (fconstructor) paras = fconstructor.parameters
        if (obj.value) {
          ctorClos = obj.value._CTOR_
          if (!ctorClos && fconstructor) {
            this.processInstruction(fclos, fconstructor, state)
            ctorClos = obj.value._CTOR_
          }
        }
      }
    }
    if (paras) {
      if (paras.type === 'ParameterList') paras = paras.parameters
      const len = Math.min(paras.length, argvalues.length)
      for (let i = 0; i < len; i++) {
        const param = paras[i]
        let index = i
        const names = node.names || node.arguments
        if (names > 0) {
          // handle named argument values like "f({value: 2, key: 3})"
          const k = names.indexOf(param.name)
          if (k !== -1) index = k
        }
        let val = argvalues[index]
        // add source line information
        if (param.loc) {
          val = SourceLine.addSrcLineInfo(
            val,
            node,
            param.loc.sourcefile,
            'CTOR ARG PASS: ',
            param.name || AstUtil.prettyPrint(param).slice(0, 50)
          )
        }

        if (fdef.type === 'StructDefinition') {
          this.saveVarInCurrentScope(obj, param, val, state)
        }
      }
    }
    // try execute ctor
    if (ctorClos) {
      if (this.checkerManager && this.checkerManager.checkAtNewObject) {
        this.checkerManager.checkAtNewObject(this, scope, fdef, state, {
          callInfo,
          state,
          fclos: ctorClos,
          ainfo: this.ainfo,
        })
      }
      const oldThisFClos = this.thisFClos
      this.thisFClos = obj
      ctorClos._this = obj
      if (callInfo?.callArgs) {
        callInfo.callArgs.receiver = obj
      }
      this.executeCall(node, ctorClos, state, scope, callInfo)
      this.thisFClos = oldThisFClos
    }

    if (obj.parent) {
      obj.parent.value[obj.qid] = obj
    }
    return obj
  }

  // if function definition is not found, execute function in args
  /**
   *
   * @param scope
   * @param caller
   * @param callsite_node
   * @param argvalues
   * @param state
   */
  executeFunctionInArguments(scope: any, caller: any, callsite_node: any, argvalues: any, state: any) {
    const needInvoke = Config.invokeCallbackOnUnknownFunction
    if (needInvoke !== 1 && needInvoke !== 2) return new UndefinedValue()

    for (let i = 0; i < argvalues.length; i++) {
      const arg = argvalues[i]
      if (arg && arg.vtype === 'fclos') {
        const fclos = lodashCloneWithTag(arg)
        const new_state = _.clone(state)
        new_state.parent = state
        new_state.callstack = state.callstack ? state.callstack.concat([caller]) : [caller]
        new_state.callsites = state.callsites
          ? state.callsites.concat([
              {
                code: AstUtil.getRawCode(callsite_node).slice(0, 100),
                nodeHash: callsite_node._meta?.nodehash,
                loc: callsite_node.loc,
              },
            ])
          : [
              {
                code: AstUtil.getRawCode(callsite_node).slice(0, 100),
                nodeHash: callsite_node._meta?.nodehash,
                loc: callsite_node.loc,
              },
            ]
        this.executeCall(callsite_node, fclos, new_state, scope, INTERNAL_CALL)
      }
    }
  }

  /**
   * judge if val is nullLiteral,impl in every lang/framework analyzer
   * @param val
   */
  isNullLiteral(val: any) {
    return false
  }

  /**
   *
   * @param scope
   */
  getExportsScope(scope: any) {
    let scp = scope
    while (scp) {
      const _export = scp.getFieldValue('module.exports')
      if (_export) return _export
      scp = scp.parent
    }
    return scp
  }

  // ***

  /**
   * record the writes to shared variables
   * @param scope
   * @param node: destination node
   * @param val: original value of the destination
   * @param fclos
   * @param state
   */
  // this.recordSideEffect = function(scope, node, mindex, val) {
  // const cscope = thisFClos.parent;
  // if (!cscope.fdata) return;
  //
  // var targetv = node.left;
  // while (targetv.type == 'MemberAccess')
  //     targetv = targetv.expression;
  //
  // const targetv_decl = scope.decls[targetv.name];
  // if (!targetv_decl) return;
  //
  // if (!targetv_decl.isStateVar) return;
  //
  // var writes = cscope.fdata.writes;
  // if (!writes) {
  //     writes = cscope.fdata.writes = [];
  // }
  // writes.push(ValueFormatter.normalizeVarAccess(mindex));
  // };

  resolveClassInheritance(fclos: any, state: any) {
    const { fdef } = fclos.ast
    const { supers } = fdef
    if (!supers || supers.length === 0) return

    const scope = fclos.parent

    for (const i in supers) {
      if (supers[i]) {
        _resolveClassInheritance.bind(this)(fclos, supers[i])
      }
    }

    /**
     *
     * @param fclos
     * @param superId
     */
    function _resolveClassInheritance(this: any, fclos: any, superId: any) {
      if (fclos?.sid === superId?.name) {
        // to avoid self-referencing
        return
      }
      const superClos = this.processInstruction(scope, superId, state)
      // const superClos = this.getMemberValue(scope, superId, state);
      if (!superClos) return new UndefinedValue()
      fclos.super = superClos

      // inherit definitions
      // superValue is used to record values of super class, so that we can handle cases like super.xxx() or super()
      const superValue = fclos.value.super || Scope.createSubScope('super', fclos, 'fclos')
      // super's parent should be assigned to base, _this will track on fclos
      superValue.parent = superClos
      for (const fieldName in superClos.value) {
        if (fieldName === 'super') continue
        const v = superClos.value[fieldName]
        if (v.runtime?.readonly) continue
        // const v_copy = _.clone(v)
        const v_copy = lodashCloneWithTag(v)
        if (v_copy) {
          if (!v_copy.func) v_copy.func = {}
          v_copy.func.inherited = true
          v_copy._this = fclos
          v_copy._base = superClos
          fclos.value[fieldName] = v_copy

          superValue.value[fieldName] = v_copy
          if (fieldName === '_CTOR_') {
            superValue.ast.node = v_copy.ast.fdef
            superValue.ast.fdef = v_copy.ast.fdef
            superValue.overloaded = superValue.overloaded || []
            superValue.overloaded.push(fdef)
          }
        }

        // v_copy.parent = fclos;  // Important!
      }

      // inherit declarations
      for (const x of superClos.ast.declKeys) {
        const v = superClos.ast.getDecl(x)
        fclos.ast.setDecl(x, v)
      }
      // inherit modifiers
      for (const x in superClos.modifier) {
        const v = superClos.modifier[x]
        fclos.modifier[x] = v
      }
      // inherit initialized variables
      if (superClos.inits) {
        for (const x of superClos.inits) {
          fclos.inits.add(x)
        }
      }
      // inherit the fdata
      if (superClos.fdata) {
        if (!fclos.fdata) fclos.fdata = {}
        for (const x in superClos.fdata) {
          fclos.fdata[x] = superClos.fdata[x]
        }
      }
    }
  }

  /**
   *
   * @param thisFClos
   */
  initState(thisFClos: any) {
    return {
      callstack: [],
      brs: '',
      pcond: [],
      binfo: {},
      einfo: {},
      this: thisFClos,
    }
  }

  // TODO iterator implementation
  /**
   *
   * @param rightVal
   * @param filter
   */
  *getValueIterator(rightVal: any, filter: any) {
    if (rightVal && typeof rightVal.getRawValue === 'function') {
      const fields = rightVal.getRawValue()
      for (const key in fields) {
        // 过滤原型链
        if (typeof key === 'string' && key.includes('__yasa')) {
          continue
        }
        if (typeof fields.hasOwnProperty === 'function' && fields.hasOwnProperty(key)) {
          if (!filter) yield { k: key, v: fields[key] }
          else if (filter(fields[key])) yield { k: key, v: fields[key] }
        }
      }
    }
  }

  /**
   * load lib func tag propag
   */
  loadLibFuncTagPropagationRule() {
    if (this.libFuncTagPropagationRuleArray) {
      return this.libFuncTagPropagationRuleArray
    }

    const ruleArray: any[] = []
    let ruleWithLangArray: any[] = []
    try {
      const rulePath = getAbsolutePath('resource/tag-propagation/lib-func-tag-propagation-rule.json')
      ruleWithLangArray = loadJSONfile(rulePath)
    } catch (e) {
      return ruleArray
    }

    if (!Array.isArray(ruleWithLangArray)) {
      return ruleArray
    }
    for (const ruleWithLang of ruleWithLangArray) {
      if (!Array.isArray(ruleWithLang.rules)) {
        continue
      }
      ruleArray.push(...ruleWithLang.rules)
    }
    return ruleArray
  }

  /**
   * load lib arg to this sid blacklist keywords
   */
  loadLibArgToThisSidBlacklistKeywords() {
    if (Array.isArray(this.libArgToThisSidBlacklistKeywords)) {
      return this.libArgToThisSidBlacklistKeywords
    }

    let sidKeywordArray: any[] = []
    try {
      const rulePath = getAbsolutePath('resource/tag-propagation/lib-arg-to-this-sid-blacklist.json')
      const ruleData = loadJSONfile(rulePath)
      if (Array.isArray(ruleData?.sidKeywords)) {
        sidKeywordArray = ruleData.sidKeywords
      } else if (Array.isArray(ruleData?.keywords)) {
        sidKeywordArray = ruleData.keywords
      }
    } catch (e) {
      return []
    }

    return sidKeywordArray.filter((item) => typeof item === 'string' && item.trim().length > 0)
  }

  /**
   * find matched rule by CallGraph
   * @param node
   * @param scope
   * @param sinkRules
   */
  findMatchedRuleByCallGraph(node: any, scope: any, sinkRules: any[]) {
    const resultArray: any[] = []

    if (!node || !scope || !sinkRules || !this.findNodeInvocations) {
      return resultArray
    }

    const invocations: Invocation[] = this.findNodeInvocations(scope, node)
    if (!invocations) {
      return resultArray
    }

    for (const invocation of invocations) {
      for (const sink of sinkRules) {
        const matchSink: boolean = checkInvocationMatchSink(invocation, sink, this.typeResolver)
        if (matchSink) {
          resultArray.push(sink)
        }
      }
    }

    return resultArray
  }

  /**
   * output all the findings of all registered checker
   * @param {any} printf - Print function for output
   */
  async outputAnalyzerExistResult(printf?: any) {
    let allFindings = null
    const { resultManager } = this.getCheckerManager()
    if (resultManager && Config.reportDir) {
      const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
      outputStrategyAutoRegister.autoRegisterAllStrategies()
      allFindings = resultManager.getFindings()
      for (const outputStrategyId in allFindings) {
        const strategy = outputStrategyAutoRegister.getStrategy(outputStrategyId)
        if (strategy && typeof strategy.outputFindings === 'function') {
          strategy.outputFindings(resultManager, strategy.getOutputFilePath(), Config, printf)
        }
      }
    }
  }
}

/**
 *
 * @param type
 */
function needCompileFirst(type: any) {
  return ['FunctionDefinition', 'ClassDefinition'].indexOf(type) !== -1
}

//* *******************************************

module.exports = Analyzer
export { Analyzer }
