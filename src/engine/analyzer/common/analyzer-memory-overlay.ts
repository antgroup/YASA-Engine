import type { ISymbolTableManager } from './symbol-table-interface'
import { ValueRef } from './value/value-ref'
import { ValueRefMap } from './value/value-ref-map'

const SymbolTableManager = require('./symbol-table-manager') as {
  new (): ISymbolTableManager
}

type SymbolUnit = Parameters<ISymbolTableManager['register']>[0]

export interface AnalyzerMemoryOverlay {
  readonly symbolTable: ISymbolTableManager
  clonePackageRoot<T>(value: T): T
  resetLocal(): void
}

interface CloneableSymbolUnit {
  readonly vtype?: string
  readonly uuid?: string | null
  readonly qid?: string | null
  _members?: ValueRefMap
  _field?: unknown
  clone?: () => CloneableSymbolUnit
}

interface PackageOverlayEntry<T> {
  readonly base: T
  readonly cloned: T
  readonly members: OverlayValueRefMap
}

function isCloneablePackageUnit(value: unknown): value is CloneableSymbolUnit {
  return typeof value === 'object' && value !== null && (value as CloneableSymbolUnit).vtype === 'package'
}

function bindPackageMemberCOW<T extends CloneableSymbolUnit>(value: T, symbolTable: ISymbolTableManager): OverlayValueRefMap | null {
  if (!(value._members instanceof ValueRefMap)) return null
  const baseMembers = value._members
  const localMembers = new ValueRefMap(() => symbolTable, () => value as SymbolUnit)
  const overlayMembers = new OverlayValueRefMap(baseMembers, localMembers, symbolTable)
  Object.defineProperty(value, '_members', {
    value: overlayMembers,
    writable: true,
    enumerable: false,
    configurable: true,
  })
  value._field = value._members.getProxy()
  return overlayMembers
}

function clonePackageUnit<T>(value: T, symbolTable: ISymbolTableManager): PackageOverlayEntry<T> | null {
  if (!isCloneablePackageUnit(value) || typeof value.clone !== 'function') return null
  const cloned = value.clone() as T
  if (!isCloneablePackageUnit(cloned)) return null
  const members = bindPackageMemberCOW(cloned, symbolTable)
  if (!members) return null
  return { base: value, cloned, members }
}

/**
 * package root 成员 overlay：读共享 base，写本地 local，删除用 tombstone 屏蔽 base。
 */
class OverlayValueRefMap extends ValueRefMap {
  private readonly deletedKeys: Set<string> = new Set()

  constructor(
    private readonly baseMembers: ValueRefMap,
    private readonly localMembers: ValueRefMap,
    private readonly symbolTable: ISymbolTableManager,
  ) {
    super(() => symbolTable)
  }

  override get size(): number {
    return this.getCombinedKeys().size
  }

  override get(key: string): unknown {
    if (this.deletedKeys.has(key)) return null
    if (this.localMembers.has(key)) return this.localMembers.get(key)
    return this.baseMembers.get(key)
  }

  override has(key: string): boolean {
    if (this.deletedKeys.has(key)) return false
    return this.localMembers.has(key) || this.baseMembers.has(key)
  }

  override set(key: string, value: SymbolUnit | ValueRef | null | undefined): void {
    this.localMembers.set(key, value)
    this.deletedKeys.delete(key)
  }

  override delete(key: string): boolean {
    const existed = this.has(key)
    this.localMembers.delete(key)
    if (this.baseMembers.has(key)) {
      this.deletedKeys.add(key)
    } else {
      this.deletedKeys.delete(key)
    }
    return existed
  }

  override clear(): void {
    this.localMembers.clear()
    this.deletedKeys.clear()
    for (const key of this.baseMembers.keys()) {
      this.deletedKeys.add(key)
    }
  }

  resetLocal(): void {
    this.localMembers.clear()
    this.deletedKeys.clear()
  }

  override keys(): IterableIterator<string> {
    return this.getCombinedKeys().keys()
  }

  override forEach(fn: (value: unknown, key: string) => void): void {
    for (const key of this.getCombinedKeys()) {
      const value = this.get(key)
      if (value) fn(value, key)
    }
  }

  override entries(): [string, unknown][] {
    const result: [string, unknown][] = []
    this.forEach((value, key) => result.push([key, value]))
    return result
  }

  override getProxy(): Record<string | symbol, unknown> {
    return new Proxy({}, {
      get: (_target, prop) => {
        if (typeof prop === 'symbol') return undefined
        if (prop === '_map') return this.getMapView()
        if (prop === '_owner') return this
        if (prop === 'hasOwnProperty') return (key: string) => this.has(key)
        return this.get(prop)
      },
      set: (_target, prop, value) => {
        if (typeof prop === 'string') this.set(prop, value)
        return true
      },
      deleteProperty: (_target, prop) => {
        if (typeof prop !== 'string') return false
        this.delete(prop)
        return true
      },
      has: (_target, prop) => typeof prop === 'string' && this.has(prop),
      ownKeys: () => Array.from(this.getCombinedKeys()),
      getOwnPropertyDescriptor: (_target, prop) => {
        if (typeof prop !== 'string' || !this.has(prop)) return undefined
        return { value: this.get(prop), writable: true, enumerable: true, configurable: true }
      },
    })
  }

