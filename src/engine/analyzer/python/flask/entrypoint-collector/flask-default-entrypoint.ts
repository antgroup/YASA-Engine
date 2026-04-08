const { extractRelativePath } = require('../../../../../util/file-util')
const { entryPointAndSourceAtSameTime } = require('../../../../../config')
const { findSourceOfFuncParam } = require('../../common/entrypoint-collector/python-entrypoint-source')
const EntryPoint = require('../../../common/entrypoint')
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
  return ['route', 'get', 'post', 'put', 'delete', 'patch'].includes(callee.property.name)
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

/**
 * 收集装饰器路由函数和类视图中的 HTTP 方法作为 entrypoint
 *
 * @param filenameAstObj
 * @param dir
 */
function findFlaskEntryPointAndSource(filenameAstObj: FilenameAstMap, dir: string) {
  const flaskEntryPointArray: (typeof EntryPoint)[] = []
  const flaskEntryPointSourceArray: any[] = []
  const inheritanceMap = buildClassInheritanceMap(filenameAstObj)

  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!body) {
      continue
    }
    const shortFileName = extractRelativePath(filename, dir)

    for (const obj of body) {
      // 路径 A：装饰器路由函数（@app.route / @bp.get 等）
      if (
        obj.type === 'FunctionDefinition' &&
        obj.parameters &&
        obj._meta?.decorators &&
        obj.id?.name
      ) {
        const funcName = obj.id.name
        for (const decoratorObj of obj._meta.decorators) {
          if (isFlaskRouteDecorator(decoratorObj)) {
            const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
            entryPoint.filePath = shortFileName
            entryPoint.functionName = funcName
            entryPoint.attribute = 'HTTP'
            flaskEntryPointArray.push(entryPoint)

            if (entryPointAndSourceAtSameTime) {
              const paramSourceArray = findSourceOfFuncParam(filename, funcName, obj, null)
              if (paramSourceArray) {
                flaskEntryPointSourceArray.push(...paramSourceArray)
              }
            }
            break
          }
        }
        continue
      }

      // 路径 B：类视图（继承 Resource / MethodView 的类中的 HTTP 方法）
      if (obj.type === 'ClassDefinition' && isClassBasedView(obj, inheritanceMap)) {
        const classBody = Array.isArray(obj.body) ? obj.body : []
        for (const member of classBody) {
          if (
            member.type !== 'FunctionDefinition' ||
            !member.id?.name ||
            !member.parameters
          ) {
            continue
          }
          const methodName = member.id.name
          if (!HTTP_METHODS.includes(methodName)) {
            continue
          }
          const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
          entryPoint.filePath = shortFileName
          entryPoint.functionName = methodName
          entryPoint.attribute = 'HTTP'
          flaskEntryPointArray.push(entryPoint)

          if (entryPointAndSourceAtSameTime) {
            const paramSourceArray = findSourceOfFuncParam(filename, methodName, member, null)
            if (paramSourceArray) {
              flaskEntryPointSourceArray.push(...paramSourceArray)
            }
          }
        }
      }
    }
  }

  return { flaskEntryPointArray, flaskEntryPointSourceArray }
}

export = {
  findFlaskEntryPointAndSource,
}
