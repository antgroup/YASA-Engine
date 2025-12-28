const path = require('path')
const PythonTaintAbstractChecker = require('./python-taint-abstract-checker')
const FileUtil = require('../../../util/file-util')

const { extractRelativePath } = FileUtil
const AstUtil = require('../../../util/ast-util')
const Config = require('../../../config')
const completeEntryPoint = require('../common-kit/entry-points-util')
const logger = require('../../../util/logger')(__filename)
const BasicRuleHandler = require('../../common/rules-basic-handler')
const { mergeAToB } = require('../../../util/common-util')
const {
  isTornadoCall,
  parseRoutePair,
  resolveImportPath,
  extractImportEntries,
  extractParamsFromAst,
  tornadoSourceAPIs,
  passthroughFuncs,
  isRequestAttributeExpression,
  isRequestAttributeAccess,
  extractTornadoParams,
} = require('./tornado-util')
const { markTaintSource } = require('../common-kit/source-util')

// Type definitions (moved from import to avoid module resolution issues)
interface FileCache {
  vars: Map<string, any>
  classes: Map<string, any>
  importedSymbols: Map<string, any>
}

interface RoutePair {
  path: string
  handlerName: string
  file?: string
}

/**
 * Tornado Taint Checker Base Class
 */
class TornadoTaintChecker extends PythonTaintAbstractChecker {
  private fileCache = new Map<string, FileCache>()

  private cachedRuleConfigFile: string | null = null

  private cachedRuleConfigContent: any[] | null = null

  /**
   * Helper function to mark a value as tainted
   * @param value
   * @param node Optional node for trace
   */
  private markAsTainted(value: any, node?: any): void {
    if (!value) return
    markTaintSource(value, { path: node || value.ast || {}, kind: 'PYTHON_INPUT' })
  }

  /**
   *
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_python_tornado_input')
    // 基类构造函数会调用 loadRuleConfig，但此时 Config.ruleConfigFile 可能还没有被设置
    // 所以我们在这里不加载规则配置，而是在 triggerAtStartOfAnalyze 中加载
  }

  /**
   * trigger at start of analyze
   * Register sourceScope values as sources
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const currentRuleConfigFile = Config.ruleConfigFile
    let ruleConfigContent: any[] = []

    if (currentRuleConfigFile && currentRuleConfigFile !== '') {
      try {
        ruleConfigContent = FileUtil.loadJSONfile(currentRuleConfigFile)
        this.cachedRuleConfigFile = currentRuleConfigFile
        this.cachedRuleConfigContent = ruleConfigContent
      } catch (e: any) {
        ruleConfigContent = []
      }
    } else if (this.cachedRuleConfigContent !== null) {
      // 使用缓存的配置内容
      ruleConfigContent = this.cachedRuleConfigContent
    } else {
      // 尝试从 BasicRuleHandler 获取（可能已经在构造函数中加载）
      try {
        ruleConfigContent = BasicRuleHandler.getRules(Config.ruleConfigFile)
        if (ruleConfigContent && ruleConfigContent.length > 0) {
          this.cachedRuleConfigContent = ruleConfigContent
        }
      } catch (e: any) {
        ruleConfigContent = []
      }
    }

    // 应用规则配置
    const checkerId = this.getCheckerId()

    if (ruleConfigContent && Array.isArray(ruleConfigContent) && ruleConfigContent.length > 0) {
      for (const ruleConfig of ruleConfigContent) {
        const checkerIds = Array.isArray(ruleConfig.checkerIds)
          ? ruleConfig.checkerIds
          : ruleConfig.checkerIds
            ? [ruleConfig.checkerIds]
            : []
        const matches = checkerIds.length > 0 && checkerIds.includes(checkerId)

        if (matches) {
          mergeAToB(ruleConfig, this.checkerRuleConfigContent)
        }
      }
    }

    // 注册 sourceScope 中的 source
    this.addSourceTagForSourceScope('PYTHON_INPUT', this.sourceScope.value)
    // 注册规则配置中的 source
    this.addSourceTagForcheckerRuleConfigContent('PYTHON_INPUT', this.checkerRuleConfigContent)
  }


  /**
   * Build a light-weight file cache for quick lookup.
   * @param analyzer
   * @param scope
   * @param node
   * @param _state
   * @param _info
   */
  triggerAtCompileUnit(analyzer: any, scope: any, node: any, state: any, _info: any): boolean | undefined {
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    const fileName = node.loc?.sourcefile
    if (!fileName) return

    const cache: FileCache = {
      vars: new Map(),
      classes: new Map(),
      importedSymbols: new Map(),
    }

    // First pass: collect all variables, classes, and assignments
    const allAssignments: Map<string, any> = new Map()
    const applicationCalls: any[] = []

    AstUtil.visit(node, {
      AssignmentExpression: (n: any) => {
        if (n.left?.type === 'Identifier' && n.left.name) {
          cache.vars.set(n.left.name, { value: n.right, file: fileName })
          allAssignments.set(n.left.name, n.right)
        }
        return true
      },
      VariableDeclaration: (n: any) => {
        const localName = n.id?.name
        if (!localName) return true
        if (n.init?.type === 'ImportExpression') {
          const modulePath = n.init.from?.value || n.init.from?.name
          if (!modulePath) return true
          const resolved = resolveImportPath(modulePath, fileName, Config.maindir)
          if (!resolved) return true
          const entries = extractImportEntries(n)
          for (const entry of entries) {
            if (!entry.local) continue
            cache.importedSymbols.set(entry.local, {
              file: resolved,
              originalName: entry.imported,
            })
          }
          return true
        }
        if (n.init) {
          cache.vars.set(localName, { value: n.init, file: fileName })
          allAssignments.set(localName, n.init)
        }
        return true
      },
      ClassDefinition: (n: any) => {
        const name = n.name?.name || n.id?.name
        if (name) {
          cache.classes.set(name, { value: n, file: fileName })
        }
        return true
      },
      // Collect Tornado Application calls
      CallExpression: (n: any) => {
        if (this.isTornadoApplicationCallAst(n)) {
          applicationCalls.push(n)
        }
        return true
      },
    })

    this.fileCache.set(fileName, cache)

    // Second pass: process Application calls with fully populated variable map
    const routesByHandler: Map<string, { classAst: any; urlPattern: string }[]> = new Map()

    for (const callNode of applicationCalls) {
      // Extract handlers argument
      const handlersArg = this.extractHandlersArgFromCallAst(callNode)
      if (!handlersArg) continue

      // Parse routes from handlers list, using allAssignments for variable resolution
      const routes = this.parseRoutesFromAstWithAssignments(handlersArg, fileName, allAssignments)
      
      for (const route of routes) {
        if (!routesByHandler.has(route.handlerName)) {
          routesByHandler.set(route.handlerName, [])
        }
        const classAst = cache.classes.get(route.handlerName)?.value
        if (classAst) {
          routesByHandler.get(route.handlerName)!.push({
            classAst,
            urlPattern: route.path,
          })
        }
      }
    }

    // Register entrypoints from detected routes
    for (const [handlerName, routeInfos] of routesByHandler) {
      for (const routeInfo of routeInfos) {
        const handlerSymVal = this.buildClassSymbol(routeInfo.classAst)
        this.emitHandlerEntrypoints(analyzer, handlerSymVal, routeInfo.urlPattern, routeInfo.classAst, scope, state)
      }
    }
  }

