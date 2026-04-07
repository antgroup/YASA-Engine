const UastSpec = require('@ant-yasa/uast-spec')

/**
 * AST 管理器：使用 nodehash 作为 key 管理 AST 对象，避免重复存储
 * 用于降低内存占用，Unit 对象中只存储 AST 的 nodehash，而不是完整的 AST 对象
 */
class ASTManager {
  private astMap: Map<string, any>

  /**
   *
   */
  constructor() {
    this.astMap = new Map()
  }

  /**
   * 注册 AST 节点并返回其 nodehash
   * 如果 AST 节点已有 nodehash，则直接返回；否则生成一个 Mock nodehash
   * @param ast AST 节点对象
   * @returns AST 节点的 nodehash
   */
  register(ast: any): string | null {
    if (!ast) {
      return null
    }
    if (typeof ast === 'string') {
      ast = UastSpec.identifier(ast)
    }
    // 确保 _meta 对象存在
    if (!ast._meta) {
      ast._meta = {}
    }

    // 获取 nodehash
    let { nodehash } = ast._meta
    if (!nodehash) {
      // 如果没有 nodehash，生成一个 Mock nodehash
      const random = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
      nodehash = `<MockASTNodeHash_${random}>`
      ast._meta.nodehash = nodehash
    }

    // 注册到 Map（如果已存在则覆盖，确保使用最新的 AST 对象）
    this.astMap.set(nodehash, ast)

    return nodehash
  }

  /**
   * 根据 nodehash 获取 AST 节点
   * @param nodehash AST 节点的 nodehash
   * @returns AST 节点对象，如果不存在则返回 null
   */
  get(nodehash: string | null | undefined): any {
    if (!nodehash) {
      return null
    }
    return this.astMap.get(nodehash) || null
  }

  /**
   * 检查 nodehash 是否存在
   * @param nodehash AST 节点的 nodehash
   * @returns 是否存在
   */
  has(nodehash: string | null | undefined): boolean {
    if (!nodehash) {
      return false
    }
    return this.astMap.has(nodehash)
  }

  /**
   * 删除 AST 节点（通常不需要，但提供清理功能）
   * @param nodehash AST 节点的 nodehash
   */
  delete(nodehash: string | null | undefined): void {
    if (nodehash) {
      this.astMap.delete(nodehash)
    }
  }

  /**
   * 清空所有 AST 节点
   */
  clear(): void {
    this.astMap.clear()
  }

  /**
   * 获取已注册的 AST 节点数量
   * @returns 节点数量
   */
  size(): number {
    return this.astMap.size
  }

  /**
   * 获取 astMap
   */
  getMap(): Map<string, any> {
    return this.astMap
  }
}

module.exports = ASTManager
