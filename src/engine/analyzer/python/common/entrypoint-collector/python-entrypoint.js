const { findFlaskEntryPointAndSource } = require('../../flask/entrypoint-collector/flask-default-entrypoint')
const {
  findInferenceTritonEntryPointAndSource,
} = require('../../inference/entrypoint-collector/inference-default-entrypoint')
const { findMcpEntryPointAndSource } = require('../../mcp/entrypoint-collector/mcp-default-entrypoint')
const Rules = require('../../../../../checker/common/rules-basic-handler')

/**
 *
 * @param dir
 * @param fileManager
 */
function findPythonFcEntryPointAndSource(dir, fileManager) {
  const pyFcEntryPointArray = []
  const pyFcEntryPointSourceArray = []
  const filenameAstObj = {}
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
function findPythonFileEntryPoint(fileManager) {
  return fileManager
}

/**
 *
 */
function getSourceNameList() {
  const sourceNameList = []
  const sourceList = Rules.getRules()?.TaintSource
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

module.exports = {
  findPythonFcEntryPointAndSource,
  findPythonFileEntryPoint,
  getSourceNameList,
}
