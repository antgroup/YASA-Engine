/**
 * AstRef - AST 节点间接引用
 * 
 * 封装 nodehash 字符串，提供类型安全的 AST 节点引用。
 * resolve() 首次从 ASTManager 获取后缓存。AST 不可变 → 缓存永不失效。
 */

import type { BaseNode } from '../../../../types/uast'

export interface AstNodeStore {
  get(hash: string): BaseNode | null | undefined
}

export interface AstNodeManager extends AstNodeStore {
  has(hash: string): boolean
  register(ast: BaseNode): string | null
}

export class AstRef {
  readonly hash: string
  private _cached: BaseNode | null = null

  constructor(hash: string) {
    if (typeof hash !== 'string' || hash.length === 0) {
      throw new Error(`[AstRef] Invalid hash: ${hash}`)
    }
    this.hash = hash
  }

  resolve(astManager: AstNodeStore): BaseNode | null {
    if (this._cached) return this._cached
    if (!astManager) return null
    const node = astManager.get(this.hash) ?? null
    if (node) this._cached = node
    return node
  }

  static isAstRef(obj: unknown): obj is AstRef {
    return obj instanceof AstRef
  }

  static from(hashOrRef: string | AstRef): AstRef {
    if (hashOrRef instanceof AstRef) {
      return hashOrRef
    }
    return new AstRef(hashOrRef)
  }

  static fromNode(astNode: BaseNode | null | undefined): AstRef | null {
    if (!astNode || typeof astNode !== 'object') {
      return null
    }
    const nodehash = (astNode as any)._meta?.nodehash
    if (typeof nodehash !== 'string' || nodehash.length === 0) {
      return null
    }
    return new AstRef(nodehash)
  }

  toString(): string {
    return `AstRef(${this.hash.substring(0, 12)}...)`
  }
}
