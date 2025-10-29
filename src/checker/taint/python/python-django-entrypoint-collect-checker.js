//fclos
const { completeEntryPoint } = require('../go/entry-points-util')
const config = require('../../../config')
const commonUtil = require('../../../util/common-util')
const IntroduceTaint = require('../common-kit/source-util')
const Checker = require('../../common/checker')
const RouteRegistryProperty = ['path', 're_path','url']
const RouteRegistryObject = ['django.urls.path', 'django.urls.re_path', 'django.conf.urls.url']
const processedRouteRegistry = new Set()
/**
 * 从AST节点获取源文件路径
 * @param {Object} node - AST节点
 * @returns {string|null} 源文件路径
 */
function getSourceFile(node) {
  if (!node) return null
  // 尝试从node本身获取
  if (node.sourcefile) return node.sourcefile
  // 尝试从loc获取
  if (node.loc?.sourcefile) return node.loc.sourcefile
  // 向上遍历父节点
  let parent = node.parent
  while (parent) {
    if (parent.sourcefile) return parent.sourcefile
    if (parent.loc?.sourcefile) return parent.loc.sourcefile
    parent = parent.parent
  }
  return null
}

/**
 * 判断是否是urls.py文件
 * @param {string} filePath - 文件路径
 * @returns {boolean}
 */
function isUrlsFile(filePath) {
  if (!filePath) return false
  return filePath.endsWith('urls.py') || filePath.includes('/urls.py')
}

/**
 * Django Entrypoint Collector
 *两个关键点：
 * 1识别路由注册方式并自采集被注册的路由函数作为entrypoint
 * 2将外部可控的数据结构标为source
 * 参考Go mux的gorilla-mux-entrypoint-collect-checker.js实现
 * 适配Django框架特有的路由注册模式
 */
class DjangoEntrypointCollector extends Checker {
  constructor(resultManager) {
    super(resultManager, 'django_entrypoint_collect_checker')
    this.desc = 'Django entrypoint collector'
  }
  /**
   * 检测Django路由注册
   * 如果当前语句是一条路由注册语句，则将被注册的路由函数采集为一个entrypoint
   * 参考Go mux的collectRouteRegistry方法，适配Django框架特点
   * 
   * Django典型路由注册方式：
   * ```python
   * from django.urls import path
   * urlpatterns = [
   *     path('api/users/', user_view),  # 这里会被检测到
   *     path('api/posts/', post_view),  # 这里也会被检测到
   * ]
   * ```
   * 
   * @param {Object} callExpNode - 函数调用AST节点
   * @param {Object} calleeFClos - 被调用函数的闭包信息
   * @param {Array} argValues - 函数参数值
   * @param {Object} scope - 作用域信息
   * @param {Object} info - 分析器信息
   */
  collectRouteRegistry(callExpNode, calleeFClos, argValues, scope, info) {
    const { analyzer, state } = info
    
    // 检测方式1：通过ast.id.name或ast.name检测path()调用
    // 这是Django中最常见的路由注册方式：from django.urls import path
    if (calleeFClos && calleeFClos.ast) {
      const functionName = calleeFClos.ast.id?.name || calleeFClos.ast.name
      
      if (RouteRegistryProperty.includes(functionName)) {
        for (const arg of argValues) {
          if (arg?.vtype === 'fclos' && arg?.ast.loc) {
            // 过滤掉urls.py文件中的函数，只保留views.py中的函数
            const sourceFile = getSourceFile(arg.ast)
            if (isUrlsFile(sourceFile)) {
              continue
            }
            
            const hash = JSON.stringify(arg.ast.loc)
            if (!processedRouteRegistry.has(hash)) {
              processedRouteRegistry.add(hash)
              IntroduceTaint.introduceFuncArgTaintBySelfCollection(arg, state, analyzer, '0', 'DJANGO_INPUT')
              const entryPoint = completeEntryPoint(arg)
              analyzer.entryPoints.push(entryPoint)
            }
          }
        }
        return // 如果检测到了，直接返回
      }
    }
    
    // 检测方式2：通过_qid属性检测（备用方式，处理没有ast的情况）
    if (calleeFClos && calleeFClos._qid && calleeFClos._qid.includes('path')) {
      for (const arg of argValues) {
        if (arg?.vtype === 'fclos' && arg?.ast.loc) {
          // 过滤掉urls.py文件中的函数，只保留views.py中的函数
          const sourceFile = getSourceFile(arg.ast)
          if (isUrlsFile(sourceFile)) {
            continue
          }
          
          const hash = JSON.stringify(arg.ast.loc)
          if (!processedRouteRegistry.has(hash)) {
            processedRouteRegistry.add(hash)
            IntroduceTaint.introduceFuncArgTaintBySelfCollection(arg, state, analyzer, '0', 'DJANGO_INPUT')
            const entryPoint = completeEntryPoint(arg)
            analyzer.entryPoints.push(entryPoint)
          }
        }
      }
    }
  }


  /**
   * 在函数调用时检测Django路由注册
   * 
   * 按照官方教程实现：选取合适的生命周期事件 - FunctionCallBefore (函数调用事件)
   * 对应官方教程中的triggerAtFunctionCallBefore方法
   * 
   * 官方教程说明：
   * "在函数调用时check，是否是一句函数调用语句"
   * "如果当前语句是一条路由注册语句，则将被注册的路由函数采集为一个entrypoint"
   * 
   * @param {Object} analyzer - 分析器实例
   * @param {Object} scope - 作用域信息
   * @param {Object} node - AST节点
   * @param {Object} state - 分析状态
   * @param {Object} info - 分析信息
   */
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    const { fclos, argvalues } = info
    this.collectRouteRegistry(node, fclos, argvalues, scope, info)
  }

  /**
   * 每次运行完main后清空hash
   * 
   * 按照官方教程实现：每次运行完main后清空hash
   * 对应官方教程中的triggerAtSymbolInterpretOfEntryPointAfter方法
   * 
   * 官方教程说明：
   * "每次运行完main后清空hash"
   * 
   * @param {Object} analyzer - 分析器实例
   * @param {Object} scope - 作用域信息
   * @param {Object} node - AST节点
   * @param {Object} state - 分析状态
   * @param {Object} info - 分析信息
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer, scope, node, state, info) {
    if (info?.entryPoint.functionName === 'main') processedRouteRegistry.clear()
  }

}

module.exports = DjangoEntrypointCollector