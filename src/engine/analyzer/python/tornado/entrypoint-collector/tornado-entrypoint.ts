const { extractRelativePath } = require('../../../../../util/file-util')
const { entryPointAndSourceAtSameTime } = require('../../../../../config')
const { findSourceOfFuncParam } = require('../../common/entrypoint-collector/python-entrypoint-source')
const EntryPoint = require('../../../common/entrypoint/entrypoint')
const Constant = require('../../../../../util/constant')
const { registerPreparedBodyRead } = require('../../../../../checker/taint/python/tornado-util')

interface ASTObject {
  body?: any[]
  [key: string]: any
}

interface FilenameAstMap {
  [filename: string]: ASTObject
}

interface ClassInfo {
  node: ASTObject
  className: string
  superNames: string[]
}

type UastNode = Record<string, unknown>

type MemberAccessNode = UastNode & {
  type: 'MemberAccess'
  object: UastNode
  property: UastNode & { name: string }
}

function isUastNode(value: unknown): value is UastNode {
  return typeof value === 'object' && value !== null
}

function hasType(node: unknown, type: string): node is UastNode & { type: string } {
  return isUastNode(node) && node.type === type
}

function isSelfAttributeAccess(node: unknown): node is MemberAccessNode {
  return (
    hasType(node, 'MemberAccess') &&
    hasType(node.object, 'Identifier') &&
    node.object.name === 'self' &&
    hasType(node.property, 'Identifier') &&
    typeof node.property.name === 'string'
  )
}

function isRequestBodyAccess(node: unknown): node is MemberAccessNode {
  return (
    hasType(node, 'MemberAccess') &&
    hasType(node.object, 'MemberAccess') &&
    hasType(node.object.object, 'Identifier') &&
    node.object.object.name === 'self' &&
    hasType(node.object.property, 'Identifier') &&
    node.object.property.name === 'request' &&
    hasType(node.property, 'Identifier') &&
    node.property.name === 'body'
  )
}

function isBodyDerivedExpression(node: unknown, visited: Set<UastNode> = new Set()): boolean {
  if (!isUastNode(node) || visited.has(node)) return false
  visited.add(node)
  if (isRequestBodyAccess(node)) return true
  if (node.type === 'CallExpression') {
    const args = Array.isArray(node.arguments) ? node.arguments : []
    return args.some((arg) => isBodyDerivedExpression(arg, visited)) || isBodyDerivedExpression(node.callee, visited)
  }
  if (node.type === 'MemberAccess') return isBodyDerivedExpression(node.object, visited)
  if (node.type === 'AwaitExpression' || node.type === 'UnaryExpression') return isBodyDerivedExpression(node.argument, visited)
  if (node.type === 'BinaryExpression') {
    return isBodyDerivedExpression(node.left, visited) || isBodyDerivedExpression(node.right, visited)
  }
  return false
}

function isNestedScopeNode(node: UastNode): boolean {
  return ['FunctionDefinition', 'Lambda', 'LambdaExpression', 'ClassDefinition'].includes(node.type as string)
}

function collectMemberAccessReads(node: unknown, visit: (memberAccess: MemberAccessNode) => void, visited: Set<UastNode> = new Set()): void {
  if (!isUastNode(node) || visited.has(node)) return
  visited.add(node)
  if (isNestedScopeNode(node)) return
  if (isSelfAttributeAccess(node)) visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (node.type === 'AssignmentExpression' && key === 'left') continue
    if (Array.isArray(value)) {
      for (const item of value) collectMemberAccessReads(item, visit, visited)
    } else {
      collectMemberAccessReads(value, visit, visited)
    }
  }
}

function unwrapTopLevelExpressionStatement(node: unknown): unknown {
  if (!hasType(node, 'ExpressionStatement')) return node
  return node.expression
}

