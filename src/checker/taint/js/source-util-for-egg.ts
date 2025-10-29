const { markTaintSource } = require('../common-kit/source-util')
const BasicRuleHandler = require('../../common/rules-basic-handler')

/**
 * introduceTaintAtMemberAccess for egg
 * @param res
 * @param scope
 * @param node
 */
function introduceTaintAtMemberAccessForEgg(res: any, scope: any, node: any): any | undefined {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return
  }
  _introduceTaintAtMemberAccess(res, scope, node)
  return res
}

/**
 * introduceTaintAtMemberAccess for egg
 * @param res
 * @param sourceScopeVal
 * @param node
 */
function _introduceTaintAtMemberAccess(res: any, sourceScopeVal: any, node: any): any | undefined {
  if (!BasicRuleHandler.getPreprocessReady()) {
    return
  }
  if (typeof res._qid === 'undefined' || typeof res._qid !== 'string') {
    return res
  }
  if (markTaintAtMemberAccess(res, sourceScopeVal, node)) {
    return res
  }
  return res
}

/**
 * mark taint at MemberAccess for egg
 * @param res
 * @param sourceScopeVal
 * @param node
 */
function markTaintAtMemberAccess(res: any, sourceScopeVal: any, node: any): boolean {
  if (typeof res._qid !== 'undefined') {
    let qid = res._qid
    if (typeof qid !== 'string') {
      return false
    }
    qid = qid?.replace('Egg.Context', 'this.ctx')
    qid = qid?.replace('Egg.Application', 'this.app')
    qid = qid?.replace('Egg.Request', 'this.ctx.request')
    qid = qid?.replace('\<instance\>', '')

    // 适配ctx=this
    const sourceFile = node.loc?.sourcefile
    if (sourceFile && typeof sourceFile === 'string') {
      const lastSlashIndex = sourceFile.lastIndexOf('/')
      const firstDotIndex = sourceFile.indexOf('.', lastSlashIndex)
      if (lastSlashIndex !== -1 && firstDotIndex !== -1 && firstDotIndex > lastSlashIndex) {
        let className = sourceFile.substring(lastSlashIndex + 1, firstDotIndex)
        if (qid.toLowerCase().includes(className.toLowerCase()) && node.object?.name === 'ctx') {
          // className场景
          qid = qid.charAt(0).toLowerCase() + qid.slice(1)
          className = className.charAt(0).toLowerCase() + className.slice(1)
          qid = qid.replace(className, 'this.ctx')
        } else if (qid.startsWith('module.exports')) {
          // module.exports场景
          qid = qid.replace('module.exports', 'this.ctx')
        }
      }
    }

    if (typeof qid === 'undefined') {
      return false
    }
    const nodeStart = node?.loc?.start?.line
    const nodeEnd = node?.loc?.end?.line
    for (const val of sourceScopeVal) {
      let paths = val.path
      if (!paths.includes('.')) {
        continue
      }
      const valStart = val.locStart
      const valEnd = val.locEnd

      if (
        (!valStart && !valEnd) ||
        (valStart === 'all' && valEnd === 'all') ||
        (nodeStart >= valStart && nodeEnd <= valEnd)
      ) {
        if (!paths.includes('*') && !paths.includes('**')) {
          if (qid === paths || qid.includes(`.${paths}`)) {
            markTaintSource(res, { path: node, kind: val.kind })
            return true
          }
        } else {
          paths = paths.replaceAll('.**', '\\.[A-Za-z0-9_\\.]*')
          paths = paths.replaceAll('**.', '[A-Za-z0-9_\\.]*\\.')
          paths = paths.replaceAll('*.', '[A-Za-z0-9_]*\\.')
          paths = paths.replaceAll('.*', '\\.[A-Za-z0-9_]*')
          paths = paths.replaceAll('\\.', '.')
          paths = paths.replaceAll('.', '\\.')
          paths = `^${paths}$`
          const regex = new RegExp(paths, 'i')
          if (qid.match(regex)) {
            markTaintSource(res, { path: node, kind: val.kind })
            return true
          }
        }
      }
    }
  }
  return false
}

module.exports = {
  introduceTaintAtMemberAccess: introduceTaintAtMemberAccessForEgg,
}
