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

const ROUTE_DECORATORS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'route'])

//此函数用于提取字面量字符串
function extractLiteralString(node: any): string | null {
  if (!node) return null
  //如果node的类型是Literal，并且value的类型是string，则返回value
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value
  }
  //如果node的类型是VariableDeclaration，并且init存在，则递归调用extractLiteralString
  if (node.type === 'VariableDeclaration' && node.init) {
    return extractLiteralString(node.init)
  }
  //如果node的类型是Identifier，并且name是None，则返回null
  if (node.type === 'Identifier' && node.name === 'None') {
    return null
  }
  return null
}

function extractRouteParams(route: string | null): string[] {
  if (!route) return []
  const regex = /\{(.*?)\}/g
  const params: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(route)) !== null) {
    const name = match[1].split(':').pop()
    if (name) params.push(name)
  }
  return params
}

function findFastApiEntryPointAndSource(filenameAstObj: FilenameAstMap, dir: string) {
  const entryPoints: (typeof EntryPoint)[] = []
  const entryPointSources: any[] = []

  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!body) continue

    //此对象用于存储路由前缀
    const routerPrefixes: Record<string, string> = {}

    // 收集 APIRouter 前缀定义,如router = APIRouter(
    //prefix="/users",       # 路由前缀
    //tags=["用户模块"],       # 文档中分组标签
    //)
    for (const obj of body) {
      //如果obj的类型不是VariableDeclaration，则跳过
      //VariableDeclaration 是变量声明
      if (obj.type !== 'VariableDeclaration') continue
      //id.name实际中是routerName，例如router = APIRouter()，那么varName就是router
      const varName = obj.id?.name
      //init是函数调用，例如router = APIRouter()，那么init就是APIRouter()
      const init = obj.init
      //CallExpression 是函数调用
      if (!varName || !init || init.type !== 'CallExpression') continue
      //callee是函数调用，例如APIRouter()，那么callee就是APIRouter
      const callee = init.callee
      //如果callee的类型是Identifier（即标识符），并且name是APIRouter，则处理
      if (callee?.type === 'Identifier' && callee.name === 'APIRouter') {
        //prefix是路由前缀，例如prefix="/api"，那么prefix就是/api
        let prefix = ''
        //如果init的arguments存在，并且arguments的类型是数组，则遍历arguments
        if (Array.isArray(init.arguments)) {
          for (const arg of init.arguments) {
            //如果arg的类型是Literal，并且value的类型是string，则将value赋值给prefix
          
            if (arg.type === 'Literal' && typeof arg.value === 'string') {
              //arg.value是字面量字符串，例如"/users"，那么prefix就是/users
              prefix = arg.value
            }
            //如果arg的类型是VariableDeclaration，并且id的name是prefix，则递归调用extractLiteralString
            if (arg.type === 'VariableDeclaration' && arg.id?.name === 'prefix') {
              const value = extractLiteralString(arg.init)
              if (value) prefix = value
            }
          }
        }
        //将prefix赋值给routerPrefixes[varName]，例如routerPrefixes['router'] = '/users'
        routerPrefixes[varName] = prefix || ''
      }
    }

    // 处理 app.include_router(router, prefix="/xxx")，如app.include_router(user_router, prefix="/users")
    for (const obj of body) {
      if (obj.type !== 'ExpressionStatement') continue
      //expr是表达式，例如app.include_router(user_router, prefix="/users")，
      // 那么expr就是app.include_router(user_router, prefix="/users")
      const expr = obj.expression
      if (!expr || expr.type !== 'CallExpression') continue
      // callee就是app.include_router
      const callee = expr.callee
      //如果callee的类型不是MemberAccess，则跳过
      if (callee?.type !== 'MemberAccess') continue
      // 那么property就是include_router
      const property = callee.property?.name
      if (property !== 'include_router') continue
      // args就是[user_router, prefix="/users"]
      const args = expr.arguments || []
      // 这里args[0]就是user_router
      const routerArg = args[0]
      if (!routerArg || routerArg.type !== 'Identifier') continue
      const routerName = routerArg.name // routerName就是user_router
      // includePrefix是前缀，例如includePrefix = '/users'
      // 如果includePrefix存在，则将includePrefix赋值给routerPrefixes[routerName]，例如routerPrefixes['user_router'] = '/users'
      let includePrefix = ''
      for (let i = 1; i < args.length; i += 1) {
        const arg = args[i]
        if (arg?.type === 'VariableDeclaration' && arg.id?.name === 'prefix') {
          const val = extractLiteralString(arg.init)
          if (val) includePrefix = val
        }
      }
      // 如果includePrefix存在，则将includePrefix赋值给routerPrefixes[routerName]，例如routerPrefixes['user_router'] = '/users'
      if (includePrefix) {
        const existing = routerPrefixes[routerName] || ''
        routerPrefixes[routerName] = `${includePrefix}${existing}`
      }
    }

    // 处理函数定义
    // relativeFile是相对路径，例如relativeFile = 'app/api/users.py'
    const relativeFile = filename.startsWith(dir) ? extractRelativePath(filename, dir) : filename
    // 遍历body，body是文件的语句列表
    for (const obj of body) {
      if (
        obj.type !== 'FunctionDefinition' ||
        !obj._meta?.decorators ||
        !obj.id?.name
      ) {
        continue
      }
      // funcName是函数名，例如funcName = 'get_user'
      const funcName = obj.id.name
      // 遍历decorators，decorators是函数装饰器列表，
      // 例如@app.get("/users")，那么decorators就是[app.get]
      for (const decoratorObj of obj._meta.decorators) {
        if (decoratorObj.type !== 'CallExpression') continue
        const callee = decoratorObj.callee
        //MemberAccess是成员访问
        if (!callee || callee.type !== 'MemberAccess') continue
        const methodName = callee.property?.name // methodName就是get
        if (!methodName || !ROUTE_DECORATORS.has(methodName)) continue

        // routerName是路由名，例如routerName = 'user_router'
        let routerName = '' 
        //Identifier是标识符，例如callee.object.name = 'user_router'
        if (callee.object?.type === 'Identifier') {
          routerName = callee.object.name
        }

        // routePath是路由路径，例如routePath = '/users/{name}'
        const routePath = extractLiteralString(decoratorObj.arguments?.[0])

        // params是路由参数列表，例如params = ['name']
        const params = extractRouteParams(routePath) 
        // prefix是路由前缀，例如prefix = '/users'
        const prefix = routerPrefixes[routerName] || ''

        const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
        entryPoint.filePath = relativeFile//如entryPoint.filePath = 'app/api/users.py'
        entryPoint.functionName = funcName//如entryPoint.functionName = 'get_user'
        entryPoint.attribute = 'HTTP'//如entryPoint.attribute = 'HTTP'
        entryPoint.extra = {
          framework: 'fastapi',//如entryPoint.extra = { framework: 'fastapi', router: 'user_router', path: '/users/{name}' }
          router: routerName,//如entryPoint.extra = { framework: 'fastapi', router: 'user_router', path: '/users/{name}' }
          path: `${prefix}${routePath || ''}`,
        }//如entryPoint.extra = { framework: 'fastapi', router: 'user_router', path: '/users/{name}' }
        console.log('**************entryPoint,extra;***************', entryPoint.extra)
        entryPoints.push(entryPoint)

        //entryPointAndSourceAtSameTime是是否同时收集入口点和源代码
        if (entryPointAndSourceAtSameTime) {
          //paramSources是参数源代码
          const paramSources = findSourceOfFuncParam(relativeFile, funcName, obj, null)
          //relativefile是相对路径，例如relativeFile = 'app/api/users.py'
          if (filename !== relativeFile) {
            const additional = findSourceOfFuncParam(filename, funcName, obj, null)
            if (additional && additional.length) {
              entryPointSources.push(...additional)
            }
          }

          if (paramSources) {
            paramSources.forEach((source: any) => {
              source.scopeFile = 'all'
            })
            entryPointSources.push(...paramSources)
          }
          //如果params存在，并且params的类型是数组，则遍历params
          if (params.length > 0 && Array.isArray(obj.parameters)) {
            for (const param of obj.parameters) {
              const paramName = param.id?.name
              if (paramName && params.includes(paramName)) {
                entryPointSources.push({
                  introPoint: 4,
                  kind: 'PYTHON_INPUT',
                  path: paramName,
                  scopeFile: 'all',
                  scopeFunc: funcName,
                  locStart: param.loc?.start?.line,
                  locEnd: param.loc?.end?.line,
                  locColumnStart: param.loc?.start?.column,
                  locColumnEnd: param.loc?.end?.column,
                })
              }
            }
          }
        }
      }
    }
  }

  return { fastApiEntryPointArray: entryPoints, fastApiEntryPointSourceArray: entryPointSources }
}

export = {
  findFastApiEntryPointAndSource,
}
