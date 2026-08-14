/**
 * 变更影响分析（Change Impact Analysis）：基于离线数据流 DB 的 5 类 evidence 一跳并集反查。
 *
 * 输入：DB 路径 + 变更区间列表（file:startLine-endLine）
 * 输出：受影响的 entrypoint 集合 + reached_via 解释 + stats
 *
 * 算法核心：不做 BFS，5 类事实表（entrypoint_body / call_site / callee_qid /
 * builtin_sources / edges_one_hop）+ 增强 provenance（module_deps /
 * go_interface_dispatch / handler_response_flow / mutating_receiver_alias /
 * decl_use_impact_edges）+ Go downstream EP 文件级回补，做并集。
 *
 * 该工具是正式 TypeScript 查询入口，只读取离线数据流 DB，不触发 analyzer 运行。
 */

import Database from 'better-sqlite3'
import * as path from 'path'
import * as fs from 'fs'
import { Command } from 'commander'

// === 公开类型契约 ===

/** 一次变更区间，对应 git hunk 或人工指定的 file:startLine-endLine。 */
export interface Change {
  file: string
  startLine: number
  endLine: number
}

/** 受影响的 entrypoint 记录，包含命中来源解释。 */
export interface Entrypoint {
  ep_id: string
  file: string
  func_name: string
  start_line: number
  end_line: number
  ep_type: string
  framework: string
  attribute: string
  reached_via: string[]
}

/** evidence 命中计数，用于解释每类事实的贡献。 */
export interface CandidateCounts {
  entrypoint_body: number
  call_site: number
  callee_qid: number
  builtin_sources: number
  module_deps: number
  go_interface_dispatch: number
  handler_response_flow: number
  mutating_receiver_alias: number
  decl_use_impact_edges: number
  edges_one_hop: number
  downstream_ep_file: number
}

export interface LookupStats {
  changed_nodes_total: number
  candidate_counts: CandidateCounts
  reachable_entrypoints: number
  enclosing_function_dirty_ranges: number
}

export interface LookupResult {
  entrypoints: Entrypoint[]
  stats: LookupStats
}

// === 内部类型 ===

/** callgraph summary 字符串 `qual\n[file : start_end]` 解析结果。 */
interface SummaryFunc {
  qual: string
  func_name: string
  file_name: string
  start_line: number
  end_line: number
}

/** entrypoints 表行（按需取列）。 */
interface EntrypointRow {
  id: number
  ep_id: string
  file: string
  func_name: string
  start_line: number
  end_line: number
  ep_type: string
  framework: string
  attribute: string
}

/** entrypoints 表的最小 (id, file, start, end) 行。 */
interface EpRangeRow {
  id: number
  file: string
  start_line: number
  end_line: number
}

/** callgraph 精确下游查询返回的 call 行（含 callee 范围）。 */
interface PreciseCallRow {
  call_site_file: string
  call_site_line: number
  callee_qid: string
  callee_start_line: number
  callee_end_line: number
}

/** Go downstream EP 集合元素：[ep_id, file]；TS Set 不能对元组做值相等，统一用字符串 key 序列化。 */
type EpFilePair = readonly [number, string]

function epFileKey(pair: EpFilePair): string {
  return `${pair[0]}\u0000${pair[1]}`
}

function parseEpFileKey(key: string): EpFilePair {
  const idx = key.indexOf('\u0000')
  return [Number(key.slice(0, idx)), key.slice(idx + 1)]
}

/** Map.setdefault 等价物：缺则插入新 Set 并返回。 */
function getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let existing = map.get(key)
  if (!existing) {
    existing = new Set<V>()
    map.set(key, existing)
  }
  return existing
}

// === 工具函数 ===

function normalizePath(filePath: string | null | undefined): string {
  if (!filePath) return ''
  let s = String(filePath)
  while (s.startsWith('/')) s = s.slice(1)
  return s
}

function normalizedChangeFile(change: Change): string {
  return normalizePath(change.file)
}

function isGoFile(filePath: string): boolean {
  return normalizePath(filePath).toLowerCase().endsWith('.go')
}

/** Python re `r"(?P<qual>.+?)\\n\[(?P<file>[^:]+) : (?P<start>\d+)_(?P<end>\d+)\]"`。
 *  Python raw string `\\n` 即字面 `\n`（反斜杠+小写 n 两字符）。TS 正则写法对应。 */
const SUMMARY_FUNC_RE = /(.+?)\\n\[([^:]+) : (\d+)_(\d+)\]/

function parseSummaryFunc(text: string | null | undefined): SummaryFunc | null {
  if (!text) return null
  const match = SUMMARY_FUNC_RE.exec(String(text))
  if (!match) return null
  const qual = match[1].trim()
  const parts = qual.split('.')
  const funcName = parts.length > 0 ? parts[parts.length - 1] : qual
  return {
    qual,
    func_name: funcName,
    file_name: match[2],
    start_line: Number(match[3]),
    end_line: Number(match[4]),
  }
}

