const AstUtil = require('../../../../../util/ast-util')
const completeEntryPoint = require('../../../../../checker/taint/common-kit/entry-points-util')

export {}

const RouteRegistryProperty = ['POST', 'GET', 'DELETE', 'PUT', 'Handle']

const RouteRegistryObject = [
  '<global>.packageManager.github.com/gin-gonic/gin.Default()',
  '<global>.packageManager.github.com/gin-gonic/gin.New()',
]

const processedRouteRegistry = new Set()

const defaultGinTaintSource = ['Params', 'Accepted', 'Request', 'BindQuery', 'BindQuery']

const defaultGinFuncCallArgTaintSource = [
  'BindJSON',
  'BindYAML',
  'BindXML',
  'BindUri',
  'MustBindWith',
  'Bind',
  'BindHeader',
  'BindWith',
  'BindQuery',
  'ShouldBind',
  'ShouldBindBodyWith',
  'ShouldBindJSON',
  'ShouldBindUri',
  'ShouldBindHeader',
  'ShouldBindWith',
  'ShouldBindQuery',
  'ShouldBindXML',
  'ShouldBindYAML',
]

const defaultFuncCallReturnValueTaintSource = [
  'FullPath',
  'GetHeader',
  'QueryArray',
  'Query',
  'PostFormArray',
  'PostForm',
  'Param',
  'GetStringSlice',
  'GetString',
  'GetRawData',
  'ClientIP',
  'ContentType',
  'Cookie',
  'GetQueryArray',
  'GetQuery',
  'GetPostFormArray',
  'GetPostForm',
  'DefaultPostForm',
  'DefaultQuery',
  'GetPostFormMap',
  'GetQueryMap',
  'GetStringMap',
  'GetStringMapString',
  'GetStringMapStringSlice',
  'PostFormMap',
  'QueryMap',
]
const GinType = '*gin.Context'

/**
 * get default gin entryPoints and source
 * @param packageManager
 */
function getGinEntryPointAndSource(packageManager: any) {
  const TaintSource: any[] = []
  const FuncCallArgTaintSource: any[] = []
  const FuncCallReturnValueTaintSource: any[] = []

  // 加载默认source
  for (const taintSource of defaultGinTaintSource) {
    TaintSource.push({
      className: GinType,
      introPoint: 4,
      kind: 'GO_INPUT',
      path: taintSource,
      scopeFile: 'all',
      scopeFunc: 'all',
    })
  }
  for (const funcCallArg of defaultGinFuncCallArgTaintSource) {
    FuncCallArgTaintSource.push({
      args: [0],
      calleeType: GinType,
      introPoint: 4,
      kind: 'GO_INPUT',
      fsig: funcCallArg,
      scopeFile: 'all',
      scopeFunc: 'all',
    })
  }
  for (const funcCallRetVal of defaultFuncCallReturnValueTaintSource) {
    FuncCallReturnValueTaintSource.push({
      values: [0],
      calleeType: GinType,
      introPoint: 4,
      kind: 'GO_INPUT',
      fsig: funcCallRetVal,
      scopeFile: 'all',
      scopeFunc: 'all',
    })
  }
  return {
    TaintSource,
    FuncCallArgTaintSource,
    FuncCallReturnValueTaintSource,
  }
}

/** 通过 rtype 判断 callee 是否为 Gin 路由注册器（Engine 或 RouterGroup） */
function isGinRouteRegistrar(calleeObject: { rtype?: unknown }): boolean {
  const rtype = calleeObject.rtype
  if (!rtype) return false
  // rtype 可能是字符串或对象（可能含循环引用），安全提取类型名
  let rtypeStr: string
  if (typeof rtype === 'string') {
    rtypeStr = rtype
  } else if (typeof rtype === 'object' && rtype !== null && 'name' in rtype) {
    rtypeStr = String((rtype as { name: unknown }).name)
  } else {
    try {
      rtypeStr = JSON.stringify(rtype)
    } catch {
      return false
    }
  }
  return rtypeStr.includes('gin.RouterGroup') || rtypeStr.includes('gin.Engine')
}

