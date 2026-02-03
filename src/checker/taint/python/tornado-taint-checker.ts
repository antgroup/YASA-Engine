const PythonTaintAbstractChecker = require('./python-taint-abstract-checker')
const Config = require('../../../config')
const completeEntryPoint = require('../common-kit/entry-points-util')
const { markTaintSource } = require('../common-kit/source-util')
const { isTornadoCall, tornadoSourceAPIs, isRequestAttributeAccess, extractTornadoParams } = require('./tornado-util')
const { extractRelativePath } = require('../../../util/file-util')

/**
 * Tornado Taint Checker - Simplified
 */
class TornadoTaintChecker extends PythonTaintAbstractChecker {
  private instanceRoutes = new Map<string, any>()

  private routeInfoMap = new Map<any, { path: string; handler: any }>()

  /**
   *
   * @param node
   */
  private getNodeKey(node: any): string | null {
    if (!node || !node.loc) return null
    return `${node.loc.sourcefile}:${node.loc.start.line}:${node.loc.start.column}`
  }

  /**
   *
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_python_tornado_input')
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    this.addSourceTagForSourceScope('PYTHON_INPUT', this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent('PYTHON_INPUT', this.checkerRuleConfigContent)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    super.triggerAtFunctionCallBefore(analyzer, scope, node, state, info)
    const { fclos, argvalues } = info
    if (Config.entryPointMode === 'ONLY_CUSTOM' || !argvalues) return
    const isApp = isTornadoCall(node, 'Application')
    const isRouter = isTornadoCall(node, 'RuleRouter')
    const isAdd = isTornadoCall(node, 'add_handlers')
    const funcName = node.callee?.property?.name || node.callee?.name
    if (isApp || isRouter || isAdd) {
      let routes: any = null
      if (isApp || isRouter) {
        const isInit = ['__init__', '_CTOR_'].includes(funcName)
        const routesIdx = isInit ? 1 : 0
        routes = argvalues[routesIdx]
      } else if (isAdd) {
        routes = argvalues[1]
      }
      if (routes) {
        this.registerRoutesFromValue(analyzer, scope, state, routes)
      }
    }
  }

  /**
   * Register routes from a collection value (List/Dict/Union/Single Symbol)
   * @param analyzer
   * @param scope
   * @param state
   * @param val
   * @param prefix
   */
  private registerRoutesFromValue(analyzer: any, scope: any, state: any, val: any, prefix = '') {
    if (!val) return
    const storedRoute = this.routeInfoMap.get(val)
    if (storedRoute) {
      this.finishRoute(analyzer, scope, state, storedRoute.handler, prefix + storedRoute.path)
      return
    }
    // 0. Handle Symbols mapping to values
    if (val.vtype === 'symbol' && val.value && typeof val.value === 'object') {
      // If it's a symbol, its 'value' is where the actual object (Tuple/List) resides
      this.registerRoutesFromValue(analyzer, scope, state, val.value, prefix)
      return
    }

    const ast = val.ast || val.node
    if (ast?.type === 'CallExpression') {
      const name = ast.callee?.property?.name || ast.callee?.name
      if (isTornadoCall(ast, 'Rule') || isTornadoCall(ast, 'URLSpec') || name === 'url') {
        const args = val.ast.arguments
        if (args && args.length >= 2) {
          const pVal = analyzer.processInstruction(scope, args[0], state)
          const path = this.getPathFromValue(analyzer, scope, state, pVal)
          const hVal = analyzer.processInstruction(scope, args[1], state)
          if (path !== null && hVal) {
            this.finishRoute(analyzer, scope, state, hVal, prefix + path)
            return
          }
        }
      }
    }

    // 2. Handle Union
    if (val.vtype === 'union' && Array.isArray(val.value)) {
      // Check if the union elements themselves form a route (path, handler)
      // Sometimes tuples are resolved as unions of their elements in some analyzer versions
      const pathArg = val.value['0'] || val.value[0]
      const handler = val.value['1'] || val.value[1]
      let handledAsRoute = false
      if (pathArg && handler) {
        const path = this.getPathFromValue(analyzer, scope, state, pathArg)
        if (path !== null) {
          this.finishRoute(analyzer, scope, state, handler, prefix + path)
          handledAsRoute = true
        }
      }
      if (!handledAsRoute) {
        val.value.forEach((v: any) => this.registerRoutesFromValue(analyzer, scope, state, v, prefix))
      }
      return
    }
    // 3. Handle raw tuple (path, handler) or any object with path/handler at index 0/1
    if (val.value && typeof val.value === 'object') {
      const pathArg = val.value['0']
      const handler = val.value['1']
      if (pathArg && handler) {
        const path = this.getPathFromValue(analyzer, scope, state, pathArg)
        if (path !== null) {
          this.finishRoute(analyzer, scope, state, handler, prefix + path)
          return
        }
      }
    }
    // 4. Handle Collections (List/Object with numeric keys)
    const isCollection = val.vtype === 'list' || (val.vtype === 'object' && val.value)
    if (isCollection) {
      const items = Array.isArray(val.value) ? val.value : typeof val.value === 'object' ? Object.values(val.value) : []
      if (items.length > 0) {
        items.forEach((item: any) => this.registerRoutesFromValue(analyzer, scope, state, item, prefix))
      }
    }
  }

