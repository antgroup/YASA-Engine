import { getLegacyArgValues } from '../../../engine/analyzer/common/call-args'

const { PythonTaintAbstractChecker } = require('./python-taint-abstract-checker')
const Config = require('../../../config')
const completeEntryPoint = require('../common-kit/entry-points-util')
const { markTaintSource } = require('../common-kit/source-util')
const { isTornadoCall, tornadoSourceAPIs, isRequestAttributeAccess } = require('./tornado-util')
const { extractRelativePath } = require('../../../util/file-util')

// Metadata storage
const tornadoRoutesMap = new WeakMap<any, any>()
const tornadoRouteMap = new WeakMap<any, any>()

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
    const { fclos, callInfo } = info
    const argvalues = getLegacyArgValues(callInfo)
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
   */
  private registerRoutesFromValue(analyzer: any, scope: any, state: any, val: any) {
    if (!val) return
    // 1. Handle recording optimization (tornadoRoute)
    if (tornadoRouteMap.has(val)) {
      const handler = tornadoRouteMap.get(val)
      if (handler) {
        this.finishRoute(analyzer, scope, state, handler)
        return
      }
    }
    // 2. Handle Union (often represents a flattened tuple)
    if (val.vtype === 'union' && Array.isArray(val.value)) {
      const handler = val.value.find((v: any) => v.vtype === 'class' || v.vtype === 'symbol' || v.vtype === 'fclos')
      if (handler) {
        this.finishRoute(analyzer, scope, state, handler)
      }
      val.value.forEach((v: any) => this.registerRoutesFromValue(analyzer, scope, state, v))
      return
    }
    // 3. Handle raw tuple (path, handler)
    if (val.value && typeof val.value === 'object') {
      const handler = val.value['1']
      if (handler) {
        const pathArg = val.value['0']
        const path = pathArg?.value || pathArg?.ast?.node?.value
        if (typeof path === 'string') {
          this.finishRoute(analyzer, scope, state, handler)
          return
        }
      }
    }
    // 4. Handle direct class/symbol (likely a result of recursion or flattened tuple)
    if (val.vtype === 'class' || val.vtype === 'symbol' || val.vtype === 'fclos') {
      this.finishRoute(analyzer, scope, state, val)
      return
    }
    // 5. Handle Collections (List/Object with numeric keys)
    const isObject = (val.vtype === 'object' || !val.vtype) && val.value
    if (isObject) {
      const items = Array.isArray(val.value) ? val.value : Object.values(val.value)
      const isLikelyCollection = Array.isArray(val.value) || Object.keys(val.value).some((k) => /^\d+$/.test(k))
      if (isLikelyCollection) {
        items.forEach((item: any) => this.registerRoutesFromValue(analyzer, scope, state, item))
      }
    }
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param state
   * @param h
   */
  private finishRoute(analyzer: any, scope: any, state: any, h: any) {
    if (!h) return
    if (h.vtype === 'union' && Array.isArray(h.value)) h = h.value[0]
    // 1. Check for recorded nested routes (Application/Router instances)
    const innerRoutes = tornadoRoutesMap.get(h) || (h.value && tornadoRoutesMap.get(h.value))
    if (innerRoutes) {
      this.registerRoutesFromValue(analyzer, scope, state, innerRoutes)
      return
    }
    // 2. Handle Class Definition (Handler classes)
    let cls = h
    if (cls.vtype !== 'class' && cls.ast?.node?.type === 'ClassDefinition') {
      try {
        cls = analyzer.processInstruction(scope, cls.ast.node, state) || this.buildClassSymbol(cls.ast.node)
      } catch (e) {
        cls = this.buildClassSymbol(cls.ast.node)
      }
    } else if (cls.vtype === 'symbol' && cls.ast?.cdef) {
      // If it's an instance symbol, get its class definition
      cls = cls.ast.cdef
    }
    if (cls && (cls.vtype === 'class' || cls.vtype === 'symbol')) {
      this.registerEntryPoints(analyzer, cls)
    }
  }

  /**
   *
   * @param analyzer
   * @param cls
   */
  private registerEntryPoints(analyzer: any, cls: any) {
    const methods = ['get', 'post', 'put', 'delete', 'patch']
    // 在 cls.value 或 cls.value.value 中查找方法（Python 类结构）
    const classValue = cls.value?.value || cls.value || {}
    Object.entries(classValue).forEach(([name, fclos]: [string, any]) => {
      if (methods.includes(name)) {
        const ep = completeEntryPoint(fclos)
        if (ep) {
          ep.funcReceiverType = cls.ast?.node?.id?.name || cls.sid || 'Unknown'
          const isDuplicate = analyzer.entryPoints.some(
            (existing: any) =>
              existing.functionName === ep.functionName &&
              existing.filePath === ep.filePath &&
              existing.funcReceiverType === ep.funcReceiverType
          )
          if (!isDuplicate) {
            analyzer.entryPoints.push(ep)
          }
          const actualParams = (fclos.ast?.fdef?.parameters || fclos.ast?.node?.parameters || []) as any[]
          actualParams.forEach((p: any) => {
            const pName = p.id?.name || p.name
            if (pName === 'self') return
            // Add source scope for all non-self parameters
            this.sourceScope.value.push({
              path: pName,
              kind: 'PYTHON_INPUT',
              scopeFile: extractRelativePath(fclos?.ast?.node?.loc?.sourcefile || ep.filePath, Config.maindir),
              scopeFunc: ep.functionName,
              locStart: p.loc?.start?.line,
              locEnd: p.loc?.end?.line,
            })
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
    const { fclos, ret, callInfo } = info
    const argvalues = getLegacyArgValues(callInfo)
    if (Config.entryPointMode === 'ONLY_CUSTOM' || !fclos || !ret) return
    const name = node.callee?.property?.name || node.callee?.name
    // 1. Record route info for Rule, URLSpec, url (Recording phase)
    const isRuleCall = isTornadoCall(node, 'Rule') || isTornadoCall(node, 'URLSpec') || name === 'url'
    if (isRuleCall && argvalues && argvalues.length >= 2) {
      const handler = argvalues[1]
      tornadoRouteMap.set(ret, handler)
    }
    // 2. Record internal routes for Application/RuleRouter instances
    const isInit = ['__init__', '_CTOR_'].includes(name)
    if (isInit && argvalues && argvalues.length >= 2) {
      const self = argvalues[0]
      const routes = argvalues[1]
      // Heuristic: if routes looks like a list/tuple of routes
      const isRouteList =
        routes && (routes.vtype === 'object' || routes.vtype === 'symbol' || Array.isArray(routes.value))
      if (isRouteList && self) {
        tornadoRoutesMap.set(self, routes)
      }
    }
    const isApp = isTornadoCall(node, 'Application')
    const isRouter = isTornadoCall(node, 'RuleRouter')
    if (!isInit && (isApp || isRouter)) {
      tornadoRoutesMap.set(ret, argvalues[0])
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

module.exports = TornadoTaintChecker
