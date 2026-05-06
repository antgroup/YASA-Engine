const { extractRelativePath } = require('../../../../../util/file-util')
const EntryPoint = require('../../../common/entrypoint')
const Constant = require('../../../../../util/constant')

// Python http.server / socketserver 框架的 HTTP handler 基类名
export const HTTP_HANDLER_BASE_NAMES = [
  'BaseHTTPRequestHandler',
  'SimpleHTTPRequestHandler',
  'CGIHTTPRequestHandler',
  'StreamRequestHandler',
  'BaseRequestHandler',
]

// Python http.server 框架的 HTTP server 基类名（用于检测 server 类的 __init__ 入口）
export const HTTP_SERVER_BASE_NAMES = [
  'HTTPServer',
  'BaseHTTPServer',
  'ThreadingHTTPServer',
  'TCPServer',
  'UDPServer',
  'ThreadingTCPServer',
  'ThreadingUDPServer',
  'ForkingTCPServer',
  'ForkingUDPServer',
]

// do_METHOD 模式及 handle 方法
export const HTTP_HANDLER_METHODS = [
  'do_GET',
  'do_POST',
  'do_PUT',
  'do_DELETE',
  'do_PATCH',
  'do_HEAD',
  'do_OPTIONS',
  'do_CONNECT',
  'do_TRACE',
  'handle',
]

const MAX_INHERITANCE_DEPTH = 10

interface ASTObject {
  body?: any[]
  [key: string]: any
}

interface FilenameAstMap {
  [filename: string]: ASTObject
}

interface ClassInfo {
  node: any
  className: string
  superNames: string[]
}

/**
 * 递归从 AST 节点中收集所有 ClassDefinition（含嵌套在函数/类内的定义）
 */
function collectAllClassDefinitions(node: any, result: ClassInfo[]): void {
  if (!node || typeof node !== 'object') return

  if (Array.isArray(node)) {
    for (const item of node) {
      collectAllClassDefinitions(item, result)
    }
    return
  }

  if (node.type === 'ClassDefinition') {
    const className: string | undefined = node.id?.name
    if (className && Array.isArray(node.supers)) {
      const superNames: string[] = node.supers
        .filter((s: any) => s.type === 'Identifier' && s.name)
        .map((s: any) => s.name as string)
      result.push({ node, className, superNames })
    }
    if (Array.isArray(node.body)) {
      collectAllClassDefinitions(node.body, result)
    }
    return
  }

  if (Array.isArray(node.body)) {
    collectAllClassDefinitions(node.body, result)
  }
  if (node.body && typeof node.body === 'object' && !Array.isArray(node.body)) {
    collectAllClassDefinitions(node.body, result)
  }
}

/**
 * 从 ClassInfo 列表构建继承关系 Map
 */
function buildInheritanceMapFromClasses(classes: ClassInfo[]): Map<string, Set<string>> {
  const inheritanceMap = new Map<string, Set<string>>()
  for (const { className, superNames } of classes) {
    if (!inheritanceMap.has(className)) {
      inheritanceMap.set(className, new Set())
    }
    const parents = inheritanceMap.get(className)!
    for (const s of superNames) {
      parents.add(s)
    }
  }
  return inheritanceMap
}

/**
 * 递归检查 className 是否直接或间接继承自 HTTP handler 基类
 */
export function isHttpHandlerSubclass(
  className: string,
  inheritanceMap: Map<string, Set<string>>,
  visited?: Set<string>
): boolean {
  if (HTTP_HANDLER_BASE_NAMES.includes(className)) return true
  if (!visited) visited = new Set()
  if (visited.has(className) || visited.size >= MAX_INHERITANCE_DEPTH) return false
  visited.add(className)
  const parents = inheritanceMap.get(className)
  if (!parents) return false
  for (const parent of parents) {
    if (isHttpHandlerSubclass(parent, inheritanceMap, visited)) return true
  }
  return false
}

/**
 * 检查运行时的类符号值是否是 HTTP handler 子类（基于 AST 的父类名）
 * 用于动态检测时判断函数返回值是否是 HTTP handler 类
 */
export function isHttpHandlerClass(cls: any): boolean {
  if (!cls || (cls.vtype !== 'class' && cls.vtype !== 'scope')) return false
  const cdef = cls.ast?.cdef || cls.ast?.node
  if (!cdef || cdef.type !== 'ClassDefinition') return false
  const supers: string[] = (cdef.supers || [])
    .filter((s: any) => s.type === 'Identifier' && s.name)
    .map((s: any) => s.name as string)
  // 直接继承检查（不需要全局继承图，只检查直接父类）
  return supers.some((s) => HTTP_HANDLER_BASE_NAMES.includes(s))
}