function qualMatchesEntrypointFile(qual: string, filePath: string): boolean {
  const normalizedFile = normalizePath(filePath).replace(/\//g, '.').replace(/-/g, '_')
  const normalizedQual = qual.replace(/-/g, '_').replace(/\//g, '.')
  const moduleParts = normalizedFile.split('.')
  const modulePath = moduleParts.slice(0, -1).join('.')
  const packageParts = modulePath.split('.')
  const packagePath = packageParts.slice(0, -1).join('.')
  return (
    (modulePath.length > 0 && normalizedQual.includes(modulePath)) ||
    (packagePath.length > 0 && normalizedQual.includes(packagePath))
  )
}

function qidMatchesFile(qid: string, filePath: string): boolean {
  const normalizedQid = qid.replace(/-/g, '_').replace(/\//g, '.')
  const stripped = normalizePath(filePath)
  const lastDot = stripped.lastIndexOf('.')
  const withoutExt = lastDot >= 0 ? stripped.slice(0, lastDot) : stripped
  const pathParts = withoutExt.replace(/-/g, '_').split('/')
  const packagePath = pathParts.slice(0, -1).filter((p) => p.length > 0).join('.')
  const packageName = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : ''
  const fileStem = pathParts.length > 0 ? pathParts[pathParts.length - 1] : ''
  const candidates: string[] = [
    packagePath,
    packageName && fileStem ? `${packageName}.${fileStem}` : '',
    fileStem,
  ]
  return candidates.some((c) => c.length > 0 && normalizedQid.includes(c))
}

// === 主类 ===

/**
 * 变更影响分析器：对单个 dataflow.db 反复执行 lookup(changes) 查询。
 * better-sqlite3 句柄在构造时打开、`dispose()` 时关闭，复用 Statement 由 better-sqlite3 内部缓存。
 */
export class ChangeImpactLookup {
  private readonly db: Database.Database
  private readonly columnsCache = new Map<string, Set<string>>()
  private readonly tableExistsCache = new Map<string, boolean>()

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true })
  }

  dispose(): void {
    this.db.close()
  }

  /** 主入口：5 类 evidence 一跳并集 + provenance fact + Go downstream EP 回补。 */
  lookup(changes: Change[]): LookupResult {
    return this.findAffectedEntrypoints(changes)
  }

  // === schema feature detect ===

  private tableColumns(tableName: string): Set<string> {
    const cached = this.columnsCache.get(tableName)
    if (cached) return cached
    // PRAGMA table_info 不支持参数绑定且表名来源仅限本文件硬编码常量。
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
    const set = new Set<string>(rows.map((r) => String(r.name)))
    this.columnsCache.set(tableName, set)
    return set
  }

  private tableExists(tableName: string): boolean {
    const cached = this.tableExistsCache.get(tableName)
    if (cached !== undefined) return cached
    const row = this.db
      .prepare("SELECT 1 AS v FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { v: number } | undefined
    const exists = row !== undefined
    this.tableExistsCache.set(tableName, exists)
    return exists
  }

  private hasCalleeSymbolId(): boolean {
    // callgraph 可选列用于补充符号级解释，不存在时保持兼容。
    return this.tableColumns('callgraph').has('callee_symbol_id')
  }

  private hasSymbolsTable(): boolean {
    if (!this.tableExists('symbols')) return false
    const required = ['symbol_id', 'file', 'start_line', 'end_line']
    const cols = this.tableColumns('symbols')
    return required.every((c) => cols.has(c))
  }

  private hasHandlerResponseFlowFacts(): boolean {
    if (!this.tableExists('handler_response_flow_facts')) return false
    const required = [
      'consumer_ep_id',
      'producer_call_node_id',
      'producer_return_node_id',
      'producer_err_node_id',
      'producer_result_node_id',
      'receiver_call_node_id',
      'receiver_node_id',
      'payload_call_node_id',
      'payload_node_id',
      'ordering_kind',
      'evidence_kind',
      'confidence',
    ]
    const cols = this.tableColumns('handler_response_flow_facts')
    return required.every((c) => cols.has(c))
  }

  private hasMutatingReceiverAlias(): boolean {
    if (!this.tableExists('mutating_receiver_alias')) return false
    const required = [
      'consumer_ep_id',
      'call_site_file',
      'call_site_line',
      'receiver_vtype',
      'mutation_method',
      'confidence',
    ]
    const cols = this.tableColumns('mutating_receiver_alias')
    return required.every((c) => cols.has(c))
  }

  private hasDeclUseImpactEdges(): boolean {
    if (!this.tableExists('decl_use_impact_edges')) return false
    const required = [
      'consumer_ep_id',
      'changed_qid',
      'changed_file',
      'changed_start_line',
      'changed_end_line',
      'use_kind',
      'confidence',
    ]
    const cols = this.tableColumns('decl_use_impact_edges')
    return required.every((c) => cols.has(c))
  }

  // === 变更节点计数 + enclosing function 扩展 ===

  /** 变更落在 DB nodes 表内的命中数，仅作 debug 计数。 */
  private countChangedNodes(change: Change): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM nodes
         WHERE ltrim(file, '/') LIKE '%' || ?
           AND line BETWEEN ? AND ?`,
      )
      .get(normalizedChangeFile(change), change.startLine, change.endLine) as { c: number } | undefined
    return row ? Number(row.c) : 0
  }

  /**
   * 函数级 dirty 扩展：行级变更可能落在某 callee 函数的空行；扩展到 enclosing function
   * 范围后再做 callee_qid 召回补偿。注意：仅参与 callee_qid lookup，**不**扩到 edges_one_hop /
   * go_interface_dispatch（否则会引入 broad fanout，违反精度收口）。
   */
  private expandChangeToEnclosingFunctions(change: Change): Change[] {
    const expanded = new Map<string, Change>()
    const normalizedFile = normalizedChangeFile(change)
    const seedKey = `${normalizedFile}|${change.startLine}|${change.endLine}`
    expanded.set(seedKey, change)

    const addRange = (fileValue: string, startLine: number, endLine: number): void => {
      if (!fileValue || startLine <= 0 || endLine <= 0) return
      const start = Math.min(startLine, endLine)
      const end = Math.max(startLine, endLine)
      const file = normalizePath(fileValue)
      const key = `${file}|${start}|${end}`
      if (!expanded.has(key)) {
        expanded.set(key, { file, startLine: start, endLine: end })
      }
    }

    const callgraphColumns = this.tableColumns('callgraph')
    if (
      callgraphColumns.has('callee_qid') &&
      callgraphColumns.has('callee_start_line') &&
      callgraphColumns.has('callee_end_line')
    ) {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT callee_start_line, callee_end_line
           FROM callgraph
           WHERE callee_qid IS NOT NULL
             AND callee_qid != ''
             AND lower(ltrim(COALESCE(call_site_file, ''), '/')) NOT LIKE '%' || lower(?)
             AND callee_start_line IS NOT NULL
             AND callee_end_line IS NOT NULL
             AND callee_start_line <= ?
             AND callee_end_line >= ?
             AND callee_qid IN (
                 SELECT DISTINCT qid
                 FROM nodes
                 WHERE ltrim(file, '/') LIKE '%' || ?
                   AND qid IS NOT NULL
             )`,
        )
        .all(
          normalizedFile,
          change.endLine,
          change.startLine,
          normalizedFile,
        ) as Array<{ callee_start_line: number | null; callee_end_line: number | null }>
      for (const r of rows) {
        addRange(normalizedFile, Number(r.callee_start_line ?? 0), Number(r.callee_end_line ?? 0))
      }
    }

    const bindingSources: Array<{
      table: string
      fileCol: string
      startCol: string
      endCol: string
    }> = []

    if (this.tableExists('go_interface_bindings')) {
      const cols = this.tableColumns('go_interface_bindings')
      if (
        cols.has('impl_method_file') &&
        cols.has('impl_method_start_line') &&
        cols.has('impl_method_end_line')
      ) {
        bindingSources.push({
          table: 'go_interface_bindings',
          fileCol: 'impl_method_file',
          startCol: 'impl_method_start_line',
          endCol: 'impl_method_end_line',
        })
      }
    }
    if (
      callgraphColumns.has('impl_method_file') &&
      callgraphColumns.has('impl_method_start_line') &&
      callgraphColumns.has('impl_method_end_line')
    ) {
      bindingSources.push({
        table: 'callgraph',
        fileCol: 'impl_method_file',
        startCol: 'impl_method_start_line',
        endCol: 'impl_method_end_line',
      })
    }

    for (const src of bindingSources) {
      const sql = `SELECT DISTINCT ${src.fileCol} AS f, ${src.startCol} AS s, ${src.endCol} AS e
                   FROM ${src.table}
                   WHERE lower(ltrim(COALESCE(${src.fileCol}, ''), '/')) LIKE '%' || lower(?)
                     AND ${src.startCol} IS NOT NULL
                     AND ${src.endCol} IS NOT NULL
                     AND ${src.startCol} <= ?
                     AND ${src.endCol} >= ?`
      const rows = this.db
        .prepare(sql)
        .all(normalizedFile, change.endLine, change.startLine) as Array<{
        f: string | null
        s: number | null
        e: number | null
      }>
      for (const r of rows) {
        addRange(String(r.f ?? normalizedFile), Number(r.s ?? 0), Number(r.e ?? 0))
      }
    }

    return Array.from(expanded.values())
  }

  // === 5 类基础 evidence 反查（一跳，无 BFS） ===

  /** 变更直接落在 EP 函数体内：file 同 + 行范围相交。 */
  private lookupEntrypointBody(change: Change): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT id
         FROM entrypoints
         WHERE ltrim(file, '/') LIKE '%' || ?
           AND start_line <= ?
           AND end_line >= ?`,
      )
      .all(normalizedChangeFile(change), change.endLine, change.startLine) as Array<{ id: number }>
    return new Set(rows.map((r) => Number(r.id)))
  }

  /** 变更落在某 EP 的调用点：callgraph.call_site_(file,line) 匹配。 */
  private lookupCallSite(change: Change): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT ep_id
         FROM callgraph
         WHERE ep_id IS NOT NULL
           AND ltrim(call_site_file, '/') LIKE '%' || ?
           AND call_site_line BETWEEN ? AND ?`,
      )
      .all(normalizedChangeFile(change), change.startLine, change.endLine) as Array<{ ep_id: number }>
    return new Set(rows.map((r) => Number(r.ep_id)))
  }

  /**
   * 精确 symbol_id 路径：producer 已落 symbols + callee_symbol_id 时用 eq-join 替代
   * qid 字符串匹配，剪掉同名跨文件 qid 误报。未命中或不可用时返回空集（由 fallback 兜底）。
   */
  private lookupCalleeSymbolId(change: Change): Set<number> {
    if (!(this.hasCalleeSymbolId() && this.hasSymbolsTable())) return new Set()
    const rows = this.db
      .prepare(
        `SELECT DISTINCT cg.ep_id
         FROM callgraph cg
         WHERE cg.ep_id IS NOT NULL
           AND cg.callee_symbol_id IS NOT NULL
           AND cg.callee_symbol_id != ''
           AND cg.callee_symbol_id IN (
               SELECT DISTINCT symbol_id
               FROM symbols
               WHERE ltrim(file, '/') LIKE '%' || ?
                 AND start_line IS NOT NULL
                 AND end_line IS NOT NULL
                 AND start_line <= ?
                 AND end_line >= ?
                 AND symbol_id IS NOT NULL
           )`,
      )
      .all(normalizedChangeFile(change), change.endLine, change.startLine) as Array<{
      ep_id: number
    }>
    return new Set(rows.map((r) => Number(r.ep_id)))
  }

  /** 检测：change 命中的 qid 在 callgraph 中是否任一带 callee_symbol_id。 */
  private changeHasAnyCalleeSymbolId(change: Change): boolean {
    if (!this.hasCalleeSymbolId()) return false
    const row = this.db
      .prepare(
        `SELECT 1 AS v
         FROM callgraph cg
         WHERE cg.ep_id IS NOT NULL
           AND cg.callee_symbol_id IS NOT NULL
           AND cg.callee_symbol_id != ''
           AND cg.callee_qid IN (
               SELECT DISTINCT qid
               FROM nodes
               WHERE ltrim(file, '/') LIKE '%' || ?
                 AND line BETWEEN ? AND ?
                 AND qid IS NOT NULL
           )
         LIMIT 1`,
      )
      .get(normalizedChangeFile(change), change.startLine, change.endLine) as { v: number } | undefined
    return row !== undefined
  }

  /**
   * callee_qid 字符串匹配 + 精确路径白名单收紧。
   * 精确 ID 路径可用 → 以 symbol_id eq-join 命中集合作白名单剪 FP；
   * 但 change 命中的 callgraph 行全无 symbol_id → 退回 qid 集合（不退化召回）。
   */
  private lookupCalleeQid(change: Change): Set<number> {
    const qidRows = this.db
      .prepare(
        `SELECT DISTINCT cg.ep_id
         FROM callgraph cg
         WHERE cg.ep_id IS NOT NULL
           AND cg.callee_qid IN (
               SELECT DISTINCT qid
               FROM nodes
               WHERE ltrim(file, '/') LIKE '%' || ?
                 AND line BETWEEN ? AND ?
                 AND qid IS NOT NULL
           )`,
      )
      .all(normalizedChangeFile(change), change.startLine, change.endLine) as Array<{ ep_id: number }>
    const qidEpIds = new Set(qidRows.map((r) => Number(r.ep_id)))
    if (!this.hasCalleeSymbolId() || !this.hasSymbolsTable()) {
      return qidEpIds
    }
    const preciseEpIds = this.lookupCalleeSymbolId(change)
    if (preciseEpIds.size === 0) {
      if (this.changeHasAnyCalleeSymbolId(change)) return new Set()
      return qidEpIds
    }
    const intersection = new Set<number>()
    for (const id of qidEpIds) {
      if (preciseEpIds.has(id)) intersection.add(id)
    }
    return intersection
  }

  /** builtin source 归属 EP：bs.ep_id 关联 entrypoints.ep_id（注意字符串 ep_id）。 */
  private lookupBuiltinSources(change: Change): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.id
         FROM builtin_sources bs
         JOIN entrypoints e ON e.ep_id = bs.ep_id
         WHERE ltrim(bs.file, '/') LIKE '%' || ?
           AND bs.line BETWEEN ? AND ?`,
      )
      .all(normalizedChangeFile(change), change.startLine, change.endLine) as Array<{ id: number }>
    return new Set(rows.map((r) => Number(r.id)))
  }

  /** 数据流一跳：edges 表与 change 文件行相邻的 from/to 节点所属 EP。 */
  private lookupEdgesOneHop(change: Change): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.ep_id
         FROM edges e
         JOIN nodes n ON (n.id = e.from_node_id OR n.id = e.to_node_id)
         WHERE e.ep_id IS NOT NULL
           AND ltrim(n.file, '/') LIKE '%' || ?
           AND n.line BETWEEN ? AND ?`,
      )
      .all(normalizedChangeFile(change), change.startLine, change.endLine) as Array<{ ep_id: number }>
    return new Set(rows.map((r) => Number(r.ep_id)))
  }

  /** handler_response_flow_facts：producer/receiver/payload anchor 与 change 行相交。 */
  private lookupHandlerResponseFlow(change: Change): Set<number> {
    if (!this.hasHandlerResponseFlowFacts()) return new Set()
    const rows = this.db
      .prepare(
        `SELECT DISTINCT hrf.consumer_ep_id
         FROM handler_response_flow_facts hrf
         JOIN nodes n ON n.id IN (
             hrf.producer_return_node_id,
             hrf.producer_err_node_id,
             hrf.producer_result_node_id,
             hrf.producer_call_node_id,
             hrf.receiver_node_id,
             hrf.receiver_call_node_id,
             hrf.payload_call_node_id,
             hrf.payload_node_id
         )
         WHERE hrf.consumer_ep_id IS NOT NULL
           AND hrf.confidence >= 70
           AND hrf.ordering_kind = 'producer_before_receiver_before_payload'
           AND hrf.evidence_kind IN ('go_gin_handler_response_flow', 'sql_backfill_handler_response_flow')
           AND ltrim(n.file, '/') LIKE '%' || ?
           AND n.line BETWEEN ? AND ?`,
      )
      .all(normalizedChangeFile(change), change.startLine, change.endLine) as Array<{
      consumer_ep_id: number
    }>
    return new Set(rows.map((r) => Number(r.consumer_ep_id)))
  }

  /**
   * mutating_receiver_alias：vtype 白名单只接受 object/class（指针/struct receiver），
   * 过滤 package/symbol/union 噪声；通过 call_site_(file,line) 反查命中 change。
   */
  private lookupMutatingReceiverAlias(change: Change): Set<number> {
    if (!this.hasMutatingReceiverAlias()) return new Set()
    const rows = this.db
      .prepare(
        `SELECT DISTINCT mra.consumer_ep_id
         FROM mutating_receiver_alias mra
         WHERE mra.consumer_ep_id IS NOT NULL
           AND mra.confidence >= 70
           AND mra.receiver_vtype IN ('object', 'class')
           AND ltrim(mra.call_site_file, '/') LIKE '%' || ?
           AND mra.call_site_line BETWEEN ? AND ?`,
      )
      .all(normalizedChangeFile(change), change.startLine, change.endLine) as Array<{
      consumer_ep_id: number
    }>
    return new Set(rows.map((r) => Number(r.consumer_ep_id)))
  }

  /**
   * decl_use_impact_edges：change 命中 callee decl 的 file+行范围，得到所有 use 它的 ep。
   * 比通用 callee_qid 字符串匹配更精确（要求 file 也匹配）。
   */
  private lookupDeclUseImpactEdges(change: Change): Set<number> {
    if (!this.hasDeclUseImpactEdges()) return new Set()
    const rows = this.db
      .prepare(
        `SELECT DISTINCT due.consumer_ep_id
         FROM decl_use_impact_edges due
         WHERE due.consumer_ep_id IS NOT NULL
           AND due.confidence >= 70
           AND due.changed_file IS NOT NULL
           AND due.changed_start_line IS NOT NULL
           AND due.changed_end_line IS NOT NULL
           AND ltrim(due.changed_file, '/') LIKE '%' || ?
           AND due.changed_end_line >= ?
           AND due.changed_start_line <= ?`,
      )
      .all(normalizedChangeFile(change), change.startLine, change.endLine) as Array<{
      consumer_ep_id: number
    }>
    return new Set(rows.map((r) => Number(r.consumer_ep_id)))
  }

  /** module_deps：Go 包导入级依赖；只接受 confidence>=90 的 3 类高置信 dep_kind。 */
  private lookupModuleDeps(change: Change): Set<number> {
    if (!this.tableExists('module_deps')) return new Set()
    const required = ['consumer_ep_id', 'imported_file', 'dep_kind', 'confidence']
    const cols = this.tableColumns('module_deps')
    if (!required.every((c) => cols.has(c))) return new Set()
    const rows = this.db
      .prepare(
        `SELECT DISTINCT md.consumer_ep_id
         FROM module_deps md
         JOIN entrypoints ep ON ep.id = md.consumer_ep_id
         WHERE md.consumer_ep_id IS NOT NULL
           AND md.confidence >= 90
           AND md.dep_kind IN ('go_import_package', 'go_init_side_effect', 'go_global_decl')
           AND lower(ltrim(md.imported_file, '/')) LIKE '%' || lower(?)`,
      )
      .all(normalizedChangeFile(change)) as Array<{ consumer_ep_id: number }>
    return new Set(rows.map((r) => Number(r.consumer_ep_id)))
  }

  /**
   * Go interface dispatch：优先 go_interface_bindings，回退 callgraph 内嵌列。
   * 候选 A return-flow filter：若 producer 给本 dispatch 的 callgraph 行写了 return_node_id，
   * 要求该 return node 至少有一条出边（runtime 真用过），否则视为弱证据剪掉。
   * 环境变量 `CIA_DISABLE_INTERFACE_RETURN_FLOW=1` → A/B 对照禁用本 filter。
   */
  private lookupGoInterfaceDispatch(change: Change): Set<number> {
    const nf = normalizedChangeFile(change)
    if (this.tableExists('go_interface_bindings')) {
      const bindingColumns = this.tableColumns('go_interface_bindings')
      const required = [
        'consumer_ep_id',
        'impl_method_qid',
        'impl_method_file',
        'impl_method_start_line',
        'impl_method_end_line',
        'dispatch_kind',
        'dispatch_confidence',
      ]
      if (required.every((c) => bindingColumns.has(c))) {
        const callgraphCols = this.tableColumns('callgraph')
        const edgesCols = this.tableColumns('edges')
        const applyReturnFlowFilter =
          callgraphCols.has('return_node_id') &&
          edgesCols.has('from_node_id') &&
          bindingColumns.has('callgraph_id') &&
          process.env.CIA_DISABLE_INTERFACE_RETURN_FLOW !== '1'
        const returnFlowClause = applyReturnFlowFilter
          ? ` AND (
              gib.callgraph_id IS NULL
              OR EXISTS (
                  SELECT 1 FROM callgraph cg2
                  WHERE cg2.id = gib.callgraph_id
                    AND (cg2.return_node_id IS NULL
                         OR EXISTS (SELECT 1 FROM edges e2 WHERE e2.from_node_id = cg2.return_node_id))
              )
          )`
          : ''
        const sql = `SELECT DISTINCT gib.consumer_ep_id
                     FROM go_interface_bindings gib
                     WHERE gib.consumer_ep_id IS NOT NULL
                       AND gib.dispatch_kind IN ('direct_fdef', 'go_interface_dispatch', 'go_cha_fallback', 'go_rtype_fallback')
                       AND gib.dispatch_confidence >= 70
                       AND (
                           (
                               lower(ltrim(gib.impl_method_file, '/')) LIKE '%' || lower(?)
                               AND gib.impl_method_start_line <= ?
                               AND gib.impl_method_end_line >= ?
                           )
                           OR gib.impl_method_qid IN (
                               SELECT DISTINCT qid
                               FROM nodes
                               WHERE ltrim(file, '/') LIKE '%' || ?
                                 AND line BETWEEN ? AND ?
                                 AND qid IS NOT NULL
                           )
                       )
                       ${returnFlowClause}`
        const rows = this.db
          .prepare(sql)
          .all(nf, change.endLine, change.startLine, nf, change.startLine, change.endLine) as Array<{
          consumer_ep_id: number
        }>
        return new Set(rows.map((r) => Number(r.consumer_ep_id)))
      }
    }

    const callgraphColumns = this.tableColumns('callgraph')
    const requiredCallgraph = [
      'ep_id',
      'impl_method_qid',
      'impl_method_file',
      'impl_method_start_line',
      'impl_method_end_line',
      'dispatch_kind',
      'dispatch_confidence',
    ]
    if (!requiredCallgraph.every((c) => callgraphColumns.has(c))) return new Set()
    const rows = this.db
      .prepare(
        `SELECT DISTINCT cg.ep_id
         FROM callgraph cg
         WHERE cg.ep_id IS NOT NULL
           AND cg.dispatch_kind IN ('direct_fdef', 'go_interface_dispatch', 'go_cha_fallback', 'go_rtype_fallback')
           AND cg.dispatch_confidence >= 70
           AND (
               (
                   lower(ltrim(cg.impl_method_file, '/')) LIKE '%' || lower(?)
                   AND cg.impl_method_start_line <= ?
                   AND cg.impl_method_end_line >= ?
               )
               OR cg.impl_method_qid IN (
                   SELECT DISTINCT qid
                   FROM nodes
                   WHERE ltrim(file, '/') LIKE '%' || ?
                     AND line BETWEEN ? AND ?
                     AND qid IS NOT NULL
               )
           )`,
      )
      .all(nf, change.endLine, change.startLine, nf, change.startLine, change.endLine) as Array<{
      ep_id: number
    }>
    return new Set(rows.map((r) => Number(r.ep_id)))
  }

  // === Go downstream EP 文件级回补：summary callgraph 路径 + precise callgraph 路径 ===

  /**
   * summary 行 callgraph：caller_func + callee_fsig 字符串 BFS（最多 2 跳），命中带相同
   * funcName/fileName 的 entrypoint（Go 文件）。仅用于补 ep_id 缺失的 callgraph 行。
   * 返回 EpFilePair 的字符串 key 集合。
   */
  private lookupSummaryCallgraphDownstream(
    seedEpId: number,
    seedFile: string,
    seedFunc: string,
  ): Set<string> {
    if (!seedFunc || seedFunc === 'undefined') return new Set()
    const callgraphColumns = this.tableColumns('callgraph')
    if (
      !callgraphColumns.has('caller_func') ||
      !callgraphColumns.has('callee_fsig') ||
      !callgraphColumns.has('ep_id')
    ) {
      return new Set()
    }

    const rows = this.db
      .prepare(
        `SELECT caller_func, callee_fsig
         FROM callgraph
         WHERE ep_id IS NULL
           AND caller_func IS NOT NULL
           AND caller_func != ''
           AND callee_fsig IS NOT NULL
           AND callee_fsig != ''`,
      )
      .all() as Array<{ caller_func: string; callee_fsig: string }>

    const seedKey = `${seedFunc}|${path.basename(normalizePath(seedFile))}`
    let frontier = new Set<string>([seedKey])
    const seen = new Set<string>([seedKey])
    let frontierQuals = new Map<string, Set<string>>()
    frontierQuals.set(seedKey, new Set())
    const downstream = new Set<string>()

    for (let iter = 0; iter < 2; iter++) {
      const nextQuals = new Map<string, Set<string>>()
      const nextFrontier = new Set<string>()
      const callerCalleePairs: Array<{ caller: SummaryFunc; callee: SummaryFunc }> = []

      for (const r of rows) {
        const caller = parseSummaryFunc(r.caller_func)
        const callee = parseSummaryFunc(r.callee_fsig)
        if (!caller || !callee) continue
        const callerKey = `${caller.func_name}|${caller.file_name}`
        const callerQuals = frontierQuals.get(callerKey) ?? new Set<string>()
        const lastSeg = caller.qual.split('.').pop() ?? caller.qual
        let qualMatches = false
        for (const q of callerQuals) {
          if (q.endsWith('.' + lastSeg)) {
            qualMatches = true
            break
          }
        }
        if (!frontier.has(callerKey) && !callerQuals.has(caller.qual) && !qualMatches) continue
        const calleeKey = `${callee.func_name}|${callee.file_name}`
        let bucket = nextQuals.get(calleeKey)
        if (!bucket) {
          bucket = new Set<string>()
          nextQuals.set(calleeKey, bucket)
        }
        bucket.add(callee.qual)
        if (!seen.has(calleeKey)) {
          seen.add(calleeKey)
          nextFrontier.add(calleeKey)
        }
        callerCalleePairs.push({ caller, callee })
      }

      // target_func_names 是 nextFrontier 中 file_name 与当前 callee 相同的 func_name 集合，
      // summary 函数范围缺少直接归属时，用行范围重叠做补救。
      for (const pair of callerCalleePairs) {
        const targetFuncNames = new Set<string>()
        for (const key of nextFrontier) {
          const sep = key.indexOf('|')
          const funcName = key.slice(0, sep)
          const fileName = key.slice(sep + 1)
          if (fileName === pair.callee.file_name) targetFuncNames.add(funcName)
        }
        const entries = this.entrypointsForSummaryFunc(pair.callee, targetFuncNames)
        for (const e of entries) downstream.add(e)
      }

      frontierQuals = nextQuals
      frontier = nextFrontier
      if (frontier.size === 0) break
    }

    const result = new Set<string>()
    for (const key of downstream) {
      const [epId] = parseEpFileKey(key)
      if (epId !== seedEpId) result.add(key)
    }
    return result
  }

  /** _entrypoints_for_summary_func 的 TS 版本：返回 EpFilePair 字符串 key 集合。 */
  private entrypointsForSummaryFunc(
    func: SummaryFunc,
    targetFuncNames: Set<string>,
  ): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT id, file, func_name, start_line, end_line
         FROM entrypoints
         WHERE ltrim(file, '/') LIKE '%' || ?
           AND lower(ltrim(file, '/')) LIKE '%.go'`,
      )
      .all(normalizePath(func.file_name)) as Array<{
      id: number
      file: string
      func_name: string | null
      start_line: number | null
      end_line: number | null
    }>
    const fallback = new Set<string>()
    const matched = new Set<string>()
    for (const row of rows) {
      const epId = Number(row.id)
      const filePath = String(row.file)
      if (!qualMatchesEntrypointFile(func.qual, filePath)) continue
      const key = epFileKey([epId, filePath])
      fallback.add(key)
      const funcName = row.func_name === null ? '' : String(row.func_name)
      const startLine = Number(row.start_line ?? 0)
      const endLine = Number(row.end_line ?? 0)
      const lineOverlaps = startLine <= func.end_line && endLine >= func.start_line
      if (lineOverlaps || funcName === func.func_name || targetFuncNames.has(funcName)) {
        matched.add(key)
      }
    }
    return matched.size > 0 ? matched : fallback
  }

  /**
   * precise callgraph 下游：依赖 callgraph 精确列（callee_start/end_line +
   * resolution_kind + confidence）+ nodes(qid,file,line)。
   * 仅接受高置信 direct_fdef / type_member 边。
   */
  private lookupPreciseCallgraphDownstream(seedEpId: number): Set<string> {
    const callgraphColumns = this.tableColumns('callgraph')
    const nodeColumns = this.tableColumns('nodes')
    const newCols = ['callee_qid', 'callee_start_line', 'callee_end_line', 'resolution_kind', 'confidence']
    const nodeReq = ['qid', 'file', 'line']
    if (!newCols.every((c) => callgraphColumns.has(c)) || !nodeReq.every((c) => nodeColumns.has(c))) {
      return new Set()
    }

    const callRows = this.db
      .prepare(
        `SELECT DISTINCT call_site_file, call_site_line, callee_qid, callee_start_line, callee_end_line
         FROM callgraph
         WHERE ep_id = ?
           AND callee_qid IS NOT NULL
           AND callee_qid != ''
           AND confidence >= 70
           AND resolution_kind IN ('direct_fdef', 'type_member')
           AND call_site_file IS NOT NULL
           AND call_site_file != ''
           AND callee_start_line IS NOT NULL
           AND callee_end_line IS NOT NULL`,
      )
      .all(seedEpId) as PreciseCallRow[]
    if (callRows.length === 0) return new Set()

    const entrypointRows = this.db
      .prepare(
        `SELECT id, file, start_line, end_line
         FROM entrypoints
         WHERE file IS NOT NULL
           AND file != ''
           AND lower(ltrim(file, '/')) LIKE '%.go'`,
      )
      .all() as Array<{ id: number; file: string; start_line: number | null; end_line: number | null }>

    const rowsByFile = new Map<string, EpRangeRow[]>()
    for (const r of entrypointRows) {
      const nf = normalizePath(String(r.file))
      let bucket = rowsByFile.get(nf)
      if (!bucket) {
        bucket = []
        rowsByFile.set(nf, bucket)
      }
      bucket.push({
        id: Number(r.id),
        file: String(r.file),
        start_line: Number(r.start_line ?? 0),
        end_line: Number(r.end_line ?? 0),
      })
    }

    const samePath = (left: string, right: string): boolean =>
      left.endsWith(right) || right.endsWith(left)

    const targetEntrypoints = (
      callFile: string,
      startLine: number,
      endLine: number,
      allowFileFallback: boolean,
      preferAfterGap: number,
      qid: string | null,
    ): Set<string> => {
      const matched = new Set<string>()
      const sameFileRows: EpRangeRow[] = []
      const normalizedCallFile = normalizePath(callFile)
      for (const [normalizedEpFile, epRows] of rowsByFile) {
        if (!samePath(normalizedCallFile, normalizedEpFile)) continue
        if (allowFileFallback && qid !== null && !qidMatchesFile(qid, normalizedEpFile)) continue
        for (const ep of epRows) {
          sameFileRows.push(ep)
          const overlaps = ep.start_line <= endLine && ep.end_line >= startLine
          const encloses = startLine <= ep.start_line && ep.end_line <= endLine
          if (overlaps || encloses) {
            matched.add(epFileKey([ep.id, ep.file]))
          }
        }
      }
      if (matched.size > 0 || !allowFileFallback) return matched
      if (sameFileRows.length === 0) return new Set()
      const followingRows = sameFileRows.filter(
        (r) => 0 <= r.start_line - endLine && r.start_line - endLine <= preferAfterGap,
      )
      const candidateRows = followingRows.length > 0 ? followingRows : sameFileRows
      let minDistance = Infinity
      for (const r of candidateRows) {
        const d = Math.min(
          Math.abs(startLine - r.start_line),
          Math.abs(startLine - r.end_line),
          Math.abs(endLine - r.start_line),
          Math.abs(endLine - r.end_line),
        )
        if (d < minDistance) minDistance = d
      }
      const out = new Set<string>()
      for (const r of candidateRows) {
        const d = Math.min(
          Math.abs(startLine - r.start_line),
          Math.abs(startLine - r.end_line),
          Math.abs(endLine - r.start_line),
          Math.abs(endLine - r.end_line),
        )
        if (d === minDistance) out.add(epFileKey([r.id, r.file]))
      }
      return out
    }

    const calleeFiles = (qid: string, startLine: number, endLine: number): Set<string> => {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT file
           FROM nodes
           WHERE qid = ?
             AND file IS NOT NULL
             AND file != ''
             AND lower(ltrim(file, '/')) LIKE '%.go'
             AND line BETWEEN ? AND ?`,
        )
        .all(qid, startLine, endLine) as Array<{ file: string }>
      return new Set(rows.map((r) => String(r.file)))
    }

    const downstream = new Set<string>()
    const parentRanges: Array<[string, number, number]> = []

    const seedRow = this.db
      .prepare('SELECT file, start_line, end_line FROM entrypoints WHERE id = ?')
      .get(seedEpId) as { file: string | null; start_line: number | null; end_line: number | null } | undefined
    let seedFileNorm = ''
    let seedStart = 0
    let seedEnd = 0
    if (seedRow) {
      seedFileNorm = normalizePath(String(seedRow.file ?? ''))
      seedStart = Number(seedRow.start_line ?? 0)
      seedEnd = Number(seedRow.end_line ?? 0)
    }

    for (const c of callRows) {
      const normalizedCallFile = normalizePath(String(c.call_site_file))
      const line = Number(c.call_site_line ?? 0)
      if (seedFileNorm && (!samePath(seedFileNorm, normalizedCallFile) || !(seedStart <= line && line <= seedEnd))) {
        continue
      }
      const start = Number(c.callee_start_line)
      const end = Number(c.callee_end_line)
      for (const k of targetEntrypoints(String(c.call_site_file), start, end, false, 10, null)) {
        downstream.add(k)
      }
      for (const calleeFile of calleeFiles(String(c.callee_qid), start, end)) {
        parentRanges.push([calleeFile, start, end])
      }
    }

    for (const c of callRows) {
      const normalizedCallFile = normalizePath(String(c.call_site_file))
      const line = Number(c.call_site_line ?? 0)
      let parentMatched = false
      for (const [parentFile, ps, pe] of parentRanges) {
        const normalizedParent = normalizePath(parentFile)
        if (samePath(normalizedParent, normalizedCallFile) && ps <= line && line <= pe) {
          parentMatched = true
          break
        }
      }
      if (!parentMatched) continue
      const start = Number(c.callee_start_line)
      const end = Number(c.callee_end_line)
      for (const k of targetEntrypoints(String(c.call_site_file), start, end, false, 10, null)) {
        downstream.add(k)
      }
      for (const calleeFile of calleeFiles(String(c.callee_qid), start, end)) {
        for (const k of targetEntrypoints(calleeFile, start, end, true, 10, String(c.callee_qid))) {
          downstream.add(k)
        }
      }
    }

    const result = new Set<string>()
    for (const key of downstream) {
      const [epId] = parseEpFileKey(key)
      if (epId !== seedEpId) result.add(key)
    }
    return result
  }

  /**
   * 总 downstream 调度：对每个 seed EP 决定 precise / summary / 兜底路径。
   * 基于调用摘要补齐 Go 下游 entrypoint 文件归属。
   *   - 仅 Go seed 文件参与；
   *   - seed 在 suppressSeedEpIds 中 → 强制空（用于 handler_response_flow direct evidence）；
   *   - precise 命中则 precise|summary；
   *   - 否则 summary；
   *   - 都无 + 有 precise schema → 跳过；
   *   - 都无 + 仅 summary schema + 单 seed → same-dir 1-EP fallback；
   *   - 老 DB 兜底大 join。
   */
  private lookupDownstreamEpFiles(
    seedEpIds: Set<number>,
    primarySeedEpIds: Set<number>,
    changeSeedEpIds: Set<number>,
    suppressSeedEpIds: Set<number>,
  ): Map<number, Set<string>> {
    const downstream = new Map<number, Set<string>>()
    if (seedEpIds.size === 0) return downstream

    const callgraphColumns = this.tableColumns('callgraph')
    const nodeColumns = this.tableColumns('nodes')
    if (!['ep_id', 'callee_qid'].every((c) => callgraphColumns.has(c))) return downstream
    if (!['qid', 'file'].every((c) => nodeColumns.has(c))) return downstream

    const sortedSeeds = Array.from(seedEpIds).sort((a, b) => a - b)
    const hasSummaryGraph = ['caller_func', 'callee_fsig', 'ep_id'].every((c) =>
      callgraphColumns.has(c),
    )
    const hasPreciseGraph = ['callee_start_line', 'callee_end_line', 'resolution_kind', 'confidence'].every((c) =>
      callgraphColumns.has(c),
    )

    for (const seedEpId of sortedSeeds) {
      if (!primarySeedEpIds.has(seedEpId)) continue
      const seedRow = this.db
        .prepare('SELECT ep_id, file, func_name FROM entrypoints WHERE id = ?')
        .get(seedEpId) as { ep_id: string | null; file: string | null; func_name: string | null } | undefined
      const seedLabel = !seedRow || seedRow.ep_id === null ? '' : String(seedRow.ep_id)
      const seedFile = !seedRow || seedRow.file === null ? '' : String(seedRow.file)
      const seedFunc = !seedRow || seedRow.func_name === null ? '' : String(seedRow.func_name)
      if (suppressSeedEpIds.has(seedEpId)) {
        downstream.set(seedEpId, new Set())
        continue
      }
      if (seedFunc === 'undefined' || seedLabel.endsWith(':undefined')) continue
      if (!isGoFile(seedFile)) continue

      let preciseDownstream = this.lookupPreciseCallgraphDownstream(seedEpId)
      if (changeSeedEpIds.has(seedEpId)) {
        const seedNormalizedFile = normalizePath(seedFile)
        const filtered = new Set<string>()
        for (const key of preciseDownstream) {
          const [, filePath] = parseEpFileKey(key)
          if (!normalizePath(filePath).endsWith(seedNormalizedFile)) filtered.add(key)
        }
        preciseDownstream = filtered
      }
      const summaryDownstream = this.lookupSummaryCallgraphDownstream(seedEpId, seedFile, seedFunc)

      if (preciseDownstream.size > 0) {
        const u = new Set<string>(preciseDownstream)
        for (const k of summaryDownstream) u.add(k)
        downstream.set(seedEpId, u)
        continue
      }
      if (summaryDownstream.size > 0) {
        downstream.set(seedEpId, summaryDownstream)
        continue
      }
      if (hasPreciseGraph) continue

      if (hasSummaryGraph && seedEpIds.size === 1) {
        const seedNorm = normalizePath(seedFile)
        // 同 directory（去掉最后一个 `/` 后的 basename）的 EP 集合，参数复用 4 次。
        const rows = this.db
          .prepare(
            `SELECT id, file
             FROM entrypoints
             WHERE id != ?
               AND lower(ltrim(file, '/')) LIKE '%.go'
               AND substr(ltrim(file, '/'), 1, length(ltrim(file, '/')) - length(replace(ltrim(file, '/'), '/', ''))) =
                   substr(?, 1, length(?) - length(replace(?, '/', '')))`,
          )
          .all(seedEpId, seedNorm, seedNorm, seedNorm) as Array<{ id: number; file: string }>
        const sameDir = new Set<string>(rows.map((r) => epFileKey([Number(r.id), String(r.file)])))
        if (sameDir.size === 1) downstream.set(seedEpId, sameDir)
        continue
      }

      const rows = this.db
        .prepare(
          `SELECT DISTINCT target.id, target.file
           FROM callgraph cg
           JOIN nodes callee
             ON callee.qid = cg.callee_qid
            AND callee.file IS NOT NULL
            AND callee.file != ''
            AND lower(ltrim(callee.file, '/')) LIKE '%.go'
           JOIN entrypoints target
             ON target.file IS NOT NULL
            AND target.file != ''
            AND lower(ltrim(target.file, '/')) LIKE '%.go'
            AND (
                ltrim(callee.file, '/') LIKE '%' || ltrim(target.file, '/')
                OR ltrim(target.file, '/') LIKE '%' || ltrim(callee.file, '/')
            )
           WHERE cg.ep_id = ?
             AND cg.callee_qid IS NOT NULL
             AND cg.callee_qid != ''
             AND target.id IN (SELECT DISTINCT ep_id FROM callgraph WHERE ep_id IS NOT NULL)`,
        )
        .all(seedEpId) as Array<{ id: number; file: string }>
      const seedDownstream = new Set<string>()
      for (const r of rows) {
        const id = Number(r.id)
        if (id !== seedEpId) seedDownstream.add(epFileKey([id, String(r.file)]))
      }
      if (seedDownstream.size > 0) downstream.set(seedEpId, seedDownstream)
    }
    return downstream
  }

  // === EP 行回填 + 主流程 ===

  /** 按 ep_id 升序拉 entrypoints 行，挂上 sorted reached_via。 */
  private fetchEpRows(epReasons: Map<number, Set<string>>): Entrypoint[] {
    const result: Entrypoint[] = []
    const sortedIds = Array.from(epReasons.keys()).sort((a, b) => a - b)
    for (const epId of sortedIds) {
      const row = this.db
        .prepare(
          `SELECT ep_id, file, func_name, start_line, end_line, ep_type, framework, attribute
           FROM entrypoints
           WHERE id = ?`,
        )
        .get(epId) as Omit<EntrypointRow, 'id'> | undefined
      if (!row) continue
      result.push({
        ep_id: String(row.ep_id),
        file: String(row.file),
        func_name: String(row.func_name),
        start_line: Number(row.start_line),
        end_line: Number(row.end_line),
        ep_type: String(row.ep_type),
        framework: String(row.framework),
        attribute: String(row.attribute),
        reached_via: Array.from(epReasons.get(epId) ?? new Set<string>()).sort(),
      })
    }
    return result
  }

  /** 主流程：11 类 candidate 一跳并集 → downstream 回补 → 单 change/entrypoint_body 精度收紧。 */
  private findAffectedEntrypoints(changes: Change[]): LookupResult {
    const candidateNames = [
      'entrypoint_body',
      'call_site',
      'callee_qid',
      'builtin_sources',
      'module_deps',
      'go_interface_dispatch',
      'handler_response_flow',
      'mutating_receiver_alias',
      'decl_use_impact_edges',
      'edges_one_hop',
      'downstream_ep_file',
    ] as const

    const candidateEpIds = new Map<string, Set<number>>()
    for (const name of candidateNames) candidateEpIds.set(name, new Set())

    const epReasons = new Map<number, Set<string>>()
    let changedNodesTotal = 0
    let enclosingFunctionDirtyRanges = 0

    for (const change of changes) {
      const changedNodes = this.countChangedNodes(change)
      changedNodesTotal += changedNodes

      // callee_qid 初始为空，下面用 expanded 累加。
      const perChange: Array<[string, Set<number>]> = [
        ['entrypoint_body', this.lookupEntrypointBody(change)],
        ['call_site', this.lookupCallSite(change)],
        ['callee_qid', new Set<number>()],
        ['builtin_sources', this.lookupBuiltinSources(change)],
        ['module_deps', this.lookupModuleDeps(change)],
        ['go_interface_dispatch', this.lookupGoInterfaceDispatch(change)],
        ['handler_response_flow', this.lookupHandlerResponseFlow(change)],
        ['mutating_receiver_alias', this.lookupMutatingReceiverAlias(change)],
        ['decl_use_impact_edges', this.lookupDeclUseImpactEdges(change)],
        ['edges_one_hop', this.lookupEdgesOneHop(change)],
      ]
      const expandedChanges = this.expandChangeToEnclosingFunctions(change)
      const calleeQidSet = perChange[2][1]
      for (const ec of expandedChanges) {
        for (const id of this.lookupCalleeQid(ec)) calleeQidSet.add(id)
      }
      enclosingFunctionDirtyRanges += Math.max(0, expandedChanges.length - 1)

      const strongEpIds = new Set<number>()
      for (const [name, ids] of perChange) {
        if (name === 'edges_one_hop') continue
        for (const id of ids) strongEpIds.add(id)
      }
      const normalizedChange = normalizedChangeFile(change)

      for (const [name, epIds] of perChange) {
        let filtered = epIds
        if (name === 'edges_one_hop' && strongEpIds.size > 0) {
          filtered = new Set()
          for (const epId of epIds) {
            const epRow = this.db
              .prepare('SELECT file FROM entrypoints WHERE id = ?')
              .get(epId) as { file: string | null } | undefined
            const epFile = !epRow || epRow.file === null ? '' : normalizePath(String(epRow.file))
            if (
              strongEpIds.has(epId) ||
              epFile.endsWith(normalizedChange) ||
              normalizedChange.endsWith(epFile)
            ) {
              filtered.add(epId)
            }
          }
          // edges-only 入口虽无 callgraph/body 结构证据，仍代表 EP 图内直接数据流依赖。
          for (const id of epIds) {
            if (!strongEpIds.has(id)) filtered.add(id)
          }
        }
        const bucket = candidateEpIds.get(name)
        if (bucket) {
          for (const id of filtered) bucket.add(id)
        }
        const reason = `${name}: ${change.file}:${change.startLine}-${change.endLine}`
        for (const epId of filtered) getOrCreateSet(epReasons, epId).add(reason)
      }

      const detail = perChange.map(([n, s]) => `${n}=${s.size}`).join(', ')
      const dirtyDetail = expandedChanges
        .filter((c) => c.file !== change.file || c.startLine !== change.startLine || c.endLine !== change.endLine)
        .map((c) => `${c.file}:${c.startLine}-${c.endLine}`)
        .join(', ')
      process.stderr.write(
        `[DEBUG] Change ${change.file}:${change.startLine}-${change.endLine} matched ${changedNodes} nodes; enclosing_function_dirty=[${dirtyDetail}]; ${detail}\n`,
      )
    }

    const structuralSeedEpIds = new Set<number>()
    for (const name of ['entrypoint_body', 'call_site', 'callee_qid', 'builtin_sources', 'go_interface_dispatch'] as const) {
      for (const id of candidateEpIds.get(name) ?? new Set<number>()) structuralSeedEpIds.add(id)
    }
    const changeSeedEpIds = new Set<number>(structuralSeedEpIds)
    const edgesOneHopSet = candidateEpIds.get('edges_one_hop') ?? new Set<number>()
    const edgesOnlyEpIds = new Set<number>()
    for (const id of edgesOneHopSet) {
      if (!structuralSeedEpIds.has(id)) edgesOnlyEpIds.add(id)
    }

    // 新 provenance facts 是直接证据，不作 broad downstream fanout 种子。
    const provenanceOnlyEpIds = new Set<number>()
    for (const name of ['module_deps', 'go_interface_dispatch', 'handler_response_flow', 'mutating_receiver_alias', 'decl_use_impact_edges'] as const) {
      for (const id of candidateEpIds.get(name) ?? new Set<number>()) {
        if (!structuralSeedEpIds.has(id) && !edgesOneHopSet.has(id)) provenanceOnlyEpIds.add(id)
      }
    }
    const primarySeedEpIds = new Set<number>()
    for (const id of epReasons.keys()) {
      if (!provenanceOnlyEpIds.has(id)) primarySeedEpIds.add(id)
    }

    let handlerResponseSeedEpIds = new Set<number>()
    if (this.hasHandlerResponseFlowFacts()) {
      const hrf = candidateEpIds.get('handler_response_flow') ?? new Set<number>()
      handlerResponseSeedEpIds = new Set<number>()
      for (const id of structuralSeedEpIds) {
        if (hrf.has(id)) handlerResponseSeedEpIds.add(id)
      }
    }

    let allowedDownstreamEpIds: Set<number> | null = null
    if (structuralSeedEpIds.size === 0) {
      allowedDownstreamEpIds = new Set<number>(edgesOnlyEpIds)
    }

    const downstreamBySeed = this.lookupDownstreamEpFiles(
      new Set<number>(epReasons.keys()),
      primarySeedEpIds,
      changeSeedEpIds,
      handlerResponseSeedEpIds,
    )

    const downstreamBucket = candidateEpIds.get('downstream_ep_file') ?? new Set<number>()
    for (const seedEpId of Array.from(downstreamBySeed.keys()).sort((a, b) => a - b)) {
      const downstreamSet = downstreamBySeed.get(seedEpId) ?? new Set<string>()
      const seedRow = this.db
        .prepare('SELECT ep_id FROM entrypoints WHERE id = ?')
        .get(seedEpId) as { ep_id: string | null } | undefined
      const seedLabel = seedRow && seedRow.ep_id !== null ? String(seedRow.ep_id) : String(seedEpId)
      const sortedDownstream = Array.from(downstreamSet)
        .map((k) => parseEpFileKey(k))
        .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
      for (const [downstreamEpId, downstreamFile] of sortedDownstream) {
        if (allowedDownstreamEpIds !== null && !allowedDownstreamEpIds.has(downstreamEpId)) continue
        downstreamBucket.add(downstreamEpId)
        const reason = `downstream_ep_file: ${seedLabel} -> ${downstreamFile}`
        getOrCreateSet(epReasons, downstreamEpId).add(reason)
      }
    }

    // 单 change + 命中 entrypoint_body 的精度收紧：避免新增/单点改扩散到既有入口。
    const epBodyBucket = candidateEpIds.get('entrypoint_body') ?? new Set<number>()
    if (changes.length === 1 && epBodyBucket.size > 0) {
      const directCandidateEpIds = new Set<number>()
      for (const name of ['entrypoint_body', 'call_site', 'callee_qid', 'builtin_sources', 'module_deps', 'go_interface_dispatch', 'handler_response_flow', 'edges_one_hop'] as const) {
        for (const id of candidateEpIds.get(name) ?? new Set<number>()) directCandidateEpIds.add(id)
      }
      const keepEpIds = epBodyBucket.size === 1 ? new Set<number>(epBodyBucket) : directCandidateEpIds
      const removedEpIds = new Set<number>()
      for (const id of epReasons.keys()) {
        if (!keepEpIds.has(id)) removedEpIds.add(id)
      }
      if (removedEpIds.size > 0) {
        const downstreamRemovedEpIds = new Set<number>()
        for (const id of removedEpIds) {
          if (downstreamBucket.has(id)) downstreamRemovedEpIds.add(id)
        }
        for (const id of removedEpIds) {
          if (!downstreamRemovedEpIds.has(id)) epReasons.delete(id)
        }
        // candidate_counts.downstream_ep_file &= downstreamRemovedEpIds（保留交集）。
        const intersected = new Set<number>()
        for (const id of downstreamBucket) {
          if (downstreamRemovedEpIds.has(id)) intersected.add(id)
        }
        candidateEpIds.set('downstream_ep_file', intersected)
      }
    }

    process.stderr.write(
      `[DEBUG] Multi-aspect one-hop reached ${epReasons.size} entrypoints\n`,
    )

    const resultEps = this.fetchEpRows(epReasons)
    const counts: CandidateCounts = {
      entrypoint_body: (candidateEpIds.get('entrypoint_body') ?? new Set()).size,
      call_site: (candidateEpIds.get('call_site') ?? new Set()).size,
      callee_qid: (candidateEpIds.get('callee_qid') ?? new Set()).size,
      builtin_sources: (candidateEpIds.get('builtin_sources') ?? new Set()).size,
      module_deps: (candidateEpIds.get('module_deps') ?? new Set()).size,
      go_interface_dispatch: (candidateEpIds.get('go_interface_dispatch') ?? new Set()).size,
      handler_response_flow: (candidateEpIds.get('handler_response_flow') ?? new Set()).size,
      mutating_receiver_alias: (candidateEpIds.get('mutating_receiver_alias') ?? new Set()).size,
      decl_use_impact_edges: (candidateEpIds.get('decl_use_impact_edges') ?? new Set()).size,
      edges_one_hop: (candidateEpIds.get('edges_one_hop') ?? new Set()).size,
      downstream_ep_file: (candidateEpIds.get('downstream_ep_file') ?? new Set()).size,
    }
    return {
      entrypoints: resultEps,
      stats: {
        changed_nodes_total: changedNodesTotal,
        candidate_counts: counts,
        reachable_entrypoints: resultEps.length,
        enclosing_function_dirty_ranges: enclosingFunctionDirtyRanges,
      },
    }
  }
}

