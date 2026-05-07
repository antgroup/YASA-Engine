/**
 * 自定义 DataBucket entrypoint 采集器
 *
 * 背景：
 * - 部分 PHP 项目的 Controller 层通过 `__call` 魔术方法把请求转发到具体 DataBucket，
 *   真正的业务入口是 `controllers/<subapp>/<*>databucket.php` 里的 public 方法。
 * - DataBucket 方法签名不固定（按 RPC 参数逐个展开，如 `($userId, $os, $v)`），
 *   不能按 Controller 的 "==2" 判定。
 * - 历史拼写/命名漂移：实际文件后缀可能存在 `databucket.php / databacket.php / databuck.php / bucket.php` 多种。
 *
 * 识别策略：
 * 1. 类名以 `DataBucket / DataBacket / DataBuck / Bucket` 之一结尾（大小写不敏感），
 *    或继承链包含 `BaseDataBucket`/`DataBucket` 等基类。
 * 2. 方法：public 非魔术，参数数 >= 1（所有参数都当外部输入）。
 * 3. 排除 PHP 魔术方法 / setInstance / getInstance / DI 模板。
 *
 * 产出：完整 EntryPoint（带 entryPointSymVal），attribute='CustomDataBucket'。
 * taint 层把所有参数都当 source（走 SOA 同样的全参污点分支）。
 */
const { extractRelativePath } = require('../../../../../util/file-util')
const EntryPoint = require('../../../common/entrypoint')
const Constant = require('../../../../../util/constant')
const logger = require('../../../../../util/logger')(__filename)
const {
  buildClassInheritanceMap,
  EXCLUDED_METHODS,
} = require('../../sparta/entrypoint-collector/sparta-default-entrypoint')
const { DI_METHOD_NAMES } = require('./custom-mvc-controller-entrypoint')

const MAX_DEPTH = 10

/** DataBucket 基类名模式（大小写不敏感，endsWith 匹配） */
const DATABUCKET_BASE_PATTERNS = ['basedatabucket', 'databucket', 'basedatabacket', 'databacket']

/** DataBucket 类名后缀（大小写不敏感，endsWith 匹配）。允许多种历史拼写。 */
const DATABUCKET_SUFFIXES = ['databucket', 'databacket', 'databuck', 'bucket']

/** 基类名——跳过基类本身不当 entrypoint 采集 */
const DATABUCKET_BASE_CLASSES = new Set([
  'basedatabucket',
  'databucket',
  'basedatabacket',
  'databacket',
])

/**
 * 判断 className 是否为 DataBucket 类
 * 条件：类名以 DATABUCKET_SUFFIXES 之一结尾（大小写不敏感），或继承链包含相应基类
 */
function isDataBucketClass(
  className: string,
  inheritanceMap: Map<string, Set<string>>,
  visited?: Set<string>
): boolean {
  const lowerName = className.toLowerCase()

  if (DATABUCKET_SUFFIXES.some((s) => lowerName.endsWith(s))) return true

  if (!visited) visited = new Set()
  if (visited.has(className) || visited.size >= MAX_DEPTH) return false
  visited.add(className)

  const parents = inheritanceMap.get(className)
  if (!parents) return false
  for (const parent of parents) {
    const lowerParent = parent.toLowerCase()
    if (DATABUCKET_BASE_PATTERNS.some((p) => lowerParent.endsWith(p))) return true
    if (isDataBucketClass(parent, inheritanceMap, visited)) return true
  }
  return false
}

/**
 * 判断方法是否为合法的 DataBucket 业务方法
 * - 非魔术 / 非 DI 模板
 * - public 或默认（PHP 默认 public）
 * - 参数数 >= 1
 */
function isDataBucketMethod(funcDef: any): boolean {
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
function findCustomDataBucketEntryPoints(analyzer: any, dir: string): any[] {
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
      if (!isDataBucketClass(className, inheritanceMap)) continue

      // 跳过基类本身
      const lowerName = className.toLowerCase()
      if (DATABUCKET_BASE_CLASSES.has(lowerName)) continue

      const body = Array.isArray(cdef.body) ? cdef.body : cdef.body?.body
      if (!body) continue

      for (const member of body) {
        if (member.type !== 'FunctionDefinition') continue
        if (!isDataBucketMethod(member)) continue

        const methodName = member.id.name
        const methodFclos = classVal.value?.[methodName]
        if (!methodFclos || methodFclos.vtype !== 'fclos') continue

        const ep = new EntryPoint(Constant.ENGIN_START_FUNCALL)
        ep.scopeVal = methodFclos.parent
        ep.argValues = []
        ep.functionName = methodName
        ep.filePath = shortFileName
        ep.attribute = 'CustomDataBucket'
        ep.packageName = undefined
        ep.entryPointSymVal = methodFclos
        entryPoints.push(ep)
      }
    }
  }

  logger.info(`[CustomDataBucket] 发现 ${entryPoints.length} 个 DataBucket entrypoints`)
  return entryPoints
}

module.exports = {
  findCustomDataBucketEntryPoints,
  isDataBucketClass,
  isDataBucketMethod,
}
