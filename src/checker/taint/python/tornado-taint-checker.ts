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
    let routes = null
    const isApp = isTornadoCall(node, 'Application')
    const isAdd = isTornadoCall(node, 'add_handlers')
    const isRouter = isTornadoCall(node, 'RuleRouter')
    if (isApp || isRouter) {
      const isInit = ['__init__', '_CTOR_'].includes(node.callee?.property?.name || node.callee?.name)
      routes = (isApp || isRouter) && isInit ? argvalues[1] : argvalues[0]
      if (!routes && argvalues[0]) routes = argvalues[0]
    } else if (isAdd) {
      routes = argvalues[1]
    }
    if (routes) {
      this.processRoutes(analyzer, scope, state, routes)
    }
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param state
   * @param val
   */
  private processRoutes(analyzer: any, scope: any, state: any, val: any) {
    if (!val) return

    // 1. Handle Union - Process all elements in the union
    if (val.vtype === 'union' && Array.isArray(val.value)) {
      // Try to see if this union represents a single route (flattened tuple/list)
      const pathVal = val.value.find((v: any) => typeof (v.value || v.ast?.value) === 'string')
      const hVal = val.value.find(
        (v: any) => v.vtype === 'class' || v.ast?.type === 'ClassDefinition' || v.vtype === 'object'
      )
      if (pathVal && hVal) {
        const path = pathVal.value || pathVal.ast?.value
        this.finishRoute(analyzer, scope, state, hVal, path)
        return
      }
      // Otherwise recurse into each element
      val.value.forEach((v: any) => this.processRoutes(analyzer, scope, state, v))
      return
    }

    // 2. Try to extract from Object/URLSpec/List-like/Rule
    let path: string | undefined
    let h: any
    if ((val.vtype === 'object' || val.vtype === 'symbol') && val.value) {
      const isRule =
        isTornadoCall(val.ast, 'Rule') ||
        isTornadoCall(val.ast, 'URLSpec') ||
        val.sid?.includes('Rule') ||
        val.sid?.includes('URLSpec')

      if (isRule) {
        const pVal = val.value['0'] || val.value.regex || val.value.matcher
        h = val.value['1'] || val.value.handler_class || val.value.target || val.value.handler
        path = pVal?.value || pVal?.ast?.value
        // If matcher is PathMatches(r"...")
        if (!path && isTornadoCall(pVal?.ast, 'PathMatches')) {
          path = pVal.ast.arguments?.[0]?.value
        }
      }
    } else if (Array.isArray(val.value)) {
      path = val.value[0]?.value || val.value[0]?.ast?.value
      h = val.value[1]
    }
    if (h) {
      // If h is an instance (object), we might need to look for its handlers recursively
      if (h.vtype === 'object' && h.value) {
        const innerRoutes = h.value.handlers || h.value.rules
        if (innerRoutes) {
          this.processRoutes(analyzer, scope, state, innerRoutes)
        }
      }
      if (typeof path === 'string') {
        this.finishRoute(analyzer, scope, state, h, path)
        return
      }
    }

    // 3. Handle nested collections (like lists of routes)
    const items =
      val.vtype === 'object' && val.value ? (Array.isArray(val.value) ? val.value : Object.values(val.value)) : null
    if (items) {
      const isLikelyCollection =
        Array.isArray(val.value) ||
        (val.value && typeof val.value === 'object' && Object.keys(val.value).some((k) => /^\d+$/.test(k)))
      if (isLikelyCollection) {
        items.forEach((item: any) => this.processRoutes(analyzer, scope, state, item))
        return
      }
    }

    // 4. Handle Direct Call (like tornado.web.url, URLSpec, Rule)
    if (val.ast?.type === 'CallExpression') {
      const isUrl = isTornadoCall(val.ast, 'url')
      const isRule = isTornadoCall(val.ast, 'Rule') || isTornadoCall(val.ast, 'URLSpec')
      if (isUrl || isRule) {
        const args = val.ast.arguments
        if (args && args.length >= 2) {
          let p = args[0].value
          if (typeof p !== 'string' && args[0].type === 'CallExpression') {
            if (isTornadoCall(args[0], 'PathMatches')) {
              p = args[0].arguments?.[0]?.value
            }
          }
          if (typeof p === 'string') {
            const hNode = args[1]
            const resolvedH = analyzer.processInstruction(scope, hNode, state)
            this.finishRoute(analyzer, scope, state, resolvedH || { ast: hNode }, p)
          }
        }
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
    if (h.vtype !== 'class' && h.ast?.type === 'ClassDefinition') {
      try {
        h = analyzer.processInstruction(scope, h.ast, state) || this.buildClassSymbol(h.ast)
      } catch (e) {
        h = this.buildClassSymbol(h.ast)
      }
    }
    if (path && h) {
      this.registerEntryPoints(analyzer, h, path)
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
    const classValue = cls.value || {}

    Object.entries(classValue).forEach(([name, fclos]: [string, any]) => {
      if (methods.includes(name) && fclos.vtype === 'fclos') {
        const ep = completeEntryPoint(fclos)
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
    const { fclos, ret } = info
    if (Config.entryPointMode === 'ONLY_CUSTOM' || !fclos || !ret) return
    const name = node.callee?.property?.name || node.callee?.name
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