  /**
   * Parse routes from handlers list AST with assignment map for variable resolution
   * @param handlersAst - AST node for handlers
   * @param fileName - Current file name
   * @param assignments - Map of variable name to value AST
   */
  private parseRoutesFromAstWithAssignments(
    handlersAst: any,
    fileName: string,
    assignments: Map<string, any>
  ): RoutePair[] {
    const routes: RoutePair[] = []
    if (!handlersAst) return routes

    // Handle identifier reference to a variable
    if (handlersAst.type === 'Identifier') {
      const valueAst = assignments.get(handlersAst.name)
      if (valueAst) {
        return this.parseRoutesFromAstWithAssignments(valueAst, fileName, assignments)
      }
      return routes
    }

    // Handle ObjectExpression (Python list parsed as object with numeric keys)
    if (handlersAst.type === 'ObjectExpression') {
      const properties = handlersAst.properties || []
      for (const prop of properties) {
        const valueNode = prop.value
        if (valueNode?.type === 'TupleExpression') {
          const pair = this.parseRouteTuple(valueNode)
          if (pair) {
            routes.push({ ...pair, file: fileName })
          }
        }
      }
      return routes
    }

    // Handle list/array expression
    if (handlersAst.type === 'ArrayExpression' || handlersAst.type === 'ListExpression') {
      const elements = handlersAst.elements || []
      for (const element of elements) {
        const pair = parseRoutePair(element)
        if (pair) {
          routes.push({ ...pair, file: fileName })
        }
      }
    }

    return routes
  }

  /**
   * Parse a route tuple AST into a RoutePair
   * @param tupleAst - TupleExpression AST node
   */
  private parseRouteTuple(tupleAst: any): RoutePair | null {
    if (!tupleAst || tupleAst.type !== 'TupleExpression') return null
    const elements = tupleAst.elements || []
    if (elements.length < 2) return null

    const pathNode = elements[0]
    const handlerNode = elements[1]

    const pathValue = pathNode?.type === 'Literal' ? pathNode.value : null
    const handlerName = handlerNode?.type === 'Identifier' ? handlerNode.name : null

    if (typeof pathValue === 'string' && handlerName) {
      return { path: pathValue, handlerName }
    }
    return null
  }

