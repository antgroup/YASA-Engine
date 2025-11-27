import { extractRelativePath } from '../../../../../util/file-util'
import * as Constant from '../../../../../util/constant'
import type { EntryPoint } from '../../../common/entrypoint'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../../../../../config')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PythonEntrypointSource = require('../../common/entrypoint-collector/python-entrypoint-source')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const EntryPointClass = require('../../../common/entrypoint')

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

interface EntryPointResult {
  fastApiEntryPointArray: EntryPoint[]
  fastApiEntryPointSourceArray: any[]
}

const ROUTE_DECORATORS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'route'])

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

  // Create entrypoint
  const entryPoint = new EntryPointClass(Constant.ENGIN_START_FUNCALL)
  entryPoint.filePath = relativeFile
  entryPoint.functionName = funcName
  entryPoint.attribute = 'HTTP'

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
  }
}

export = { findFastApiEntryPointAndSource }
