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
    loc?: {
      sourcefile?: string
    }
    id?: {
      name?: string
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
const entryPointsUpToUser: boolean = !_.isEmpty(entrypoints)

/**
 * 填充entryPoint信息
 * @param main
 * @returns {EntryPoint}
 */
function completeEntryPoint(main: MainFunction): typeof EntryPoint {
  const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
  entryPoint.scopeVal = main.parent
  entryPoint.argValues = []
  entryPoint.entryPointSymVal = main
  entryPoint.filePath =
    main.filePath || main.ast?.loc?.sourcefile?.substring(config.maindirPrefix.length)
  entryPoint.functionName = main.functionName || main.ast?.id?.name
  entryPoint.attribute = 'HTTP'
  entryPoint.parent ??= main.parent
  // TODO
  entryPoint.funcReceiverType = main.funcReceiverType
  return entryPoint
}

module.exports = {
  completeEntryPoint,
  entryPointsUpToUser,
}