/**
 * 从 AST 文件级别检测包含 HTTP handler 类的文件
 * 返回文件相对路径列表（用于添加 file-begin 入口点）
 */
export function findFilesWithHttpHandlers(filenameAstObj: FilenameAstMap, dir: string): string[] {
  const result: string[] = []
  for (const filename in filenameAstObj) {
    const ast = filenameAstObj[filename]
    if (!ast) continue

    const allClasses: ClassInfo[] = []
    collectAllClassDefinitions(ast, allClasses)
    const inheritanceMap = buildInheritanceMapFromClasses(allClasses)

    const hasHttpHandler = allClasses.some(({ className }) => isHttpHandlerSubclass(className, inheritanceMap))
    if (hasHttpHandler) {
      result.push(filename)
    }
  }
  return result
}

/**
 * 检查 className 是否直接或间接继承自 HTTP server 基类（如 HTTPServer）
 */
function isHttpServerSubclass(
  className: string,
  inheritanceMap: Map<string, Set<string>>,
  visited?: Set<string>
): boolean {
  if (HTTP_SERVER_BASE_NAMES.includes(className)) return true
  if (!visited) visited = new Set()
  if (visited.has(className) || visited.size >= MAX_INHERITANCE_DEPTH) return false
  visited.add(className)
  const parents = inheritanceMap.get(className)
  if (!parents) return false
  for (const parent of parents) {
    if (isHttpServerSubclass(parent, inheritanceMap, visited)) return true
  }
  return false
}

/**
 * 从 AST 中收集顶层 ClassDefinition（不深入嵌套，因为 lookupFclos 只索引顶层方法）
 */
function collectTopLevelClassDefinitions(ast: ASTObject): ClassInfo[] {
  const result: ClassInfo[] = []
  const body = Array.isArray(ast.body) ? ast.body : []
  for (const node of body) {
    if (node.type === 'ClassDefinition' && node.id?.name && Array.isArray(node.supers)) {
      const superNames: string[] = node.supers
        .filter((s: any) => s.type === 'Identifier' && s.name)
        .map((s: any) => s.name as string)
      result.push({ node, className: node.id.name, superNames })
    }
  }
  return result
}

/**
 * 检测继承自 HTTPServer 的类，注册其 __init__ 为 FUNCALL 入口点
 * 用于让分析器进入 server 类的 __init__，从而发现 handler 类的动态注册
 */
export function findHttpServerEntryPointAndSource(
  filenameAstObj: FilenameAstMap,
  dir: string
): { httpServerEntryPointArray: any[]; httpServerEntryPointSourceArray: any[] } {
  const httpServerEntryPointArray: any[] = []
  const httpServerEntryPointSourceArray: any[] = []

  // 构建跨文件继承关系（仅顶层类）
  const inheritanceMap = new Map<string, Set<string>>()
  for (const filename in filenameAstObj) {
    const ast = filenameAstObj[filename]
    if (!ast) continue
    const topClasses = collectTopLevelClassDefinitions(ast)
    for (const { className, superNames } of topClasses) {
      if (!inheritanceMap.has(className)) {
        inheritanceMap.set(className, new Set())
      }
      const parents = inheritanceMap.get(className)!
      for (const s of superNames) {
        parents.add(s)
      }
    }
  }

  for (const filename in filenameAstObj) {
    const ast = filenameAstObj[filename]
    if (!ast) continue
    const shortFileName = extractRelativePath(filename, dir)
    const topClasses = collectTopLevelClassDefinitions(ast)

    for (const { className, superNames, node } of topClasses) {
      // 跳过直接就是 HTTPServer 基类的
      if (HTTP_SERVER_BASE_NAMES.includes(className)) continue
      if (!isHttpServerSubclass(className, inheritanceMap)) continue

      // 注册 __init__ 为入口点（如 PolicyServerInput.__init__）
      const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
      entryPoint.filePath = shortFileName
      entryPoint.functionName = '__init__'
      entryPoint.attribute = 'HTTP'
      httpServerEntryPointArray.push(entryPoint)
    }
  }

  return { httpServerEntryPointArray, httpServerEntryPointSourceArray }
}