  /**
   * Extract path string from a symbol value, handling PathMatches
   * @param analyzer
   * @param scope
   * @param state
   * @param val
   */
  private getPathFromValue(analyzer: any, scope: any, state: any, val: any): string | null {
    if (!val) return null
    if (typeof val.value === 'string') return val.value
    if (typeof val.ast?.value === 'string') return val.ast.value
    // Check for PathMatches(pattern)
    const ast = val.ast || val.node
    if (ast?.type === 'CallExpression' && isTornadoCall(ast, 'PathMatches')) {
      const arg = ast.arguments?.[0]
      if (arg) {
        const argVal = analyzer.processInstruction(scope, arg, state)
        return typeof argVal?.value === 'string' ? argVal.value : arg.value || null
      }
    }
    return null
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param state
   * @param h
   * @param path
   */
  private finishRoute(analyzer: any, scope: any, state: any, h: any, path: string) {
    if (!h) return
    if (h.vtype === 'union' && Array.isArray(h.value)) h = h.value[0]
    let innerRoutes: any = null
    const hAst = h.ast || h.node
    if (hAst) {
      const key = this.getNodeKey(hAst)
      if (key) innerRoutes = this.instanceRoutes.get(key)
    }
    if (!innerRoutes) {
      innerRoutes = this.instanceRoutes.get(h)
    }
    if (innerRoutes) {
      this.registerRoutesFromValue(analyzer, scope, state, innerRoutes, path)
      return
    }
    // Handle Class Definition (Handler classes)
    let cls = h
    if (cls.vtype !== 'class' && cls.ast?.type === 'ClassDefinition') {
      try {
        cls = analyzer.processInstruction(scope, cls.ast, state) || this.buildClassSymbol(cls.ast)
      } catch (e) {
        cls = this.buildClassSymbol(cls.ast)
      }
    } else if (cls.vtype === 'symbol' && cls.cdef) {
      // If it's an instance symbol, get its class definition
      cls = cls.cdef
    }
    if (path && cls && (cls.vtype === 'class' || cls.vtype === 'symbol')) {
      this.registerEntryPoints(analyzer, cls, path)
    }
  }

  /**
   *
   * @param analyzer
   * @param cls
   * @param path
   */
  private registerEntryPoints(analyzer: any, cls: any, path: string) {
    const methods = ['get', 'post', 'put', 'delete', 'patch']
    // Look for methods in cls.value, cls.field, or cls.value.field (Python specificity)
    const classValue = cls.value?.field || cls.field || cls.value || {}
    Object.entries(classValue).forEach(([name, fclos]: [string, any]) => {
      if (methods.includes(name)) {
        const ep = completeEntryPoint(fclos)
        if (ep) {
          ep.urlPattern = path
          ep.handlerName = cls.ast?.id?.name || cls.sid || 'Unknown'
          const isDuplicate = analyzer.entryPoints.some(
            (existing: any) =>
              existing.urlPattern === ep.urlPattern &&
              existing.functionName === ep.functionName &&
              existing.filePath === ep.filePath
          )
          if (!isDuplicate) {
            analyzer.entryPoints.push(ep)
          }
          const scopeFile = extractRelativePath(
            fclos.fdef?.loc?.sourcefile || fclos.ast?.loc?.sourcefile,
            Config.maindir
          )
          const scopeFunc = fclos.fdef?.id?.name || fclos.ast?.id?.name
          const info = extractTornadoParams(path)
          let paramIdx = 0
          const actualParams = (fclos.fdef?.parameters || fclos.ast?.parameters || []) as any[]
          actualParams.forEach((p: any) => {
            const pName = p.id?.name || p.name
            if (pName === 'self') return
            paramIdx++
            if (info.named.includes(pName) || (info.named.length === 0 && paramIdx <= info.positionalCount)) {
              this.sourceScope.value.push({
                path: pName,
                kind: 'PYTHON_INPUT',
                scopeFile: scopeFile || 'all',
                scopeFunc: scopeFunc || 'all',
                locStart: p.loc?.start?.line || 'all',
                locEnd: p.loc?.end?.line || 'all',
              })
            }
          })
        }
      }
    })
  }

  /**
   *
   * @param node
   */
  private buildClassSymbol(node: any) {
    const value: any = {}
    node.body?.forEach((m: any) => {
      if (m.type === 'FunctionDefinition') {
        const name = m.id?.name || m.name?.name
        if (name) {
          value[name] = {
            vtype: 'fclos',
            fdef: m,
            ast: m,
          }
        }
      }
    })
    return { vtype: 'class', value, ast: node }
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    super.triggerAtFunctionCallAfter(analyzer, scope, node, state, info)
    const { fclos, ret, argvalues } = info
    const name = node.callee?.property?.name || node.callee?.name
    const isInit = ['__init__', '_CTOR_'].includes(name)
    const isApp = isTornadoCall(node, 'Application')
    const isRouter = isTornadoCall(node, 'RuleRouter')

    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    if (!isApp && !isRouter && !isInit) {
      if (!fclos || !ret) return
    }
    // 1. Mark Taint Source for APIs
    if (tornadoSourceAPIs.has(name)) {
      markTaintSource(ret, { path: node, kind: 'PYTHON_INPUT' })
    }
    // 2. Track routes for instances (nested routers/apps)
    if (isInit && argvalues && argvalues.length >= 2) {
      const self = argvalues[0]
      const routes = argvalues[1]
      const isRouteList =
        routes &&
        (routes.vtype === 'object' ||
          routes.vtype === 'symbol' ||
          routes.vtype === 'list' ||
          Array.isArray(routes.value))
      const selfAst = self?.ast || self?.node
      if (isRouteList && self) {
        const instKey = this.getNodeKey(selfAst)
        if (instKey) {
          this.instanceRoutes.set(instKey, routes)
        }
        this.instanceRoutes.set(self, routes)
        if (self.cdef && self.cdef.ast) {
          const classKey = this.getNodeKey(self.cdef.ast)
          if (classKey) {
            this.instanceRoutes.set(classKey, routes)
          }
        }
      }
    }
    if (!isInit && (isApp || isRouter)) {
      const key = this.getNodeKey(node)
      if (key) {
        this.instanceRoutes.set(key, argvalues[0])
      }
    }

    // 3. Record route info for Rule/URLSpec
    if (isTornadoCall(node, 'Rule') || isTornadoCall(node, 'URLSpec')) {
      const args = node.arguments
      if (args && args.length >= 2) {
        const pVal = analyzer.processInstruction(scope, args[0], state)
        const path = this.getPathFromValue(analyzer, scope, state, pVal)
        const hVal = analyzer.processInstruction(scope, args[1], state)
        if (path !== null && hVal && ret) {
          this.routeInfoMap.set(ret, { path, handler: hVal })
        }
      }
    }
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtMemberAccess(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (Config.entryPointMode !== 'ONLY_CUSTOM' && isRequestAttributeAccess(node)) {
      markTaintSource(info.res, { path: node, kind: 'PYTHON_INPUT' })
    }
  }
}

export = TornadoTaintChecker
