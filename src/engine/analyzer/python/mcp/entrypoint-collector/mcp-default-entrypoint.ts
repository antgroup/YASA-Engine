const { extractRelativePath } = require('../../../../../util/file-util')
const EntryPoint = require('../../../common/entrypoint')
const Constant = require('../../../../../util/constant')
const { entryPointAndSourceAtSameTime } = require('../../../../../config')
const { findSourceOfFuncParam } = require('../../common/entrypoint-collector/python-entrypoint-source')

/**
 *
 * @param filenameAstObj
 * @param dir
 * @returns {{mcpEntryPointArray: *[], mcpEntryPointSourceArray: *[]}}
 */
function findMcpEntryPointAndSource(filenameAstObj: any, dir: any) {
  const mcpEntryPointArray: any[] = []
  const mcpEntryPointSourceArray: any[] = []

  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!body) {
      continue
    }
    for (const obj of body) {
      if (
        obj.type !== 'FunctionDefinition' ||
        !obj.hasOwnProperty('parameters') ||
        !obj.hasOwnProperty('_meta') ||
        !obj._meta.hasOwnProperty('decorators') ||
        !obj.hasOwnProperty('id') ||
        !obj.id.hasOwnProperty('name')
      ) {
        continue
      }
      const funcName = obj.id.name

      for (const decoratorObj of obj._meta.decorators) {
        if (decoratorObj.type === 'CallExpression' && decoratorObj.hasOwnProperty('callee')) {
          const { callee } = decoratorObj
          if (callee.type === 'MemberAccess') {
            if (!callee.hasOwnProperty('property')) {
              continue
            }
            const { property } = callee
            if (!property.hasOwnProperty('name')) {
              continue
            }
            if (['tool', 'call_tool'].includes(property.name)) {
              const shortFileName = extractRelativePath(filename, dir)
              const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
              entryPoint.filePath = shortFileName
              entryPoint.functionName = funcName
              entryPoint.attribute = 'MCPTool'
              mcpEntryPointArray.push(entryPoint)

              if (entryPointAndSourceAtSameTime) {
                const paramSourceArray = findSourceOfFuncParam(filename, funcName, obj, null)
                if (paramSourceArray) {
                  mcpEntryPointSourceArray.push(...paramSourceArray)
                }
              }
            }
          }
        }
      }
    }
  }

  return { mcpEntryPointArray, mcpEntryPointSourceArray }
}

export = {
  findMcpEntryPointAndSource,
}
