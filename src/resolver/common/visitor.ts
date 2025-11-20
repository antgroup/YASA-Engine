import type { AstAndScope } from './value/ast-and-scope'

/**
 * AST visitor for type resolver
 */
export default class TypeResolverASTVisitor {
  astAndScopeArray: AstAndScope[] = []

  nodeScope: any

  nodeScopeAst: any

  /**
   * visit CallExpression
   * @param node
   * @constructor
   * @returns {*}
   */
  CallExpression(node: any) {
    return this.assembleAstAndScope(node)
  }

  /**
   * visit VariableDeclaration
   * @param node
   * @constructor
   * @returns {*}
   */
  VariableDeclaration(node: any) {
    return this.assembleAstAndScope(node)
  }

  /**
   * visit NewExpression
   * @param node
   * @constructor
   * @returns {*}
   */
  NewExpression(node: any) {
    return this.assembleAstAndScope(node)
  }

  /**
   * assemble ast and scope
   * @param node
   * @returns {*}
   */
  assembleAstAndScope(node: any) {
    const astAndScope: AstAndScope = {
      ast: node,
      nodeScope: this.nodeScope,
      nodeScopeAst: this.nodeScopeAst,
    }
    this.astAndScopeArray.push(astAndScope)

    return true
  }
}
