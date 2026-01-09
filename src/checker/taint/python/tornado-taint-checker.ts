const path = require('path')
const PythonTaintAbstractChecker = require('./python-taint-abstract-checker')
const FileUtil = require('../../../util/file-util')
const AstUtil = require('../../../util/ast-util')
const Config = require('../../../config')
const completeEntryPoint = require('../common-kit/entry-points-util')
const logger = require('../../../util/logger')(__filename)
const BasicRuleHandler = require('../../common/rules-basic-handler')
const { mergeAToB } = require('../../../util/common-util')
const {
  extractParamsFromAst,
  isTornadoCall,
  tornadoSourceAPIs,
  passthroughFuncs,
  isRequestAttributeExpression,
  isRequestAttributeAccess,
  extractTornadoParams,
} = require('./tornado-util')
const { markTaintSource } = require('../common-kit/source-util')

interface RoutePair {
  path: string
  handlerName: string
  file?: string
  handlerSymVal?: any
}

/**
 * Tornado Taint Checker Base Class
 */
class TornadoTaintChecker extends PythonTaintAbstractChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_python_tornado_input')
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
    // 注册 sourceScope 中的 source
    this.addSourceTagForSourceScope('PYTHON_INPUT', this.sourceScope.value)
    // 注册规则配置中的 source
    this.addSourceTagForcheckerRuleConfigContent('PYTHON_INPUT', this.checkerRuleConfigContent)
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
      const { callee } = node
      const isInitCall =
        callee?.type === 'MemberAccess' &&
        (callee?.property?.name === '__init__' || callee?.property?.name === '_CTOR_')
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
   * @param node
   * @param fclos
   * @param argvalues
   */

  /**
   * Handle API calls like self.get_argument()
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    super.triggerAtFunctionCallAfter(analyzer, scope, node, state, info)
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    const { fclos, ret } = info
    if (!fclos || !ret) return

    const funcName = node.callee?.property?.name || node.callee?.name
    if (!funcName) return

    // Mark Tornado source APIs and passthrough functions
    if (tornadoSourceAPIs.has(funcName)) {
      markTaintSource(ret, { path: node || ret.ast || {}, kind: 'PYTHON_INPUT' })
    } else if (passthroughFuncs.has(funcName)) {
      // Check for request attribute access like self.request.body.decode()
      const isReqAttr = node.callee?.type === 'MemberAccess' && isRequestAttributeExpression(node.callee.object)
      const receiver = fclos?.object || fclos?._this
      const isTaintedReceiver =
        receiver && (receiver.taint || receiver.hasTagRec || receiver._tags?.has('PYTHON_INPUT'))

      if (isReqAttr || isTaintedReceiver) {
        markTaintSource(ret, { path: node || ret.ast || {}, kind: 'PYTHON_INPUT' })
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
    if (isRequestAttributeAccess(node)) {
      markTaintSource(info.res, { path: node || info.res.ast || {}, kind: 'PYTHON_INPUT' })
    }
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
        const handlerName = 'Handler' // Placeholder name
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
    if (!handlerSymVal || handlerSymVal.vtype !== 'class') return

    const httpMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options'])
    const handlers = Object.entries(handlerSymVal.value).filter(
      ([key, value]: [string, any]) => httpMethods.has(key) && value.vtype === 'fclos'
    )

    for (const [method, fclos] of handlers as any[]) {
      if (fclos.fdef?.loc?.sourcefile?.endsWith('__init__.py')) continue

      let finalEp = fclos
      if (scope && state && fclos.fdef) {
        try {
          const processed = analyzer.processInstruction(scope, fclos.fdef, state)
          if (processed?.vtype === 'fclos') {
            processed.parent = handlerSymVal
            processed.params = fclos.params || extractParamsFromAst(fclos.fdef)
            finalEp = processed
          }
        } catch (e) {
          /* fallback */
        }
      }

      if (!finalEp.value) finalEp.value = {}
      finalEp.parent = handlerSymVal
      if (handlerSymVal.vtype === 'class' && !handlerSymVal.field) handlerSymVal.field = {}

      try {
        if (!finalEp.ast) finalEp.ast = finalEp.fdef
        if (!finalEp.functionName) {
          const rawName = finalEp.fdef?.name?.name || finalEp.fdef?.id?.name || finalEp.name || ''
          const handlerName = this.extractHandlerNameFromSymbolValue(handlerSymVal)
          finalEp.functionName = handlerName ? `${handlerName}.${rawName}` : rawName
        }
        if (!finalEp.filePath && finalEp.fdef?.loc?.sourcefile) {
          finalEp.filePath = Config.maindir
            ? FileUtil.extractRelativePath(finalEp.fdef.loc.sourcefile, Config.maindir)
            : finalEp.fdef.loc.sourcefile
        }

        const entryPoint = completeEntryPoint(finalEp)
        entryPoint.urlPattern = urlPattern
        entryPoint.handlerName = this.extractHandlerNameFromSymbolValue(handlerSymVal)
        analyzer.entryPoints.push(entryPoint)

        // Register path parameters as sources
        const params = extractTornadoParams(urlPattern)
        const paramMetas = finalEp.params || extractParamsFromAst(finalEp.fdef) || []
        paramMetas.forEach((meta: any, idx: number) => {
          if (meta.name === 'self') return
          const isSource =
            params.named.includes(meta.name) || (params.named.length === 0 && idx <= params.positionalCount)
          if (isSource) {
            const sourceEntry = {
              path: meta.name,
              kind: 'PYTHON_INPUT',
              scopeFile: 'all',
              scopeFunc: 'all',
              locStart: 'all',
              locEnd: 'all',
            }
            this.sourceScope.value.push(sourceEntry)
            this.addSourceTagForSourceScope('PYTHON_INPUT', [sourceEntry])
          }
        })
      } catch (e: any) {
        logger.warn(`Error in entrypoint collection: ${e?.message || e}`)
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
