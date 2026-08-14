import type { TraceItem, TraceWriteOptions } from '../../../../util/finding-util'

const Config = require('../../../../config')

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

interface DataflowEdgeStatsLike {
  ENABLED: boolean
  SQLITE_ENABLED: boolean
  ensureNode(val: unknown, metadata?: unknown): number | null
  recordEdge(from: unknown, to: unknown, edgeType: string): void
}

function isDataflowStatsEnabled(): boolean {
  return Config.dataflowDb
}

// 懒加载 dataflow-edge-stats（避免循环依赖）
let _edgeStats: DataflowEdgeStatsLike | null = null
function getEdgeStats(): DataflowEdgeStatsLike | null {
  if (!isDataflowStatsEnabled()) return null
  if (!_edgeStats) {
    _edgeStats = require('../dataflow-edge-stats') as DataflowEdgeStatsLike
  }
  return _edgeStats
}

// 懒加载 current-entrypoint（避免循环依赖）
let _entryPointConfig: any = null
function getCurrentEntryPointOwnerKey(): string | undefined {
  if (!_entryPointConfig) {
    _entryPointConfig = require('../entrypoint/current-entrypoint')
  }
  return _entryPointConfig.getEntryPointOwnerKey?.()
}

export class TaintRecord {
  _owner: any
  /**
   * 首次获得污点时的 entrypoint owner key（null 表示无 EP 语境，如 preprocess 期的污点）。
   * entrypoint 之间是独立请求上下文：共享值（分配点实例/外部调用符号值等）在别的入口分析期间
   * 被打上的污点，对本入口的分析不是有效证据，在各污点获取路径上按此字段拦截。
   */
  private _epOwner: string | null = null
  private hasTag: boolean | null = null
  private tagTraces: Map<string, TraceItem[]> | null = null
  /**
   * 非传播型 sanitizer/precondition tag（SanitizerTagValue 对象集合）。
   * 与 tagTraces（传播型 string tag，如 JAVA_INPUT/SOURCE）严格分离，
   * 避免对象作 Map key 污染 tagTraces.has(string) / Array.from(keys) 语义。
   */
  private sanitizerTags: Set<any> | null = null
  /** 标记 owner 是否需要递归污点检查（ObjectValue/UnionValue/BVTValue） */
  private _recursiveHasTag: boolean = false

  constructor(owner: any) {
    this._owner = owner
  }

  private ensureTagTraces(): Map<string, TraceItem[]> {
    if (!this.tagTraces) this.tagTraces = new Map()
    return this.tagTraces
  }

