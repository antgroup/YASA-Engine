import { extractRelativePath } from '../../../../../util/file-util'
import * as Constant from '../../../../../util/constant'
import type { EntryPoint } from '../../../common/entrypoint/entrypoint'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../../../../../config')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PythonEntrypointSource = require('../../common/entrypoint-collector/python-entrypoint-source')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const EntryPointClass = require('../../../common/entrypoint/entrypoint')

const { entryPointAndSourceAtSameTime } = config
const { findSourceOfFuncParam } = PythonEntrypointSource

interface ASTObject {
  body?: any[]
  [key: string]: any
}

interface FilenameAstMap {
  [filename: string]: ASTObject
}

interface ValidInstances {
  validFastApiInstances: Set<string>
  validRouterInstances: Set<string>
}

interface LifespanAssignment {
  filename: string
  assignmentNode: any
}

interface EntryPointResult {
  fastApiEntryPointArray: EntryPoint[]
  fastApiEntryPointSourceArray: any[]
  lifespanGlobalAssignments: LifespanAssignment[]
}

const ROUTE_DECORATORS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'route', 'websocket'])

/**
 * Extracts literal string value.
 * @param node AST node
 * @returns {string | null} String value or null
 */
function extractLiteralString(node: any): string | null {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value
  }
  return null
}

/**
 * Extracts variable name and init expression.
 * @param obj AST node
 * @returns {{ varName?: string; init?: any } | null} Variable info or null
 */
function extractVarNameAndInit(obj: any): { varName?: string; init?: any } | null {
  if (obj.type === 'AssignmentExpression' && obj.operator === '=' && obj.left?.type === 'Identifier') {
    return { varName: obj.left.name, init: obj.right }
  }
  return null
}

/**
 * Analyzes imports to build name map.
 * @param body AST body
 * @returns {Map<string, string>} Import name map
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
function analyzeImports(body: any[]): Map<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(body)) return map

  for (const obj of body) {
    if (!obj || typeof obj !== 'object') continue

    if (obj.type === 'VariableDeclaration' && obj.init?.type === 'ImportExpression') {
      const importExpr = obj.init
      const localName = obj.id?.name
      if (!localName) continue

      const fromValue = extractLiteralString(importExpr.from)
      const importedName = importExpr.imported?.name // Identifier

      if (fromValue) {
        // from ... import ...
        if ((fromValue === 'fastapi' || fromValue.startsWith('fastapi.')) && importedName) {
          // Use full path: fastapi.responses.ORJSONResponse instead of fastapi.ORJSONResponse
          const canonicalName = fromValue === 'fastapi' ? `fastapi.${importedName}` : `${fromValue}.${importedName}`
          map.set(localName, canonicalName)
        }
      } else if (importedName === 'fastapi') {
        // import fastapi
        map.set(localName, 'fastapi')
      }
    }
  }
  return map
}

/**
 * Resolves canonical name from node.
 * @param node AST node
 * @param importMap Import map
 * @returns {string | null} Canonical name or null
 */
function resolveCanonicalName(node: any, importMap: Map<string, string>): string | null {
  if (!node) return null
  if (node.type === 'Identifier') {
    return importMap.get(node.name) || null
  }
  if (node.type === 'MemberAccess') {
    const objectCanonical = resolveCanonicalName(node.object, importMap)
    const propertyName = node.property?.name
    if (objectCanonical && propertyName) {
      return `${objectCanonical}.${propertyName}`
    }
  }
  return null
}

