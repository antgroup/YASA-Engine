const { findFlaskEntryPointAndSource } = require('../../flask/entrypoint-collector/flask-default-entrypoint')
const {
  findInferenceAiStudioTplEntryPointAndSource,
  findInferenceTritonEntryPointAndSource,
} = require('../../inference/entrypoint-collector/inference-default-entrypoint')
const { findMcpEntryPointAndSource } = require('../../mcp/entrypoint-collector/mcp-default-entrypoint')
const BasicRuleHandler = require('../../../../../checker/common/rules-basic-handler')

type FileManager = Record<string, any>

interface FindEntryPointResult {
  pyFcEntryPointArray: any[]
  pyFcEntryPointSourceArray: any[]
}

/**
 *
 * @param dir
 * @param fileManager
 */
function findPythonFcEntryPointAndSource(dir: string, fileManager: FileManager): FindEntryPointResult {
  const pyFcEntryPointArray: any[] = []
  const pyFcEntryPointSourceArray: any[] = []
  const filenameAstObj: Record<string, any> = {}
  for (const filename in fileManager) {
    const modClos = fileManager[filename]
    if (modClos.hasOwnProperty('ast')) {
      filenameAstObj[filename] = modClos.ast
    }
  }

  const { flaskEntryPointArray, flaskEntryPointSourceArray } = findFlaskEntryPointAndSource(filenameAstObj, dir)
  if (flaskEntryPointArray) {
    pyFcEntryPointArray.push(...flaskEntryPointArray)
  }
  if (flaskEntryPointSourceArray) {
    pyFcEntryPointSourceArray.push(...flaskEntryPointSourceArray)
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

export = {
  findPythonFcEntryPointAndSource,
  findPythonFileEntryPoint,
  getSourceNameList,
}
