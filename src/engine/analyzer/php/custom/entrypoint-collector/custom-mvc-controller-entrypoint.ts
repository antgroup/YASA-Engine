/**
 * 自定义 MVC 框架 Controller entrypoint 采集器（路由中立）
 *
 * 背景：
 * - 部分 PHP 项目使用 catchall 路由把未在路由表中显式注册的 public action 也调用到，
 *   不能用路由白名单做准入门票（会漏），改走"类签名约定"。
 *
 * 识别策略：
 * 1. 类名以 `Controller` 结尾（大小写不敏感），或继承链包含 `BaseController`/`Controller`。
 * 2. 方法：public 非魔术，参数数 >= 1（典型 action 签名为 `($request, $response)`，
 *    也允许 1 参和 3+ 参的真 action，只排 0 参）。
 * 3. 排除 PHP 魔术方法 / setInstance / getInstance / DI 模板。
 *
 * 产出：完整 EntryPoint（带 entryPointSymVal），attribute='CustomMvcController'。
 * taint 层只把第一个参数 `$request` 当 source（`$response` 是输出端）。
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

/** 不作为 action 的 DI / 单例模板方法名（小写） */
const DI_METHOD_NAMES = new Set(['setinstance', 'getinstance'])

/**
 * 判断方法是否为自定义 MVC Controller 的合法 action
 * - 非魔术 / 非 DI 模板
 * - public 或未显式修饰（PHP 默认 public）
 * - 参数数 >= 1（0 参方法一般是工具函数，不采）
 */
function isMvcActionMethod(funcDef: any): boolean {
  const name = funcDef.id?.name
  if (!name) return false
  if (EXCLUDED_METHODS.has(name)) return false
  if (DI_METHOD_NAMES.has(name.toLowerCase())) return false

  const modifiers: any[] = funcDef.modifiers || []
  for (const m of modifiers) {
    const kw = typeof m === 'string' ? m : m?.name || m?.value || m?.kind
    if (!kw) continue
    const lower = String(kw).toLowerCase()
    if (lower === 'private' || lower === 'protected' || lower === 'abstract') return false
  }

  const params = funcDef.parameters || funcDef.params
  if (!params || params.length < 1) return false
  return true
}

/**
 * 采集入口
 * @param analyzer PhpAnalyzer 实例
 * @param dir 项目根目录
 */
function findCustomMvcControllerEntryPoints(analyzer: any, dir: string): any[] {
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
      if (!isControllerClass(className, inheritanceMap)) continue

      // 跳过基类本身（BaseController / Controller），它们没有业务 action
      const lowerName = className.toLowerCase()
      if (lowerName === 'basecontroller' || lowerName === 'controller') continue

      const body = Array.isArray(cdef.body) ? cdef.body : cdef.body?.body
      if (!body) continue

      for (const member of body) {
        if (member.type !== 'FunctionDefinition') continue
        if (!isMvcActionMethod(member)) continue

        const methodName = member.id.name
        const methodFclos = classVal.value?.[methodName]
        if (!methodFclos || methodFclos.vtype !== 'fclos') continue

        const ep = new EntryPoint(Constant.ENGIN_START_FUNCALL)
        ep.scopeVal = methodFclos.parent
        ep.argValues = []
        ep.functionName = methodName
        ep.filePath = shortFileName
        ep.attribute = 'CustomMvcController'
        ep.packageName = undefined
        ep.entryPointSymVal = methodFclos
        entryPoints.push(ep)
      }
    }
  }

  logger.info(`[CustomMvcController] 发现 ${entryPoints.length} 个 MVC Controller action entrypoints`)
  return entryPoints
}

module.exports = {
  findCustomMvcControllerEntryPoints,
  isMvcActionMethod,
  DI_METHOD_NAMES,
}