  /**
   * Check if a CallExpression AST node is a Tornado Application call
   * Supports patterns:
   * - tornado.web.Application.__init__(self, handlers, ...)
   * - Application.__init__(self, handlers, ...)
   * - tornado.web.Application(handlers, ...)
   * - Application(handlers, ...)
   * @param node - CallExpression AST node
   */
  private isTornadoApplicationCallAst(node: any): boolean {
    if (!node || node.type !== 'CallExpression' || !node.callee) return false
    const { callee } = node
    // logger.info(`Checking CallExpression for Tornado Application: ${AstUtil.prettyPrint(callee)}`)

    // Pattern 1: Direct Application call - Application(...)
    if (callee.type === 'Identifier' && callee.name === 'Application') {
      return true
    }

    // Pattern 2: MemberAccess ending with Application - tornado.web.Application(...)
    if (callee.type === 'MemberAccess' && callee.property?.name === 'Application') {
      return true
    }

    // Pattern 3: __init__ call on Application - tornado.web.Application.__init__(...)
    if (callee.type === 'MemberAccess' && callee.property?.name === '__init__') {
      let current = callee.object
      while (current) {
        if (current.type === 'Identifier' && current.name === 'Application') {
          return true
        }
        if (current.type === 'MemberAccess' && current.property?.name === 'Application') {
          return true
        }
        current = current.type === 'MemberAccess' ? current.object : null
      }
    }

    return false
  }

  /**
   * Extract handlers argument from Tornado Application call AST
   * @param node - CallExpression AST node
   */
  private extractHandlersArgFromCallAst(node: any): any {
    if (!node.arguments || node.arguments.length === 0) return null
    const { callee } = node

    // Check if this is an __init__ call (first arg is self)
    const isInitCall = callee?.type === 'MemberAccess' && callee?.property?.name === '__init__'
    
    if (isInitCall && node.arguments.length >= 2) {
      // __init__(self, handlers, ...) -> handlers is at index 1
      return node.arguments[1]
    }
    // Application(handlers, ...) -> handlers is at index 0
    return node.arguments[0]
  }


