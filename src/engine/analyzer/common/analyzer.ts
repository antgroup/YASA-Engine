const _ = require('lodash')
const Uuid = require('node-uuid')
const chalk = require('chalk')
const logger = require('../../../util/logger')(__filename)
const Config = require('../../../config')
const Initializer = require('./initializer')
const MemSpace = require('./memSpace')
const NativeResolver = require('./native-resolver')
const MemState = require('./memState')
const Scope = require('./scope')
const SourceLine = require('./source-line')
const AstUtil = require('../../../util/ast-util')
const ValueFormatter = require('../../../util/value-formatter')
const StateUtil = require('../../util/state-util')
const SymAddress = require('./sym-address')
const { unionAllValues } = require('./memStateBVT')
const { cloneWithDepth } = require('../../../util/clone-util')
const { handleException } = require('./exception-handler')
const {
  ValueUtil: { ObjectValue, Scoped, PrimitiveValue, UndefinedValue, UnionValue, SymbolValue, PackageValue },
} = require('../../util/value-util')

const { filterDataFromScope, shallowEqual } = require('../../../util/common-util')
const Rules = require('../../../checker/common/rules-basic-handler')
const { getAbsolutePath, loadJSONfile } = require('../../../util/file-util')
const { matchSinkAtFuncCallWithCalleeType } = require('../../../checker/taint/common-kit/sink-util')
const { moveExistElementsToBuffer } = require('../java/common/builtins/buffer')
const { PerformanceTracker } = require('../../../util/performance-tracker')
// ***

/**
 * The main AST analyzer with checker invoking
 * @param checker
 * @constructor
 */
class Analyzer extends MemSpace {
  options: any

  checkerManager: any

  enablePerformanceLogging: boolean

  lastReturnValue: any

  thisFClos: any

  entry_fclos: any

  inRange: boolean

  ainfo: Record<string, any>

  sourceCodeCache: Record<string, any>

  lastProcessedNode: any

  thisIterationTime: number

  prevIterationTime: number

  statistics: { numProcessedInstructions: number }

  entryPoints: any[]

  libFuncTagPropagationRuleArray: any[]

  moduleManager: any

  packageManager: any

  fileManager!: Record<string, any>

  funcSymbolTable!: Record<string, any>

  topScope: any

  preprocessState: boolean | undefined

  performanceTracker: import('../../../util/performance-tracker').IPerformanceTracker

  /**
   *
   * @param checkerManager
   * @param options
   */
  constructor(checkerManager: any, options?: any) {
    super()
    this.options = options || {}
    this.checkerManager = checkerManager // 关联的检查器管理器
    this.performanceTracker = new PerformanceTracker()
    this.enablePerformanceLogging = this.options.enablePerformanceLogging || false // 默认关闭
    // 启用指令监控（如果启用了性能日志）
    this.performanceTracker.enableInstructionMonitor(this.enablePerformanceLogging)
    this.lastReturnValue = null // 记录最后一次函数调用的返回值
    this.thisFClos = null // 当前分析函数的闭包
    this.entry_fclos = null // 最外层函数的闭包
    this.inRange = false // 范围语句标志
    this.ainfo = {} // 整个分析过程中的信息
    this.sourceCodeCache = {} // 缓存的源代码
    this.lastProcessedNode = null
    // 超时控制
    this.thisIterationTime = 0
    this.prevIterationTime = 0
    this.statistics = {
      numProcessedInstructions: 0,
    }

    this.initValTreeStruct()
    this.entryPoints = []
    this.libFuncTagPropagationRuleArray = this.loadLibFuncTagPropagationRule()
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
    this.moduleManager = Scoped({
      parent: null, // will set to topScope right away
      sid: 'moduleManager',
    }) // cache of imported module

    this.packageManager = PackageValue({
      parent: null, // will set to topScope right away
      sid: '',
      id: '',
      name: 'packageManager',
    }) // cache of imported module

    this.fileManager = {}
    this.funcSymbolTable = {} // 函数符号值集合，可快速搜索全局函数，向QL/断点粘连提供快速检索能力
    this.topScope = Scoped({
      id: '<global>',
      sid: '<global>',
      moduleManager: this.moduleManager,
      packageManager: this.packageManager,
      fileManager: this.fileManager,
      funcSymbolTable: this.funcSymbolTable,
      parent: null,
    })
    this.funcSymbolTable.parent = this.topScope
    this.fileManager.parent = this.topScope
    this.moduleManager.parent = this.topScope
    this.packageManager.parent = this.topScope
    this.fileManager.parent = this.topScope

    this.thisFClos = this.topScope
  }

  /**
   * 执行分析流程的通用方法，统一处理性能追踪（同步版本）
   * 
   * **重要说明：**
   * - 此方法仅用于同步 preProcess 场景，preProcessFn 必须返回 void（不能返回 Promise）
   * - 如果 preProcessFn 可能返回 Promise，请使用 executeAnalysisPipelineAsync 方法
   * 
   * @param preProcessFn - 执行同步 preProcess 的函数（必须返回 void，不能返回 Promise）
   * @param symbolInterpretFn - 执行 symbolInterpret 的函数
   */
  private executeAnalysisPipeline(preProcessFn: () => void, symbolInterpretFn: () => void): void {
    // 开始整体性能追踪
    this.performanceTracker.start()
    this.performanceTracker.start('preProcess')

    Rules.setPreprocessReady(false)
    // 启用指令级别的性能监控（如果已启用性能日志）
    this.performanceTracker.startInstructionMonitor()

    // 执行同步 preProcess
    preProcessFn()

    this.performanceTracker.end('preProcess')
    this.performanceTracker.start('startAnalyze')

    this.startAnalyze()

    this.performanceTracker.end('startAnalyze')
    Rules.setPreprocessReady(true)

    this.performanceTracker.start('symbolInterpret')

    symbolInterpretFn()

    this.performanceTracker.end('symbolInterpret')
    this.endAnalyze()

    // 记录性能数据并输出摘要（会自动输出指令统计）
    this.performanceTracker.logPerformance()
  }

