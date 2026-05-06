/**
 * Sparta 框架 entrypoint 采集器
 *
 * Sparta 控制器模式：
 * - 继承 Controller / BaseController / 任何以 Controller 结尾的类
 * - action 方法签名：public function actionName($request, $response)
 * - 两个参数的方法被识别为 HTTP 入口
 */
const { extractRelativePath } = require('../../../../../util/file-util')
const EntryPoint = require('../../../common/entrypoint')
const Constant = require('../../../../../util/constant')
const logger = require('../../../../../util/logger')(__filename)

/** Controller 基类名模式 */
const CONTROLLER_BASE_NAMES = ['Controller', 'BaseController']
const CONTROLLER_SUFFIX = 'Controller'

/** PHP 魔术方法和内部方法，不作为 entrypoint */
const EXCLUDED_METHODS = new Set([
  '__construct', '__destruct', '__get', '__set', '__call', '__callStatic',
  '__isset', '__unset', '__sleep', '__wakeup', '__toString', '__invoke',
  '__clone', '__debugInfo', '__serialize', '__unserialize',
])

/**
 * 从所有文件的 AST 中构建类继承关系
 */
function buildClassInheritanceMap(moduleScopes: Map<string, any>): Map<string, Set<string>> {
  const inheritanceMap = new Map<string, Set<string>>()

  for (const [, modClos] of moduleScopes) {
    if (!modClos?.value) continue
    for (const key of Object.keys(modClos.value)) {
      const val = modClos.value[key]
      const cdef = val?.ast?.cdef
      if (!cdef || cdef.type !== 'ClassDefinition') continue

      const className = cdef.id?.name
      if (!className) continue

      if (!inheritanceMap.has(className)) {
        inheritanceMap.set(className, new Set())
      }
      const parents = inheritanceMap.get(className)!

      // supers 是父类列表
      if (Array.isArray(cdef.supers)) {
        for (const s of cdef.supers) {
          const parentName = s.type === 'Identifier' ? s.name : s.name || s.value
          if (parentName) parents.add(parentName)
        }
      }
      // 兼容 extends 字段
      if (cdef.extends) {
        const extName = typeof cdef.extends === 'string' ? cdef.extends
          : cdef.extends.name || cdef.extends.value
        if (extName) parents.add(extName)
      }
    }
  }
  return inheritanceMap
}

const MAX_DEPTH = 10

/**
 * 递归检查 className 是否直接或间接继承自 Controller
 */
function isControllerClass(
  className: string,
  inheritanceMap: Map<string, Set<string>>,
  visited?: Set<string>
): boolean {
  if (CONTROLLER_BASE_NAMES.includes(className)) return true
  if (className.endsWith(CONTROLLER_SUFFIX)) return true
  if (!visited) visited = new Set()
  if (visited.has(className) || visited.size >= MAX_DEPTH) return false
  visited.add(className)
  const parents = inheritanceMap.get(className)
  if (!parents) return false
  for (const parent of parents) {
    if (isControllerClass(parent, inheritanceMap, visited)) return true
  }
  return false
}

/**
 * 判断方法是否为 Sparta action 方法
 * 特征：非魔术方法，参数 >= 2（$request, $response）
 */
function isActionMethod(funcDef: any): boolean {
  const name = funcDef.id?.name
  if (!name || EXCLUDED_METHODS.has(name)) return false
  // 参数数量 >= 2（$request, $response）
  const params = funcDef.parameters || funcDef.params
  if (!params || params.length < 2) return false
  return true
}

/**
 * 从 analyzer 的 moduleScopes 中扫描 Sparta Controller，收集 action entrypoints
 *
 * @param analyzer PhpAnalyzer 实例
 * @param dir 项目根目录
 * @returns entrypoint 数组
 */
function findSpartaEntryPoints(analyzer: any, dir: string): any[] {
  const entryPoints: any[] = []
  const moduleScopes: Map<string, any> = analyzer.moduleScopes || new Map()

  if (moduleScopes.size === 0) return entryPoints

  const inheritanceMap = buildClassInheritanceMap(moduleScopes)

  for (const [filename, modClos] of moduleScopes) {
    if (!modClos?.value) continue
    const shortFileName = extractRelativePath(filename, dir)

    for (const key of Object.keys(modClos.value)) {
      const val = modClos.value[key]
      const cdef = val?.ast?.cdef
      if (!cdef || cdef.type !== 'ClassDefinition') continue

      const className = cdef.id?.name
      if (!className) continue

      // 检查是否为 Controller 类
      if (!isControllerClass(className, inheritanceMap)) continue

      // 扫描类体中的方法
      const body = Array.isArray(cdef.body) ? cdef.body : cdef.body?.body
      if (!body) continue

      for (const member of body) {
        if (member.type !== 'FunctionDefinition') continue
        if (!isActionMethod(member)) continue

        const methodName = member.id.name
        const ep = new EntryPoint(Constant.ENGIN_START_FUNCALL)
        ep.filePath = shortFileName
        ep.functionName = methodName
        ep.attribute = 'SpartaHTTP'
        entryPoints.push(ep)
      }
    }
  }

  logger.info(`[SpartaEntrypoint] 发现 ${entryPoints.length} 个 Controller action entrypoints`)
  return entryPoints
}

module.exports = {
  findSpartaEntryPoints,
  isControllerClass,
  buildClassInheritanceMap,
  EXCLUDED_METHODS,
}