  private cloneTraceMap(source: Map<string, TraceItem[]> | null): Map<string, TraceItem[]> | null {
    if (!source) return null
    const map = new Map<string, TraceItem[]>()
    for (const [k, v] of source) map.set(k, [...v])
    return map
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

  /**
   * 当前 EP 语境下该记录的污点是否可读。entrypoint 之间是独立请求上下文：
   * 共享值在别的入口分析期间获得的污点，对本入口既不可见也不参与传播，
   * 避免跨入口的错拼证据链。无 EP 语境（preprocess/串行兼容路径）时按原样可见。
   */
  private isVisibleInCurrentEp(): boolean {
    if (!this._epOwner) return true
    const current = getCurrentEntryPointOwnerKey()
    if (!current) return true
    return this._epOwner === current
  }

  /** 非递归：当前 Unit 自身是否被标记为污点 */
  get isTainted(): boolean {
    return !!this.hasTag && this.isVisibleInCurrentEp()
  }

  /** 递归：仅对需要递归检查的类型委托 astUtil.hasTag 深度检查 */
  get isTaintedRec(): boolean {
    if (!this.isVisibleInCurrentEp()) return false
    if (this.hasTag) return true

    if (this._recursiveHasTag) {
      return getAstUtilHasTag()(this._owner)
    }
    return false
  }

  getTrace(tag: string): TraceItem[] | null {
    if (!this.isVisibleInCurrentEp()) return null
    return this.tagTraces?.get(tag) || null
  }

  getTags(): string[] {
    return this.tagTraces ? Array.from(this.tagTraces.keys()) : []
  }

  /** 返回非传播型 SanitizerTagValue 对象集合（与 getTags() 互不重叠） */
  getSanitizerTags(): any[] {
    return this.sanitizerTags ? Array.from(this.sanitizerTags) : []
  }

  /** 当前是否挂着指定 SanitizerTagValue 对象 */
  hasSanitizerTag(tag: any): boolean {
    return this.sanitizerTags ? this.sanitizerTags.has(tag) : false
  }

  containsTag(tag: string, visited?: Set<TaintRecord>): boolean {
    if (!this.isVisibleInCurrentEp()) return false
    // 非 string tag（SanitizerTagValue 对象）查 sanitizerTags
    if (typeof tag !== 'string') {
      return this.sanitizerTags ? this.sanitizerTags.has(tag) : false
    }
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
    if (!this.tagTraces || !this.isVisibleInCurrentEp()) return false
    for (const [_, traces] of this.tagTraces) {
      if (traces.length > 0) return true
    }
    return false
  }

  getFirstTrace(): TraceItem[] | null {
    if (!this.tagTraces || !this.isVisibleInCurrentEp()) return null
    for (const [_, traces] of this.tagTraces) return traces
    return null
  }

  // --- 修改 ---

  addTag(tag: string): void {
    // 严判 string：非 string（如 SanitizerTagValue 对象）走 sanitizerTags 旁路，避免对象 key 污染 tagTraces。
    if (typeof tag !== 'string') {
      this.addSanitizerTag(tag)
      return
    }
    const map = this.ensureTagTraces()
    if (!map.has(tag)) map.set(tag, [])
    this.hasTag = true
    this.stampEpOwner()
  }

  /** 添加非传播型 SanitizerTagValue 对象（PRECONDITION_xx / sanitizer 严判用） */
  addSanitizerTag(tag: any): void {
    if (tag === null || tag === undefined) return
    if (!this.sanitizerTags) this.sanitizerTags = new Set()
    this.sanitizerTags.add(tag)
    this.hasTag = true
  }

  addTraceToTag(tag: string, item: TraceItem, _options?: TraceWriteOptions): void {
    const map = this.ensureTagTraces()
    if (!map.has(tag)) map.set(tag, [])
    map.get(tag)!.push(item)
    this.hasTag = true
    this.stampEpOwner()
  }

  /** 只在目标 tag 缺失或为空时物化单 tag trace，避免默认库传播混入其它来源边界。 */
  materializeTagTrace(tag: string, trace: TraceItem[]): void {
    if (typeof tag !== 'string' || !Array.isArray(trace) || trace.length === 0) return
    // 跨 entrypoint 污点拦截：外来 EP 的 trace 不物化到本 EP 的记录上
    if (this.isForeignEntryPointTrace(trace, getCurrentEntryPointOwnerKey())) return
    const map = this.ensureTagTraces()
    const current = map.get(tag)
    if (current && current.length > 0) return
    map.set(tag, [...trace])
    this.hasTag = true
    this.stampEpOwner()
  }

  addTraceToAllTags(item: TraceItem, _options?: TraceWriteOptions): void {
    if (!this.tagTraces) return
    for (const [_, traces] of this.tagTraces) traces.push(item)
    this.stampEpOwner()
  }

  /** 按 tag 快照当前各 trace 数组长度（用于 fan-out 循环抑制相邻重复 push） */
  snapshotTraceLengths(): Map<string, number> | null {
    if (!this.tagTraces) return null
    const map = new Map<string, number>()
    for (const [tag, traces] of this.tagTraces) map.set(tag, traces.length)
    return map
  }

  /** 把各 tag 的 trace 数组截断到 lengths 记录的长度（数组缩短不会创建新对象，引用关系保持） */
  truncateTraceLengths(lengths: Map<string, number> | null): void {
    if (!lengths || !this.tagTraces) return
    for (const [tag, traces] of this.tagTraces) {
      const target = lengths.get(tag)
      if (target !== undefined && traces.length > target) traces.length = target
    }
  }

  popFromAllTraces(_options?: TraceWriteOptions): void {
    if (!this.tagTraces) return
    for (const [_, traces] of this.tagTraces) traces.pop()
  }

  /** 清空所有 tag 的 trace（保留 tag 本身） */
  clearTrace(): void {
    if (!this.tagTraces) return
    for (const [tag] of this.tagTraces) this.tagTraces.set(tag, [])
  }

  /** 从 source 复制 tags + trace + hasTag（收口 memSpace 手工复制） */
  copyFrom(source: TaintRecord): void {
    this.hasTag = source.hasTag
    this.tagTraces = this.cloneTraceMap(source.tagTraces)
    if (source.sanitizerTags && source.sanitizerTags.size > 0) {
      this.sanitizerTags = new Set(source.sanitizerTags)
    } else {
      this.sanitizerTags = null
    }
    // owner 随污点一起复制，保证下游合并仍能识别来源 EP
    this._epOwner = source._epOwner
  }

  clear(): void {
    this.hasTag = null
    this.tagTraces = null
    this.sanitizerTags = null
    this._epOwner = null
  }

  // --- 传播接口 ---

  /** 标记当前为污点源 */
  markSource(): void {
    this.hasTag = true
    this.stampEpOwner()
    // 确保 source 节点在 DB 中存在并标记 nodeRole='source'（离线阶段 BFS 起点）
    const stats = getEdgeStats()
    if (stats?.SQLITE_ENABLED && this._owner) stats.ensureNode(this._owner, { nodeRole: 'source' })
  }

  /** 从单个源传播污点状态（source 必须是 Unit，调用方负责类型检查） */
  propagateFrom(source: any): void {
    // 跨 entrypoint 污点拦截：外来 EP 的污点在本 EP 语境下无效，flag 也不接
    if (this.isForeignEntryPointTaint(source?._taint, getCurrentEntryPointOwnerKey())) return
    const stats = getEdgeStats()
    if (stats?.ENABLED || stats?.SQLITE_ENABLED) stats?.recordEdge(source, this._owner, 'propagate')
    // 用 _taint 避免触发 getter 创建空 TaintRecord
    this.hasTag = source?._taint?.isTaintedRec ?? null
    if (this.hasTag) this.stampEpOwner()
  }

  /** 从多个源合并污点状态（sources 元素必须是 Unit，调用方负责类型检查） */
  mergeFrom(sources: (any)[]): void {
    const currentOwner = getCurrentEntryPointOwnerKey()
    // 跨 entrypoint 污点拦截：过滤外来 EP 的污点源
    const validSources = sources.filter((s: any) => !this.isForeignEntryPointTaint(s?._taint, currentOwner))
    const stats = getEdgeStats()
    if (stats?.ENABLED || stats?.SQLITE_ENABLED) {
      for (const s of validSources) {
        if (s) stats.recordEdge(s, this._owner, 'merge')
      }
    }
    this.hasTag = validSources.some((s: any) => s?._taint?.isTaintedRec) || null
    if (this.hasTag) this.stampEpOwner()
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
  setAllTraces(traceVal: TraceItem[]): void {
    if (this.tagTraces && this.tagTraces.size > 0) {
      for (const [tag] of this.tagTraces) this.tagTraces.set(tag, [...traceVal])
    } else {
      this.ensureTagTraces().set('__default__', [...traceVal])
      this.hasTag = true
    }
    this.stampEpOwner()
  }

  /** 从 source 按同名 tag 继承 trace，避免跨 tag 绑定错误来源 */
  inheritTracesFrom(source: TaintRecord): void {
    if (!this.tagTraces) return
    const currentOwner = getCurrentEntryPointOwnerKey()
    if (this.isForeignEntryPointTaint(source, currentOwner)) return
    let wrote = false
    for (const [tag] of this.tagTraces) {
      const srcTrace = source.getTrace(tag)
      if (this.isForeignEntryPointTrace(srcTrace, currentOwner)) continue
      if (srcTrace && srcTrace.length > 0) {
        this.tagTraces.set(tag, [...srcTrace])
        wrote = true
      }
    }
    // 合并也是污点获取点：首次写入时打上本 EP owner，否则跨 EP 场景记录无 owner 守卫会失效
    if (wrote) this.stampEpOwner()
  }

  private traceHasSourceStep(trace: TraceItem[] | undefined): boolean {
    return Array.isArray(trace) && trace.some((item: TraceItem) => item?.tag === 'SOURCE: ' ||
      (typeof item?.str === 'string' && item.str.includes('SOURCE: ')))
  }

  private getSourceStep(trace: TraceItem[] | undefined): TraceItem | undefined {
    return Array.isArray(trace)
      ? trace.find((item: TraceItem) => item?.tag === 'SOURCE: ' ||
        (typeof item?.str === 'string' && item.str.includes('SOURCE: ')))
      : undefined
  }

  /** 记录污点首次获得时的 entrypoint 语境；NULL_TAINT（_owner 为空）不打标 */
  private stampEpOwner(): void {
    if (this._epOwner || !this._owner) return
    this._epOwner = getCurrentEntryPointOwnerKey() ?? null
  }

  /**
   * donor 记录是否携带其他 entrypoint 的污点。记录级判据，覆盖 flag-only 传播形成的无 SOURCE trace。
   */
  private isForeignEntryPointTaint(source: TaintRecord | null | undefined, currentOwner: string | undefined): boolean {
    if (!source || !currentOwner) return false
    const owner = source._epOwner
    return typeof owner === 'string' && owner.length > 0 && owner !== currentOwner
  }

  /**
   * donor trace 的 SOURCE 属于其他 entrypoint 时，该污点在当前 entrypoint 语境下不是有效证据。
   * entrypoint 之间是独立请求上下文：共享值（分配点实例/外部调用符号值等）在别的入口分析期间
   * 被打上的污点，合入本入口的链路只会产生错拼的证据链，必须在合并处拦截。
   */
  private isForeignEntryPointTrace(trace: TraceItem[] | null | undefined, currentOwner: string | undefined): boolean {
    if (!currentOwner || !Array.isArray(trace)) return false
    const owner = this.getSourceStep(trace)?.source_owner_ep
    return typeof owner === 'string' && owner.length > 0 && owner !== currentOwner
  }

  private getSourceFile(sourceStep: TraceItem): string {
    if (typeof sourceStep.file === 'string' && sourceStep.file.length > 0) return sourceStep.file
    const nodeFile = sourceStep.node?.loc?.sourcefile
    if (typeof nodeFile === 'string' && nodeFile.length > 0) return nodeFile
    return ''
  }

  private getSourceLine(sourceStep: TraceItem): string {
    if (Array.isArray(sourceStep.line)) return sourceStep.line.join(',')
    if (typeof sourceStep.line === 'number') return String(sourceStep.line)
    const nodeLine = sourceStep.node?.loc?.start?.line
    if (typeof nodeLine === 'number') return String(nodeLine)
    return ''
  }

  private getSourceIdentity(trace: TraceItem[] | undefined): string | undefined {
    const sourceStep = this.getSourceStep(trace)
    if (!sourceStep) return undefined
    const owner = typeof sourceStep.source_owner_ep === 'string' && sourceStep.source_owner_ep.length > 0
      ? sourceStep.source_owner_ep
      : ''
    const file = this.getSourceFile(sourceStep)
    const line = this.getSourceLine(sourceStep)
    if (!owner && !file && !line) return undefined
    return `${owner}|${file}|${line}`
  }

  private hasDifferentSourceIdentity(left: TraceItem[] | undefined, right: TraceItem[] | undefined): boolean {
    const leftIdentity = this.getSourceIdentity(left)
    const rightIdentity = this.getSourceIdentity(right)
    return leftIdentity !== undefined && rightIdentity !== undefined && leftIdentity !== rightIdentity
  }

  /** 跨 source 合并只借用传播位置，不能把 donor 的 source owner 带到目标链路。 */
  private static withoutSourceOwner(item: TraceItem): TraceItem {
    if (!('source_owner_ep' in item)) return item
    const cloned = { ...item }
    delete cloned.source_owner_ep
    return cloned
  }

  /** 从 source 复制 traces 到 this（逐 tag 深拷贝，不影响 hasTag） */
  mergeTracesFrom(source: TaintRecord): void {
    // 跨 entrypoint 污点拦截：donor 记录整体属于其他 EP 时直接拒绝
    if (this.isForeignEntryPointTaint(source, getCurrentEntryPointOwnerKey())) return
    let wrote = false
    if (source.sanitizerTags && source.sanitizerTags.size > 0) {
      if (!this.sanitizerTags) this.sanitizerTags = new Set()
      for (const tag of source.sanitizerTags) this.sanitizerTags.add(tag)
      this.hasTag = true
      wrote = true
    }
    if (source.tagTraces) {
      const map = this.ensureTagTraces()
      const currentOwner = getCurrentEntryPointOwnerKey()
      for (const [tag, trace] of source.tagTraces) {
        if (this.isForeignEntryPointTrace(trace, currentOwner)) continue
        const current = map.get(tag)
        if (this.traceHasSourceStep(current) && !this.traceHasSourceStep(trace)) continue
        map.set(tag, [...trace])
        wrote = true
      }
    }
    // 合并也是污点获取点：首次写入时打上本 EP owner，否则跨 EP 场景记录无 owner 守卫会失效
    if (wrote) this.stampEpOwner()
  }

  /** 返回单条 trace 的位置键，忽略 callback provenance 以支持兼容元数据合并。 */
  private static traceItemBaseKey(item: TraceItem): string {
    const lineKey = Array.isArray(item.line) ? item.line.join(',') : String(item.line ?? '')
    return `${item.file ?? ''}|${item.tag ?? ''}|${lineKey}`
  }

  /** 把单条 trace 的去重键缓存到 item 上，避免热点路径反复 JSON.stringify(line) */
  private static traceItemKey(item: TraceItem): string {
    const cached = (item as TraceItem & { __dedupKey?: string }).__dedupKey
    if (cached !== undefined) return cached
    const baseKey = TaintRecord.traceItemBaseKey(item)
    const callbackOwner = item._callbackEdge === true
      ? `|callback:${item._callbackClosureOwnerHash ?? ''}`
      : ''
    const key = `${baseKey}${callbackOwner}`
    ;(item as TraceItem & { __dedupKey?: string }).__dedupKey = key
    return key
  }

  /** 从 source 合并 traces，带三维去重（file + tag + line）。线性扫描 + Map 索引，避免 O(N*M)；返回是否实际新增了 trace 条目 */
  mergeTracesDedup(source: TaintRecord): boolean {
    let added = false
    // 跨 entrypoint 污点拦截：donor 记录整体属于其他 EP 时直接拒绝
    if (this.isForeignEntryPointTaint(source, getCurrentEntryPointOwnerKey())) return added
    if (source.sanitizerTags && source.sanitizerTags.size > 0) {
      if (!this.sanitizerTags) this.sanitizerTags = new Set()
      for (const tag of source.sanitizerTags) this.sanitizerTags.add(tag)
      this.hasTag = true
    }
    if (!source.tagTraces) return added
    const map = this.ensureTagTraces()
    const currentOwner = getCurrentEntryPointOwnerKey()
    for (const [tag, resTrace] of source.tagTraces) {
      if (this.isForeignEntryPointTrace(resTrace, currentOwner)) continue
      const childTrace = map.get(tag)
      if (!childTrace) {
        map.set(tag, [...resTrace])
        added = true
        continue
      }

      const hasDifferentSource = this.hasDifferentSourceIdentity(childTrace, resTrace)
      const childHasPropagation = childTrace.some((item: TraceItem) => item?.tag !== 'SOURCE: ' && item?.tag !== 'SINK: ')

      // 用 Map 给 childTrace 建索引，单 tag 内合并降到 O(N+M)
      const indexByKey = new Map<string, TraceItem>()
      for (const item of childTrace) indexByKey.set(TaintRecord.traceItemKey(item), item)

      for (const resTraceItem of resTrace) {
        // 已形成传播链的不同来源只借用传播步，避免把第二个 SOURCE/历史 SINK 拼进同一条证据链。
        if (hasDifferentSource && childHasPropagation && (resTraceItem?.tag === 'SOURCE: ' || resTraceItem?.tag === 'SINK: ')) continue
        const key = TaintRecord.traceItemKey(resTraceItem)
        const existing = indexByKey.get(key)
        if (existing) {
          // 同位置去重只补展示名，避免把内部物化标记提升到基准输出。
          if (existing.affectedNodeName?.includes('__tmp') && !resTraceItem.affectedNodeName?.includes('__tmp')) {
            existing.affectedNodeName = resTraceItem.affectedNodeName
          }
        } else {
          const itemToMerge = hasDifferentSource
            ? TaintRecord.withoutSourceOwner(resTraceItem)
            : resTraceItem
          childTrace.push(itemToMerge)
          indexByKey.set(key, itemToMerge)
          added = true
        }
      }
    }
    // 合并也是污点获取点：首次写入时打上本 EP owner，否则跨 EP 场景记录无 owner 守卫会失效
    if (added) this.stampEpOwner()
    return added
  }

  /** 结构化比较两条 trace 的行号（number 或 number[]，跨行 trace 逐元素比较） */
  private static isSameTraceLine(a: number | number[] | undefined, b: number | number[] | undefined): boolean {
    if (a === b) return true
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((v, i) => v === b[i])
    }
    return false
  }

  /** 从 resTaint 传播 trace 到当前值（收口 source-line processFieldAndArguments 重复模式）；返回是否实际新增了内容 */
  propagateTraceFrom(resTaint: TaintRecord, traceItem?: TraceItem, options?: TraceWriteOptions): boolean {
    // 跨 entrypoint 污点拦截：外来 EP 的 donor 既不接受 trace 也不写当前 step
    if (this.isForeignEntryPointTaint(resTaint, getCurrentEntryPointOwnerKey())) return false
    let changed = false
    if (traceItem && !resTaint.hasTraces() && this.hasTags()) {
      // 同一语句点对同一记录的连续 decoration 是同一流动点的重写而非新流动步，
      // 与根路径 dedupLastTrace 的同位置替换语义对齐：末步同 (file, line, tag) 时先弹出再写入。
      const firstTrace = this.getFirstTrace()
      if (firstTrace && firstTrace.length > 0) {
        const last = firstTrace[firstTrace.length - 1]
        if (
          last.file === traceItem.file &&
          last.tag === traceItem.tag &&
          TaintRecord.isSameTraceLine(last.line, traceItem.line) &&
          (last._callbackEdge === true) === (traceItem._callbackEdge === true) &&
          (last._callbackEdge !== true || last._callbackClosureOwnerHash === traceItem._callbackClosureOwnerHash)
        ) {
          this.popFromAllTraces(options)
        }
      }
      this.addTraceToAllTags(traceItem, options)
      changed = true
    }
    if (this.mergeTracesDedup(resTaint)) changed = true
    return changed
  }

  /** 去重：若最后一条 trace 与参数及回调归属匹配则弹出。 */
  dedupLastTrace(file: string, line: number, tag: string, options?: TraceWriteOptions): void {
    const firstTrace = this.getFirstTrace()
    if (!firstTrace || firstTrace.length === 0) return
    const last = firstTrace[firstTrace.length - 1]
    const callbackMatches = (last._callbackEdge === true) === (options?.callbackEdge === true) &&
      (last._callbackEdge !== true || last._callbackClosureOwnerHash === options?.callbackClosureOwnerHash)
    if (last.file === file && last.line === line && last.tag === tag && callbackMatches) this.popFromAllTraces(options)
  }

  /** 返回 tagTraces 的只读引用（给 source-line 等需要直接遍历 Map 的场景） */
  getTagTracesMap(): ReadonlyMap<string, TraceItem[]> {
    return this.tagTraces ?? new Map()
  }

  // --- 克隆 ---

  _clone(newOwner: any): TaintRecord {
    const copy = new TaintRecord(newOwner)
    copy.hasTag = this.hasTag
    copy._recursiveHasTag = this._recursiveHasTag
    copy._epOwner = this._epOwner
    copy.tagTraces = this.cloneTraceMap(this.tagTraces)
    if (this.sanitizerTags && this.sanitizerTags.size > 0) {
      copy.sanitizerTags = new Set(this.sanitizerTags)
    }

    // 仅在有 taint 时记录 clone 边，避免无污点 clone 噪音
    if (this.hasTag && this._owner && newOwner) {
      const stats = getEdgeStats()
      if (stats?.ENABLED || stats?.SQLITE_ENABLED) stats?.recordEdge(this._owner, newOwner, 'taint_clone')
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