  /**
   * 执行分析流程的通用方法（异步版本），统一处理性能追踪
   * 
   * 用于处理异步 preProcess 场景，避免 analyzeProjectAsync 中的代码重复。
   * 
   * @param preProcessFn - 执行异步 preProcess 的函数
   * @param symbolInterpretFn - 执行 symbolInterpret 的函数
   */
  private async executeAnalysisPipelineAsync(
    preProcessFn: () => Promise<void>,
    symbolInterpretFn: () => void
  ): Promise<void> {
    // 开始整体性能追踪
    this.performanceTracker.start()
    this.performanceTracker.start('preProcess')

    Rules.setPreprocessReady(false)
    // 启用指令级别的性能监控（如果已启用性能日志）
    this.performanceTracker.startInstructionMonitor()

    // 执行异步 preProcess
    await preProcessFn()

    this.performanceTracker.end('preProcess')
    this.performanceTracker.start('startAnalyze')

    this.startAnalyze()

    this.performanceTracker.end('startAnalyze')
    Rules.setPreprocessReady(true)

    this.performanceTracker.start('symbolInterpret')

    symbolInterpretFn()

    this.performanceTracker.end('symbolInterpret')
    this.endAnalyze()

    // 记录性能数据并输出摘要（会自动输出指令统计）
    this.performanceTracker.logPerformance()
  }

  /**
   * 分析单个文件
   * 
   * 性能追踪逻辑已统一到 executeAnalysisPipeline 方法，避免代码重复。
   * 
   * @param source - 源代码内容
   * @param fileName - 文件名
   * @returns 分析结果
   */
  analyzeSingleFile(source: any, fileName: any) {
    try {
      if (typeof this.preProcess4SingleFile === 'function' && typeof this.symbolInterpret === 'function') {
        this.executeAnalysisPipeline(
          () => this.preProcess4SingleFile(source, fileName),
          () => this.symbolInterpret()
        )
      } else {
        logger.info(`this analyzer has not support analyzeSingleFile yet`)
      }
      return this.recordCheckerFindings()
    } catch (e) {
      handleException(e, 'Error occurred in analyzer analyzeSingleFile', 'Error occurred in analyzer analyzeSingleFile')
    }
  }

  /**
   * 异步分析项目
   * 
   * 用于处理支持异步 preProcess 的分析器（如 Go Analyzer、Python Analyzer）。
   * 
   * @param processingDir - 要分析的项目目录
   * @returns 分析结果
   */
  async analyzeProjectAsync(processingDir: any) {
    try {
      if (typeof this.preProcess === 'function' && typeof this.symbolInterpret === 'function') {
        await this.executeAnalysisPipelineAsync(
          () => this.preProcess(processingDir),
          () => this.symbolInterpret()
        )
      }
      return this.recordCheckerFindings()
    } catch (e) {
      handleException(
        e,
        'Error occurred in analyzer analyzeProjectAsync',
        'Error occurred in analyzer analyzeProjectAsync'
      )
    }
  }

