const PythonTaintAbstractChecker = require('./python-taint-abstract-checker')
const Config = require('../../../config')
const completeEntryPoint = require('../common-kit/entry-points-util')
const { markTaintSource } = require('../common-kit/source-util')
const { isTornadoCall, tornadoSourceAPIs, isRequestAttributeAccess, extractTornadoParams } = require('./tornado-util')

/**
 * Tornado Taint Checker - Simplified
 */
class TornadoTaintChecker extends PythonTaintAbstractChecker {
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
    if (Config.entryPointMode === 'ONLY_CUSTOM' || !fclos || !argvalues) return
    const isApp = isTornadoCall(node, 'Application')
    const isRouter = isTornadoCall(node, 'RuleRouter')
    const isAdd = isTornadoCall(node, 'add_handlers')
    if (isApp || isRouter || isAdd) {
      let routes: any = null
      if (isApp || isRouter) {
        const isInit = ['__init__', '_CTOR_'].includes(node.callee?.property?.name || node.callee?.name)
        routes = (isInit && argvalues[1]) || argvalues[0]
      } else {
        routes = argvalues[1] // isAdd case
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
    // 1. Handle recording optimization (tornadoRoute)
    if (val.tornadoRoute) {
      const { path, handler } = val.tornadoRoute
      if (path && handler) {
        this.finishRoute(analyzer, scope, state, handler, prefix + path)
        return
      }
    }
    // 2. Handle Union
    if (val.vtype === 'union' && Array.isArray(val.value)) {
      // Small optimization: if this union contains exactly a string and something else, it might be a flattened tuple
      const pathVal = val.value.find(
        (v: any) => v.tornadoPath || typeof v.value === 'string' || typeof v.ast?.value === 'string'
      )
      const hVal = val.value.find((v: any) => v.vtype === 'class' || v.vtype === 'symbol' || v.vtype === 'object')
      if (pathVal && hVal) {
        const path = pathVal.tornadoPath || pathVal.value || pathVal.ast?.value
        if (typeof path === 'string') {
          this.finishRoute(analyzer, scope, state, hVal, prefix + path)
          return
        }
      }
      val.value.forEach((v: any) => this.registerRoutesFromValue(analyzer, scope, state, v, prefix))
      return
    }
    // 3. Handle Collections (List/Object with numeric keys)
    const isObject = val.vtype === 'object' && val.value
    if (isObject) {
      const isCollection = Array.isArray(val.value) || Object.keys(val.value).some((k) => /^\d+$/.test(k))
      if (isCollection) {
        const items = Array.isArray(val.value) ? val.value : Object.values(val.value)
        items.forEach((item: any) => this.registerRoutesFromValue(analyzer, scope, state, item, prefix))
        return
      }
    }
    // 4. Fallback for raw tuple (path, handler)
    const isTuple =
      (Array.isArray(val.value) && val.value.length >= 2) ||
      (val.vtype === 'object' && val.value && val.value['0'] && val.value['1'])
    if (isTuple) {
      const pathArg = val.value['0'] || (Array.isArray(val.value) ? val.value[0] : null)
      const handler = val.value['1'] || (Array.isArray(val.value) ? val.value[1] : null)
      const path = pathArg?.tornadoPath || pathArg?.value || pathArg?.ast?.value
      if (typeof path === 'string' && handler) {
        this.finishRoute(analyzer, scope, state, handler, prefix + path)
      }
    }
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
    // 1. Check for recorded nested routes (Application/Router instances)
    const innerRoutes = h.tornadoRoutes || h.value?.tornadoRoutes || h.field?.tornadoRoutes
    if (innerRoutes) {
      this.registerRoutesFromValue(analyzer, scope, state, innerRoutes, path)
      return
    }
    // 2. Handle Class Definition (Handler classes)
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
          analyzer.entryPoints.push(ep)
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
                scopeFile: 'all',
                scopeFunc: 'all',
                locStart: 'all',
                locEnd: 'all',
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
    if (Config.entryPointMode === 'ONLY_CUSTOM' || !fclos || !ret) return
    const name = node.callee?.property?.name || node.callee?.name
    // 1. Record route info for Rule, URLSpec, url (Recording phase)
    const isRuleCall = isTornadoCall(node, 'Rule') || isTornadoCall(node, 'URLSpec') || name === 'url'
    if (isRuleCall && argvalues && argvalues.length >= 2) {
      const pArg = argvalues[0]
      const path = pArg?.tornadoPath || pArg?.value
      const handler = argvalues[1]
      ret.tornadoRoute = { path, handler }
    }
    // 2. Record path for PathMatches
    if (isTornadoCall(node, 'PathMatches') && argvalues && argvalues.length >= 1) {
      const path = argvalues[0]?.value
      if (typeof path === 'string') {
        ret.tornadoPath = path
      }
    }
    // 3. Record internal routes for Application/RuleRouter instances
    const isInit = ['__init__', '_CTOR_'].includes(name)
    if (isInit && argvalues && argvalues.length >= 2) {
      const self = argvalues[0]
      const routes = argvalues[1]
      // Heuristic: if routes looks like a list/tuple of routes
      const isRouteList =
        routes && (routes.vtype === 'object' || routes.vtype === 'symbol' || Array.isArray(routes.value))
      if (isRouteList && self) {
        self.tornadoRoutes = routes
      }
    }
    const isApp = isTornadoCall(node, 'Application')
    const isRouter = isTornadoCall(node, 'RuleRouter')
    if (!isInit && (isApp || isRouter)) {
      // Direct class call returns instance
      ret.tornadoRoutes = argvalues[0]
    }
    if (tornadoSourceAPIs.has(name)) {
      markTaintSource(ret, { path: node, kind: 'PYTHON_INPUT' })
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
