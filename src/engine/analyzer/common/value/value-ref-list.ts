import { ValueRef } from './value-ref'
import type Unit from './unit'
import type { ValueRegistry } from './value-ref-map'
import { RAW_TARGET, IS_UNION_ARRAY } from './symbols'

/**
 * ValueRefList — 内部存 ValueRef[]，通过 Proxy 对外模拟原生 Array
 *
 * proxy[i]       → resolve ValueRef → 返回 Value（走缓存）
 * proxy[i] = val → 转 ValueRef 存储
 * proxy.push()   → 拦截，存 ValueRef
 * proxy.length   → _refs.length
 * Array.isArray(proxy) → true（target 是真数组）
 * for...of       → 自动 resolve 每个元素
 */
export class ValueRefList {
  _refs: ValueRef[] = []
  private _getSymbolTable: () => ValueRegistry | null
  private _proxy: any
  private _onMutate: (() => void) | null = null

  constructor(getSymbolTable: () => ValueRegistry | null, onMutate?: () => void) {
    this._getSymbolTable = getSymbolTable
    this._onMutate = onMutate || null
    this._proxy = this._createProxy()
  }

  private _resolve(ref: ValueRef): any {
    if (!ref) return undefined
    const st = this._getSymbolTable()
    if (st) {
      const value = ref.resolve(st)
      if (value) return value
    }
    return ref.uuid
  }

  getProxy(): any {
    return this._proxy
  }

  get length(): number {
    return this._refs.length
  }

  set length(val: number) {
    this._refs.length = val
  }

  push(...values: (Unit | ValueRef | string)[]): number {
    for (const value of values) {
      if (value instanceof ValueRef) {
        this._refs.push(value)
      } else if (typeof value === 'string') {
        if (value.startsWith('symuuid_')) {
          this._refs.push(new ValueRef(value))
        }
      } else {
        const uuid = value.uuid
        if (uuid) {
          this._refs.push(new ValueRef(uuid))
        }
      }
    }
    return this._refs.length
  }

  set(index: number, value: Unit | ValueRef | string | null | undefined): void {
    if (value === null || value === undefined) {
      if (index >= 0 && index < this._refs.length) {
        this._refs.splice(index, 1)
      }
      return
    }
    let ref: ValueRef
    if (value instanceof ValueRef) {
      ref = value
    } else if (typeof value === 'string') {
      ref = new ValueRef(value)
    } else {
      const st = this._getSymbolTable()
      if (st) {
        const newUuid = st.register(value)
        if (newUuid) {
          ref = new ValueRef(newUuid)
        } else {
          return
        }
      } else {
        const uuid = value.uuid
        if (uuid) {
          ref = new ValueRef(uuid)
        } else {
          return
        }
      }
    }
    if (index >= 0) {
      this._refs[index] = ref
    }
  }

  toArray(): any[] {
    return this._refs.map(ref => this._resolve(ref))
  }

  some(fn: (value: any, index: number) => boolean): boolean {
    for (let i = 0; i < this._refs.length; i++) {
      if (fn(this._resolve(this._refs[i]), i)) return true
    }
    return false
  }

  find(fn: (value: any, index: number) => boolean): any {
    for (let i = 0; i < this._refs.length; i++) {
      const v = this._resolve(this._refs[i])
      if (fn(v, i)) return v
    }
    return undefined
  }

  forEach(fn: (value: any, index: number) => void): void {
    for (let i = 0; i < this._refs.length; i++) {
      fn(this._resolve(this._refs[i]), i)
    }
  }

  map<T>(fn: (value: any, index: number) => T): T[] {
    const result: T[] = []
    for (let i = 0; i < this._refs.length; i++) {
      result.push(fn(this._resolve(this._refs[i]), i))
    }
    return result
  }

  [Symbol.iterator](): Iterator<any> {
    const refs = this._refs
    const resolve = (ref: ValueRef) => this._resolve(ref)
    let index = 0
    return {
      next(): IteratorResult<any> {
        if (index < refs.length) {
          return { value: resolve(refs[index++]), done: false }
        }
        return { value: undefined, done: true }
      },
    }
  }