function getTopLevelPrepareStatements(body: unknown): unknown[] {
  if (Array.isArray(body)) return body.map(unwrapTopLevelExpressionStatement)
  if (hasType(body, 'ScopedStatement') && Array.isArray(body.body)) {
    return body.body.map(unwrapTopLevelExpressionStatement)
  }
  if (hasType(body, 'Sequence') && Array.isArray(body.expressions)) {
    return body.expressions.map(unwrapTopLevelExpressionStatement)
  }
  return []
}

function registerPreparedBodyAttributeReads(classNode: ASTObject): void {
  const classBody = Array.isArray(classNode.body) ? classNode.body : []
  const prepareMethod = classBody.find(
    (member: unknown) => hasType(member, 'FunctionDefinition') && hasType(member.id, 'Identifier') && member.id.name === 'prepare'
  )
  if (!prepareMethod) return

  const bodyAttributes = new Map<string, boolean>()
  for (const statement of getTopLevelPrepareStatements(prepareMethod.body)) {
    if (!hasType(statement, 'AssignmentExpression') || statement.operator !== '=') continue
    if (isSelfAttributeAccess(statement.left)) {
      bodyAttributes.set(statement.left.property.name, isBodyDerivedExpression(statement.right))
    }
  }
  const preparedAttributes = new Set(
    [...bodyAttributes].filter(([, isBodyDerived]) => isBodyDerived).map(([attribute]) => attribute)
  )
  if (preparedAttributes.size === 0) return

  for (const member of classBody) {
    if (!hasType(member, 'FunctionDefinition') || member === prepareMethod) continue
    collectMemberAccessReads(member.body, (node) => {
      if (preparedAttributes.has(node.property.name)) registerPreparedBodyRead(node)
    })
  }
}

// Tornado RequestHandler 基类名（同时识别 Identifier 与 MemberAccess 末端 property name）
const TORNADO_HANDLER_BASE_NAMES = ['RequestHandler']

// Tornado handler 暴露的 HTTP 方法 + 生命周期 hook（覆盖 source 入口；不含 initialize/__init__ 避免污染构造路径）
const TORNADO_HTTP_METHODS = [
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'options',
  'prepare',
  'on_finish',
]

const MAX_INHERITANCE_DEPTH = 10

/**
 * 提取 supers 节点中的"父类标识符"
 * 兼容两种形态：
 *   - Identifier：父类直接引用（`class X(RequestHandler)`）
 *   - MemberAccess：父类带前缀（`class X(tornado.web.RequestHandler)`，取末端 property.name）
 */
function extractSuperName(superNode: any): string | null {
  if (!superNode || typeof superNode !== 'object') return null
  if (superNode.type === 'Identifier' && typeof superNode.name === 'string') {
    return superNode.name
  }
  if (superNode.type === 'MemberAccess' && typeof superNode.property?.name === 'string') {
    return superNode.property.name
  }
  return null
}

/**
 * 收集顶层 ClassDefinition（路由表 Application([...]) 引用的均为顶层类，bkimageanalyze 全部命中）
 */
function collectTopLevelClassDefinitions(ast: ASTObject): ClassInfo[] {
  const result: ClassInfo[] = []
  const body = Array.isArray(ast.body) ? ast.body : []
  for (const node of body) {
    if (node.type !== 'ClassDefinition' || !node.id?.name || !Array.isArray(node.supers)) continue
    const superNames: string[] = node.supers
      .map((s: any) => extractSuperName(s))
      .filter((n: string | null): n is string => n !== null)
    result.push({ node, className: node.id.name, superNames })
  }
  return result
}

/**
 * 跨文件构建顶层类继承图
 */
function buildInheritanceMap(filenameAstObj: FilenameAstMap): Map<string, Set<string>> {
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
  return inheritanceMap
}

/**
 * 递归判定 className 是否（直接/间接）继承自 Tornado RequestHandler
 */
