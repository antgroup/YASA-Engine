const astUtil = require('../../../../../util/ast-util')
const { completeEntryPoint } = require('../../../../../checker/taint/go/entry-points-util')

const RouteRegistryProperty = ['POST', 'GET', 'DELETE', 'PUT']

const RouteRegistryObject = ['github.com/gin-gonic/gin.Default()', 'github.com/gin-gonic/gin.New()']

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
function getGinEntryPointAndSource(packageManager) {
  const TaintSource = []
  const FuncCallArgTaintSource = []
  const FuncCallReturnValueTaintSource = []

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
function collectRouteRegistry(callExpNode, calleeObject, argValues, scope) {
  const routeFCloses = []
  const propertyName = callExpNode.callee.property?.name
  const objectQid = calleeObject._qid
  // TODO：后续考虑用rtype判断
  if (
    RouteRegistryObject.some((ginPrefix) => objectQid?.startsWith(ginPrefix)) &&
    RouteRegistryProperty.includes(propertyName)
  ) {
    for (const arg of argValues) {
      if (arg?.vtype === 'fclos' && arg.ast?.loc) {
        // 避免对同一条路由注册语句重复添加
        const hash = JSON.stringify(arg.ast.loc)
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
function getGinDefaultEntrypoint(packageManager) {
  const ginDefaultEntrypointSymvals = astUtil.satisfy(
    packageManager,
    (n) => n.vtype === 'fclos' && n.ast?.parameters && astUtil.prettyPrintAST(n.ast.parameters).includes(GinType),
    (node, prop) => prop === 'field',
    null,
    true
  )
  return ginDefaultEntrypointSymvals.map((symbols) => completeEntryPoint(symbols))
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
