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

/**
 * 
 * @param {any} node
 * @returns {string | null}
 */
function extractLiteralString(node: any): string | null {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value
  }
  return null
}

/**
 *
 * @param {string | null} route
 * @returns {string[]}
 */
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

/**
 *
 * @param {any} obj
 * @returns {{ varName?: string; init?: any } | null}
 */
function extractVarNameAndInit(obj: any): { varName?: string; init?: any } | null {
  try {
    if (obj.type === 'AssignmentExpression' && obj.operator === '=') {
      if (obj.left?.type === 'Identifier') {
        return { varName: obj.left.name, init: obj.right }
      }
    }
  } catch (error) {
    // 忽略解析错误
  }
  return null
}

/**
 *
 * @param {any} body
 * @returns {{ hasFastAPI: boolean; hasAPIRouter: boolean; importedNames: Set<string> }}
 */
function checkFastApiImports(body: any[]): { hasFastAPI: boolean; hasAPIRouter: boolean; importedNames: Set<string> } {
  const importedNames = new Set<string>()
  let hasFastAPI = false
  let hasAPIRouter = false

  if (!Array.isArray(body)) {
    return { hasFastAPI, hasAPIRouter, importedNames }
  }

  const addImportedName = (name?: string) => {
    if (!name) return
    importedNames.add(name)
    if (name === 'FastAPI') {
      hasFastAPI = true
    }
    if (name === 'APIRouter') {
      hasAPIRouter = true
    }
  }

  for (const obj of body) {
    if (!obj || typeof obj !== 'object') continue

    if (obj.type === 'VariableDeclaration' && obj.init?.type === 'ImportExpression') {
      const importExpr = obj.init
      const fromValue = extractLiteralString(importExpr.from)
      if (fromValue === 'fastapi') {
        if (importExpr.imported?.type === 'Identifier' && importExpr.imported.name) {
          addImportedName(importExpr.imported.name)
        }
      }
    }
  }

  return { hasFastAPI, hasAPIRouter, importedNames }
}

/**
 *
 * @param {any} callExpr
 * @param {Set<string>} importedNames
 * @returns {'FastAPI' | 'APIRouter' | null}
 */
function isFastApiOrRouterCall(callExpr: any, importedNames: Set<string>): 'FastAPI' | 'APIRouter' | null {
  if (!callExpr || callExpr.type !== 'CallExpression') return null

  const callee = callExpr.callee
  if (!callee) return null

  // 检查是否是 Identifier（直接调用 FastAPI() 或 APIRouter()）
  if (callee.type === 'Identifier') {
    const name = callee.name
    if (name === 'FastAPI' && importedNames.has('FastAPI')) {
      return 'FastAPI'
    }
    if (name === 'APIRouter' && importedNames.has('APIRouter')) {
      return 'APIRouter'
    }
  }

  return null
}

/**
 *
 * @param {FilenameAstMap} filenameAstObj
 * @param {string} dir
 * @returns {{ fastApiEntryPointArray: EntryPoint[]; fastApiEntryPointSourceArray: any[] }}
 */
function findFastApiEntryPointAndSource(filenameAstObj: FilenameAstMap, dir: string) {
  const entryPoints: (typeof EntryPoint)[] = []
  const entryPointSources: any[] = []

  for (const filename in filenameAstObj) {
    const fileObj = filenameAstObj[filename]
    if (!fileObj?.body) continue

    // 计算相对路径
    const body = fileObj.body
    const relativeFile = filename.startsWith(dir)
      ? extractRelativePath(filename, dir)
      : filename

    const { hasFastAPI, hasAPIRouter, importedNames } = checkFastApiImports(body)
    if (!hasFastAPI && !hasAPIRouter) {
      continue
    }

    const validFastApiInstances = new Set<string>()
    const validRouterInstances = new Set<string>()

    for (const obj of body) {
      if (!obj || typeof obj !== 'object') continue

      // 只处理 AssignmentExpression（新版本 UAST）
      if (obj.type === 'AssignmentExpression' && obj.operator === '=') {
        const varInfo = extractVarNameAndInit(obj)
        if (!varInfo?.varName || !varInfo.init) continue

        const callType = isFastApiOrRouterCall(varInfo.init, importedNames)
        if (callType === 'FastAPI') {
          validFastApiInstances.add(varInfo.varName)
        } else if (callType === 'APIRouter') {
          validRouterInstances.add(varInfo.varName)
        }
      }
    }

    for (const obj of body) {
      if (!obj || typeof obj !== 'object') continue

      if (obj.type === 'FunctionDefinition' && obj._meta?.decorators && obj.id?.name) {
        const funcName = obj.id.name
        const decorators = obj._meta.decorators

        for (const deco of decorators) {
          if (!deco || deco.type !== 'CallExpression') continue
          const callee = deco.callee

          if (!callee || callee.type !== 'MemberAccess') continue

          const methodName = callee.property?.name
          if (!methodName || !ROUTE_DECORATORS.has(methodName)) continue

          // 获取装饰器对象名（router 或 app）
          let routerName = ''
          if (callee.object?.type === 'Identifier') {
            routerName = callee.object.name
          }

          // 验证装饰器对象是否有效
          // 1. 如果是 FastAPI 实例（如 app）
          // 2. 或者是已注册的 APIRouter 实例（如 user_router）
          const isValidRouter =
            validFastApiInstances.has(routerName) || validRouterInstances.has(routerName)

          if (!isValidRouter) {
            // 装饰器对象无效，跳过
            continue
          }

          // 装饰器有效，创建 entrypoint
          const routePath = extractLiteralString(deco.arguments?.[0])
          const params = extractRouteParams(routePath)

          const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
          entryPoint.filePath = relativeFile
          entryPoint.functionName = funcName
          entryPoint.attribute = 'HTTP'

          entryPoints.push(entryPoint)

          if (entryPointAndSourceAtSameTime) {
            const paramSources = findSourceOfFuncParam(relativeFile, funcName, obj, null)

            if (filename !== relativeFile) {
              const extra = findSourceOfFuncParam(filename, funcName, obj, null)
              if (extra?.length) entryPointSources.push(...extra)
            }

            if (paramSources) {
              for (const s of paramSources) s.scopeFile = 'all'
              entryPointSources.push(...paramSources)
            }

            if (params.length && Array.isArray(obj.parameters)) {
              for (const p of obj.parameters) {
                const pn = p.id?.name
                if (pn && params.includes(pn)) {
                  entryPointSources.push({
                    introPoint: 4,
                    kind: 'PYTHON_INPUT',
                    path: pn,
                    scopeFile: 'all',
                    scopeFunc: funcName,
                    locStart: p.loc?.start?.line,
                    locEnd: p.loc?.end?.line,
                    locColumnStart: p.loc?.start?.column,
                    locColumnEnd: p.loc?.end?.column,
                  })
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    fastApiEntryPointArray: entryPoints,
    fastApiEntryPointSourceArray: entryPointSources,
}
}

export = { findFastApiEntryPointAndSource }
