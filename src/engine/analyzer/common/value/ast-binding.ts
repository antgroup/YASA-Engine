import { AstRef } from './ast-ref'
import type { AstNodeManager } from './ast-ref'
import type { BaseNode } from '../../../../types/uast'

/**
 * AstBinding - AST 绑定属性组（RefGroup）
 *
 * 拥有 node/fdef/cdef/decls 的 AstRef 存储，
 * getter 自动通过 ASTManager resolve 为 AST 节点对象，
 * setter 自动提取 nodehash 创建 AstRef。
 */
export class AstBinding {
  private _nodeRef: AstRef | null = null
  private _fdefRef: AstRef | null = null
  private _cdefRef: AstRef | null = null
  private _declsMap: Map<string, AstRef> | undefined = undefined
  private _owner: { getASTManager(): AstNodeManager | null }

  constructor(owner: { getASTManager(): AstNodeManager | null }) {
    this._owner = owner
  }

  private _resolve(ref: AstRef | null): BaseNode | null {
    if (!ref) return null
    const mgr = this._owner.getASTManager()
    if (!mgr) return null
    try { return mgr.get(ref.hash) ?? null } catch { return null }
  }

  private _toRef(astNode: BaseNode | null | undefined): AstRef | null {
    if (!astNode) return null
    const hash = astNode._meta?.nodehash
    if (!hash) {
      const mgr = this._owner.getASTManager()
      if (!mgr) return null
      const registered = mgr.register(astNode)
      return registered ? new AstRef(registered) : null
    }
    const mgr = this._owner.getASTManager()
    if (mgr && !mgr.has(hash)) {
      mgr.register(astNode)
    }
    return new AstRef(hash)
  }

  get node(): BaseNode | null { return this._resolve(this._nodeRef) }
  set node(astNode: BaseNode | null | undefined) { this._nodeRef = this._toRef(astNode ?? null) }

  get fdef(): BaseNode | null { return this._resolve(this._fdefRef) }
  set fdef(astNode: BaseNode | null | undefined) { this._fdefRef = this._toRef(astNode ?? null) }

  get cdef(): BaseNode | null { return this._resolve(this._cdefRef) }
  set cdef(astNode: BaseNode | null | undefined) { this._cdefRef = this._toRef(astNode ?? null) }

  getDecl(key: string): BaseNode | null {
    return this._resolve(this._declsMap?.get(key) ?? null)
  }

  setDecl(key: string, astNode: BaseNode | null | undefined): void {
    if (!astNode) { this._declsMap?.delete(key); return }
    const ref = this._toRef(astNode)
    if (ref) {
      if (!this._declsMap) this._declsMap = new Map()
      this._declsMap.set(key, ref)
    }
  }

  hasDecl(key: string): boolean {
    return this._declsMap?.has(key) ?? false
  }

  deleteDecl(key: string): void {
    this._declsMap?.delete(key)
  }

  get declKeys(): string[] {
    return this._declsMap ? Array.from(this._declsMap.keys()) : []
  }

  initDecls(declsObj: Record<string, BaseNode | string> | null | undefined): void {
    if (!declsObj || typeof declsObj !== 'object' || Array.isArray(declsObj)) return
    const keys = Object.keys(declsObj)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const uastNode = declsObj[key]
      let hash: string | null = null
      if (typeof uastNode === 'string') {
        hash = uastNode
      } else if (uastNode && typeof uastNode === 'object') {
        hash = uastNode._meta?.nodehash ?? null
      }
      if (hash) {
        if (!this._declsMap) this._declsMap = new Map()
        this._declsMap.set(key, new AstRef(hash))
      }
    }
  }

  _clone(newOwner: { getASTManager(): AstNodeManager | null }): AstBinding {
    const c = new AstBinding(newOwner)
    c._nodeRef = this._nodeRef
    c._fdefRef = this._fdefRef
    c._cdefRef = this._cdefRef
    c._declsMap = this._declsMap ? new Map(this._declsMap) : undefined
    return c
  }
}
