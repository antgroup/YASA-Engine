const AstUtil = require('../../../../../util/ast-util')
const completeEntryPoint = require('../../../../../checker/taint/common-kit/entry-points-util')

export {}

const RouteRegistryProperty = ['POST', 'GET', 'DELETE', 'PUT']

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
  // TODO：后续考虑用rtype判断
  if (
    RouteRegistryObject.some((ginPrefix) => objectQid?.startsWith(ginPrefix)) &&
    RouteRegistryProperty.includes(propertyName)
  ) {
    for (const arg of argValues) {
      if (arg?.vtype === 'fclos' && arg.ast?.node?.loc) {
        // 避免对同一条路由注册语句重复添加
        const hash = JSON.stringify(arg.ast.node.loc)
        if (!processedRouteRegistry.has(hash)) {
          processedRouteRegistry.add(hash)
          routeFCloses.push(arg)
        }
      }
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
