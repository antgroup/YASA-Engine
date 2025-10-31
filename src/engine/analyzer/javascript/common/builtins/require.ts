const logger = require('../../../../../util/logger')(__filename)

module.exports = {
  /**
   * require processing for commonJS module
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  processRequire(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    if (argvalues.length !== 1) {
      logger.warn('require: params length [%d] is not equal to 1', argvalues.length)
    }
    let argNode: any
    if (node.type === 'CallExpression') {
      argNode = node.arguments[0]
    } else {
      argNode = argvalues[0]
    }
    const importMod = this.processImportDirect(this.topScope, argNode, state)
    return importMod || {}
  },
}
