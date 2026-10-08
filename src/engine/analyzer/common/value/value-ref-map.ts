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
 * _proxyTarget 永久为空 {}，仅作为 Proxy 构造所需的 target object。
 * 所有数据读写均通过 _map，不往 _proxyTarget 写 string key，
 * 避免 V8 NameDictionary::Add 扩容导致的 OOM（原 365k 实例 × bags = 3.73GiB）。
 *
 * COW：_clone 共享 _map 引用（避免 clone 时 new Map() 重复 Rehash 扩容的 Map backing OOM），
 * 首次写时拆分为独立副本。注册成功的 Unit 同时存 WeakRef _direct，
 * cloned ST 查不到 uuid 时 resolve 回退 _direct 而非退化为 UUID 字符串（避免子作用域被误当字符串）。
 *
 * proxy[key]       → resolve ValueRef → 返回 Value
 * proxy[key] = val → 转 ValueRef 存储（uuid + direct）
 * delete proxy[key] → 删除
 * Object.keys(proxy) → _map.keys()
 * for...in          → 遍历 keys
 */
export class ValueRefMap {
  /** 内部数据主体。COW 共享时写前须调 _ensureMapOwned，外部禁止直接写 */
  _map: Map<string, ValueRef> = new Map()
  /** COW 标记：true 表示 _map 与其他实例共享，写前须拷贝 */
  private _mapShared: boolean = false
  private _getSymbolTable: () => ValueRegistry | null
  private _getOwner: (() => Unit | null) | null
  private _proxy: any
  private _proxyTarget: Record<string, any> = {}

  constructor(getSymbolTable: () => ValueRegistry | null, getOwner?: () => Unit | null) {
    this._getSymbolTable = getSymbolTable
    this._getOwner = getOwner || null
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
    this._ensureMapOwned()
    this._setInternal(key, value)
    // v5 hook #5：slot_bind 事件。每次成功 set 记一条边（value → ownerUnit）
    // delete 语义（value==null）不记边
    if (value != null && this._getOwner) {
      const owner = this._getOwner()
      if (owner) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { auditSlotBindEvent } = require('./unit-audit')
          auditSlotBindEvent(value, owner, key)
        } catch (_e) {
          // 插桩失败不影响原逻辑
        }
      }
    }
  }

  private _setInternal(key: string, value: Unit | ValueRef | null | undefined): void {
    if (value == null) {
      this._map.delete(key)
      return
    }
    if (value instanceof ValueRef) {
      this._map.set(key, value)
      return
    }
    // UUID string → pure reference (no direct object available)
    if (typeof value === 'string' && (value as any).startsWith('symuuid')) {
      this._map.set(key, new ValueRef(value as any))
      return
    }
    // Register Unit values in ST, store UUID-only ref (no _direct)。
    // Matches旧 createFieldProxy: SET stores UUID string, GET resolves via ST。
    if (value && typeof value === 'object' && (value as any).vtype && (value as any).qid) {
      const st = this._getSymbolTable()
      if (st) {
        const uuid = st.register(value as Unit)
        if (uuid) {
          this._map.set(key, new ValueRef(uuid))
          return
        }
      }
    }
    // Non-Unit values or ST unavailable: store with whatever UUID is available
    const uuid = value?.uuid || ''
    if (uuid) {
      this._map.set(key, new ValueRef(uuid))
    } else {
      this._map.set(key, new ValueRef('', value))
    }
  }

  delete(key: string): boolean {
    this._ensureMapOwned()
    return this._map.delete(key)
  }

  clear(): void {
    this._ensureMapOwned()
    this._map.clear()
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

  /** COW 写时拷贝：共享 Map 在首次写前拆分为独立副本 */
  private _ensureMapOwned(): void {
    if (this._mapShared) {
      this._map = new Map(this._map)
      this._mapShared = false
    }
  }

  private _createProxy(): any {
    const self = this
    return new Proxy(this._proxyTarget, {
      get(_target, prop) {
        if (typeof prop === 'symbol') return (_target as any)[prop]
        if (typeof prop === 'string') {
          if (prop === '_map') return self._map as ReadonlyMap<string, ValueRef>
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
          self.delete(prop)
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
          const ref = self._map.get(prop)!
          // uuid 非空返回 UUID string（保持旧 _target[prop] 语义）；
          // uuid 为空时回退 resolve/direct，避免 desc.value 退化为 ''
          const value = ref.uuid
            ? ref.uuid
            : ref.resolve(self._getSymbolTable()) ?? ref._direct ?? undefined
          return {
            value,
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
      } else if (typeof value === 'string') {
        map._map.set(key, new ValueRef(value))
      }
    }
    return map
  }

  _clone(getSymbolTable: () => ValueRegistry | null): ValueRefMap {
    const copy = new ValueRefMap(getSymbolTable)
    // COW：共享 _map 引用不拷贝，写时由 _ensureMapOwned 拆分为独立副本。
    // 不守 size>0：空 map 克隆时若不置 _mapShared，任一侧 set 直接写共享对象、
    // 两侧互相污染,_map 异常增长 → satisfy BFS 触达 2^32-1 抛 RangeError。
    copy._map = this._map
    this._mapShared = true
    copy._mapShared = true
    return copy
  }
}