  /**
   * On function call before execution, use argvalues to get resolved symbol values
   * This replaces the old AST-based triggerAtFuncCallSyntax approach.
   * Using symbol interpretation allows us to:
   * 1. Get resolved symbol values for arguments (especially strings) via argvalues
   * 2. Handle cases where route lists are obtained through function calls
   * 3. Process route objects regardless of how they are obtained (variable, function call, etc.)
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    // 先调用基类方法
    super.triggerAtFunctionCallBefore(analyzer, scope, node, state, info)

    const { fclos, argvalues } = info
    if (!fclos || !argvalues) return

    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    const fileName = node.loc?.sourcefile
    if (!fileName) return

    // 检查是否是 Application 或 add_handlers 调用
    let routeListArgValue: any = null
    const isApp = isTornadoCall(node, 'Application')
    const isAddHandlers = isTornadoCall(node, 'add_handlers')

    if (isApp) {
      // Check if this is an __init__ call pattern: Application.__init__(self, handlers, ...)
      // In this case, handlers is the second argument (index 1)
      const callee = node.callee
      const isInitCall = callee?.type === 'MemberAccess' && callee?.property?.name === '__init__'
      if (isInitCall) {
        // __init__(self, handlers, ...) -> handlers is at index 1
        routeListArgValue = argvalues[1]
      } else {
        // Application(handlers, ...) -> handlers is at index 0
        ;[routeListArgValue] = argvalues
      }
    } else if (isAddHandlers) {
      // add_handlers(host, routes) -> second arg is routes
      ;[, routeListArgValue] = argvalues
    }

    if (routeListArgValue) {
      this.collectTornadoEntrypointAndSourceFromArgValue(analyzer, scope, state, routeListArgValue, fileName)
    }
  }

  /**
   * Collect entrypoints and sources from resolved symbol values (from argvalues)
   * @param analyzer
   * @param scope
   * @param state
   * @param routeListSymVal - Resolved symbol value for route list
   * @param currentFile
   */
  private collectTornadoEntrypointAndSourceFromArgValue(
    analyzer: any,
    scope: any,
    state: any,
    routeListSymVal: any,
    currentFile: string
  ): void {
    if (!routeListSymVal) return

    const processed = new Set<string>()
    const routePairs = this.extractRoutesFromSymbolValue(routeListSymVal, currentFile, analyzer, scope, state)

    for (let i = 0; i < routePairs.length; i++) {
      const pair = routePairs[i]
      if (!pair.path || !pair.handlerName) {
        continue
      }
      const dedupKey = `${pair.file || currentFile}::${pair.handlerName}::${pair.path}`
      if (processed.has(dedupKey)) {
        continue
      }
      processed.add(dedupKey)

      let handlerSymVal: any = null
      let classAst: any = null

      // Helper function to process class AST and get handler symbol value
      const processHandlerClass = (ast: any) => {
        classAst = ast
        try {
          handlerSymVal = analyzer.processInstruction(scope, classAst, state)
          if (!handlerSymVal || handlerSymVal.vtype !== 'class') {
            handlerSymVal = this.buildClassSymbol(classAst)
            if (!handlerSymVal.field) {
              handlerSymVal.field = {}
            }
          }
        } catch (e) {
          handlerSymVal = this.buildClassSymbol(classAst)
          if (!handlerSymVal.field) {
            handlerSymVal.field = {}
          }
        }
      }

      // First, try to use handler symbol value directly from the route pair
      if (pair.handlerSymVal) {
        const handlerSym = pair.handlerSymVal
        // If it's already a class symbol value, use it directly
        if (handlerSym.vtype === 'class') {
          handlerSymVal = handlerSym
          classAst = handlerSym.ast || handlerSym.fdef
        } else if (handlerSym.ast && handlerSym.ast.type === 'ClassDefinition') {
          // If we have the AST, process it to get the class symbol value
          processHandlerClass(handlerSym.ast)
        } else {
          // Try to resolve from identifier
          const { handlerName } = pair
          const handlerFile = pair.file || currentFile
          const handlerClassAst = this.resolveSymbol(handlerName, handlerFile)
          if (handlerClassAst && handlerClassAst.type === 'ClassDefinition') {
            processHandlerClass(handlerClassAst)
          }
        }
      } else {
        // Fallback: resolve handler class from name
        const { handlerName } = pair
        const handlerFile = pair.file || currentFile
        const handlerClassAst = this.resolveSymbol(handlerName, handlerFile)
        if (handlerClassAst && handlerClassAst.type === 'ClassDefinition') {
          processHandlerClass(handlerClassAst)
        }
      }

      // Ensure handlerSymVal has field structure
      if (handlerSymVal && handlerSymVal.vtype === 'class' && !handlerSymVal.field) {
        handlerSymVal.field = {}
      }

      if (handlerSymVal && classAst) {
        this.emitHandlerEntrypoints(analyzer, handlerSymVal, pair.path, classAst, scope, state)
      }
    }
  }

  /**
   * Proactive Sink Matching
   * Overrides base class to add flexible matching for common Python sinks (DB, Shell)
   * that might be missed due to incomplete type resolution.
   */
  checkByNameMatch(node: any, fclos: any, argvalues: any): void {
    // 1. Try standard matching first
    super.checkByNameMatch(node, fclos, argvalues)

    // 2. Proactive matching for critical sinks if no finding was generated yet
    // We look for common method names regardless of the receiver's inferred type
    const funcName = node.callee?.property?.name || node.callee?.name
    if (!funcName) return

    const proactiveSinks: Record<string, string> = {
      execute: 'PythonSqlInjection',
      popen: 'PythonCommandInjection',
      system: 'PythonCommandInjection',
    }

    if (proactiveSinks[funcName]) {
      // Check if any argument is tainted
      const taintedArg = argvalues.find((arg: any) => arg && (arg.taint || arg.hasTagRec || arg._tags?.has('PYTHON_INPUT')))
      if (taintedArg) {
        // Construct a manual finding if not already found
        const attribute = proactiveSinks[funcName]
        const ruleName = `${funcName} (Proactive Match)\nSINK Attribute: ${attribute}`
        
        const taintFlowFinding = this.buildTaintFinding(
          this.getCheckerId(),
          this.desc,
          node,
          taintedArg,
          fclos,
          'PYTHON_INPUT',
          ruleName,
          [] // No specific sanitizers for proactive match
        )
        
        const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
        if (TaintOutputStrategy.isNewFinding(this.resultManager, taintFlowFinding)) {
          this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
        }
      }
    }
  }