/**
 * Collects valid FastAPI instances.
 * @param body AST body
 * @param importMap Import map
 * @returns {ValidInstances} Valid instances
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
function collectValidInstances(body: any[], importMap: Map<string, string>): ValidInstances {
  const validFastApiInstances = new Set<string>()
  const validRouterInstances = new Set<string>()

  for (const obj of body) {
    if (!obj || typeof obj !== 'object') continue

    // Only process AssignmentExpression
    if (obj.type === 'AssignmentExpression' && obj.operator === '=') {
      const varInfo = extractVarNameAndInit(obj)
      if (!varInfo?.varName || !varInfo.init) continue

      if (varInfo.init.type === 'CallExpression') {
        const canonical = resolveCanonicalName(varInfo.init.callee, importMap)
        if (canonical && canonical.startsWith('fastapi')) {
          if (canonical.endsWith('.FastAPI')) {
            validFastApiInstances.add(varInfo.varName)
          } else if (canonical.endsWith('.APIRouter')) {
            validRouterInstances.add(varInfo.varName)
          }
        }
      }
    }
  }
  return { validFastApiInstances, validRouterInstances }
}

/**
 * 从 AST 节点的 id 字段提取变量名。
 * UAST 中 VariableDeclaration 的 id 可能是字符串（global 声明）或 Identifier 对象。
 */
function extractIdName(id: any): string | undefined {
  if (typeof id === 'string') return id
  if (id?.name) return id.name
  return undefined
}

