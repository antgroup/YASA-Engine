/**
 *
 * @param obj
 */
function refreshCtx(obj: Record<string, any> | null | undefined): void {
  if (!obj) {
    return
  }
  for (const key in obj) {
    if (key !== 'controller' && key !== 'service' && key !== 'rpc' && key !== 'modules' && key !== 'common') {
      delete obj[key]
    }
  }
}

export = {
  refreshCtx,
}