  /**
   * Handle API calls like self.get_argument()
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    // 先调用基类方法处理规则配置中的 source
    super.triggerAtFunctionCallAfter(analyzer, scope, node, state, info)
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    const { fclos, ret } = info
    if (!fclos || !ret) {
      return
    }

    // 从 node.callee 获取方法名（对于 MemberAccess 调用，如 self.get_argument）
    let funcName: string | null = null
    if (node.callee?.type === 'MemberAccess') {
      funcName = node.callee.property?.name
    } else if (node.callee?.type === 'Identifier') {
      funcName = node.callee.name
    }

    // 检查是否是 tornado source API 调用（如 get_argument）
    if (funcName && tornadoSourceAPIs.has(funcName)) {
      this.markAsTainted(ret, node)
    }

    // 处理 passthrough 函数（如 decode, strip 等）
    if (funcName && passthroughFuncs.has(funcName)) {
      // 使用 isRequestAttributeExpression 统一检测 request 属性访问（如 self.request.body.decode）
      // 这避免了重复的 AST 模式匹配逻辑，保持与 tornado-util.ts 的一致性
      if (
        node.callee?.type === 'MemberAccess' &&
        node.callee.object &&
        isRequestAttributeExpression(node.callee.object)
      ) {
        // 直接标记返回值为 source（因为 self.request.body/query/headers/cookies 等是 source）
        this.markAsTainted(ret, node)
        return // 已经标记，不需要再检查 receiver
      }
      // 检查 receiver 是否被污染
      const receiver = fclos?.object || fclos?._this
      if (receiver && (receiver.taint || receiver.hasTagRec || receiver._tags?.has('PYTHON_INPUT'))) {
        this.markAsTainted(ret, node)
      }
    }
  }

  /**
   * Trigger before entrypoint execution
   * Mark path parameters as tainted sources
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const entryPointConfig = require('../../../engine/analyzer/common/current-entrypoint')
    const entryPoint = entryPointConfig.getCurrentEntryPoint()
    if (!entryPoint || !entryPoint.entryPointSymVal) return

    // Check if this entrypoint has path parameters that should be marked as tainted
    const params = entryPoint.entryPointSymVal?.ast?.parameters
    if (!params) return

    // Get parameter names from sourceScope
    const paramNames = new Set<string>()
    for (const source of this.sourceScope.value) {
      if (source.path && source.kind === 'PYTHON_INPUT') {
        paramNames.add(source.path)
      }
    }

    // Mark matching parameters as tainted by processing them and marking the result
    for (const key in params) {
      const param = params[key]
      const paramName = param?.id?.name || param?.name
      if (paramName && paramNames.has(paramName) && paramName !== 'self') {
        try {
          // Process the parameter to get its symbol value
          const paramSymVal = analyzer.processInstruction(entryPoint.entryPointSymVal, param.id || param, state)
          if (paramSymVal) {
            this.markAsTainted(paramSymVal, param.id || param)
          }
        } catch (e) {
          // Ignore errors
        }
      }
    }
  }

  /**
   * Handle Member Access Sources like self.request.body
   * Reuses isRequestAttributeAccess from tornado-util.ts to maintain consistency
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtMemberAccess(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    const { res } = info

    // 重用 isRequestAttributeAccess 工具函数，避免重复逻辑并保持行为一致
    if (isRequestAttributeAccess(node)) {
      this.markAsTainted(res, node)
    }
  }

  /**
   * Resolve symbol cross-file
   * @param name
   * @param currentFile
   */
  private resolveSymbol(name: string, currentFile: string): any | null {
    if (!name || !currentFile) return null
    const cache = this.fileCache.get(currentFile)
    if (!cache) return null
    const { vars, classes, importedSymbols } = cache
    if (vars.has(name)) {
      const entry = vars.get(name)
      if (entry?.value) {
        entry.value.loc = entry.value.loc || {}
        entry.value.loc.sourcefile = entry.file
        return entry.value
      }
    }
    if (classes.has(name)) {
      const entry = classes.get(name)
      if (entry?.value) {
        entry.value.loc = entry.value.loc || {}
        entry.value.loc.sourcefile = entry.file
        return entry.value
      }
    }

    const importInfo = importedSymbols.get(name)
    if (!importInfo) return null
    const targetCache = this.fileCache.get(importInfo.file)
    if (!targetCache) return null
    const targetName = importInfo.originalName || name
    if (targetCache.vars.has(targetName)) {
      const entry = targetCache.vars.get(targetName)
      if (entry?.value) {
        entry.value.loc = entry.value.loc || {}
        entry.value.loc.sourcefile = entry.file
        return entry.value
      }
    }
    if (targetCache.classes.has(targetName)) {
      const entry = targetCache.classes.get(targetName)
      if (entry?.value) {
        entry.value.loc = entry.value.loc || {}
        entry.value.loc.sourcefile = entry.file
        return entry.value
      }
    }
    return null
  }

