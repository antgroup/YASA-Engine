import { extractRelativePath } from '../../../../../util/file-util'
import * as Constant from '../../../../../util/constant'
import type { EntryPoint } from '../../../common/entrypoint/entrypoint'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../../../../../config')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PythonEntrypointSource = require('./python-entrypoint-source')
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

interface FunctionToolEntryPointResult {
  functionToolEntryPointArray: EntryPoint[]
  functionToolEntryPointSourceArray: any[]
}

// 通用装饰器入口点识别的默认装饰器名列表
// 覆盖 OpenAI Agents SDK / LangChain / MCP / Flask 等主流框架
const DEFAULT_FUNCTION_TOOL_DECORATORS = ['function_tool', 'tool', 'mcp.tool', 'app.tool']

/**
 * 从配置读取装饰器名列表，未配置时用默认列表
 */
function getFunctionToolDecoratorNames(): string[] {
  const configured = config.pythonFunctionToolDecorators
  if (Array.isArray(configured) && configured.length > 0) {
    return configured
  }
  return DEFAULT_FUNCTION_TOOL_DECORATORS
}

/**
 * 从配置读取 collector 注册开关，默认 true
 */
function isFunctionToolCollectorEnabled(): boolean {
  const enabled = config.pythonFunctionToolCollectorEnabled
  return enabled !== false
}

/**
 * 提取装饰器的规范名
 * - Identifier: 返回 name
 * - MemberAccess: 返回 objectName.propertyName（如 mcp.tool）
 * - CallExpression: 取 callee 递归解析
 */
function resolveDecoratorName(deco: any): string | null {
  if (!deco) return null
  if (deco.type === 'Identifier' && typeof deco.name === 'string') {
    return deco.name
  }
  if (deco.type === 'MemberAccess') {
    const objectName = deco.object?.type === 'Identifier' ? deco.object.name : null
    const propertyName = deco.property?.type === 'Identifier' ? deco.property.name : null
    if (objectName && propertyName) {
      return `${objectName}.${propertyName}`
    }
    return propertyName
  }
  if (deco.type === 'CallExpression') {
    return resolveDecoratorName(deco.callee)
  }
  return null
}

/**
 * 解析 @function_tool(name_override="...") 装饰器的 name_override 参数
 * 用于把 entrypoint 的 functionName 设为 name_override 指定的值
 */
function extractNameOverride(deco: any): string | null {
  if (!deco || deco.type !== 'CallExpression' || !Array.isArray(deco.arguments)) {
    return null
  }
  for (const arg of deco.arguments) {
    if (!arg || arg.type !== 'VariableDeclaration' || arg.id?.type !== 'Identifier') continue
    if (arg.id.name === 'name_override' && arg.init?.type === 'Literal' && typeof arg.init.value === 'string') {
      return arg.init.value
    }
  }
  return null
}

/**
 * 通用装饰器入口点 collector
 *
 * 识别 @function_tool / @tool / @mcp.tool / @app.tool 装饰器为入口点，
 * 把被装饰函数加入 entrypoint 列表，参数标为 TaintSource。
 *
 * 装饰器名列表可配置（config.pythonFunctionToolDecorators），默认覆盖主流 agent tool 框架。
 * collector 注册开关：config.pythonFunctionToolCollectorEnabled（默认 true）。
 */
function findFunctionToolEntryPointAndSource(
  filenameAstObj: FilenameAstMap,
  dir: string
): FunctionToolEntryPointResult {
  const functionToolEntryPointArray: EntryPoint[] = []
  const functionToolEntryPointSourceArray: any[] = []

  if (!isFunctionToolCollectorEnabled()) {
    return { functionToolEntryPointArray, functionToolEntryPointSourceArray }
  }

  const decoratorNames = new Set(getFunctionToolDecoratorNames())

  for (const filename in filenameAstObj) {
    if (!Object.prototype.hasOwnProperty.call(filenameAstObj, filename)) continue
    const fileObj = filenameAstObj[filename]
    if (!fileObj?.body) continue

    const { body } = fileObj
    const relativeFile = filename.startsWith(dir) ? extractRelativePath(filename, dir) : filename
    if (!relativeFile) continue

    for (const obj of body) {
      if (!obj || typeof obj !== 'object') continue
      if (obj.type !== 'FunctionDefinition' || !obj._meta?.decorators || !obj.id?.name) continue

      const funcName = obj.id.name
      const { decorators } = obj._meta

      let matched = false
      let nameOverride: string | null = null
      for (const deco of decorators) {
        const decoName = resolveDecoratorName(deco)
        if (!decoName) continue
        if (!decoratorNames.has(decoName)) continue
        matched = true
        nameOverride = extractNameOverride(deco)
        break
      }
      if (!matched) continue

      const entryPoint = new EntryPointClass(Constant.ENGIN_START_FUNCALL) as EntryPoint
      entryPoint.filePath = relativeFile
      // entrypoint 匹配依赖 AST 函数名（fclos 索引按 node.id.name 构建）
      // name_override 是 OpenAI Agents SDK 对 LLM 暴露的工具名，不改变 Python 函数名
      entryPoint.functionName = funcName
      entryPoint.attribute = 'FunctionTool'
      entryPoint.funcLocStart = obj.loc?.start?.line as number | undefined
      entryPoint.funcLocEnd = obj.loc?.end?.line as number | undefined

      functionToolEntryPointArray.push(entryPoint)

      if (entryPointAndSourceAtSameTime) {
        // 被装饰函数的所有参数标为 TaintSource
        // name_override 存在时 scopeFunc 仍用真实函数名（与 AST 定义对应）
        const paramSources = findSourceOfFuncParam(filename, funcName, obj, undefined)
        if (paramSources) {
          functionToolEntryPointSourceArray.push(...paramSources)
        }
      }
    }
  }

  return { functionToolEntryPointArray, functionToolEntryPointSourceArray }
}

export = { findFunctionToolEntryPointAndSource }
