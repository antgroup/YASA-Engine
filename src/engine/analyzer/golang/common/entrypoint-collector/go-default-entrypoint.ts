const AstUtil = require('../../../../../util/ast-util')

export {}

/**
 * get main entryPoints
 * @param packageManager
 * @returns {*[]}
 */
function getMainEntryPoints(packageManager: any) {
  const entryPoints: any[] = []
  const mainEntryPoints = AstUtil.satisfy(
    packageManager,
    (n: any) => n.ast?.id?.name === 'main' && n.vtype === 'fclos',
    (node: any, prop: any) => prop === 'field',
    null,
    true
  )
  entryPoints.push(...(mainEntryPoints || []))
  return entryPoints
}

module.exports = {
  getMainEntryPoints,
}
