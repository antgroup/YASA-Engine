// 跨 addSrcLineInfo 调用复用的 visited memo：单 entrypoint 生命周期内
// 防止同一污染子树被反复重灌 buildNestedTraceCopy（卡点 A 主因）。
// 按 entrypoint 重置（resetCrossCallVisited）；union/BVT 不进 memo。
export type CrossCallVisitedKey = string

// LRU 容量上限：单 entrypoint 内 115k clone 实测，50000 足够覆盖热值集，避免 Map 自身膨胀到 GB 级。
const CROSS_CALL_VISITED_MAX_ENTRIES = 50000

/**
 * 跨调用 visited memo：Map 保存插入顺序，超容量淘汰最旧（LRU 近似）。
 * entry 包含「该指纹的全 tag 末步组合」，命中即认为该 val 在本入口内已灌过 trace，直接跳过整个 processFieldAndArguments。
 */
class CrossCallVisited {
  private map: Map<CrossCallVisitedKey, true> = new Map()
  private maxEntries: number

  constructor(maxEntries: number = CROSS_CALL_VISITED_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  /** 命中返回 true；命中会刷新到 Map 末尾以维持 LRU 顺序。 */
  has(key: CrossCallVisitedKey): boolean {
    if (!this.map.has(key)) return false
    this.map.delete(key)
    this.map.set(key, true)
    return true
  }

  /** 写入新指纹；超容量时淘汰 Map 中最旧的 entry。 */
  mark(key: CrossCallVisitedKey): void {
    if (this.map.has(key)) {
      this.map.delete(key)
      this.map.set(key, true)
      return
    }
    this.map.set(key, true)
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next()
      if (!oldest.done) {
        this.map.delete(oldest.value as CrossCallVisitedKey)
      }
    }
  }

  /** 按 entrypoint 重置：跨入口污染会让卡点 A 完全失败（Expert §3.3 约束 3）。 */
  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

// 模块级单例：source-line.ts 复用该实例跨 addSrcLineInfo 调用去重。
const crossCallVisited = new CrossCallVisited()

/**
 * 构建单次 addSrcLineInfo 调用入口处的跨调用 memo key。
 * union/BVT（buildBucketKey 返回 null）由调用方 fallback 到单次 visited，不进跨调用 memo。
 * key 由「val 桶指纹 + 全 tag 末步指纹」组成：多 tag 时按 tag 各取末步组合，避免 getLastTraceVariantKey 只看 Map 第一个 tag 的失真。
 */
function buildCrossCallVisitedKey(
  bucketKey: string,
  taint: {
    getTags?: () => string[]
    getTrace?: (tag: string) => { file?: string; line?: unknown; tag?: string; affectedNodeName?: string }[] | null
  } | null | undefined,
): string | null {
  if (!taint || typeof taint.getTags !== 'function' || typeof taint.getTrace !== 'function') {
    return null
  }
  const tags = taint.getTags()
  if (tags.length === 0) return null
  const perTagKeys: string[] = []
  for (const tag of tags) {
    const trace = taint.getTrace(tag)
    if (!Array.isArray(trace) || trace.length === 0) {
      perTagKeys.push(`<empty:${tag}>`)
      continue
    }
    const last = trace[trace.length - 1]
    const lineKey = Array.isArray(last?.line) ? (last!.line as unknown[]).join(',') : String(last?.line ?? '')
    perTagKeys.push(`${last?.file ?? ''}:${lineKey}:${last?.tag ?? ''}:${last?.affectedNodeName ?? ''}`)
  }
  perTagKeys.sort()
  return `${bucketKey}#${perTagKeys.join('|')}`
}

/**
 * 判定是否命中跨调用 memo；命中则跳过整个 processFieldAndArguments（整树不重灌）。
 * 由调用方先 buildCrossCallVisitedKey 取得 key 再 probe，避免 union/BVT 路径构造空 key。
 */
function probeCrossCallVisited(key: CrossCallVisitedKey): boolean {
  return crossCallVisited.has(key)
}

/** 写入命中指纹；调用方负责只在 memo miss 后调用一次。 */
function markCrossCallVisited(key: CrossCallVisitedKey): void {
  crossCallVisited.mark(key)
}

/** 入口开始 hook：python-analyzer.resetMemoryGuardForEntryPoint 同点调用。 */
function resetCrossCallVisited(): void {
  crossCallVisited.clear()
}

module.exports = {
  CrossCallVisited,
  buildCrossCallVisitedKey,
  probeCrossCallVisited,
  markCrossCallVisited,
  resetCrossCallVisited,
}