/**
 * 从 FastAPI lifespan 回调中提取全局变量赋值节点。
 * FastAPI(lifespan=xxx) 模式中，xxx 函数的 global 变量赋值需在模块作用域执行。
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
function extractLifespanAssignments(
  body: any[],
  importMap: Map<string, string>,
  filename: string,
  result: LifespanAssignment[]
): void {
  // 收集所有 FastAPI(..., lifespan=xxx) 中的 lifespan 函数名
  const lifespanFuncNames = new Set<string>()
  for (const obj of body) {
    if (obj?.type !== 'AssignmentExpression' || obj?.right?.type !== 'CallExpression') continue
    const canonical = resolveCanonicalName(obj.right.callee, importMap)
    if (!canonical || !canonical.endsWith('.FastAPI')) continue
    const args = obj.right.arguments
    if (!Array.isArray(args)) continue
    for (const arg of args) {
      if (arg?.type === 'VariableDeclaration' && arg.id?.name === 'lifespan' && arg.init?.type === 'Identifier') {
        lifespanFuncNames.add(arg.init.name)
      }
    }
  }
  if (lifespanFuncNames.size === 0) return

  // 查找 lifespan 函数定义，提取 global 变量赋值
  for (const obj of body) {
    if (obj?.type !== 'FunctionDefinition' || !lifespanFuncNames.has(obj.id?.name)) continue
    const fnBody = obj.body?.body
    if (!Array.isArray(fnBody)) continue

    // 收集 global 声明的变量名（id 可能是字符串或 Identifier 对象）
    const globalVarNames = new Set<string>()
    for (const stmt of fnBody) {
      if (stmt?.type === 'Sequence' && Array.isArray(stmt.expressions)) {
        for (const expr of stmt.expressions) {
          if (expr?.type === 'VariableDeclaration') {
            const name = extractIdName(expr.id)
            if (name) globalVarNames.add(name)
          }
        }
      }
      // global 声明只有一个变量时可能是单个 VariableDeclaration
      if (stmt?.type === 'VariableDeclaration') {
        const name = extractIdName(stmt.id)
        if (name) globalVarNames.add(name)
      }
    }
    if (globalVarNames.size === 0) continue

    // 收集对 global 变量的赋值节点
    for (const stmt of fnBody) {
      if (
        stmt?.type === 'AssignmentExpression' &&
        stmt.operator === '=' &&
        stmt.left?.type === 'Identifier' &&
        globalVarNames.has(stmt.left.name)
      ) {
        result.push({ filename, assignmentNode: stmt })
      }
    }
  }
}

/**
 * Processes decorator for entry points.
 * @param deco Decorator node
 * @param funcName Function name
 * @param obj Function node
 * @param relativeFile Relative file path
 * @param filename Absolute file path
 * @param validInstances Valid instances
 * @param entryPoints Entry points array
 * @param entryPointSources Sources array
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
function processDecorator(
  deco: any,
  funcName: string,
  obj: any,
  relativeFile: string,
  filename: string,
  validInstances: ValidInstances,
  entryPoints: EntryPoint[],
  entryPointSources: any[]
): void {
  if (!deco || deco.type !== 'CallExpression') return
  const { callee } = deco

  if (!callee || callee.type !== 'MemberAccess') return

  const methodName = callee.property?.name
  if (!methodName || !ROUTE_DECORATORS.has(methodName)) return

  // Get router or app name
  let routerName = ''
  if (callee.object?.type === 'Identifier') {
    routerName = callee.object.name
  }

  // Validate router/app
  const { validFastApiInstances, validRouterInstances } = validInstances
  const isValidRouter = validFastApiInstances.has(routerName) || validRouterInstances.has(routerName)

  if (!isValidRouter) return

  // 创建 entrypoint，携带函数定义行号用于精确匹配 overloaded 同名函数
  const entryPoint = new EntryPointClass(Constant.ENGIN_START_FUNCALL)
  entryPoint.filePath = relativeFile
  entryPoint.functionName = funcName
  entryPoint.attribute = 'HTTP'
  entryPoint.funcLocStart = obj.loc?.start?.line as number | undefined
  entryPoint.funcLocEnd = obj.loc?.end?.line as number | undefined

  entryPoints.push(entryPoint)

  if (entryPointAndSourceAtSameTime) {
    const paramSources = findSourceOfFuncParam(filename, funcName, obj, undefined)

    if (paramSources) {
      entryPointSources.push(...paramSources)
    }
  }
}

/**
 * Finds FastAPI entry points and sources.
 * @param filenameAstObj Filename to AST map
 * @param dir Root directory
 * @returns {EntryPointResult} Entry points and sources
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
function findFastApiEntryPointAndSource(filenameAstObj: FilenameAstMap, dir: string): EntryPointResult {
  const entryPoints: EntryPoint[] = []
  const entryPointSources: any[] = []
  const lifespanGlobalAssignments: LifespanAssignment[] = []

  for (const filename in filenameAstObj) {
    if (!Object.prototype.hasOwnProperty.call(filenameAstObj, filename)) continue
    const fileObj = filenameAstObj[filename]
    if (!fileObj?.body) continue

    // Calculate relative path
    const { body } = fileObj
    const relativeFile = filename.startsWith(dir) ? extractRelativePath(filename, dir) : filename

    if (!relativeFile) continue

    const importMap = analyzeImports(body)

    // Only scan if core components (FastAPI or APIRouter) are imported
    // Only scan if core components (FastAPI or APIRouter) are imported
    let hasCoreImport = false
    for (const val of importMap.values()) {
      if (
        val === 'fastapi' ||
        (val.startsWith('fastapi') && (val.endsWith('.FastAPI') || val.endsWith('.APIRouter')))
      ) {
        hasCoreImport = true
        break
      }
    }
    if (!hasCoreImport) continue

    const validInstances = collectValidInstances(body, importMap)

    // 提取 lifespan 回调中的全局变量赋值
    extractLifespanAssignments(body, importMap, filename, lifespanGlobalAssignments)

    for (const obj of body) {
      if (!obj || typeof obj !== 'object') continue

      if (obj.type === 'FunctionDefinition' && obj._meta?.decorators && obj.id?.name) {
        const funcName = obj.id.name
        const { decorators } = obj._meta

        for (const deco of decorators) {
          processDecorator(deco, funcName, obj, relativeFile, filename, validInstances, entryPoints, entryPointSources)
        }
      }
    }
  }

  return {
    fastApiEntryPointArray: entryPoints,
    fastApiEntryPointSourceArray: entryPointSources,
    lifespanGlobalAssignments,
  }
}

export = { findFastApiEntryPointAndSource }

