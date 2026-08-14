/**
 * per-executor 数据流写入上下文：EP-local 缓存、边去重、边缓冲、诊断计数器。
 * 串行路径不创建 context，所有读取方 fallback 到 module-global。
 */

// SimpleLRU 从 dataflow-edge-stats 中复制，避免循环依赖
class SimpleLRU<K, V> {
  private map = new Map<K, V>()

  constructor(private max: number) {}

  get(k: K): V | undefined {
    const v = this.map.get(k)
    if (v !== undefined) {
      this.map.delete(k)
      this.map.set(k, v)
    }
    return v
  }

  set(k: K, v: V): void {
    if (this.map.has(k)) {
      this.map.delete(k)
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value as K | undefined
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(k, v)
  }

  get size(): number { return this.map.size }
  clear(): void { this.map.clear() }
}

type EdgeEpDedupSet = Set<number>
type EdgeTypeDedupMap = Map<number, EdgeEpDedupSet>
type EdgeToDedupMap = Map<number, EdgeTypeDedupMap>
type EdgeFromDedupMap = Map<number, EdgeToDedupMap>

export class DataflowWriterContext {
  // 节点缓存
  nodeIdCache = new SimpleLRU<string, number>(300_000)
  stringNodeCache = new SimpleLRU<string, number>(300_000)
  valNodeIdCache = new WeakMap<object, Map<string, number>>()

  // 边去重
  edgeDedupMap: EdgeFromDedupMap = new Map()
  edgeTypeIdMap = new Map<string, number>()
  nextEdgeTypeId = 1

  // 边缓冲
  edgeBuffer: Array<[number, number, string, number | null, number | null, string | null, string | null, string | null]> = []

  // EP 映射
  epIdCache = new Map<string, number>()

  // Call anchor
  callAnchorIdCache = new Map<string, number>()
  callAnchorIdSeq = 0

  // 诊断计数器
  insertNodeTimeMs = 0
  insertEdgeTimeMs = 0
  insertNodeCount = 0
  insertEdgeCount = 0
  selfEdgeFiltered = 0
  edgeDedupFiltered = 0
  incrementalEdgeSkipped = 0
  sourceProbeSkipped = 0

  // Hook
  beforeEdgeHook: ((from: unknown) => void) | null = null
}

/**
 * 获取当前 executor context 中的 DataflowWriterContext。
 * 无 executor context 时返回 undefined，调用方 fallback 到 module-global。
 */
export function getCurrentWriterContext(): DataflowWriterContext | undefined {
  // 延迟 require 避免循环依赖
  const { getCurrentExecutorWriterContext } = require('./entrypoint/entrypoint-executor')
  return getCurrentExecutorWriterContext()
}
