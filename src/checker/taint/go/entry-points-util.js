const _ = require('lodash')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const constValue = require('../../../util/constant')
const Rules = require('../../common/rules-basic-handler')
const config = require('../../../config')

const { RouterPath } = Rules.getRules() || {}
const entryPointsUpToUser = !_.isEmpty(RouterPath)

/**
 * 填充entryPoint信息
 * @param main
 * @returns {EntryPoint}
 */
function completeEntryPoint(main) {
  const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
  entryPoint.scopeVal = main.parent
  entryPoint.argValues = []
  entryPoint.entryPointSymVal = main
  entryPoint.filePath = main.filePath || main.ast?.loc?.sourcefile?.substring(config.maindirPrefix.length)
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