  /**
   * 同步分析项目
   * 
   * 用于处理同步 preProcess 的分析器（如 Java Analyzer、JavaScript Analyzer）。
   * 性能追踪逻辑已统一到 executeAnalysisPipeline 方法，避免代码重复。
   * 
   * @param processingDir - 要分析的项目目录
   * @returns 分析结果
   */
  analyzeProject(processingDir: any) {
    try {
      if (typeof this.preProcess === 'function' && typeof this.symbolInterpret === 'function') {
        this.executeAnalysisPipeline(
          () => this.preProcess(processingDir),
          () => this.symbolInterpret()
        )
      }
      return this.recordCheckerFindings()
    } catch (e) {
      handleException(e, 'Error occurred in analyzer analyzeProject', 'Error occurred in analyzer analyzeProject')
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
   * @param source
   * @param filename
   */
  parseUast(source: any, filename: any) {}

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
   * @param target
   * @param topScopeTemp
   */
  findValInTree(target: any, topScopeTemp: any): any {
    const passVals: any[] = []
    let current = target
    while (current) {
      if (current.sid === '<global>') {
        break
      }
      passVals.push(current)
      current = current.parent
    }
    passVals.reverse()
    let scope = topScopeTemp
    for (const val of passVals) {
      let hasFind = false
      for (const s of Object.values(scope) as any[]) {
        if (
          s &&
          val.vtype === s.vtype &&
          val.id === s.id &&
          val.sid === s.sid &&
          val.qid === s.qid &&
          val.sort === s.sort &&
          val.name === s.name &&
          val.ast === s.ast &&
          val.parent?.vtype === s.parent?.vtype
        ) {
          scope = s
          hasFind = true
          break // 提前退出循环
        }
      }
      if (!hasFind && scope.field) {
        for (const s of Object.values(scope.field) as any[]) {
          if (
            s &&
            val.vtype === s.vtype &&
            val.id === s.id &&
            val.sid === s.sid &&
            val.qid === s.qid &&
            val.sort === s.sort &&
            val.name === s.name &&
            val.ast === s.ast &&
            val.parent?.vtype === s.parent?.vtype
          ) {
            scope = s
            hasFind = true
            break // 提前退出循环
          }
        }
      }
      if (!hasFind) {
        return null
      }
    }
    return scope
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

  /**
   *
   * @param node
   */
  debugInstruction(node: any) {
    if (!Array.isArray(node)) {
      const code = this.sourceCodeCache[node?.loc?.sourcefile]

      if (code) {
        const { start, end } = node.loc
        const showLine = getLine(code, node.loc.start.line)
        const startColumn = start.column
        let endColumn = end.column
        if (start.line !== end.line) {
          endColumn = start.column
        }
        const msg = `${start.line}   ${showLine.substring(0, startColumn)}${chalk.blue(
          showLine.substring(startColumn, endColumn)
        )}${showLine.substring(endColumn, showLine.length)}`
        logger.debug(msg)
      }
    }

    /**
     *
     * @param code
     * @param n
     */
    function getLine(code: any, n: any) {
      // 将代码分割成行数组
      const lines = code.split('\n')

      // 检查行数是否在有效范围内
      if (n > 0 && n <= lines.length) {
        // 获取第N行的内容
        return lines[n - 1]
      }
      return null // 行数无效，返回null或其他适当的值
    }
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
      return UndefinedValue()
    }
    if (node.vtype) {
      return node
    }
    this.lastProcessedNode = node

    if (scope.vtype === 'union') {
      const res = UnionValue()
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
      return SymbolValue(node)
    }
    // TODO 添加判断，后续指令是否是跟在return或throw后且在同一个scope内无法执行的指令 4+
    this.statistics.numProcessedInstructions++

    // 如果启用了性能日志（enablePerformanceLogging），会自动记录指令执行时间和次数
    this.performanceTracker.startInstruction()

    let val
    try {
      val = inst.call(this, scope, node, state)
    } catch (e) {
      handleException(
        e,
        '',
        `process${node.type} error! loc is${node.loc.sourcefile}::${node.loc.start.line}_${node.loc.end.line}`
      )
      val = UndefinedValue()
    }

    // 性能追踪：结束指令执行并更新统计（内部会检查是否启用）
    this.performanceTracker.endInstructionAndUpdateStats(
      node,
      (node: any, instructionType: string) => this.getLocationKey(node, instructionType)
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
        this.processClassDefinition(val.parent, val.cdef, state)
        break
      case 'fclos':
        this.processFunctionDefinition(val.parent, val.fdef, state)
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
    return UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processLiteral(scope: any, node: any, state: any) {
    return PrimitiveValue({ ...node, ast: node, qid: node.value, sid: node.value, id: node.value })
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processIdentifier(scope: any, node: any, state: any) {
    if (node.name === 'undefined') return PrimitiveValue({ type: 'Literal', value: undefined })
    const res = this.getMemberValue(scope, node, state)
    if (res.vtype === 'fclos') {
      res._this = this.topScope
    }
    if (res.vtype === 'undefine' || res.vtype === 'uninitialized' || res.vtype === 'symbol') {
      res.vtype = 'symbol'
      res._id = node.name
      res._sid = node.name
    }
    this.checkerManager.checkAtIdentifier(this, scope, node, state, { res })
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCompileUnit(scope: any, node: any, state: any) {
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
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processExportStatement(scope: any, node: any, state: any) {
    // locate exports
    const exports = this.getExportsScope(scope)
    const val = this.processInstruction(scope, node.argument, state)
    if (Array.isArray(exports)) {
      exports.forEach((exp) => this.saveVarInCurrentScope(exp, node.alias, val, state))
    } else if (exports) {
      this.saveVarInCurrentScope(exports, node.alias, val, state)
    }
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
  processIfStatement(scope: any, node: any, state: any) {
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

    const b: string = 'U' // abstraction.evaluate(test, state.pcond);
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
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSwitchStatement(scope: any, node: any, state: any) {
    // cases: [ SwitchCase ]
    const test = this.processInstruction(scope, node.discriminant, state)
    if (test && test.type === 'Literal') {
      for (const caseClause of node.cases) {
        if (
          !caseClause.test || // FIXME
          caseClause.test.value === test.value
        ) {
          return this.processInstruction(scope, caseClause.body, state)
        }
      }
      return UndefinedValue()
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
    return UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processForStatement(scope: any, node: any, state: any) {
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
    return UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processWhileStatement(scope: any, node: any, state: any) {
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

    return UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processRangeStatement(scope: any, node: any, state: any) {
    const { key, value, right, body } = node
    scope = Analyzer.createSubScope(
      `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
      scope
    )
    const rightVal = this.processInstruction(scope, right, state)
    if (
      !Array.isArray(rightVal) &&
      (this.inRange ||
        rightVal?.vtype === 'primitive' ||
        Object.keys(rightVal.getRawValue()).length === 0 ||
        rightVal?.vtype === 'union')
    ) {
      if (value) {
        if (value.type === 'VariableDeclaration') {
          this.saveVarInCurrentScope(scope, value.id, rightVal, state)
        } else if (value.type === 'TupleExpression') {
          for (const ele of value.elements) {
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
        return
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
            if (_.isString(k)) k = PrimitiveValue({ ...key, value: k, ast: key, qid: k, sid: k, id: k })
            this.saveVarInScope(scope, key, k, state)
          }
        }
        if (value) {
          if (value.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, value.id, v, state)
          } else {
            this.saveVarInScope(scope, value, v, state)
          }
        }
        this.processInstruction(scope, body, state)
      }
      this.inRange = false
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processReturnStatement(scope: any, node: any, state: any) {
    // { expression }
    // lastReturnValue should be treated as union since there are multi return points in one func
    if (node.argument) {
      const return_value = this.processInstruction(scope, node.argument, state)
      if (!node.isYield) {
        if (!this.lastReturnValue) {
          this.lastReturnValue = return_value
        } else if (this.lastReturnValue.vtype === 'union') {
          if (return_value === this.lastReturnValue || return_value.value === this.lastReturnValue.value) {
            const new_return_value = cloneWithDepth(return_value, 2)
            this.lastReturnValue.appendValue(new_return_value, false)
          } else {
            this.lastReturnValue.appendValue(return_value, false)
          }
        } else {
          const tmp = UnionValue()
          tmp.appendValue(this.lastReturnValue)
          tmp.appendValue(return_value)
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
      return return_value
    }
    return PrimitiveValue({ type: 'Literal', value: null, loc: node.loc })
  }

  // TODO break statement
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processBreakStatement(scope: any, node: any, state: any) {
    return UndefinedValue()
  }

  // TODO continue statement
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processContinueStatement(scope: any, node: any, state: any) {
    return UndefinedValue()
  }

  // TODO throw
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processThrowStatement(scope: any, node: any, state: any) {
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
          node.argument.name
        )
        // 没有被try处理的异常
        state.throwstack = state.throwstack ?? []
        state.throwstack.push(throw_value)
        return throw_value
      }
    }
    return PrimitiveValue({ type: 'Literal', value: node.argument, loc: node.loc })
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processTryStatement(scope: any, node: any, state: any) {
    // 此处processInstruction的返回值是undefine 因此无法拿到try里面是否抛出异常的信息
    this.processInstruction(scope, node.body, state)
    const { handlers } = node
    if (handlers) {
      for (const clause of handlers) {
        scope = Analyzer.createSubScope(
          `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
          scope
        )
        clause.parameter.forEach((param: any) => this.processInstruction(scope, param, state))
        this.processInstruction(scope, clause.body, state)
      }
    }
    if (node.finalizer) this.processInstruction(scope, node.finalizer, state)
    return UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processExpressionStatement(scope: any, node: any, state: any) {
    // { expression }
    return this.processInstruction(scope, node.expression, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processScopedStatement(scope: any, node: any, state: any) {
    /*
    { statements }
    */
    const { loc } = node
    let scopeName
    if (loc) {
      if (!scope._qid) {
        const relateFileName = loc.sourcefile.startsWith(Config.maindirPrefix)
          ? loc.sourcefile?.substring(Config.maindirPrefix.length).split('.')[0]
          : loc.sourcefile.split('.')[0]
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
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processBinaryExpression(scope: any, node: any, state: any) {
    /*
   { operator,
     left,
     right
    }
    */
    const new_node = _.clone(node)
    new_node.ast = node
    const new_left = (new_node.left = this.processInstruction(scope, node.left, state))
    const new_right = (new_node.right = this.processInstruction(scope, node.right, state))

    const has_tag = (new_left && new_left.hasTagRec) || (new_right && new_right.hasTagRec)
    if (has_tag) {
      new_node.hasTagRec = has_tag
    }

    if (this.checkerManager && this.checkerManager.checkAtBinaryOperation)
      this.checkerManager.checkAtBinaryOperation(this, scope, node, state, { newNode: new_node })

    return SymbolValue(new_node)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processUnaryExpression(scope: any, node: any, state: any) {
    const new_node = SymbolValue(_.clone(node))
    new_node.ast = node
    new_node.argument = this.processInstruction(scope, node.argument, state)
    // return nativeResolver.simplifyUnaryExpression(new_node);
    const hasTags = new_node.argument && new_node.argument.hasTagRec
    if (hasTags) new_node.hasTagRec = hasTags
    return new_node
  }

  /**
   * "left = right", "left *= right", etc.
   * @param scope
   * @param node
   * @param state
   */
  processAssignmentExpression(scope: any, node: any, state: any) {
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
        if (node.cloned && !tmpVal?.refCount) {
          tmpVal = _.clone(tmpVal)
          tmpVal.value = _.clone(tmpVal.value)
        }
        const oldVal = this.processInstruction(scope, left, state)

        // TODO: clean the following up
        if (left.type === 'TupleExpression') {
          for (let k = 0; k < left.elements.length; k++) {
            const x = left.elements[k]
            if (!x || x.name === '_') continue

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
          if (!tmpVal)
            // explicit null value
            tmpVal = PrimitiveValue({ type: 'Literal', value: null, loc: right.loc })
          const sid = SymAddress.toStringID(node.left)
          tmpVal.sid = !tmpVal.id || tmpVal.id === '<anonymous>' ? sid : tmpVal.id
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
          if (left.name === undefined && left.sid !== undefined) {
            left.name = left.sid
          }
          tmpVal = SourceLine.addSrcLineInfo(tmpVal, node, node.loc && node.loc.sourcefile, 'Var Pass:', left.name)
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
        const val = SymbolValue(node)
        val.type = 'BinaryOperation'
        val.operator = node.operator.substring(0, node.operator.length - 1)
        val.arith_assign = true
        val.left = this.processInstruction(scope, node.left, state)
        val.right = this.processInstruction(scope, node.right, state)
        if (node.cloned) {
          const clonedValue = _.clone(val.right.value)
          val.right = _.clone(val.right)
          val.right.value = clonedValue
        }
        const { left } = node
        const oldVal = this.getMemberValueNoCreate(scope, left, state)

        const hasTags = (val.left && val.left.hasTagRec) || (val.right && val.right.hasTagRec)
        if (hasTags) val.hasTagRec = hasTags

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
  processConditionalExpression(scope: any, node: any, state: any) {
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

    const res = UnionValue()
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
  processSuperExpression(scope: any, node: any, state: any) {
    return this.getMemberValue(scope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processThisExpression(scope: any, node: any, state: any) {
    return this.thisFClos
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processMemberAccess(scope: any, node: any, state: any) {
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
  processSliceExpression(scope: any, node: any, state: any) {}

  // TODO tuple
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processTupleExpression(scope: any, node: any, state: any) {
    return unionAllValues(
      node.elements.map((ele: any) => {
        return this.processInstruction(scope, ele, state)
      }),
      state
    )
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processObjectExpression(scope: any, node: any, state: any) {
    // FIXME
    let res = Scoped({ parent: scope, ast: node })
    if (node.properties) {
      for (const property of node.properties) {
        let name
        let fvalue
        switch (property.type) {
          case 'ObjectMethod': {
            name = property.key.name
            fvalue = this.createFuncScope(property, scope)
            fvalue.fdef = _.clone(fvalue.fdef)
            if (fvalue.fdef) {
              fvalue.fdef.type = 'FunctionDefinition'
            }
            fvalue.ast = _.clone(fvalue.ast)
            if (fvalue.ast) {
              fvalue.ast.type = 'FunctionDefinition'
            }
            break
          }
          case 'SpreadElement': {
            this.processInstruction(res, property, state)
            continue
          }
          case 'ObjectProperty':
          default: {
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
                name = key.type === 'Literal' ? key.value : key.name
                break
            }
            fvalue = this.processInstruction(res, property.value, state)
            res.hasTagRec = res.hasTagRec || fvalue?.hasTagRec
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
    }
    res = ObjectValue(res)
    res.vtype = 'object'
    res._this = res
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCallExpression(scope: any, node: any, state: any) {
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
    if (!fclos) return UndefinedValue()
    if (node?.callee?.type === 'MemberAccess' && fclos.fdef && node.callee?.object?.type !== 'SuperExpression') {
      fclos._this = this.processInstruction(scope, node.callee.object, state)
    }

    // prepare the function arguments
    let argvalues = []
    let same_args = true // minor optimization to save memory
    for (const arg of node.arguments) {
      let argv = this.processInstruction(scope, arg, state)
      // 处理参数是 箭头函数或匿名函数
      // 参数类型必须是函数定义,且fclos找不到定义或未建模适配
      // 如果参数适配建模，则会进入相应的逻辑模拟执行，例如array.push
      if (arg?.type === 'FunctionDefinition' && arg?.name === '<anonymous>' && !fclos?.fdef && !fclos?.execute) {
        // let subscope = Scope.createSubScope(argv.sid + '_scope', scope,'scope')
        argv = this.processAndCallFuncDef(scope, arg, argv, state)
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

    // analyze the resolved function closure and the function arguments
    const res = this.executeCall(node, fclos, argvalues, state, scope)

    // function definition not found, examine possible call-back functions in the arguments
    if (fclos.vtype !== 'fclos' && Config.invokeCallbackOnUnknownFunction) {
      this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
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
   *
   * @param scope
   * @param fDef
   * @param fClos
   * @param state
   */
  processAndCallFuncDef(scope: any, fDef: any, fClos: any, state: any) {
    if (fDef?.type !== 'FunctionDefinition' || fClos?.vtype !== 'fclos') return fClos

    try {
      // process FuncDef的参数
      const argValues = []
      for (const para of fDef.parameters) {
        const argv = this.processInstruction(scope, para, state)
        if (Array.isArray(argv)) {
          argValues.push(...argv)
        } else {
          argValues.push(argv)
        }
      }
      // execute call
      return this.executeCall(fDef, fClos, argValues, state, scope)
    } catch (e) {
      handleException(
        e,
        '',
        `YASA Simulation Execution Error in processAndCallFuncDef. Loc is ${fDef?.loc?.sourcefile} line:${fDef?.loc?.start?.line}`
      )
      return UndefinedValue()
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCastExpression(scope: any, node: any, state: any) {
    return this.processInstruction(scope, node.expression, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processNewExpression(scope: any, node: any, state: any) {
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
    return UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processFunctionDefinition(scope: any, node: any, state: any) {
    let fclos
    if (node.body) {
      // TODO: handle function declaration better
      fclos = this.createFuncScope(node, scope)
    } else {
      fclos = UndefinedValue()
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
    if (!(cdef && cdef.body)) return UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = Scope.createSubScope(fname, scope, 'class') // class scope
    cscope.cdef = cdef
    cscope.fdef = cdef
    cscope.ast = cdef
    cscope.__preprocess = true
    return cscope
  }

  /**
   *
   * @param scope
   * @param cdef
   * @param state
   */
  processClassDefinition(scope: any, cdef: any, state: any) {
    if (!(cdef && cdef.body)) return UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = Scope.createSubScope(fname, scope, 'class') // class scope
    cscope.fdef = cdef
    cscope.cdef = cdef
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
  processVariableDeclaration(scope: any, node: any, state: any) {
    const initialNode = node.init
    const { id } = node
    if (!id || id?.name === '_') return UndefinedValue() // e.g. in Go

    let initVal
    if (!initialNode) {
      initVal = this.createVarDeclarationScope(id, scope)
      initVal.uninit = !initialNode
      initVal = SourceLine.addSrcLineInfo(initVal, id, id.loc && id.loc.sourcefile, 'Var Pass: ', id.name)
    } else if (node?.parent?.type === 'CatchClause' && node?._meta?.isCatchParam && state?.throwstack?.length > 0) {
      // 处理throw传递到catch的情况
      initVal = state?.throwstack && state?.throwstack.shift()
      initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', id.name)
      delete node._meta.isCatchParm
    } else {
      initVal = this.processInstruction(scope, initialNode, state)
      if (initialNode.type === 'ImportExpression') {
        if (initVal?.sid === 'module.exports' && _.keys(initVal?.value).length === 0) {
          initVal = this.processInstruction(scope, initialNode, state)
        }
      }
      initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', id.name)
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
    if (
      initVal &&
      !Array.isArray(initVal) &&
      !(initVal.name || (initVal.id && initVal.id !== '<anonymous>') || initVal.sid)
    ) {
      initVal.sid = id.name
      delete initVal.id
    }

    scope.decls[id.name] = id

    const typeQualifiedName = AstUtil.typeToQualifiedName(node.varType)
    let declTypeVal
    if (typeQualifiedName) {
      declTypeVal = this.getMemberValueNoCreate(scope, typeQualifiedName, state)
    }

    if (initVal && declTypeVal) {
      initVal.sort = declTypeVal.sort
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
    if (ret && ret.refCount) {
      ret.refCount--
      if (ret.refCount === 0) {
        delete ret.refCount
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
      val.refCount = val.refCount || 0
      val.refCount++
    }
    return val
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processImportExpression(scope: any, node: any, state: any) {
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
  processSpreadElement(scope: any, node: any, state: any) {
    const val = this.processInstruction(scope, node.argument, state)
    if (!val) {
      return val
    }
    const res = new Set()
    const self = this
    const fields = Array.isArray(val) ? val : val.exports ? val.exports.getRawValue() : val.getRawValue()
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
        const offset = Object.keys(scope.field).length
        const isArray = node.parent?._meta?.isArray
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

    return Array.from(res)
  }

  // TODO YieldExpression
  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processYieldExpression(scope: any, node: any, state: any) {
    node.expression = node.argument
    return this.processReturnStatement(scope, node, state)
  }

  /**
   *
   * @param node
   */
  traceNodeInfo(node: any) {
    const loc = node?.loc
    if (!loc) return

    const sourcefile = (() => {
      let n = node
      while (n) {
        if (n?.loc?.sourcefile) {
          return n.loc.sourcefile
        }
        n = n.parent
      }
      return null
    })()

    if (!sourcefile) return
    const source_code = this.sourceCodeCache[sourcefile]
    if (!source_code) return
    const lines = source_code.split('\n')

    const snippet = lines[loc.start.line - 1]
    const start = loc.start.column
    const end = loc.end.line === loc.start.line ? loc.end.column : snippet.length - 1

    const prefix = `${sourcefile}:${loc.start.line}:[${node.type}] ${snippet.substring(0, start)}`
    const highlight = source_code.substring(loc.start.index, loc.end.index).substring(0, 100).replace(/\n/g, ' ')
    return prefix + chalk.blue(highlight)
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
  executeCall(node: any, fclos: any, argvalues: any, state: any, scope: any): any {
    if (Config.makeAllCG && fclos?.fdef?.type === 'FunctionDefinition' && this.ainfo?.callgraph?.nodes) {
      for (const callgraphnode of this.ainfo?.callgraph?.nodes.values()) {
        if (
          callgraphnode.opts?.funcDef?.loc?.start?.line &&
          callgraphnode.opts?.funcDef?.loc?.end?.line &&
          callgraphnode.opts?.funcDef?.loc?.sourcefile === fclos.fdef?.loc?.sourcefile &&
          callgraphnode.opts?.funcDef?.loc?.start?.line === fclos.fdef?.loc?.start?.line &&
          callgraphnode.opts?.funcDef?.loc?.end?.line === fclos.fdef?.loc?.end?.line
        ) {
          this.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
            argvalues,
            fclos,
            pcond: state.pcond,
            entry_fclos: this.entry_fclos,
            einfo: state.einfo,
            state,
            analyzer: this,
            ainfo: this.ainfo,
          })
          return SymbolValue({
            type: 'FunctionCall',
            expression: fclos,
            arguments: argvalues,
            ast: node,
          })
        }
      }
    }

    // process the function body
    if (fclos.fdef || fclos.execute) {
      const { decorators } = fclos
      // const decorators = fclos.ast && fclos.ast.decorators;
      if (decorators && decorators.length > 0) {
        return this.executeCallWithDecorators(_.clone(decorators), fclos, argvalues, state, node, scope)
      }
      return this.executeSingleCall(fclos, argvalues, state, node, scope)
    }
    if (fclos.vtype === 'union') {
      const res: any[] = []
      for (const f of fclos.value) {
        if (!f) continue
        node = node || f.ast
        const v = this.executeCall(node, f, argvalues, state, scope)
        if (v) res.push(v)
      }
      const len = res.length
      if (len === 0) {
      } else if (len === 1) return res[0]
      else return UnionValue({ value: res })
    }

    // now for the function without body
    if (this.checkerManager) {
      this.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        argvalues,
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

    const libFuncTagPropagationRuleFound = this.processLibFuncTagPropagation(node, fclos, argvalues, scope, state)
    if (!libFuncTagPropagationRuleFound) {
      // 没有配置的库函数，采用默认处理方式：arg->ret
      return this.processLibArgToRet(node, fclos, argvalues, scope, state)
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
  processLibArgToRet(node: any, fclos: any, argvalues: any, scope: any, state: any) {
    // the case without function body, still process the call, e.g. perform taint propagation
    let res = _.clone(node)
    res.expression = fclos
    res.arguments = argvalues
    res.ast = node
    const argsSignature = AstUtil.prettyPrintAST(node.arguments)
    res.id = `${fclos?.id}(${argsSignature})`
    res.sid = `${fclos?.sid}(${argsSignature})`
    res.qid = `${fclos?.qid}(${argsSignature})`
    // res.field = {}
    if (fclos.hasTagRec) {
      res.hasTagRec = true
    }

    // attach taint information if any
    // var taint;
    for (const arg of argvalues) {
      if (arg) {
        if (arg.hasTagRec) {
          res.hasTagRec = true
          break
        }
        const hasTag = AstUtil.hasTag(arg, '')
        if (hasTag) {
          res.hasTagRec = true
        }
      }
    }

    // e.g. XXInterface token = XXInterface(id) where id is ctor_init
    for (const arg of argvalues) {
      if (arg && arg.ctor_init && node.expression && node.expression.value) {
        let top_scope = scope
        while (top_scope.parent) {
          top_scope = top_scope.parent
        }
        if (top_scope.value && top_scope.value[node.expression.value]) {
          res.ctor_init = true
        }
      }
    }
    if (node.callee.type === 'MemberAccess') {
      if (fclos?.object?.hasTagRec) {
        res.hasTagRec = true
      }
    }

    // return { type : 'FunctionCall', expression: fclos, arguments: argvalues,
    //          ast: node };
    res = SymbolValue(res) // esp. for member getter function

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
  processLibFuncTagPropagation(node: any, fclos: any, argvalues: any, scope: any, state: any) {
    let matchRuleFound = false
    const libFuncTagPropagationRuleArray = this.loadLibFuncTagPropagationRule()
    for (const libFuncTagPropagationRule of libFuncTagPropagationRuleArray) {
      if (
        matchSinkAtFuncCallWithCalleeType(node, fclos, [libFuncTagPropagationRule.func], scope, argvalues)?.length > 0
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
    const res = argvalues[targetIndex]

    res.setMisc('precise', false)
    moveExistElementsToBuffer(res)

    const passIn = res.getMisc('pass-in') || []
    for (const argIndex in argvalues) {
      if (sourceIndex >= 0 && sourceIndex !== Number(argIndex)) {
        continue
      }
      const arg = argvalues[argIndex]
      passIn.push(arg)
      if (arg.hasTagRec) {
        res.hasTagRec = true
      }
      const hasTag = AstUtil.hasTag(arg, '')
      if (hasTag) {
        res.hasTagRec = true
      }
    }

    res.setMisc('pass-in', passIn)
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
    const _this = fclos.getThis()
    if (!argvalues || !_this) {
      return
    }

    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)

    switch (node.callee.type) {
      case 'MemberAccess':
        const thisVal = this.processInstruction(scope, node.callee.object, state)
        for (const argIndex in argvalues) {
          if (sourceIndex >= 0 && sourceIndex !== Number(argIndex)) {
            continue
          }
          const arg = argvalues[argIndex]
          if (arg.hasTagRec) {
            thisVal.setFieldValue(
              arg.id,
              ObjectValue({
                sid: arg.sid,
                qid: arg.qid,
                parent: thisVal,
                value: arg,
              })
            )
            thisVal.hasTagRec = true
          }
          const hasTag = AstUtil.hasTag(arg, '')
          if (hasTag) {
            thisVal.hasTagRec = true
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
          const arg = argvalues[argIndex]

          arg.setMisc('precise', false)
          moveExistElementsToBuffer(arg)

          if (thisVal && thisVal.hasTagRec) {
            arg.setFieldValue(
              thisVal.id,
              ObjectValue({
                sid: thisVal.sid,
                qid: thisVal.qid,
                parent: arg,
                value: thisVal,
              })
            )
            arg.hasTagRec = true
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
  executeCallWithDecorators(decorators: any, fclos: any, argvalues: any, state: any, node: any, scope: any) {
    if (!decorators || decorators.length === 0) {
      return this.executeSingleCall(fclos, argvalues, state, node, scope)
    }

    // The decorator expressions get called top to bottom, and produce decorators,
    // while decorators themselves run in the opposite direction, bottom to top.

    let decorator = decorators.pop()
    let descriptor_fclos = fclos
    const class_obj = fclos.getThis() // fclos represents class method, the parent of it is class object

    while (decorator) {
      let descriptor = ObjectValue({ sid: 'descriptor' })
      descriptor.value.value = _.clone(descriptor_fclos)
      const { name } = decorator // both function decl and identifier have name
      const target = decorator
      decorator._this = class_obj
      let descriptor_res
      // const decorator_clos = this.getMemberValue(scope, decorator, state);
      const decorator_clos = decorator

      // if decorator is not found, just skip it
      // TODO decorators that can't be found should be summary analyzed
      if (decorator_clos?.vtype === 'fclos' && !shallowEqual(decorator_clos.ast, decorator)) {
        descriptor_res = this.executeCall(node, decorator, [target, name, descriptor], state, scope)
      } else {
        descriptor_res = null
      }

      if (descriptor_res && descriptor_res.value.value) {
        descriptor = descriptor_res
      }

      descriptor_fclos = this.getMemberValue(
        descriptor,
        PrimitiveValue({
          type: 'Literal',
          value: 'value',
        }),
        state
      )
      // descriptor_fclos runs with class object as it's [this], which can be located from parent of class method
      descriptor_fclos._this = class_obj
      decorator = decorators.pop()
    }
    return this.executeSingleCall(descriptor_fclos, argvalues, state, descriptor_fclos.ast, scope)
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
  executeSingleCall(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    let fdecl = fclos.fdef
    let fname // name of the function

    if (fclos && fclos.vtype === 'union') {
      const res = UnionValue()
      for (const fc of fclos.value) {
        node = node || fc.ast
        res.appendValue(this.executeSingleCall(fc, argvalues, state, node, scope))
      }
      return res
    }
    let execute_builtin = false
    if (!fdecl) {
      if (!fclos.execute) {
        return { type: 'FunctionCall', callee: fclos, arguments: argvalues, loc: node.loc }
      }
      // execute prepared builtins function
      execute_builtin = true
    } else {
      fname = fdecl.name
      if (fdecl.type === 'StructDefinition') {
        return this.buildNewObject(fdecl, argvalues, fclos, state, node, scope)
      }
      if (fdecl.type === 'ClassDefinition' && fclos.value?._CTOR_ && fclos.value?._CTOR_.vtype === 'fclos') {
        fdecl = fclos?.value?._CTOR_?.fdef
      }
      if (fdecl.type !== 'FunctionDefinition') {
        return UndefinedValue()
      }
    }

    if (fclos.overloaded && fclos.overloaded.length > 1) {
      // overloaded functions
      let hasFind = false
      for (const f of fclos.overloaded) {
        let paramLength = 0
        const param = f.parameters
        if (param) {
          paramLength = Array.isArray(param) ? param.length : param.parameters.length
        }
        if (paramLength === argvalues.length) {
          let typeMatch = true
          const literalTypeList = ['String', 'string', 'int', 'Integer', 'Double', 'double', 'float', 'Float']
          for (let i = 0; i < paramLength; i++) {
            if (
              param[i].varType?.id?.name === argvalues[i].rtype?.definiteType?.name ||
              argvalues[i].rtype?.definiteType?.name?.endsWith(`.${param[i].varType?.id?.name}`) ||
              (argvalues[i].vtype === 'primitive' && literalTypeList.includes(param[i].varType?.id?.name))
            ) {
              continue
            }
            typeMatch = false
          }
          if (typeMatch) {
            hasFind = true
            fclos = _.clone(fclos)
            fclos.ast = fclos.fdef = fdecl = f // adjust to the right function definition
            break
          }
        }
      }
      // 兜底，假设类型完全没匹配到（类型检测没适配好），就走长度匹配
      if (!hasFind) {
        for (const f of fclos.overloaded) {
          let paramLength = 0
          const param = f.parameters
          if (param) {
            paramLength = Array.isArray(param) ? param.length : param.parameters.length
          }
          if (paramLength === argvalues.length) {
            fclos = _.clone(fclos)
            fclos.ast = fclos.fdef = fdecl = f // adjust to the right function definition
            break
          }
        }
      }
    }

    if (logger.isTraceEnabled()) logger.trace(`\nprocessCall: function: ${this.formatScope(fdecl?.id?.name)}`)

    // avoid infinite loops,the re-entry should only less than 3
    if (
      fdecl &&
      state.callstack.reduce((previousValue: any, currentValue: any) => {
        return currentValue.fdef === fdecl ? previousValue + 1 : previousValue
      }, 0) > 0
    ) {
      return SymbolValue({
        type: 'FunctionCall',
        expression: fclos,
        arguments: argvalues,
        ast: node,
      })
    }

    // pre-call processing
    const oldThisFClos = this.thisFClos
    this.thisFClos = fclos.getThis()

    fname = fname || fclos.id || fclos.sid || ''
    if (fname === '<anonymous>') {
      fname = fclos.id
    }

    let fscope = Scope.createSubScope(`${fname}_scope`, fclos) // this is actually named "activation record" in computer science
    fscope._this = fclos._this
    if (fclos.vtype === 'class') {
      // for javascript class ctor function
      fscope = fclos
    }

    // prepare execute state
    const new_state = _.clone(state)
    new_state.parent = state
    new_state.callstack = state.callstack ? state.callstack.concat([fclos]) : [fclos]
    new_state.brs = ''
    // this.recordFunctionDefinitions(fscope, fdecl.body, new_state);

    let return_value
    if (execute_builtin) {
      this?.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        argvalues,
        fclos,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        analyzer: this,
        ainfo: this.ainfo,
      })

      // this.lastReturnValue =  fclos.execute.call(this, fclos, argvalues, new_state, node, scope);
      this.lastReturnValue = null
      for (let i = 0; i < argvalues.length; i++) {
        argvalues[i] = SourceLine.addSrcLineInfo(argvalues[i], node, node.loc && node.loc.sourcefile, 'CALL: ', fname)
      }
      return_value = fclos.execute.call(this, fclos, argvalues, new_state, node, scope)
    } else {
      // now go into the function body
      this?.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        argvalues,
        fclos,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        analyzer: this,
        ainfo: this.ainfo,
      })

      // process function arguments
      if (!fdecl.parameters) {
        // Errors.UnexpectedNode(`warning: processCall: function parameters not found: ${fdecl}`)
        return UndefinedValue()
      }
      const params = fdecl.parameters
      // // make sure all parameters in fclos are defined
      params?.forEach((param: any) => {
        this.processInstruction(fscope, param, new_state)
      })

      const size = Math.min(argvalues.length, params.length)
      let hasVariadicElement = false
      if (
        argvalues.length > size &&
        ((Config.language !== 'js' && Config.language !== 'javascript') ||
          params[params.length - 1]?._meta.isRestElement)
      ) {
        hasVariadicElement = true
      }
      for (let i = 0; i < size; i++) {
        const param = params[i]
        let val
        const paramName = param.id?.name
        if (i === size - 1 && hasVariadicElement) {
          // variadic parameter processing
          const rest_argvalues = argvalues.slice(i)
          const rest_val: any = {}
          rest_argvalues.forEach((element: any, index: any) => {
            rest_val[index.toString()] = element
          })

          val = ObjectValue({
            id: paramName,
            field: rest_val,
          })
        } else {
          if (!paramName) continue // unused parameters

          let index = i
          if (node.names && node.names.length > 0) {
            // handle named argument values like "f({value: 2, key: 3})"
            const k = node.names.indexOf(param.name)
            if (k !== -1) index = k
          }
          // if (DEBUG) logger.info('write arg:' + formatNode(param) + ' = ' + formatNode(argvalues[i]));
          val = argvalues[index]
        }

        // add source line information
        if (param.loc && oldThisFClos && node.type !== 'FunctionDefinition') {
          val = SourceLine.addSrcLineInfo(val, node, node.loc && node.loc.sourcefile, 'CALL: ', fname)
          const fdeclParam = Array.isArray(fdecl.parameters) ? fdecl.parameters[0] : fdecl.parameters
          if (fdeclParam.loc.end.line === param.loc.end.line)
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

        // argument passing
        this.saveVarInCurrentScope(fscope, param, val, new_state)
      }

      // make sure all parameters in fclos are defined
      params?.forEach((param: any) => {
        const val = this._getMemberValueDirect(fscope, param.id, state, false, 0, new Set())
        if (!val) {
          this.saveVarInCurrentScope(fscope, param.id, UndefinedValue(), state)
        }
      })

      let objectVal
      if (node?.callee?.type === 'MemberAccess') {
        // objectVal = this.processInstruction(scope, node.callee.object, state)
        objectVal = SourceLine.addSrcLineInfo(fclos._this, node, node.loc && node.loc.sourcefile, 'CALL: ', fname)
        objectVal = SourceLine.addSrcLineInfo(
          fclos._this,
          node.callee.object,
          node.callee.object.loc.sourcefile,
          'ARG PASS: ',
          node.callee.object.name
        )
      }

      // return parameters
      if (fdecl.returnParameters) {
        const val_0 = PrimitiveValue({ type: 'Literal', value: 0, loc: fdecl.returnParameters.loc })
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
      // if (this.lastReturnValue) {  // for the source line trace
      //     const dataflow = 'RETURN:'; // size ? 'RETURN: ' : null;
      //     this.lastReturnValue = SourceLine.addSrcLineInfo(this.lastReturnValue, node, node.loc && node.loc.sourcefile, dataflow);
      // }
      // return_value = return_value || UndefinedValue();
      return_value = this.lastReturnValue || UndefinedValue()
      this.lastReturnValue = oldReturnValue

      const tag = 'CALL RETURN:' // size ? 'RETURN: ' : null;
      return_value = SourceLine.addSrcLineInfo(return_value, node, node.loc && node.loc.sourcefile, tag, fname)
    }

    // post-call processing
    delete fclos.value[fscope.id]
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

    const { fdef } = fclos
    // if (analysisutil.isInCallStack(fdef, state.callstack)) return;

    const obj = this.buildNewObject(fdef, argvalues, fclos, state, node, scope)
    if (logger.isTraceEnabled()) logger.trace(`new expression: ${this.formatScope(obj)}`)

    if (obj && this.checkerManager?.checkAtNewExprAfter) {
      this.checkerManager.checkAtNewExprAfter(this, scope, node, state, {
        argvalues,
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
  buildNewObject(fdef: any, argvalues: any, fclos: any, state: any, node: any, scope: any) {
    let obj
    // clone the basic class object
    obj = ObjectValue(fclos)
    obj.reset()
    obj.vtype = 'object'
    obj.value = {}
    obj.id = `${obj.sid}<instance>`
    obj.qid += '<instance>'
    obj._this = obj
    if (obj.parent?.sid === '<global>') {
      obj.parent = scope
    }
    if (typeof fclos.value === 'object') {
      for (const x in fclos.value) {
        const v = fclos.value[x]
        if (!v) continue
        const v_copy = cloneWithDepth(v)
        obj.value[x] = v_copy
        // if (v.vtype !== 'fclos') {   // can reuse function definitions
        // }
        if (typeof v_copy === 'object') {
          v_copy._this = obj
          v_copy.parent = obj
        }
      }
    }

    if (_.isFunction(fclos.execute)) {
      fclos.execute.call(this, obj, argvalues, state, node, scope)
    }

    if (!argvalues) return obj

    if (!fdef) {
      if (logger.isTraceEnabled())
        logger.trace(`processNewObject: definition not found: ${ValueFormatter.formatNode(fclos)}`)

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
        fclos.vtype = 'class'
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
        paras = fdef.members.map((x: any) => SymbolValue({ type: 'Parameter', name: x.name, loc: x.loc }))
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
          val = SourceLine.addSrcLineInfo(val, node, param.loc.sourcefile, 'CTOR ARG PASS: ', param.name)
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
          argvalues,
          state,
          fclos: ctorClos,
          ainfo: this.ainfo,
        })
      }
      const oldThisFClos = this.thisFClos
      this.thisFClos = obj
      ctorClos._this = obj
      this.executeCall(node, ctorClos, argvalues, state, scope)
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
    if (needInvoke !== 1 && needInvoke !== 2) return UndefinedValue()

    for (let i = 0; i < argvalues.length; i++) {
      const arg = argvalues[i]
      if (arg && arg.vtype === 'fclos') {
        const fclos = _.clone(arg)
        const new_state = _.clone(state)
        new_state.parent = state
        new_state.callstack = state.callstack ? state.callstack.concat([caller]) : [caller]
        this.executeCall(callsite_node, fclos, [], new_state, scope)
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
    const { fdef } = fclos
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
      if (fclos?.id === superId?.name) {
        // to avoid self-referencing
        return
      }
      const superClos = this.processInstruction(scope, superId, state)
      // const superClos = this.getMemberValue(scope, superId, state);
      if (!superClos) return UndefinedValue()
      fclos.super = superClos

      // inherit definitions
      // superValue is used to record values of super class, so that we can handle cases like super.xxx() or super()
      const superValue = fclos.value.super || Scope.createSubScope('super', fclos, 'fclos')
      // super's parent should be assigned to base, _this will track on fclos
      superValue.parent = superClos
      for (const fieldName in superClos.value) {
        if (fieldName === 'super') continue
        const v = superClos.value[fieldName]
        if (v.readonly) continue
        const v_copy = _.clone(v)
        v_copy.inherited = true
        v_copy._this = fclos
        v_copy._base = superClos
        fclos.value[fieldName] = v_copy

        superValue.value[fieldName] = v_copy
        // super fclos should fill its fdef with ctor definition
        if (fieldName === '_CTOR_') {
          superValue.fdef = v_copy.fdef
          superValue.overloaded = superValue.overloaded || []
          superValue.overloaded.push(fdef)
        }

        // v_copy.parent = fclos;  // Important!
      }

      // inherit declarations
      for (const x in superClos.decls) {
        const v = superClos.decls[x]
        fclos.decls[x] = v
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
