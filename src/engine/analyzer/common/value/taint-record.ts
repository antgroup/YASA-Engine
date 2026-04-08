/**
 * TaintRecord - 污点追踪属性组
 *
 * 内存优化：
 * - 大部分 Unit 从不使用 taint（95%+），用全局 NULL_TAINT 单例避免对象分配
 * - NULL_TAINT 不持有 _owner，所有查询返回 false/empty
 * - 任何写操作自动将 owner.taint 升级为独立实例（写时复制语义）
 * - tagTraces 懒分配，仅在首次 addTag 时创建 Map
 *
 * ObjectValue/UnionValue/BVTValue 构造时调 markRecursive()，
 * 会触发升级为独立实例（因为 isTaintedRec 需要 _owner 做递归检查）。
 */

// 懒加载 ast-util.hasTag（避免循环依赖）
let _astUtilHasTag: ((val: any) => boolean) | null = null
function getAstUtilHasTag(): (val: any) => boolean {
  if (!_astUtilHasTag) {
    _astUtilHasTag = require('../../../../util/ast-util').hasTag
  }
  return _astUtilHasTag!
}

export class TaintRecord {
  _owner: any
  private hasTag: boolean | null = null
  private tagTraces: Map<string, any[]> | null = null
  /** 标记 owner 是否需要递归污点检查（ObjectValue/UnionValue/BVTValue） */
  private _recursiveHasTag: boolean = false

  constructor(owner: any) {
    this._owner = owner
  }

  private ensureTagTraces(): Map<string, any[]> {
    if (!this.tagTraces) this.tagTraces = new Map()
    return this.tagTraces
  }

  /** 标记为需要递归污点检查（ObjectValue/UnionValue/BVTValue 构造时调用） */
  markRecursive(): void {
    this._recursiveHasTag = true
  }

  /** Re-bind to a new owner (e.g. when taint is transferred via {...unit} spread) */
  rebindOwner(newOwner: any): void {
    this._owner = newOwner
  }


  // --- 查询 ---

  /** 非递归：当前 Unit 自身是否被标记为污点 */
  get isTainted(): boolean {
    return !!this.hasTag
  }

  /** 递归：仅对需要递归检查的类型委托 astUtil.hasTag 深度检查 */
  get isTaintedRec(): boolean {
    if (this._recursiveHasTag) {
      return getAstUtilHasTag()(this._owner)
    }
    return !!this.hasTag
  }

  getTrace(tag: string): any[] | null {
    return this.tagTraces?.get(tag) || null
  }

  getTags(): string[] {
    return this.tagTraces ? Array.from(this.tagTraces.keys()) : []
  }

  containsTag(tag: string, visited?: Set<TaintRecord>): boolean {
    if (this.tagTraces?.has(tag)) return true
    // 递归类型（Union/BVT/Object）：检查子值是否持有该 tag
    if (this._recursiveHasTag && this._owner) {
      if (!visited) visited = new Set()
      if (visited.has(this)) return false
      visited.add(this)
      const owner = this._owner
      if (owner.vtype === 'union' && Array.isArray(owner.value)) {
        return owner.value.some((child: any) => child?._taint?.containsTag(tag, visited))
      }
      if (owner.vtype === 'BVT' && owner.value) {
        return Object.values(owner.value).some((child: any) => (child as any)?._taint?.containsTag(tag, visited))
      }
    }
    return false
  }

  hasTraces(): boolean {
    if (!this.tagTraces) return false
    for (const [_, traces] of this.tagTraces) {
      if (traces.length > 0) return true
    }
    return false
  }

  getFirstTrace(): any[] | null {
    if (!this.tagTraces) return null
    for (const [_, traces] of this.tagTraces) {
      return traces
    }
    return null
  }

  // --- 修改 ---

  addTag(tag: string): void {
    const map = this.ensureTagTraces()
    if (!map.has(tag)) {
      map.set(tag, [])
    }
    this.hasTag = true
  }

  addTraceToTag(tag: string, item: any): void {
    const map = this.ensureTagTraces()
    if (!map.has(tag)) {
      map.set(tag, [])
    }
    map.get(tag)!.push(item)
    this.hasTag = true
  }

  addTraceToAllTags(item: any): void {
    if (!this.tagTraces) return
    for (const [_, traces] of this.tagTraces) {
      traces.push(item)
    }
  }

  popFromAllTraces(): void {
    if (!this.tagTraces) return
    for (const [_, traces] of this.tagTraces) {
      traces.pop()
    }
  }

  /** 清空所有 tag 的 trace（保留 tag 本身） */
  clearTrace(): void {
    if (!this.tagTraces) return
    for (const [tag] of this.tagTraces) {
      this.tagTraces.set(tag, [])
    }
  }

  /** 从 source 复制 tags + trace + hasTag（收口 memSpace 手工复制） */
  copyFrom(source: TaintRecord): void {
    this.hasTag = source.hasTag
    if (source.tagTraces) {
      const map = this.ensureTagTraces()
      map.clear()
      for (const [k, v] of source.tagTraces) {
        map.set(k, [...v])
      }
    } else {
      this.tagTraces = null
    }
  }

  clear(): void {
    this.hasTag = null
    this.tagTraces = null
  }

