const { extractRelativePath } = require('../../../../../util/file-util')
const { entryPointAndSourceAtSameTime } = require('../../../../../config')
const { findSourceOfFuncParam } = require('../../common/entrypoint-collector/python-entrypoint-source')
const EntryPoint = require('../../../common/entrypoint/entrypoint')
const Constant = require('../../../../../util/constant')

interface ASTObject {
  body?: any[]
  [key: string]: any
}

interface FilenameAstMap {
  [filename: string]: ASTObject
}

// 类视图基类名：Flask-RESTX Resource、Flask MethodView
const CLASS_VIEW_BASE_NAMES = ['Resource', 'MethodView']
// HTTP 方法名
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']
// Flask 应用级生命周期钩子：被 @app.before_request 等装饰的函数 body 在每次请求前执行，
// 其中对全局对象 g 的属性绑定（g.db = ..., g.cu = ...）需要在所有路由 entrypoint dispatch 前
// 在模块作用域预执行，才能让跨文件路由内 g.cu 解析到正确的 sqlite3 类型链
const FLASK_LIFECYCLE_HOOK_NAMES = new Set(['before_request', 'before_first_request', 'before_app_request'])

/**
 * 检查装饰器函数是否为 Flask 路由装饰器（@app.route / @app.get 等）
 */
function isFlaskRouteDecorator(decoratorObj: any): boolean {
  if (decoratorObj.type !== 'CallExpression' || !decoratorObj.callee) {
    return false
  }
  const { callee } = decoratorObj
  if (callee.type !== 'MemberAccess' || !callee.property?.name) {
    return false
  }
  const methodName = callee.property.name
  if (!['route', 'get', 'post', 'put', 'delete', 'patch'].includes(methodName)) {
    return false
  }
  if (methodName !== 'patch') {
    return true
  }
  const firstArg = Array.isArray(decoratorObj.arguments) ? decoratorObj.arguments[0] : undefined
  return firstArg?.type === 'Literal' && typeof firstArg.value === 'string' && firstArg.value.startsWith('/')
}

/**
 * 检查装饰器是否为 Flask 应用级生命周期钩子（@app.before_request 等）
 * 形态：MemberAccess（无调用参数），property.name in FLASK_LIFECYCLE_HOOK_NAMES
 */
function isFlaskLifecycleHookDecorator(decoratorObj: any): boolean {
  if (!decoratorObj || decoratorObj.type !== 'MemberAccess') return false
  const propName: string | undefined = decoratorObj.property?.name
  if (!propName) return false
  return FLASK_LIFECYCLE_HOOK_NAMES.has(propName)
}

/**
 * 从所有文件的 AST 中收集类继承关系
 * 返回 Map<className, Set<parentClassName>>
 */
function buildClassInheritanceMap(filenameAstObj: FilenameAstMap): Map<string, Set<string>> {
  const inheritanceMap = new Map<string, Set<string>>()
  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!body) continue
    for (const obj of body) {
      if (obj.type !== 'ClassDefinition' || !obj.id?.name || !Array.isArray(obj.supers)) continue
      const className: string = obj.id.name
      if (!inheritanceMap.has(className)) {
        inheritanceMap.set(className, new Set())
      }
      const parents = inheritanceMap.get(className)!
      for (const s of obj.supers) {
        if (s.type === 'Identifier' && s.name) {
          parents.add(s.name)
        }
      }
    }
  }
  return inheritanceMap
}

const MAX_INHERITANCE_DEPTH = 10

/**
 * 递归检查 className 是否直接或间接继承自 CLASS_VIEW_BASE_NAMES
 */
function isTransitiveClassView(
  className: string,
  inheritanceMap: Map<string, Set<string>>,
  visited?: Set<string>
): boolean {
  if (CLASS_VIEW_BASE_NAMES.includes(className)) return true
  if (!visited) visited = new Set()
  if (visited.has(className) || visited.size >= MAX_INHERITANCE_DEPTH) return false
  visited.add(className)
  const parents = inheritanceMap.get(className)
  if (!parents) return false
  for (const parent of parents) {
    if (isTransitiveClassView(parent, inheritanceMap, visited)) return true
  }
  return false
}

/**
 * 检查类是否直接或间接继承自 REST 类视图基类（Resource / MethodView）
 */
