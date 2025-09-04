
/**
 *
 * @param obj
 */
function refreshCtx(obj) {
  for (const key in obj) {
    if (key !== 'controller' && key !== 'service' && key !== 'rpc' && key !== 'modules' && key !== 'common') {
      delete obj[key]
    }
  }
}

module.exports = {
  refreshCtx,
}