  // --- 传播接口 ---

  /** 标记当前为污点源 */
  markSource(): void {
    this.hasTag = true
  }

  /** 从单个源传播污点状态（source 必须是 Unit，调用方负责类型检查） */
  propagateFrom(source: any): void {
    // 用 _taint 避免触发 getter 创建空 TaintRecord
    this.hasTag = source?._taint?.isTaintedRec ?? null
  }

  /** 从多个源合并污点状态（sources 元素必须是 Unit，调用方负责类型检查） */
  mergeFrom(sources: (any)[]): void {
    this.hasTag = sources.some((s: any) => s?._taint?.isTaintedRec) || null
  }

  /** 清除污点状态 */
  sanitize(): void {
    this.hasTag = null
  }

  // --- 外部访问接口 ---

  /** tagTraces 是否有 tag（等价于 tagTraces.size > 0） */
  hasTags(): boolean {
    return this.tagTraces ? this.tagTraces.size > 0 : false
  }

  /** 为所有现有 tag 设置相同 trace；若无 tag 则创建 __default__ 并标记 hasTag */
  setAllTraces(traceVal: any[]): void {
    if (this.tagTraces && this.tagTraces.size > 0) {
      for (const [tag] of this.tagTraces) {
        this.tagTraces.set(tag, traceVal)
      }
    } else {
      this.ensureTagTraces().set('__default__', traceVal)
      this.hasTag = true
    }
  }

  /** 从 source 继承 trace（所有 tag 共享同一数组引用，用于父→子成员传播） */
  inheritTracesFrom(source: TaintRecord): void {
    const srcTrace = source.getFirstTrace()
    if (!srcTrace || srcTrace.length === 0) return
    if (!this.tagTraces) return
    const shared = [...srcTrace]
    for (const [tag] of this.tagTraces) {
      this.tagTraces.set(tag, shared)
    }
  }

  /** 从 source 复制 traces 到 this（逐 tag 深拷贝，不影响 hasTag） */
  mergeTracesFrom(source: TaintRecord): void {
    if (!source.tagTraces) return
    const map = this.ensureTagTraces()
    for (const [tag, trace] of source.tagTraces) {
      map.set(tag, [...trace])
    }
  }

  /** 从 source 合并 traces，带三维去重（file + tag + JSON.stringify(line)） */
  mergeTracesDedup(source: TaintRecord): void {
    if (!source.tagTraces) return
    const map = this.ensureTagTraces()
    for (const [tag, resTrace] of source.tagTraces) {
      const childTrace = map.get(tag)
      if (!childTrace) {
        map.set(tag, [...resTrace])
        continue
      }

      for (const resTraceItem of resTrace) {
        let isDuplicate = false
        for (const childTraceItem of childTrace) {
          if (
            childTraceItem.file === resTraceItem.file &&
            childTraceItem.tag === resTraceItem.tag &&
            JSON.stringify(childTraceItem.line) === JSON.stringify(resTraceItem.line)
          ) {
            // __tmp 名称覆盖规则
            if (childTraceItem.affectedNodeName?.includes('__tmp') && !resTraceItem.affectedNodeName?.includes('__tmp')) {
              childTraceItem.affectedNodeName = resTraceItem.affectedNodeName
            }
            isDuplicate = true
            break
          }
        }
        if (!isDuplicate) {
          childTrace.push(resTraceItem)
        }
      }
    }
  }

  /** 从 resTaint 传播 trace 到当前值（收口 source-line processFieldAndArguments 重复模式） */
  propagateTraceFrom(resTaint: TaintRecord, traceItem?: any): void {
    if (traceItem && !resTaint.hasTraces() && this.hasTags()) {
      this.addTraceToAllTags(traceItem)
    }
    this.mergeTracesDedup(resTaint)
  }

  /** 去重：若最后一条 trace 与参数匹配则弹出 */
  dedupLastTrace(file: string, line: number, tag: string): void {
    const firstTrace = this.getFirstTrace()
    if (firstTrace && firstTrace.length > 0) {
      const last = firstTrace[firstTrace.length - 1]
      if (last.file === file && last.line === line && last.tag === tag) {
        this.popFromAllTraces()
      }
    }
  }

  /** 返回 tagTraces 的只读引用（给 source-line 等需要直接遍历 Map 的场景） */
  getTagTracesMap(): ReadonlyMap<string, any[]> {
    return this.tagTraces ?? new Map()
  }

  // --- 克隆 ---

  _clone(newOwner: any): TaintRecord {
    const copy = new TaintRecord(newOwner)
    copy.hasTag = this.hasTag
    copy._recursiveHasTag = this._recursiveHasTag
    if (this.tagTraces) {
      const map = copy.ensureTagTraces()
      for (const [k, v] of this.tagTraces) {
        map.set(k, [...v])
      }
    }
    return copy
  }
}

/**
 * 全局共享的空 TaintRecord 单例。
 * 所有查询返回 false/empty，所有写操作无副作用（因为没有真实 owner 可以升级）。
 * Unit 构造时默认使用此实例，只在确实需要 taint 时才 new TaintRecord(this)。
 */
export const NULL_TAINT = new TaintRecord(null)