function isClassBasedView(classNode: any, inheritanceMap: Map<string, Set<string>>): boolean {
  const className: string | undefined = classNode.id?.name
  if (!className) return false
  return isTransitiveClassView(className, inheritanceMap)
}

// 递归遍历 AST 的最大深度保护，避免病态 AST 导致栈溢出
const MAX_AST_TRAVERSAL_DEPTH = 64

interface FlaskLifespanAssignment {
  filename: string
  assignmentNode: any
}

interface FlaskCollectCtx {
  filename: string
  shortFileName: string
  inheritanceMap: Map<string, Set<string>>
  flaskEntryPointArray: (typeof EntryPoint)[]
  flaskEntryPointSourceArray: any[]
  flaskLifespanGlobalAssignments: FlaskLifespanAssignment[]
}

/**
 * 从 ScopedStatement / 语句数组中递归取出所有顶层 AssignmentExpression 节点
 * 兼容 Sequence 包装与裸 ScopedStatement 两种 AST 形态
 */
function collectAssignmentsFromBody(body: any, out: any[]): void {
  if (!body) return
  if (Array.isArray(body)) {
    for (const stmt of body) collectAssignmentsFromBody(stmt, out)
    return
  }
  if (typeof body !== 'object') return
  if (body.type === 'AssignmentExpression') {
    out.push(body)
    return
  }
  if (body.type === 'Sequence' && Array.isArray(body.expressions)) {
    for (const expr of body.expressions) collectAssignmentsFromBody(expr, out)
    return
  }
  if (body.type === 'ScopedStatement' && Array.isArray(body.body)) {
    for (const stmt of body.body) collectAssignmentsFromBody(stmt, out)
    return
  }
  if (Array.isArray(body.body)) {
    for (const stmt of body.body) collectAssignmentsFromBody(stmt, out)
  }
}

/**
 * 检测 FunctionDefinition 是否被 @app.before_request 等生命周期钩子装饰，
 * 命中则把 body 内对全局对象（如 g.x = ...）的赋值节点收集为 lifespan 赋值，
 * 由 python-taint-checker 在模块作用域预执行，使跨文件路由内的 g 属性能解析到正确类型链
 */
function tryRegisterLifecycleHook(node: any, ctx: FlaskCollectCtx): void {
  if (!node._meta?.decorators) return
  let hooked = false
  for (const decoratorObj of node._meta.decorators) {
    if (isFlaskLifecycleHookDecorator(decoratorObj)) {
      hooked = true
      break
    }
  }
  if (!hooked) return
  const assignments: any[] = []
  collectAssignmentsFromBody(node.body, assignments)
  for (const stmt of assignments) {
    // 仅收集左侧为 MemberAccess 形式（g.x = ...）或 Identifier 形式（local 赋值兜底）
    // 模块作用域执行后，全局 g 对象会被绑定 db / cu 等属性
    const left = stmt.left
    if (!left) continue
    if (left.type !== 'MemberAccess' && left.type !== 'Identifier') continue
    ctx.flaskLifespanGlobalAssignments.push({
      filename: ctx.filename,
      assignmentNode: stmt,
    })
  }
}

/**
 * 检测 FunctionDefinition 是否为 Flask 路由 handler，命中则注册为 entrypoint
 * 适用于模块顶层 def 与嵌套在工厂函数（register_routes/create_app）内的 inner def
 */
function tryRegisterRouteFunction(node: any, ctx: FlaskCollectCtx): void {
  if (!node.parameters || !node._meta?.decorators || !node.id?.name) return
  const funcName: string = node.id.name
  for (const decoratorObj of node._meta.decorators) {
    if (!isFlaskRouteDecorator(decoratorObj)) continue
    const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
    entryPoint.filePath = ctx.shortFileName
    entryPoint.functionName = funcName
    entryPoint.attribute = 'HTTP'
    // 携带函数定义行号，用于精确匹配 overloaded 同名函数
    entryPoint.funcLocStart = node.loc?.start?.line as number | undefined
    entryPoint.funcLocEnd = node.loc?.end?.line as number | undefined
    ctx.flaskEntryPointArray.push(entryPoint)

    if (entryPointAndSourceAtSameTime) {
      const paramSourceArray = findSourceOfFuncParam(ctx.filename, funcName, node, null)
      if (paramSourceArray) {
        ctx.flaskEntryPointSourceArray.push(...paramSourceArray)
      }
    }
    return
  }
}