  /**
   * Extract route pairs from resolved symbol values (from argvalues)
   * @param routeListSymVal - Symbol value representing route list
   * @param currentFile - Current file path
   * @param analyzer
   * @param scope
   * @param state
   * @returns Array of route pairs with handler symbol values
   */
  private extractRoutesFromSymbolValue(
    routeListSymVal: any,
    currentFile: string,
    analyzer?: any,
    scope?: any,
    state?: any
  ): Array<RoutePair & { handlerSymVal?: any }> {
    if (!routeListSymVal) return []

    // Handle list/tuple symbol values
    if (routeListSymVal.vtype === 'list' || routeListSymVal.vtype === 'tuple' || routeListSymVal.vtype === 'array') {
      const elements = routeListSymVal.value || []
      return elements.flatMap((element: any) =>
        this.extractRoutesFromSymbolValue(element, currentFile, analyzer, scope, state)
      )
    }

    // Handle object type that might be a list (e.g., when symbol interpretation returns object for list literals)
    // Check if it has numeric keys (0, 1, 2, ...) which indicates it's an array-like object
    if (routeListSymVal.vtype === 'object' && routeListSymVal.value) {
      const keys = Object.keys(routeListSymVal.value).filter((k) => /^\d+$/.test(k))
      if (keys.length > 0) {
        // It's an array-like object, extract elements by numeric keys
        const elements = keys.map((k) => routeListSymVal.value[k])
        return elements.flatMap((element: any) =>
          this.extractRoutesFromSymbolValue(element, currentFile, analyzer, scope, state)
        )
      }
    }

    // Handle union types
    if (routeListSymVal.vtype === 'union' && Array.isArray(routeListSymVal.value)) {
      // Union type might represent a tuple (path, handler)
      // Check if it has exactly 2 elements and try to extract as tuple
      if (routeListSymVal.value.length === 2) {
        const [pathSymVal, handlerSymVal] = routeListSymVal.value
        const pathValue = this.extractStringFromSymbolValue(pathSymVal)
        const handlerName = this.extractHandlerNameFromSymbolValue(handlerSymVal)
        if (pathValue && handlerName) {
          const file =
            handlerSymVal?.ast?.loc?.sourcefile ||
            handlerSymVal?.fdef?.loc?.sourcefile ||
            handlerSymVal?.loc?.sourcefile ||
            currentFile
          return [{ path: pathValue, handlerName, file, handlerSymVal }]
        }
      }
      // Otherwise, recursively process each element
      return routeListSymVal.value.flatMap((val: any) =>
        this.extractRoutesFromSymbolValue(val, currentFile, analyzer, scope, state)
      )
    }

    // Handle tuple/route pair: (path, handler)
    // Check if it's a tuple with 2 elements
    if (
      routeListSymVal.vtype === 'tuple' &&
      Array.isArray(routeListSymVal.value) &&
      routeListSymVal.value.length >= 2
    ) {
      const [pathSymVal, handlerSymVal] = routeListSymVal.value
      const pathValue = this.extractStringFromSymbolValue(pathSymVal)
      const handlerName = this.extractHandlerNameFromSymbolValue(handlerSymVal)
      if (pathValue && handlerName) {
        const file =
          handlerSymVal?.ast?.loc?.sourcefile ||
          handlerSymVal?.fdef?.loc?.sourcefile ||
          handlerSymVal?.loc?.sourcefile ||
          currentFile
        return [{ path: pathValue, handlerName, file, handlerSymVal }]
      }
    }

    // Handle object type that represents a tuple (e.g., when tuple is represented as object with 0, 1 keys)
    if (
      routeListSymVal.vtype === 'object' &&
      routeListSymVal.value &&
      routeListSymVal.value['0'] &&
      routeListSymVal.value['1']
    ) {
      const pathSymVal = routeListSymVal.value['0']
      const handlerSymVal = routeListSymVal.value['1']
      const pathValue = this.extractStringFromSymbolValue(pathSymVal)
      const handlerName = this.extractHandlerNameFromSymbolValue(handlerSymVal)
      if (pathValue && handlerName) {
        const file =
          handlerSymVal?.ast?.loc?.sourcefile ||
          handlerSymVal?.fdef?.loc?.sourcefile ||
          handlerSymVal?.loc?.sourcefile ||
          currentFile
        return [{ path: pathValue, handlerName, file, handlerSymVal }]
      }
    }

    // Handle list concatenation via BinaryExpression (e.g., app_routes + [...])
    const astNode = routeListSymVal.ast
    if (astNode && astNode.type === 'BinaryExpression' && astNode.operator === '+') {
      try {
        const pairs: Array<RoutePair & { handlerSymVal?: any }> = []
        const leftVal = analyzer?.processInstruction ? analyzer.processInstruction(scope, astNode.left, state) : null
        if (leftVal) {
          pairs.push(...this.extractRoutesFromSymbolValue(leftVal, currentFile, analyzer, scope, state))
        }
        const rightVal = analyzer?.processInstruction ? analyzer.processInstruction(scope, astNode.right, state) : null
        if (rightVal) {
          pairs.push(...this.extractRoutesFromSymbolValue(rightVal, currentFile, analyzer, scope, state))
        }
        if (pairs.length > 0) {
          return pairs
        }
      } catch (e) {
        // ignore and fallback to AST parse below
      }
    }

    // Fallback: try to parse from AST if available
    if (routeListSymVal.ast) {
      const pair = parseRoutePair(routeListSymVal.ast)
      if (pair) {
        const file = routeListSymVal.ast?.loc?.sourcefile || routeListSymVal.loc?.sourcefile || currentFile
        return [{ ...pair, file }]
      }
    }

    return []
  }

