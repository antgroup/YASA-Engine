/**
 * ValueRef - Value 间接引用
 * 
 * 封装 UUID 字符串，提供类型安全的 Value 引用。
 * resolve() 首次从符号表获取后缓存，后续直接返回缓存引用。
 * UUID readonly + 缓存同一 JS 对象引用 → 属性修改自动可见，缓存永不失效。
 */

export class ValueRef {
  readonly uuid: string
  private _directWeak?: WeakRef<any>
  private _directStrong?: any

  constructor(uuid: string, direct?: any) {
    if (!direct && (typeof uuid !== 'string' || uuid.length === 0)) {
      throw new Error(`[ValueRef] Invalid uuid: ${uuid}`)
    }
    this.uuid = uuid || ''
    if (direct != null) {
      if (typeof direct === 'object') {
        this._directWeak = new WeakRef(direct)
      } else {
        this._directStrong = direct
      }
    }
  }

  get _direct(): any {
    if (this._directStrong != null) return this._directStrong
    return this._directWeak?.deref() ?? null
  }

  set _direct(val: any) {
    if (val == null) {
      this._directWeak = undefined
      this._directStrong = undefined
    } else if (typeof val === 'object') {
      this._directWeak = new WeakRef(val)
      this._directStrong = undefined
    } else {
      this._directStrong = val
      this._directWeak = undefined
    }
  }

  resolve(symbolTable: any): any | null {
    const direct = this._direct
    if (direct) return direct

    if (!this.uuid) return null
    if (!symbolTable || typeof symbolTable.get !== 'function') {
      return null
    }
    return symbolTable.get(this.uuid) ?? null
  }

  /**
   * UUID 注册成功后调用：清除 _direct 强引用。
   * 有 uuid → 后续 resolve() 仍优先走 WeakRef（保持 identity），GC 回收后走 ST。
   * 无 uuid → 保留 _direct（非 Unit 值场景）。
   */
  markRegistered(): void {
    if (this.uuid) {
      this._directStrong = undefined
    }
  }

  static isValueRef(obj: any): obj is ValueRef {
    return obj instanceof ValueRef
  }

  static from(uuidOrRef: string | ValueRef): ValueRef {
    if (uuidOrRef instanceof ValueRef) {
      return uuidOrRef
    }
    return new ValueRef(uuidOrRef)
  }

  toString(): string {
    return `ValueRef(${this.uuid.substring(0, 12)}...)`
  }
}
