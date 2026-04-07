const _ = require('lodash')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const constValue = require('../../../util/constant')
const Rules = require('../../common/rules-basic-handler')
const config = require('../../../config')

interface EntryPointConfig {
  [key: string]: any
}

interface MainFunction {
  parent?: any
  ast?: {
    node?: {
      loc?: {
        sourcefile?: string
      }
      id?: {
        name?: string
      }
    }
  }
  filePath?: string
  functionName?: string
  funcReceiverType?: string
}

const entrypoints: EntryPointConfig[] = []
if (Array.isArray(Rules.getRules()) && Rules.getRules().length > 0) {
  for (const rule of Rules.getRules()) {
    if (Array.isArray(rule.entrypoints)) {
      entrypoints.push(...rule.entrypoints)
    }
  }
}

/**
 * 填充entryPoint信息
 * @param main
 * @param isPreProcess 是否是为了模拟服务上下文而必须执行的操作，并非真实的api
 * @returns {EntryPoint}
 */
function completeEntryPoint(main: MainFunction, isPreProcess = false): typeof EntryPoint {
  const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
  entryPoint.scopeVal = main.parent
  entryPoint.argValues = []
  entryPoint.entryPointSymVal = main
  entryPoint.filePath = main.filePath || (config.maindirPrefix
    ? main.ast?.node?.loc?.sourcefile?.substring(config.maindirPrefix.length)
    : main.ast?.node?.loc?.sourcefile)
  entryPoint.functionName = main.functionName || main.ast?.node?.id?.name
  entryPoint.attribute = 'HTTP'
  entryPoint.parent ??= main.parent
  // TODO
  entryPoint.funcReceiverType = main.funcReceiverType
  entryPoint.isPreProcess = isPreProcess
  return entryPoint
}

module.exports = completeEntryPoint