  /**
   * Extract string value from symbol value
   * @param symVal - Symbol value
   * @returns String value or null
   */
  private extractStringFromSymbolValue(symVal: any): string | null {
    if (!symVal) return null

    // Direct string value
    if (symVal.vtype === 'string' || symVal.vtype === 'literal') {
      return typeof symVal.value === 'string' ? symVal.value : null
    }

    // From AST
    if (symVal.ast && (symVal.ast.type === 'StringLiteral' || symVal.ast.type === 'Literal')) {
      return typeof symVal.ast.value === 'string' ? symVal.ast.value : null
    }

    return null
  }

  /**
   * Extract handler name/class from symbol value
   * @param handlerSymVal - Handler symbol value
   * @returns Handler name or null
   */
  private extractHandlerNameFromSymbolValue(handlerSymVal: any): string | null {
    if (!handlerSymVal) return null

    // If it's a class symbol value
    if (handlerSymVal.vtype === 'class') {
      // Try to get class name from AST
      if (handlerSymVal.ast?.id?.name) {
        return handlerSymVal.ast.id.name
      }
      if (handlerSymVal.ast?.name?.name) {
        return handlerSymVal.ast.name.name
      }
      // Try from _sid or _qid
      if (handlerSymVal._sid) {
        return handlerSymVal._sid
      }
      if (handlerSymVal._qid) {
        const parts = handlerSymVal._qid.split('.')
        return parts[parts.length - 1]
      }
    }

    // If it's an identifier symbol value
    if (handlerSymVal.vtype === 'identifier' || handlerSymVal.vtype === 'var') {
      if (handlerSymVal._sid) {
        return handlerSymVal._sid
      }
      if (handlerSymVal.ast?.name) {
        return handlerSymVal.ast.name
      }
    }

    // From AST
    if (handlerSymVal.ast) {
      if (handlerSymVal.ast.type === 'Identifier') {
        return handlerSymVal.ast.name
      }
      if (handlerSymVal.ast.type === 'ClassDefinition') {
        return handlerSymVal.ast.id?.name || handlerSymVal.ast.name?.name || null
      }
    }

    return null
  }