  override _clone(getSymbolTable: () => ISymbolTableManager | null): ValueRefMap {
    const copy = new ValueRefMap(getSymbolTable)
    for (const [key, value] of this.entries()) {
      copy.set(key, value as SymbolUnit | ValueRef)
    }
    return copy
  }

  private getCombinedKeys(): Set<string> {
    const keys = new Set<string>()
    for (const key of this.baseMembers.keys()) {
      if (!this.deletedKeys.has(key)) keys.add(key)
    }
    for (const key of this.localMembers.keys()) {
      if (!this.deletedKeys.has(key)) keys.add(key)
    }
    return keys
  }

  private getMapView(): Map<string, ValueRef> {
    const result = new Map<string, ValueRef>()
    const readRaw = (map: ValueRefMap): Map<string, ValueRef> => map._map
    for (const [key, ref] of readRaw(this.baseMembers)) {
      if (!this.deletedKeys.has(key)) result.set(key, ref)
    }
    for (const [key, ref] of readRaw(this.localMembers)) {
      if (!this.deletedKeys.has(key)) result.set(key, ref)
    }
    return result
  }
}

/**
 * EP 内存 overlay：读取合成基础符号表与本地符号表，写入只进入本地符号表。
 */
class OverlaySymbolTableManager implements ISymbolTableManager {
  private readonly localSymbolTable: ISymbolTableManager

  private readonly deletedSymbols: Set<string> = new Set()

  private isBaseCleared: boolean = false

  resetLocal(): void {
    this.localSymbolTable.clear()
    this.deletedSymbols.clear()
    this.isBaseCleared = false
  }

  constructor(private readonly baseSymbolTable: ISymbolTableManager) {
    this.localSymbolTable = new SymbolTableManager()
  }

  calculateUUID(unit: SymbolUnit, qidSuffix?: string): string | null {
    return this.localSymbolTable.calculateUUID(unit, qidSuffix)
  }

  register(unit: SymbolUnit): string | null {
    const uuid = this.localSymbolTable.register(unit)
    if (uuid) {
      this.deletedSymbols.delete(uuid)
    }
    return uuid
  }

  get(uuid: string | null | undefined): SymbolUnit | null {
    if (!uuid || this.deletedSymbols.has(uuid)) return null
    return this.localSymbolTable.get(uuid) ?? (this.isBaseCleared ? null : this.baseSymbolTable.get(uuid))
  }

  has(uuid: string | null | undefined): boolean {
    if (!uuid || this.deletedSymbols.has(uuid)) return false
    return this.localSymbolTable.has(uuid) || (!this.isBaseCleared && this.baseSymbolTable.has(uuid))
  }

  delete(uuid: string | null | undefined): void {
    if (!uuid) return
    this.localSymbolTable.delete(uuid)
    if (!this.isBaseCleared && this.baseSymbolTable.has(uuid)) {
      this.deletedSymbols.add(uuid)
    }
  }

  clear(): void {
    this.localSymbolTable.clear()
    this.deletedSymbols.clear()
    this.isBaseCleared = true
  }

  size(): number {
    return this.getMap().size
  }

  getMap(): Map<string, SymbolUnit> {
    const merged = new Map<string, SymbolUnit>()
    if (!this.isBaseCleared) {
      for (const [uuid, unit] of this.baseSymbolTable.getMap()) {
        if (!this.deletedSymbols.has(uuid)) {
          merged.set(uuid, unit)
        }
      }
    }
    for (const [uuid, unit] of this.localSymbolTable.getMap()) {
      if (!this.deletedSymbols.has(uuid)) {
        merged.set(uuid, unit)
      }
    }
    return merged
  }
}

export function createAnalyzerMemoryOverlay(baseSymbolTable: ISymbolTableManager): AnalyzerMemoryOverlay {
  const symbolTable = new OverlaySymbolTableManager(baseSymbolTable)
  const packageOverlayCache = new WeakMap<object, PackageOverlayEntry<unknown>>()
  const packageOverlayEntries = new Set<PackageOverlayEntry<unknown>>()
  return {
    symbolTable,
    clonePackageRoot<T>(value: T): T {
      if (!isCloneablePackageUnit(value)) return value
      const cached = packageOverlayCache.get(value) as PackageOverlayEntry<T> | undefined
      if (cached?.base === value) return cached.cloned
      const entry = clonePackageUnit(value, symbolTable)
      if (entry) {
        symbolTable.register(entry.cloned)
        packageOverlayCache.set(value, entry)
        packageOverlayEntries.add(entry)
        return entry.cloned
      }
      return value
    },
    resetLocal(): void {
      symbolTable.resetLocal()
      // package overlay 壳对象跨 EP 复用，显式清掉成员 overlay 的本地写入和 tombstone。
      for (const entry of packageOverlayEntries) {
        entry.members.resetLocal()
      }
    },
  }
}