/**
 * 处理类视图：在类 body 内枚举 HTTP 方法注册为 entrypoint
 */
function registerClassViewMethods(classNode: any, ctx: FlaskCollectCtx): void {
  const classBody = Array.isArray(classNode.body) ? classNode.body : []
  for (const member of classBody) {
    if (
      member.type !== 'FunctionDefinition' ||
      !member.id?.name ||
      !member.parameters
    ) {
      continue
    }
    const methodName: string = member.id.name
    if (!HTTP_METHODS.includes(methodName)) continue
    const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
    entryPoint.filePath = ctx.shortFileName
    entryPoint.functionName = methodName
    entryPoint.attribute = 'HTTP'
    // 携带函数定义行号，用于精确匹配 overloaded 同名方法
    entryPoint.funcLocStart = member.loc?.start?.line as number | undefined
    entryPoint.funcLocEnd = member.loc?.end?.line as number | undefined
    ctx.flaskEntryPointArray.push(entryPoint)

    if (entryPointAndSourceAtSameTime) {
      const paramSourceArray = findSourceOfFuncParam(ctx.filename, methodName, member, null)
      if (paramSourceArray) {
        ctx.flaskEntryPointSourceArray.push(...paramSourceArray)
      }
    }
  }
}

/**
 * 递归遍历 AST 节点，识别两类 Flask entrypoint：
 *   - 路径 A：装饰器路由函数 @app.route / @bp.get 等（含工厂函数 inner def）
 *   - 路径 B：类视图（继承 Resource / MethodView）的 HTTP 方法
 * 进入 FunctionDefinition / ClassDefinition body 后继续递归，覆盖嵌套注册场景
 */
function collectFlaskFromNode(node: any, ctx: FlaskCollectCtx, depth: number): void {
  if (depth > MAX_AST_TRAVERSAL_DEPTH) return
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) collectFlaskFromNode(child, ctx, depth + 1)
    return
  }
  if (typeof node !== 'object') return

  if (node.type === 'FunctionDefinition') {
    tryRegisterRouteFunction(node, ctx)
    tryRegisterLifecycleHook(node, ctx)
    if (Array.isArray(node.body)) {
      collectFlaskFromNode(node.body, ctx, depth + 1)
    } else if (node.body && typeof node.body === 'object') {
      // 部分 AST 实现将 function body 包成 BlockStatement 对象而非数组，递归进入
      collectFlaskFromNode(node.body, ctx, depth + 1)
    }
    return
  }

  if (node.type === 'ClassDefinition') {
    if (isClassBasedView(node, ctx.inheritanceMap)) {
      registerClassViewMethods(node, ctx)
    }
    // 继续递归类 body，覆盖类内嵌套 def 内再嵌套路由的少见模式
    if (Array.isArray(node.body)) {
      collectFlaskFromNode(node.body, ctx, depth + 1)
    } else if (node.body && typeof node.body === 'object') {
      collectFlaskFromNode(node.body, ctx, depth + 1)
    }
    return
  }

  if (Array.isArray(node.body)) {
    collectFlaskFromNode(node.body, ctx, depth + 1)
  } else if (node.body && typeof node.body === 'object') {
    collectFlaskFromNode(node.body, ctx, depth + 1)
  }
}

/**
 * 收集装饰器路由函数和类视图中的 HTTP 方法作为 entrypoint
 *
 * @param filenameAstObj
 * @param dir
 */
function findFlaskEntryPointAndSource(filenameAstObj: FilenameAstMap, dir: string) {
  const flaskEntryPointArray: (typeof EntryPoint)[] = []
  const flaskEntryPointSourceArray: any[] = []
  const flaskLifespanGlobalAssignments: FlaskLifespanAssignment[] = []
  const inheritanceMap = buildClassInheritanceMap(filenameAstObj)

  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!body) {
      continue
    }
    const shortFileName = extractRelativePath(filename, dir)
    const ctx: FlaskCollectCtx = {
      filename,
      shortFileName,
      inheritanceMap,
      flaskEntryPointArray,
      flaskEntryPointSourceArray,
      flaskLifespanGlobalAssignments,
    }
    collectFlaskFromNode(body, ctx, 0)
  }

  return { flaskEntryPointArray, flaskEntryPointSourceArray, flaskLifespanGlobalAssignments }
}

export = {
  findFlaskEntryPointAndSource,
}