/** 沿 scope 链查找标识符对应的值 */
function lookupInScopeChain(name: string, scope: { _field?: Record<string, unknown>; parent?: any }): unknown {
  let current: { _field?: Record<string, unknown>; parent?: any } | null = scope
  while (current) {
    if (current._field && name in current._field) {
      return current._field[name]
    }
    current = current.parent ?? null
  }
  return null
}

/** 从 scope 链中解析 AST 表达式（Identifier / MemberAccess）对应的运行时值 */
function resolveAstExpr(astNode: { type?: string; name?: string; object?: any; property?: { name?: string } }, scope: any): any {
  if (!astNode || !scope) return null
  if (astNode.type === 'Identifier') {
    return lookupInScopeChain(astNode.name ?? '', scope)
  }
  if (astNode.type === 'MemberAccess' && astNode.object && astNode.property?.name) {
    const obj = resolveAstExpr(astNode.object, scope)
    if (obj && obj._field) {
      return obj._field[astNode.property.name] ?? null
    }
  }
  return null
}

/**
 * 自采集路由，将注册的路由函数添加到entryPoints
 * @param callExpNode
 * @param calleeObject
 * @param argValues
 * @param scope
 * @returns {null}
 */
function collectRouteRegistry(callExpNode: any, calleeObject: any, argValues: any[], scope: any) {
  const routeFCloses: any[] = []
  const propertyName = callExpNode.callee.property?.name
  const objectQid = calleeObject.qid
  // qid 前缀匹配（原有逻辑）或 rtype 匹配（支持 RouterGroup / Engine）
  const isQidMatch = RouteRegistryObject.some((ginPrefix) => objectQid?.startsWith(ginPrefix))
  const isRtypeMatch = isGinRouteRegistrar(calleeObject)
  if (
    (isQidMatch || isRtypeMatch) &&
    RouteRegistryProperty.includes(propertyName)
  ) {
    for (let i = 0; i < argValues.length; i++) {
      const arg = argValues[i]
      if (!arg || (arg.vtype !== 'fclos' && arg.vtype !== 'symbol')) continue
      if (!arg.ast?.node?.loc) continue

      // 用路由注册语句位置去重
      const hash = JSON.stringify(callExpNode.loc) + '#' + String(i)
      if (processedRouteRegistry.has(hash)) continue
      processedRouteRegistry.add(hash)

      // 检查 AST 中对应位置的参数是否为包装函数调用（如 WrapFD(handler)）
      // 如果是，尝试从 scope 中解析实际 handler
      const astArg = callExpNode.arguments?.[i]
      if (astArg?.type === 'CallExpression' && astArg.arguments?.length > 0) {
        // 包装函数模式：取第一个参数作为实际 handler
        const innerAstArg = astArg.arguments[0]
        const resolved = resolveAstExpr(innerAstArg, scope)
        if (resolved?.vtype === 'fclos' && resolved.ast?.node?.loc) {
          routeFCloses.push(resolved)
          continue
        }
      }
      routeFCloses.push(arg)
    }
    return routeFCloses
  }
}

/**
 *
 * @param packageManager
 */
function getGinDefaultEntrypoint(packageManager: any) {
  const ginDefaultEntrypointSymvals = AstUtil.satisfy(
    packageManager,
    (n: any) => n.vtype === 'fclos' && n.ast?.node?.parameters && AstUtil.prettyPrintAST(n.ast.node.parameters).includes(GinType),
    (node: any, prop: any) => prop === '_field',
    null,
    true
  )
  if (ginDefaultEntrypointSymvals) {
    return ginDefaultEntrypointSymvals.map((symbols: any) => completeEntryPoint(symbols))
  }
  return []
}

/**
 *
 */
function clearProcessedRouteRegistry() {
  processedRouteRegistry.clear()
}

module.exports = {
  getGinEntryPointAndSource,
  collectRouteRegistry,
  clearProcessedRouteRegistry,
  getGinDefaultEntrypoint,
}
