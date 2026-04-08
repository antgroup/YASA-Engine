/**
 * ScopeCtx - 作用域上下文属性组（RefGroup）
 *
 * 管理 fileScope/exports 的 UUID 存储和 SymbolTable resolve，
 * 以及 declarationMap 的直接存储。
 * getter 自动通过 SymbolTable resolve UUID 为 Value 对象，
 * setter 自动提取 UUID 存储。
 */
export class ScopeCtx {
  private _fileScopeUuid: string | null = null
  private _exportsUuid: string | null = null
  private _declarationMap: Map<string, any> | null = null
  private _owner: { getSymbolTable(): any }

  constructor(owner: { getSymbolTable(): any }) {
    this._owner = owner
  }

  // --- fileScope ---

  get fileScope(): any {
    if (!this._fileScopeUuid) return null
    const st = this._owner.getSymbolTable()
    return st ? st.get(this._fileScopeUuid) : null
  }

  set fileScope(unit: any) {
    if (!unit) { this._fileScopeUuid = null; return }
    const st = this._owner.getSymbolTable()
    if (unit.uuid !== this._fileScopeUuid) {
      if (unit.uuid) {
        this._fileScopeUuid = unit.uuid
      } else if (st) {
        this._fileScopeUuid = st.register(unit)
      } else {
        this._fileScopeUuid = unit.uuid || null
      }
    }
  }

  // --- exports ---

  get exports(): any {
    if (!this._exportsUuid) return null
    const st = this._owner.getSymbolTable()
    return st ? st.get(this._exportsUuid) : null
  }

  set exports(unit: any) {
    if (!unit) { this._exportsUuid = null; return }
    const st = this._owner.getSymbolTable()
    if (unit.uuid !== this._exportsUuid) {
      if (unit.uuid) {
        this._exportsUuid = unit.uuid
      } else if (st) {
        this._exportsUuid = st.register(unit)
      }
    }
  }

  // --- declarationMap ---

  get declarationMap(): Map<string, any> | null {
    return this._declarationMap
  }

  set declarationMap(map: Map<string, any> | null) {
    this._declarationMap = map
  }

  // --- _clone ---

  _clone(newOwner: { getSymbolTable(): any }): ScopeCtx {
    const c = new ScopeCtx(newOwner)
    c._fileScopeUuid = this._fileScopeUuid
    c._exportsUuid = this._exportsUuid
    c._declarationMap = this._declarationMap ? new Map(this._declarationMap) : null
    return c
  }
}
