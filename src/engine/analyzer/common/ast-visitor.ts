/**
 * find inner FunctionDefinition
 */
export class InnerFuncDefVisitor {
  matchFuncDefCount = 0

  /**
   * visit FunctionDefinition
   * @param node
   * @constructor
   */
  FunctionDefinition(node: any) {
    this.matchFuncDefCount += 1
    return this.matchFuncDefCount <= 1
  }
}