  has(value: Unit | ValueRef | string): boolean {
    const uuid = value instanceof ValueRef ? value.uuid
      : typeof value === 'string' ? value
      : value?.uuid
    if (!uuid) return false
    return this._refs.some(r => r.uuid === uuid)
  }

  private _createProxy(): any {
    const self = this
    return new Proxy([] as any[], {
      get(_target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const ref = self._refs[Number(prop)]
          return ref ? self._resolve(ref) : undefined
        }

        switch (prop) {
          case 'length':
            return self._refs.length
          case '_refs':
            return self._refs
          case '_owner':
            return self
          case Symbol.iterator:
            return function* () {
              for (let i = 0; i < self._refs.length; i++) {
                yield self._resolve(self._refs[i])
              }
            }
          case 'push':
            return (...args: any[]) => self.push(...args)
          case 'pop':
            return () => {
              const ref = self._refs.pop()
              return ref ? self._resolve(ref) : undefined
            }
          case 'shift':
            return () => {
              const ref = self._refs.shift()
              return ref ? self._resolve(ref) : undefined
            }
          case 'unshift':
            return (...args: any[]) => {
              const refs = args.map((v: any) => {
                if (v instanceof ValueRef) return v
                const uuid = typeof v === 'string' ? v : v?.uuid
                return uuid ? new ValueRef(uuid) : null
              }).filter(Boolean) as ValueRef[]
              self._refs.unshift(...refs)
              return self._refs.length
            }
          case 'splice':
            return (start: number, deleteCount?: number, ...items: any[]) => {
              const newRefs = items.map((v: any) => {
                if (v instanceof ValueRef) return v
                const uuid = typeof v === 'string' ? v : v?.uuid
                return uuid ? new ValueRef(uuid) : null
              }).filter(Boolean) as ValueRef[]
              const removed = deleteCount !== undefined
                ? self._refs.splice(start, deleteCount, ...newRefs)
                : self._refs.splice(start)
              return removed.map(r => self._resolve(r))
            }
          case 'slice':
            return (start?: number, end?: number) => {
              const sliced = self._refs.slice(start, end)
              return sliced.map(r => self._resolve(r))
            }
          case 'concat':
            return (...args: any[]) => {
              const result: any[] = []
              for (const ref of self._refs) {
                result.push(self._resolve(ref))
              }
              for (const arg of args) {
                if (Array.isArray(arg)) {
                  result.push(...arg)
                } else {
                  result.push(arg)
                }
              }
              return result
            }
          case 'indexOf':
            return (searchVal: any, fromIndex?: number) => {
              const start = fromIndex ?? 0
              for (let i = start; i < self._refs.length; i++) {
                if (self._resolve(self._refs[i]) === searchVal) return i
              }
              return -1
            }
          case 'includes':
            return (searchVal: any, fromIndex?: number) => {
              const start = fromIndex ?? 0
              for (let i = start; i < self._refs.length; i++) {
                if (self._resolve(self._refs[i]) === searchVal) return true
              }
              return false
            }
          case 'forEach':
            return (fn: any) => {
              for (let i = 0; i < self._refs.length; i++) {
                fn(self._resolve(self._refs[i]), i, receiver)
              }
            }
          case 'map':
            return (fn: any) => {
              const result: any[] = []
              for (let i = 0; i < self._refs.length; i++) {
                result.push(fn(self._resolve(self._refs[i]), i, receiver))
              }
              return result
            }
          case 'filter':
            return (fn: any) => {
              const result: any[] = []
              for (let i = 0; i < self._refs.length; i++) {
                const v = self._resolve(self._refs[i])
                if (fn(v, i, receiver)) result.push(v)
              }
              return result
            }
          case 'some':
            return (fn: any) => {
              for (let i = 0; i < self._refs.length; i++) {
                if (fn(self._resolve(self._refs[i]), i, receiver)) return true
              }
              return false
            }
          case 'every':
            return (fn: any) => {
              for (let i = 0; i < self._refs.length; i++) {
                if (!fn(self._resolve(self._refs[i]), i, receiver)) return false
              }
              return true
            }
          case 'find':
            return (fn: any) => {
              for (let i = 0; i < self._refs.length; i++) {
                const v = self._resolve(self._refs[i])
                if (fn(v, i, receiver)) return v
              }
              return undefined
            }
          case 'findIndex':
            return (fn: any) => {
              for (let i = 0; i < self._refs.length; i++) {
                if (fn(self._resolve(self._refs[i]), i, receiver)) return i
              }
              return -1
            }
          case 'reduce':
            return (fn: any, initial?: any) => {
              let acc = initial
              let startIdx = 0
              if (acc === undefined) {
                acc = self._refs.length > 0 ? self._resolve(self._refs[0]) : undefined
                startIdx = 1
              }
              for (let i = startIdx; i < self._refs.length; i++) {
                acc = fn(acc, self._resolve(self._refs[i]), i, receiver)
              }
              return acc
            }
          case 'join':
            return (sep?: string) => {
              const arr: any[] = []
              for (const ref of self._refs) arr.push(self._resolve(ref))
              return arr.join(sep)
            }
          case 'sort':
            return (fn?: any) => {
              const resolved = self._refs.map((r, i) => ({ ref: r, val: self._resolve(r), i }))
              if (fn) {
                resolved.sort((a, b) => fn(a.val, b.val))
              } else {
                resolved.sort((a, b) => String(a.val) < String(b.val) ? -1 : 1)
              }
              self._refs = resolved.map(x => x.ref)
              self._onMutate?.()
              return receiver
            }
          case 'reverse':
            return () => {
              self._refs.reverse()
              self._onMutate?.()
              return receiver
            }
          case 'flat':
          case 'flatMap':
          case 'keys':
          case 'values':
          case 'entries':
          case 'at':
          case 'toString':
          case 'toLocaleString':
          case 'constructor':
            return (Array.prototype as any)[prop]?.bind(
              self._refs.map(r => self._resolve(r))
            )
          default:
            if (prop === IS_UNION_ARRAY) return true
            if (prop === RAW_TARGET) return self._refs.map(r => r.uuid)
            return undefined
        }
      },

      set(_target, prop, value) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          self.set(Number(prop), value)
          self._onMutate?.()
          return true
        }
        if (prop === 'length') {
          self._refs.length = value
          self._onMutate?.()
          return true
        }
        return true
      },

