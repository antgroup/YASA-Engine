import { ValueRef } from './value-ref'
import type Unit from './unit'
import { RAW_TARGET } from './symbols'

/**
 * ValueStore — 符号表只读接口
 */
export interface ValueStore {
  get(uuid: string): Unit | null | undefined
}

/**
 * ValueRegistry — 符号表读写接口
 */
export interface ValueRegistry extends ValueStore {
  register(value: Unit): string | null
}

/**
 * ValueRefMap — 内部存 Map<string, ValueRef>，通过 Proxy 对外模拟 Record
 *
 * 设计原则：_members 是数据所有者，ValueRef 同时持有 uuid + _direct。
 * 有 UUID → 优先从符号表 resolve（匹配旧 createFieldProxy 行为），_direct 做 fallback。
 * 无 UUID → 直返 _direct（非 Unit 值或注册失败时）。
 *
 * proxy[key]       → resolve ValueRef → 返回 Value
 * proxy[key] = val → 转 ValueRef 存储（uuid + direct）
 * delete proxy[key] → 删除
 * Object.keys(proxy) → _map.keys()
 * for...in          → 遍历 keys
 */
export class ValueRefMap {
  _map: Map<string, ValueRef> = new Map()
  private _getSymbolTable: () => ValueRegistry | null
  private _proxy: any
  private _proxyTarget: Record<string, any> = {}

  constructor(getSymbolTable: () => ValueRegistry | null) {
    this._getSymbolTable = getSymbolTable
    this._proxy = this._createProxy()
    Object.defineProperty(this._proxy, RAW_TARGET, {
      value: this._proxyTarget,
      writable: false,
      enumerable: false,
      configurable: false,
    })
  }

  get size(): number {
    return this._map.size
  }

  getProxy(): any {
    return this._proxy
  }

  get(key: string): any {
    const ref = this._map.get(key)
    if (!ref) return null
    const st = this._getSymbolTable()
    const resolved = ref.resolve(st)
    if (resolved) return resolved
    if (ref.uuid) return ref.uuid
    return null
  }

  has(key: string): boolean {
    return this._map.has(key)
  }

  set(key: string, value: Unit | ValueRef | null | undefined): void {
    if (value == null) {
      this._map.delete(key)
      delete this._proxyTarget[key]
      return
    }
    if (value instanceof ValueRef) {
      this._map.set(key, value)
      this._proxyTarget[key] = value.uuid || value._direct
      return
    }
    // UUID string → pure reference (no direct object available)
    if (typeof value === 'string' && (value as any).startsWith('symuuid')) {
      this._map.set(key, new ValueRef(value as any))
      this._proxyTarget[key] = value
      return
    }
    // Register Unit values in ST, store UUID-only ref (no _direct).
    // Matches old createFieldProxy: SET stores UUID string, GET resolves via ST.
    if (value && typeof value === 'object' && (value as any).vtype && (value as any).qid) {
      const st = this._getSymbolTable()
      if (st) {
        const uuid = st.register(value as Unit)
        if (uuid) {
          this._map.set(key, new ValueRef(uuid))
          this._proxyTarget[key] = uuid
          return
        }
      }
    }
    // Non-Unit values or ST unavailable: store with whatever UUID is available
    const uuid = value?.uuid || ''
    if (uuid) {
      this._map.set(key, new ValueRef(uuid))
      this._proxyTarget[key] = uuid
    } else {
      this._map.set(key, new ValueRef('', value))
      this._proxyTarget[key] = value
    }
  }

  delete(key: string): boolean {
    delete this._proxyTarget[key]
    return this._map.delete(key)
  }

  clear(): void {
    this._map.clear()
    for (const k of Object.keys(this._proxyTarget)) {
      delete this._proxyTarget[k]
    }
  }

  keys(): IterableIterator<string> {
    return this._map.keys()
  }

  forEach(fn: (value: any, key: string) => void): void {
    const st = this._getSymbolTable()
    for (const [key, ref] of this._map) {
      const value = ref.resolve(st)
      if (value) fn(value, key)
    }
  }

  entries(): [string, any][] {
    const st = this._getSymbolTable()
    const result: [string, any][] = []
    for (const [key, ref] of this._map) {
      const value = ref.resolve(st)
      if (value) result.push([key, value])
    }
    return result
  }

  private _createProxy(): any {
    const self = this
    return new Proxy(this._proxyTarget, {
      get(_target, prop) {
        if (typeof prop === 'symbol') return (_target as any)[prop]
        if (typeof prop === 'string') {
          if (prop === '_map') return self._map
          if (prop === '_owner') return self
          if (prop === 'hasOwnProperty') return (key: string) => self._map.has(key)
          const ref = self._map.get(prop)
          if (!ref) return _target[prop]
          const st = self._getSymbolTable()
          const resolved = ref.resolve(st)
          if (resolved) return resolved
          if (ref.uuid) return ref.uuid
          return undefined
        }
        return undefined
      },

      set(_target, prop, value) {
        if (typeof prop === 'string') {
          self.set(prop, value)
          return true
        }
        return true
      },

      deleteProperty(_target, prop) {
        if (typeof prop === 'string') {
          self._map.delete(prop)
          delete _target[prop]
          return true
        }
        return false
      },

      has(_target, prop) {
        if (typeof prop === 'string') {
          return self._map.has(prop)
        }
        return false
      },

      ownKeys(_target) {
        const keys: (string | symbol)[] = Array.from(self._map.keys())
        if (Object.prototype.hasOwnProperty.call(_target, RAW_TARGET)) {
          keys.push(RAW_TARGET)
        }
        return keys
      },

      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop === 'string' && self._map.has(prop)) {
          return {
            value: _target[prop],
            writable: true,
            enumerable: true,
            configurable: true,
          }
        }
        return Object.getOwnPropertyDescriptor(_target, prop)
      },
    })
  }

  static from(
    data: Record<string, string | ValueRef> | Map<string, string | ValueRef>,
    getSymbolTable: () => ValueRegistry | null,
  ): ValueRefMap {
    const map = new ValueRefMap(getSymbolTable)
    const entries = data instanceof Map ? data.entries() : Object.entries(data)
    for (const [key, value] of entries) {
      if (value instanceof ValueRef) {
        map._map.set(key, value)
        map._proxyTarget[key] = value.uuid || value._direct
      } else if (typeof value === 'string') {
        map._map.set(key, new ValueRef(value))
        map._proxyTarget[key] = value
      }
    }
    return map
  }

  _clone(getSymbolTable: () => ValueRegistry | null): ValueRefMap {
    const copy = new ValueRefMap(getSymbolTable)
    copy._map = new Map(this._map)
    for (const [key, ref] of copy._map) {
      copy._proxyTarget[key] = ref.uuid || ref._direct
    }
    return copy
  }
}