  /**
   * Register EntryPoints and Path Param Sources
   * [Fixed]: Removed Config check to forcefully register parameters as sources
   * @param analyzer
   * @param handlerSymVal
   * @param urlPattern
   * @param classAst
   * @param scope
   * @param state
   */
  private emitHandlerEntrypoints(
    analyzer: any,
    handlerSymVal: any,
    urlPattern: string,
    classAst: any,
    scope?: any,
    state?: any
  ) {
    if (!handlerSymVal || handlerSymVal.vtype !== 'class') {
      return
    }
    const httpMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options'])
    const entrypoints = Object.entries(handlerSymVal.value)
      .filter(([key, value]: [string, any]) => httpMethods.has(key) && value.vtype === 'fclos')
      .map(([, value]: [string, any]) => value)

    for (const ep of entrypoints as any[]) {
      // ignore init files
      if (ep.fdef?.loc?.sourcefile?.endsWith('__init__.py')) {
        continue
      }

      // 尝试使用 analyzer.processInstruction 获取正确的 fclos 对象
      let finalEp = ep
      if (scope && state && ep.fdef) {
        try {
          const processedFclos = analyzer.processInstruction(scope, ep.fdef, state)
          if (processedFclos && processedFclos.vtype === 'fclos') {
            processedFclos.parent = handlerSymVal
            processedFclos.params = ep.params || extractParamsFromAst(ep.fdef)
            if (!processedFclos.value) {
              processedFclos.value = {}
            }
            finalEp = processedFclos
          }
        } catch (e) {
          // fallback to original ep
        }
      }
      // 确保 ep 有 value 属性
      if (!finalEp.value) {
        finalEp.value = {}
      }

      // 确保 finalEp.parent 正确设置，并且 handlerSymVal 有 field 结构
      if (handlerSymVal && handlerSymVal.vtype === 'class') {
        if (!handlerSymVal.field) {
          handlerSymVal.field = {}
        }
        finalEp.parent = handlerSymVal
      }

      try {
        // 确保 finalEp 有 completeEntryPoint 需要的属性
        if (!finalEp.ast && finalEp.fdef) {
          finalEp.ast = finalEp.fdef
        }
        if (!finalEp.functionName) {
          const rawFuncName = finalEp.fdef?.name?.name || finalEp.fdef?.id?.name || finalEp.name || ''
          const handlerName = this.extractHandlerNameFromSymbolValue(handlerSymVal)
          finalEp.functionName = handlerName ? `${handlerName}.${rawFuncName}` : rawFuncName
        }
        // 确保 finalEp 有 filePath
        if (!finalEp.filePath && finalEp.fdef?.loc?.sourcefile) {
          const { sourcefile } = finalEp.fdef.loc
          if (Config.maindir && typeof Config.maindir === 'string') {
            finalEp.filePath = FileUtil.extractRelativePath(sourcefile, Config.maindir)
          } else {
            finalEp.filePath = sourcefile
          }
        }
        // 确保 finalEp 有 ast，completeEntryPoint 可能需要它
        if (!finalEp.ast && finalEp.fdef) {
          finalEp.ast = finalEp.fdef
        }
        const entryPoint = completeEntryPoint(finalEp)
        entryPoint.urlPattern = urlPattern
        entryPoint.handlerName = this.extractHandlerNameFromSymbolValue(handlerSymVal)
        // 确保 entryPoint.entryPointSymVal.parent 有 field 结构
        if (
          entryPoint.entryPointSymVal?.parent &&
          entryPoint.entryPointSymVal.parent.vtype === 'class' &&
          !entryPoint.entryPointSymVal.parent.field
        ) {
          entryPoint.entryPointSymVal.parent.field = {}
        }
        analyzer.entryPoints.push(entryPoint)

        // 注册参数为 source
        const funcName = finalEp.fdef?.name?.name || finalEp.fdef?.id?.name || finalEp.name || ''
        const sourceFile = finalEp.fdef?.loc?.sourcefile || classAst?.loc?.sourcefile || ''
        let scopeFile: string | null = null
        if (sourceFile) {
          if (Config.maindir && typeof Config.maindir === 'string') {
            scopeFile = extractRelativePath(sourceFile, Config.maindir)
          } else {
            scopeFile = sourceFile
          }
        }

        const params = extractTornadoParams(urlPattern)
        const paramMetas =
          (Array.isArray((finalEp as any).params) && (finalEp as any).params.length
            ? (finalEp as any).params
            : extractParamsFromAst(finalEp.fdef)) || []
        if (paramMetas.length > 0) {
          let positionalIdx = 0
          for (const meta of paramMetas) {
            if (meta.name === 'self') continue

            let isSource = false
            if (params.named.length > 0) {
              if (params.named.includes(meta.name)) {
                isSource = true
              }
            } else if (params.positionalCount > 0) {
              if (positionalIdx < params.positionalCount) {
                isSource = true
              }
            }
            positionalIdx++

            if (!isSource) continue

            // 对于路径参数，使用 'all' 以匹配所有文件和位置，因为参数可能在函数定义的不同位置
            const sourceEntry = {
              path: meta.name,
              kind: 'PYTHON_INPUT',
              scopeFile: 'all', // 使用 'all' 以匹配所有文件
              scopeFunc: 'all', // 使用 'all' 以匹配所有函数，因为 handler 方法可能在嵌套作用域中
              locStart: 'all', // 使用 'all' 以匹配所有行号
              locEnd: 'all', // 使用 'all' 以匹配所有行号
            }
            this.sourceScope.value.push(sourceEntry)
            // 立即注册 source，因为 triggerAtStartOfAnalyze 可能在 entrypoints 收集之前被调用
            this.addSourceTagForSourceScope('PYTHON_INPUT', [sourceEntry])
          }
        }
      } catch (e: any) {
        logger.warn(`Error in completeEntryPoint: ${e?.message || e}`)
        continue
      }
    }
  }

  /**
   *
   * @param classNode
   */
  private buildClassSymbol(classNode: any): any {
    const value: any = {}
    const members = classNode.body || []
    const className = classNode.name?.name || classNode.id?.name || 'UnknownClass'
    members.forEach((member: any) => {
      if (member.type !== 'FunctionDefinition') return
      const memberName = member.name?.name || member.name?.id?.name || member.id?.name
      if (memberName) {
        value[memberName] = {
          vtype: 'fclos',
          fdef: member,
          ast: member,
          params: extractParamsFromAst(member),
        }
      }
    })
    return { vtype: 'class', value, ast: classNode }
  }
}

export = TornadoTaintChecker