      has(_target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          return Number(prop) < self._refs.length
        }
        if (prop === 'length') return true
        if (prop === Symbol.iterator) return true
        return prop in Array.prototype
      },

      ownKeys() {
        const keys: string[] = []
        for (let i = 0; i < self._refs.length; i++) {
          keys.push(String(i))
        }
        keys.push('length')
        return keys
      },

      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const idx = Number(prop)
          if (idx < self._refs.length) {
            return {
              value: self._refs[idx].uuid,
              writable: true,
              enumerable: true,
              configurable: true,
            }
          }
        }
        if (prop === 'length') {
          return {
            value: self._refs.length,
            writable: true,
            enumerable: false,
            configurable: false,
          }
        }
        return undefined
      },
    })
  }

  static from(
    data: (string | ValueRef | Unit)[],
    getSymbolTable: () => ValueRegistry | null,
  ): ValueRefList {
    const list = new ValueRefList(getSymbolTable)
    for (const item of data) {
      if (item instanceof ValueRef) {
        list._refs.push(item)
      } else if (typeof item === 'string') {
        list._refs.push(new ValueRef(item))
      } else {
        const uuid = item?.uuid
        if (uuid) {
          list._refs.push(new ValueRef(uuid))
        }
      }
    }
    return list
  }

  _clone(getSymbolTable: () => ValueRegistry | null, onMutate?: () => void): ValueRefList {
    const copy = new ValueRefList(getSymbolTable, onMutate || this._onMutate || undefined)
    copy._refs = this._refs.slice()
    return copy
  }
}
