const PythonTaintAbstractChecker = require('./python-taint-abstract-checker')
const Config = require('../../../config')
const completeEntryPoint = require('../common-kit/entry-points-util')
const { markTaintSource } = require('../common-kit/source-util')
const {
  isTornadoCall,
  tornadoSourceAPIs,
  passthroughFuncs,
  isRequestAttributeExpression,
  isRequestAttributeAccess,
  extractTornadoParams,
} = require('./tornado-util')

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
    if (isTornadoCall(node, 'Application')) routes = argvalues[0]
    else if (isTornadoCall(node, 'add_handlers')) routes = argvalues[1]

    if (routes) this.processRoutes(analyzer, scope, state, routes)
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

    // 1. Handle Union - Try to see if the union itself is a route (flattened tuple)
    if (val.vtype === 'union' && Array.isArray(val.value)) {
      const pathVal = val.value.find((v: any) => typeof (v.value || v.ast?.value) === 'string')
      const hVal = val.value.find((v: any) => v.vtype === 'class' || v.ast?.type === 'ClassDefinition')

      if (pathVal && hVal) {
        const path = pathVal.value || pathVal.ast?.value
        this.finishRoute(analyzer, scope, state, hVal, path)
        return
      }

      val.value.forEach((v: any) => this.processRoutes(analyzer, scope, state, v))
      return
    }

    // 2. Try to extract from Object/Tuple/URLSpec
    let path: string | undefined
    let h: any

    if ((val.vtype === 'object' || val.vtype === 'tuple') && val.value) {
      const pVal = val.value['0'] || val.value.regex || val.value._pattern
      h = val.value['1'] || val.value.handler_class || val.value._handler_class
      path = pVal?.value || pVal?.ast?.value
    } else if (Array.isArray(val.value)) {
      const pVal = val.value[0]
      h = val.value[1]
      path = pVal?.value || pVal?.ast?.value
    }

    if (typeof path === 'string' && h) {
      this.finishRoute(analyzer, scope, state, h, path)
      return
    }

    // 3. Handle Symbol or Call (like tornado.web.url)
    if (val.ast?.type === 'CallExpression') {
      const { callee } = val.ast
      const name = callee.property?.name || callee.name
      if (name === 'url' || name === 'URLSpec') {
        const args = val.ast.arguments
        if (args && args.length >= 2) {
          const p = args[0].value
          const hNode = args[1]
          if (typeof p === 'string') {
            const resolvedH = analyzer.processInstruction(scope, hNode, state)
            this.finishRoute(analyzer, scope, state, resolvedH || { ast: hNode }, p)
            return
          }
        }
      }
    }

    // 4. Fallback: Collections
    if (['list', 'tuple', 'object'].includes(val.vtype) || (val.vtype === 'object' && val.value)) {
      const items = Array.isArray(val.value) ? val.value : Object.values(val.value || {})
      const isLikelyCollection =
        Array.isArray(val.value) ||
        (val.vtype === 'object' && Object.keys(val.value || {}).some((k) => /^\d+$/.test(k)))

      if (isLikelyCollection && items.length > 0) {
        items.forEach((item: any) => this.processRoutes(analyzer, scope, state, item))
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

    if (h?.vtype === 'class') {
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
        ep.handlerName = cls.ast?.id?.name || cls._sid || 'Unknown'
        analyzer.entryPoints.push(ep)

        const info = extractTornadoParams(path)
        let paramIdx = 0
        const actualParams = (fclos.params || fclos.fdef?.parameters || fclos.ast?.parameters || []) as any[]
        actualParams.forEach((p: any) => {
          const pName = p.name || p.id?.name
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
        const name = m.name?.name || m.id?.name
        if (name) {
          value[name] = {
            vtype: 'fclos',
            fdef: m,
            ast: m,
            params: (m.parameters?.parameters || m.parameters || []).map((p: any) => ({ name: p.id?.name || p.name })),
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
    if (
      tornadoSourceAPIs.has(name) ||
      (passthroughFuncs.has(name) && isRequestAttributeExpression(node.callee?.object))
    ) {
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