// === CLI 入口（仅在直接执行时跑） ===

/**
 * 解析 --changes 参数：可以是 inline JSON 字符串，也可以是 `@/path/to/file.json`。
 */
function parseChangesArg(raw: string): Change[] {
  let text: string
  if (raw.startsWith('@')) {
    text = fs.readFileSync(raw.slice(1), 'utf8')
  } else {
    text = raw
  }
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) {
    throw new Error('--changes must be a JSON array of {file,startLine,endLine}')
  }
  const out: Change[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('change item must be object')
    }
    const obj = item as Record<string, unknown>
    if (typeof obj.file !== 'string' || typeof obj.startLine !== 'number' || typeof obj.endLine !== 'number') {
      throw new Error('change item must have {file:string,startLine:number,endLine:number}')
    }
    out.push({ file: obj.file, startLine: obj.startLine, endLine: obj.endLine })
  }
  return out
}

function runCli(argv: string[]): void {
  const program = new Command()
  program
    .name('impact-lookup')
    .description('变更影响分析（基于离线数据流 DB 的 evidence 并集）')
    .requiredOption('--db <path>', '离线 dataflow.db 路径')
    .requiredOption('--changes <json>', 'JSON 数组或 @file 路径')
    .action((opts: { db: string; changes: string }) => {
      const changes = parseChangesArg(opts.changes)
      const lookup = new ChangeImpactLookup(opts.db)
      try {
        const result = lookup.lookup(changes)
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      } finally {
        lookup.dispose()
      }
    })
  program.parse(argv)
}

// 直接执行（`tsx impact-lookup.ts ...` 或 `node dist/impact-lookup.js ...`）时进 CLI。
if (require.main === module) {
  runCli(process.argv)
}
