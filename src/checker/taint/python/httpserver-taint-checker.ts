import { getLegacyArgValues } from '../../../engine/analyzer/common/call-args'

const { PythonTaintAbstractChecker } = require('./python-taint-abstract-checker')
const Config = require('../../../config')
const completeEntryPoint = require('../common-kit/entry-points-util')
const { markTaintSource } = require('../common-kit/source-util')
const { isHttpHandlerClass, HTTP_HANDLER_METHODS } = require('../../../engine/analyzer/python/httpserver/entrypoint-collector/httpserver-entrypoint')
const { extractRelativePath } = require('../../../util/file-util')

// 记录已注册的 HTTP handler 类，避免重复注册
const registeredHandlerClasses = new WeakSet()

/**
 * Python http.server 框架 taint checker
 * 动态检测 HTTP handler 类并注册入口点，标记请求体来源为污点
 */
class HttpServerTaintChecker extends PythonTaintAbstractChecker {
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_python_httpserver_input')
  }

  /**
   * 初始化：添加 checker 的 taint tag 到 sources 和 rule config
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    this.addSourceTagForcheckerRuleConfigContent('PYTHON_INPUT', this.checkerRuleConfigContent)
  }

  /**
   * 函数调用后触发：
   * 1. 检测返回值是否是 HTTP handler 类，若是则注册 do_* 方法为入口点
   * 2. 检测 rfile.read() 调用，标记返回值为污点来源
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    super.triggerAtFunctionCallAfter(analyzer, scope, node, state, info)

    const { fclos, ret, callInfo } = info
    const argvalues = getLegacyArgValues(callInfo)

    if (Config.entryPointMode === 'ONLY_CUSTOM') return

    // 检测 rfile.read() 调用 → 标记返回值为污点来源
    this.markRfileReadAsSource(node, ret)

    // 检测函数返回值是否是 HTTP handler 类
    if (ret && (ret.vtype === 'class' || ret.vtype === 'scope')) {
      this.tryRegisterHttpHandlerEntryPoints(analyzer, ret)
    }

    // 检测参数中是否有 HTTP handler 类（如 HTTPServer.__init__(self, addr, HandlerClass)）
    if (argvalues && Array.isArray(argvalues)) {
      for (const arg of argvalues) {
        if (arg && (arg.vtype === 'class' || arg.vtype === 'scope')) {
          this.tryRegisterHttpHandlerEntryPoints(analyzer, arg)
        }
      }
    }
  }

  /**
   * 属性访问触发：检测 self.rfile 等属性访问，标记为污点来源
   * 注意：只在 HTTP handler 方法上下文中触发
   */
  triggerAtMemberAccess(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (this.isHttpRequestBodyAccess(node)) {
      markTaintSource(info.res, { path: node, kind: 'PYTHON_INPUT' })
    }
  }

  /**
   * 检测 rfile.read() 调用并标记返回值为污点来源
   * 匹配模式：self.rfile.read(...) 或 rfile.read(...)
   */
  private markRfileReadAsSource(node: any, ret: any): void {
    if (!node || node.type !== 'CallExpression') return
    if (!ret) return
    const callee = node.callee
    if (callee?.type !== 'MemberAccess') return
    const methodName = callee.property?.name
    if (methodName !== 'read' && methodName !== 'readline' && methodName !== 'readlines') return
    // 检查 callee.object 是否是 rfile 属性访问
    const obj = callee.object
    if (!obj) return
    // 匹配 self.rfile 或直接 rfile
    const isRfile =
      (obj.type === 'MemberAccess' &&
        obj.object?.name === 'self' &&
        obj.property?.name === 'rfile') ||
      (obj.type === 'Identifier' && obj.name === 'rfile')
    if (isRfile) {
      markTaintSource(ret, { path: node, kind: 'PYTHON_INPUT' })
    }
  }

  /**
   * 检测属性访问是否是 HTTP 请求相关属性（如 self.headers、self.path 等）
   */
  private isHttpRequestBodyAccess(node: any): boolean {
    if (node?.type !== 'MemberAccess') return false
    const obj = node.object
    // 匹配 self.rfile / self.headers / self.path / self.command 等
    return (
      obj?.type === 'Identifier' &&
      obj?.name === 'self' &&
      ['rfile', 'headers', 'path', 'command', 'request_version', 'raw_requestline'].includes(
        node.property?.name
      )
    )
  }

  /**
   * 尝试将 HTTP handler 类的 do_* 方法注册为入口点
   * @param analyzer 分析器实例
   * @param cls 类符号值
   */
  private tryRegisterHttpHandlerEntryPoints(analyzer: any, cls: any): void {
    if (!isHttpHandlerClass(cls)) return
    if (registeredHandlerClasses.has(cls)) return
    registeredHandlerClasses.add(cls)

    // 从类的 value 字典中查找 HTTP handler 方法
    const classValue = cls.value?.value || cls.value || {}
    for (const methodName of HTTP_HANDLER_METHODS) {
      const fclos = classValue[methodName]
      if (!fclos) continue

      // 必须有 ast.node 才能被引擎执行，否则会导致 executeSingleCall 崩溃
      if (!fclos?.ast?.node) continue

      const ep = completeEntryPoint(fclos)
      if (!ep) continue

      ep.funcReceiverType = cls.ast?.node?.id?.name || cls.sid || 'Handler'

      // 避免重复注册
      const isDuplicate = analyzer.entryPoints.some(
        (existing: any) =>
          existing.functionName === ep.functionName &&
          existing.filePath === ep.filePath &&
          existing.funcReceiverType === ep.funcReceiverType
      )
      if (!isDuplicate) {
        analyzer.entryPoints.push(ep)
      }

      // 将 self 注册为污点来源
      const selfParam = (fclos.ast?.fdef?.parameters || fclos.ast?.node?.parameters || []).find(
        (p: any) => (p.id?.name || p.name) === 'self'
      )
      if (selfParam) {
        const sourceFile = extractRelativePath(
          fclos?.ast?.node?.loc?.sourcefile || ep.filePath,
          Config.maindir
        )
        this.sourceScope.value.push({
          path: 'self',
          kind: 'PYTHON_INPUT',
          scopeFile: sourceFile,
          scopeFunc: ep.functionName,
          locStart: selfParam.loc?.start?.line,
          locEnd: selfParam.loc?.end?.line,
        })
      }
    }
  }
}

module.exports = HttpServerTaintChecker
