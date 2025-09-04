const astUtil = require('../../../../../util/ast-util')

/**
 * get main entryPoints
 * @param packageManager
 * @returns {*[]}
 */
function getMainEntryPoints(packageManager) {
  const entryPoints = []
  const mainEntryPoints = astUtil.satisfy(
    packageManager,
    (n) => n.ast?.id?.name === 'main' && n.vtype === 'fclos',
    (node, prop) => prop === 'field',
    null,
    true
  )
  entryPoints.push(...(mainEntryPoints || []))
  return entryPoints
}

module.exports = {
  getMainEntryPoints,
}