function isTornadoHandlerSubclass(
  className: string,
  inheritanceMap: Map<string, Set<string>>,
  visited?: Set<string>
): boolean {
  if (TORNADO_HANDLER_BASE_NAMES.includes(className)) return true
  if (!visited) visited = new Set()
  if (visited.has(className) || visited.size >= MAX_INHERITANCE_DEPTH) return false
  visited.add(className)
  const parents = inheritanceMap.get(className)
  if (!parents) return false
  for (const parent of parents) {
    if (isTornadoHandlerSubclass(parent, inheritanceMap, visited)) return true
  }
  return false
}

/**
 * 把 handler 类内的 HTTP 方法 / 生命周期 hook 注册为 entrypoint
 */
function registerHandlerMethods(
  classNode: any,
  filename: string,
  shortFileName: string,
  entryPointArray: any[],
  entryPointSourceArray: any[]
): void {
  const classBody = Array.isArray(classNode.body) ? classNode.body : []
  for (const member of classBody) {
    if (member.type !== 'FunctionDefinition' || !member.id?.name || !member.parameters) continue
    const methodName: string = member.id.name
    if (!TORNADO_HTTP_METHODS.includes(methodName)) continue

    const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
    entryPoint.filePath = shortFileName
    entryPoint.functionName = methodName
    entryPoint.attribute = 'HTTP'
    // 携带函数定义行号，用于精确匹配 overloaded 同名方法
    entryPoint.funcLocStart = member.loc?.start?.line as number | undefined
    entryPoint.funcLocEnd = member.loc?.end?.line as number | undefined
    // Tornado handler 方法被自定义装饰器包裹时，引擎 executeCallWithDecorators 执行 wrapper
    // 而非原始方法体，导致 self.request.body 等 source 从未触发。
    // 标记 skipDecorators 让入口点执行时直接跳过装饰器。
    if (member._meta?.decorators?.length > 0) {
      entryPoint.skipDecorators = true
    }
    entryPointArray.push(entryPoint)

    if (entryPointAndSourceAtSameTime) {
      const paramSourceArray = findSourceOfFuncParam(filename, methodName, member, null)
      if (paramSourceArray) {
        entryPointSourceArray.push(...paramSourceArray)
      }
    }
  }
}

/**
 * Tornado entrypoint 预收集器
 * 静态扫描所有继承自 tornado.web.RequestHandler 的类，把 HTTP 方法注册为入口；
 * source 由 tornado-taint-checker.ts 在符号执行阶段对 self.request.* 与 get_argument(...) 标记，本收集器不重复处理。
 *
 * @param filenameAstObj
 * @param dir
 */
function findTornadoEntryPointAndSource(
  filenameAstObj: FilenameAstMap,
  dir: string
): { tornadoEntryPointArray: any[]; tornadoEntryPointSourceArray: any[] } {
  const tornadoEntryPointArray: any[] = []
  const tornadoEntryPointSourceArray: any[] = []

  const inheritanceMap = buildInheritanceMap(filenameAstObj)

  for (const filename in filenameAstObj) {
    const ast = filenameAstObj[filename]
    if (!ast) continue
    const shortFileName = extractRelativePath(filename, dir)
    const topClasses = collectTopLevelClassDefinitions(ast)
    for (const { className, node } of topClasses) {
      // 跳过 RequestHandler 本身（仅出现在 tornado SDK 自身代码场景）
      if (TORNADO_HANDLER_BASE_NAMES.includes(className)) continue
      if (!isTornadoHandlerSubclass(className, inheritanceMap)) continue
      registerPreparedBodyAttributeReads(node)
      registerHandlerMethods(node, filename, shortFileName, tornadoEntryPointArray, tornadoEntryPointSourceArray)
    }
  }

  return { tornadoEntryPointArray, tornadoEntryPointSourceArray }
}

export = {
  findTornadoEntryPointAndSource,
  _testOnly: {
    registerPreparedBodyAttributeReads,
  },
}
