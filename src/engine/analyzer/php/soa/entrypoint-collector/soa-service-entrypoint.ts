/**
 * SOA Service 框架 entrypoint 采集器
 *
 * SOA 服务模式：
 * - 类名以 Svc / Service 结尾，或继承 *BaseService / *Service
 * - 服务方法参数即为 RPC 用户输入，全部标记为 source
 * - 排除已由 Sparta 处理的 Controller 类
 *
 * 与 Sparta collector 不同，SOA collector 直接返回带 symVal 的完整 EntryPoint，
 * 因为 PHP 类方法的 fclos 不在 context.funcs 中（除非重写父类方法），
 * resolveFrameworkEntryPoints 无法定位它们。
 */
const { extractRelativePath } = require('../../../../../util/file-util')
const EntryPoint = require('../../../common/entrypoint')
const Constant = require('../../../../../util/constant')
const logger = require('../../../../../util/logger')(__filename)
const {
  buildClassInheritanceMap,
  isControllerClass,
  EXCLUDED_METHODS,
} = require('../../sparta/entrypoint-collector/sparta-default-entrypoint')

/** SOA Service 类名后缀（大小写不敏感匹配） */
const SERVICE_SUFFIXES = ['svc', 'service']

/** Service 基类名模式（大小写不敏感匹配） */
const SERVICE_BASE_PATTERNS = ['baseservice', 'service']

const MAX_DEPTH = 10

/**
 * 判断 className 是否为 SOA Service 类
 * 条件：类名以 Svc/Service 结尾，或继承链中包含 *BaseService/*Service
 * 排除 Controller 类（已由 Sparta 处理）
 */
function isServiceClass(
  className: string,
  inheritanceMap: Map<string, Set<string>>,
  visited?: Set<string>
): boolean {
  // 排除 Controller 类
  if (isControllerClass(className, inheritanceMap)) return false

  const lowerName = className.toLowerCase()

  // 类名以 Svc 或 Service 结尾
  if (SERVICE_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))) return true

  // 递归检查继承链
  if (!visited) visited = new Set()
  if (visited.has(className) || visited.size >= MAX_DEPTH) return false
  visited.add(className)

  const parents = inheritanceMap.get(className)
  if (!parents) return false
  for (const parent of parents) {
    const lowerParent = parent.toLowerCase()
    if (SERVICE_BASE_PATTERNS.some((pattern) => lowerParent.endsWith(pattern))) return true
    if (isServiceClass(parent, inheritanceMap, visited)) return true
  }
  return false
}

/**
 * 判断方法是否为 SOA Service 方法
 * 条件：非魔术方法，有 >= 1 个参数
 */
function isServiceMethod(funcDef: any): boolean {
  const name = funcDef.id?.name
  if (!name || EXCLUDED_METHODS.has(name)) return false
  const params = funcDef.parameters || funcDef.params
  if (!params || params.length < 1) return false
  return true
}

/**
 * 从 analyzer 的 moduleScopes 中扫描 SOA Service 类，直接解析方法 fclos 为完整 entrypoints。
 * PHP 类方法的 fclos 存储在 classValue.value[methodName] 中（不在 context.funcs），
 * 所以此处直接从 class scope value 中获取 fclos，无需经过 resolveFrameworkEntryPoints。
 *
 * @param analyzer PhpAnalyzer 实例
 * @param dir 项目根目录
 * @returns 完整的 EntryPoint 数组（带 entryPointSymVal）
 */
function findSoaServiceEntryPoints(analyzer: any, dir: string): any[] {
  const entryPoints: any[] = []
  const moduleScopes: Map<string, any> = analyzer.moduleScopes || new Map()

  if (moduleScopes.size === 0) return entryPoints

  const inheritanceMap = buildClassInheritanceMap(moduleScopes)

  for (const [filename, modClos] of moduleScopes) {
    if (!modClos?.value) continue
    const shortFileName = extractRelativePath(filename, dir)

    for (const key of Object.keys(modClos.value)) {
      const classVal = modClos.value[key]
      const cdef = classVal?.ast?.cdef
      if (!cdef || cdef.type !== 'ClassDefinition') continue

      const className = cdef.id?.name
      if (!className) continue
      if (!isServiceClass(className, inheritanceMap)) continue

      // 扫描类体中的方法，直接从 classVal.value 中获取对应的 fclos
      const body = Array.isArray(cdef.body) ? cdef.body : cdef.body?.body
      if (!body) continue

      for (const member of body) {
        if (member.type !== 'FunctionDefinition') continue
        if (!isServiceMethod(member)) continue

        const methodName = member.id.name
        // 从类 scope value 中获取方法的 fclos
        const methodFclos = classVal.value?.[methodName]
        if (!methodFclos || methodFclos.vtype !== 'fclos') continue

        const ep = new EntryPoint(Constant.ENGIN_START_FUNCALL)
        ep.scopeVal = methodFclos.parent
        ep.argValues = []
        ep.functionName = methodName
        ep.filePath = shortFileName
        ep.attribute = 'SOAService'
        ep.packageName = undefined
        ep.entryPointSymVal = methodFclos
        entryPoints.push(ep)
      }
    }
  }

  logger.info(`[SoaServiceEntrypoint] 发现 ${entryPoints.length} 个 SOA Service entrypoints`)
  return entryPoints
}

module.exports = {
  findSoaServiceEntryPoints,
  isServiceClass,
  isServiceMethod,
}
