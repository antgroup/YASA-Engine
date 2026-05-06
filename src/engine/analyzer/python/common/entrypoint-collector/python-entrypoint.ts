const { findFlaskEntryPointAndSource } = require('../../flask/entrypoint-collector/flask-default-entrypoint')
const { findFastApiEntryPointAndSource } = require('../../fastapi/entrypoint-collector/fastapi-entrypoint')
const {
  findInferenceAiStudioTplEntryPointAndSource,
  findInferenceTritonEntryPointAndSource,
} = require('../../inference/entrypoint-collector/inference-default-entrypoint')
const { findMcpEntryPointAndSource } = require('../../mcp/entrypoint-collector/mcp-default-entrypoint')
const { findHttpServerEntryPointAndSource } = require('../../httpserver/entrypoint-collector/httpserver-entrypoint')
const BasicRuleHandler = require('../../../../../checker/common/rules-basic-handler')
const { loadPythonDefaultRule } = require('../../../../../checker/taint/python/python-taint-abstract-checker')
const AstUtil = require('../../../../../util/ast-util')

type FileManager = Record<string, any>

interface FindEntryPointResult {
  pyFcEntryPointArray: any[]
  pyFcEntryPointSourceArray: any[]
}

/**
 *
 * @param dir
 * @param fileManager
 * @param analyzer
 */
function findPythonFcEntryPointAndSource(dir: string, fileManager: FileManager, analyzer: any): FindEntryPointResult {
  const pyFcEntryPointArray: any[] = []
  const pyFcEntryPointSourceArray: any[] = []
  const filenameAstObj: Record<string, any> = {}
  for (const filename in fileManager) {
    const fileEntry = fileManager[filename]
    if (fileEntry?.astNode?._meta?.nodehash !== undefined) {
      filenameAstObj[filename] = fileEntry.astNode
    }
  }


  const { flaskEntryPointArray, flaskEntryPointSourceArray } = findFlaskEntryPointAndSource(filenameAstObj, dir)
  if (flaskEntryPointArray) {
    pyFcEntryPointArray.push(...flaskEntryPointArray)
  }
  if (flaskEntryPointSourceArray) {
    pyFcEntryPointSourceArray.push(...flaskEntryPointSourceArray)
  }

  const { fastApiEntryPointArray, fastApiEntryPointSourceArray } = findFastApiEntryPointAndSource(filenameAstObj, dir)
  if (fastApiEntryPointArray) {
    pyFcEntryPointArray.push(...fastApiEntryPointArray)
  }
  if (fastApiEntryPointSourceArray) {
    pyFcEntryPointSourceArray.push(...fastApiEntryPointSourceArray)
  }

  const { inferenceAiStudioTplEntryPointArray, inferenceAiStudioTplEntryPointSourceArray } =
    findInferenceAiStudioTplEntryPointAndSource(filenameAstObj, dir)
  if (inferenceAiStudioTplEntryPointArray) {
    pyFcEntryPointArray.push(...inferenceAiStudioTplEntryPointArray)
  }
  if (inferenceAiStudioTplEntryPointSourceArray) {
    pyFcEntryPointSourceArray.push(...inferenceAiStudioTplEntryPointSourceArray)
  }

  const { inferenceTritonEntryPointArray, inferenceTritonEntryPointSourceArray } =
    findInferenceTritonEntryPointAndSource(filenameAstObj, dir)
  if (inferenceTritonEntryPointArray) {
    pyFcEntryPointArray.push(...inferenceTritonEntryPointArray)
  }
  if (inferenceTritonEntryPointSourceArray) {
    pyFcEntryPointSourceArray.push(...inferenceTritonEntryPointSourceArray)
  }

  const { mcpEntryPointArray, mcpEntryPointSourceArray } = findMcpEntryPointAndSource(filenameAstObj, dir)
  if (mcpEntryPointArray) {
    pyFcEntryPointArray.push(...mcpEntryPointArray)
  }
  if (mcpEntryPointSourceArray) {
    pyFcEntryPointSourceArray.push(...mcpEntryPointSourceArray)
  }

  const { httpServerEntryPointArray, httpServerEntryPointSourceArray } = findHttpServerEntryPointAndSource(
    filenameAstObj,
    dir
  )
  if (httpServerEntryPointArray) {
    pyFcEntryPointArray.push(...httpServerEntryPointArray)
  }
  if (httpServerEntryPointSourceArray) {
    pyFcEntryPointSourceArray.push(...httpServerEntryPointSourceArray)
  }

  return { pyFcEntryPointArray, pyFcEntryPointSourceArray }
}

