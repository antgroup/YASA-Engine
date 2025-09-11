const { extractRelativePath } = require('../../../../../util/file-util')
const EntryPoint = require('../../../common/entrypoint')
const constValue = require('../../../../../util/constant')
const { entryPointAndSourceAtSameTime } = require('../../../../../config')
const { findSourceOfFuncParam } = require('../../common/entrypoint-collector/python-entrypoint-source')

/**
 *
 * @param filenameAstObj
 * @param dir
 * @returns {{inferenceAiStudioTplEntryPointArray: *[], inferenceAiStudioTplEntryPointSourceArray: *[]}}
 */
function findInferenceAiStudioTplEntryPointAndSource(filenameAstObj, dir) {
  const inferenceAiStudioTplEntryPointArray = []
  const inferenceAiStudioTplEntryPointSourceArray = []

  const paramIndexArray = []
  paramIndexArray.push(0)

  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!body) {
      continue
    }
    for (const obj of body) {
      if (obj.type !== 'ClassDefinition' || !obj.body) {
        continue
      }

      let classMatch = false
      if (obj.id?.name === 'UserHandler') {
        classMatch = true
      } else if (obj.supers) {
        for (const superCls of obj.supers) {
          if (superCls.name === 'MayaBaseHandler') {
            classMatch = true
            break
          }
        }
      }
      if (!classMatch) {
        continue
      }

      for (const bodyObj of obj.body) {
        if (bodyObj.type !== 'FunctionDefinition') {
          continue
        }
        if (bodyObj.id?.name === 'predict_np') {
          const shortFileName = extractRelativePath(filename, dir)
          const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
          entryPoint.filePath = shortFileName
          entryPoint.functionName = 'predict_np'
          entryPoint.attribute = 'HTTP'
          inferenceAiStudioTplEntryPointArray.push(entryPoint)

          if (entryPointAndSourceAtSameTime) {
            const paramSourceArray = findSourceOfFuncParam(filename, 'predict_np', bodyObj, paramIndexArray)
            if (paramSourceArray) {
              inferenceAiStudioTplEntryPointSourceArray.push(...paramSourceArray)
            }
          }
        }
      }
    }
  }

  return { inferenceAiStudioTplEntryPointArray, inferenceAiStudioTplEntryPointSourceArray }
}

/**
 *
 * @param filenameAstObj
 * @param dir
 */
function findInferenceTritonEntryPointAndSource(filenameAstObj, dir) {
  const inferenceTritonEntryPointArray = []
  const inferenceTritonEntryPointSourceArray = []

  const paramIndexArray = []
  paramIndexArray.push(0)

  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!body) {
      continue
    }
    for (const obj of body) {
      if (obj.type !== 'ClassDefinition' || !obj.body) {
        continue
      }

      let classMatch = false
      if (obj.id?.name === 'TritonPythonModel') {
        classMatch = true
      }
      if (!classMatch) {
        continue
      }

      for (const bodyObj of obj.body) {
        if (bodyObj.type !== 'FunctionDefinition') {
          continue
        }
        if (bodyObj.id?.name === 'execute') {
          const shortFileName = extractRelativePath(filename, dir)
          const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
          entryPoint.filePath = shortFileName
          entryPoint.functionName = 'execute'
          entryPoint.attribute = 'HTTP'
          inferenceTritonEntryPointArray.push(entryPoint)

          if (entryPointAndSourceAtSameTime) {
            const paramSourceArray = findSourceOfFuncParam(filename, 'execute', bodyObj, paramIndexArray)
            if (paramSourceArray) {
              inferenceTritonEntryPointSourceArray.push(...paramSourceArray)
            }
          }
        }
      }
    }
  }

  return { inferenceTritonEntryPointArray, inferenceTritonEntryPointSourceArray }
}

module.exports = {
  findInferenceAiStudioTplEntryPointAndSource,
  findInferenceTritonEntryPointAndSource,
}