/**
 *
 * @param fileManager
 * @returns {*}
 */
function findPythonFileEntryPoint(fileManager: FileManager): FileManager {
  return fileManager
}

/**
 *
 */
function getSourceNameList(): string[] {
  const sourceNameList: string[] = []

  const sourceList: any[] = []
  if (Array.isArray(BasicRuleHandler.getRules()) && BasicRuleHandler.getRules().length > 0) {
    for (const rule of BasicRuleHandler.getRules()) {
      if (Array.isArray(rule.sources?.TaintSource)) {
        sourceList.push(...rule.sources.TaintSource)
      }
    }
  }
  const defaultRule = loadPythonDefaultRule()
  if (Array.isArray(defaultRule) && defaultRule.length > 0) {
    for (const rule of defaultRule) {
      if (Array.isArray(rule.sources?.TaintSource)) {
        sourceList.push(...rule.sources.TaintSource)
      }
    }
  }
  if (!sourceList) {
    return sourceNameList
  }
  for (const source of sourceList) {
    if (sourceNameList.includes(source.path)) {
      continue
    }
    sourceNameList.push(source.path)
  }
  return sourceNameList
}

/**
 * 构建 fclos 索引
 * 遍历 moduleManager 一次，建立 (filePath, functionName) -> fclos[] 的映射
 * 用于加速后续的 entrypoint 查找
 * 
 * @param moduleManager 模块管理器
 * @param dir 基础目录
 * @param extractRelativePath 路径提取函数
 * @returns fclos 索引 Map
 */
function buildFclosIndex(
  moduleManager: any,
  dir: string,
  extractRelativePath: (path: string, dir: string) => string | null
): Map<string, any[]> {
  // 一次性遍历所有 fclos
  const allFclos = AstUtil.satisfy(
    moduleManager,
    (n: any) => n.vtype === 'fclos',
    (node: any, prop: any) => prop === '_field',
    null,
    true
  )

  // 构建索引：(filePath + '::' + functionName) -> fclos[]
  const fclosIndex = new Map<string, any[]>()

  if (Array.isArray(allFclos)) {
    for (const fclos of allFclos) {
      const sourcefile = extractRelativePath(fclos?.ast?.node?.loc?.sourcefile, dir)
      const funcName = fclos?.ast?.node?.id?.name
      
      // 构建复合 key，需要区分 null, undefined, 空字符串和正常字符串
      let fileKey
      if (sourcefile === null) {
        fileKey = '@@NULL@@'
      } else if (sourcefile === undefined) {
        fileKey = '@@UNDEFINED@@'
      } else {
        fileKey = sourcefile  // 保留空字符串和正常字符串
      }
      
      const funcKey = funcName === null ? '@@NULL@@' : (funcName === undefined ? '@@UNDEFINED@@' : funcName)
      const compositeKey = `${fileKey}::${funcKey}`
      
      if (!fclosIndex.has(compositeKey)) {
        fclosIndex.set(compositeKey, [])
      }
      fclosIndex.get(compositeKey)!.push(fclos)
    }
  }

  return fclosIndex
}

/**
 * 从索引中查找 fclos
 * 
 * @param fclosIndex fclos 索引
 * @param filePath 文件路径
 * @param functionName 函数名
 * @returns fclos 数组或 undefined
 */
function lookupFclos(
  fclosIndex: Map<string, any[]>,
  filePath: string | null | undefined,
  functionName: string
): any[] | undefined {
  // 与 buildFclosIndex 保持完全一致的 key 构建逻辑
  let fileKey
  if (filePath === null) {
    fileKey = '@@NULL@@'
  } else if (filePath === undefined) {
    fileKey = '@@UNDEFINED@@'
  } else {
    fileKey = filePath  // 保留空字符串和正常字符串
  }
  
  const funcKey = functionName === null ? '@@NULL@@' : (functionName === undefined ? '@@UNDEFINED@@' : functionName)
  const compositeKey = `${fileKey}::${funcKey}`
  
  return fclosIndex.get(compositeKey)
}

export = {
  findPythonFcEntryPointAndSource,
  findPythonFileEntryPoint,
  getSourceNameList,
  buildFclosIndex,
  lookupFclos,
}
