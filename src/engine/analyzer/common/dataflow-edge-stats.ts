/**
 * 数据流边统计模块
 *
 * 边粒度：(file:line:col:qid) → (file:line:col:qid)
 * 统计：去重边数、重复查询次数、EP 敏感边数
 *
 * SQLite 模式：通过 CLI 参数 --dataflowDb 启用，dataflow.db 输出到 report 目录。
 * starter.ts 调用 enableDataflowDb() 设置 flag，再调用 initSqlite() 建库建表。
 * 关闭时所有 recordEdge / ensureNode / recordEntrypoint 等接口 short-circuit 返回，零 runtime 开销。
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getCurrentEntryPoint } = require('./entrypoint/current-entrypoint')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getCurrentWriterContext } = require('./dataflow-writer-context')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prettyPrint } = require('../../../util/ast-util')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const QidUnifyUtil = require('../../../util/qid-unify-util')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { YASA_VERSION } = require('../../../util/constant')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path')
const { createSqliteDatabase } = require('../../../util/better-sqlite3-loader') as typeof import('../../../util/better-sqlite3-loader')

// runtime mutable flags：默认全 false，零 runtime 开销
// 由 starter.ts 在 CLI 解析后调用 enableDataflowDb() 翻转
let _sqliteEnabled = false
type DataflowDbMode = 'full' | 'incremental-facts'
let _dbMode: DataflowDbMode = 'full'
const DATAFLOW_SCHEMA_VERSION = '2'
const INCREMENTAL_FACTS_SKIPPED_EDGE_TYPES = new Set([
  'slot_bind',
  'bvt_set',
  'union_compose',
  'instance_new',
  'cow_copy',
  'alias_clone',
  'taint_clone',
  'propagate',
  'merge',
  'field_write',
  'assign',
])

function enableDataflowDb(opts?: { mode?: DataflowDbMode }): void {
  _sqliteEnabled = true
  _dbMode = opts?.mode === 'incremental-facts' ? 'incremental-facts' : 'full'
}

type CallgraphP0Facts = {
  callerQid: string | null
  callerStartLine: number | null
  callerEndLine: number | null
  calleeStartLine: number | null
  calleeEndLine: number | null
  resolutionKind: string
  confidence: number
  provenance: string
}

// ===== SQLite 模式 =====
type SqliteQueryParams = readonly unknown[] | Readonly<Record<string, unknown>>
type SqliteStatement<Row> = { get(...params: unknown[]): Row | undefined }
type SqliteRunStatement = { run(...params: unknown[]): unknown }
type SqliteReadonlyQueryParams = readonly unknown[] | Readonly<Record<string, unknown>>
type DataflowDbQueryState = 'running' | 'closed'
interface DataflowDbQueryMetadata {
  dbPath: string
  commitSeq: number
  committedAt: string
  state: DataflowDbQueryState
}
interface DataflowDbQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[]
  metadata: DataflowDbQueryMetadata
}
type NodeIdRow = { id: number }

let db: SqliteDatabaseLike | null = null
let sqliteDbPath: string | null = null
let sqliteInitializedEver = false
let sqliteClosed = false
let sqliteCommitSeq = 0
let sqliteLastCommitAt: string | null = null
let sqliteFatalError: Error | null = null
let stmtInsertNode: SqliteExecStatement | null = null
let stmtInsertEdge: SqliteExecStatement | null = null
let stmtUpdateNodeMetadata: SqliteExecStatement | null = null
let stmtInsertEntrypoint: SqliteExecStatement | null = null
let stmtGetEntrypointId: SqliteExecStatement<{ id: number }> | null = null
let stmtInsertBuiltinSource: SqliteExecStatement | null = null
let stmtInsertCallgraph: SqliteExecStatement | null = null
let stmtUpdateCallgraphDispatch: SqliteRunStatement | null = null
let stmtInsertCallArg: SqliteExecStatement | null = null
let stmtInsertSymbol: SqliteRunStatement | null = null
let stmtInsertSourceFile: SqliteExecStatement | null = null
let stmtUpsertMetadata: SqliteRunStatement | null = null
let stmtSelectNodeByFields: SqliteStatement<NodeIdRow> | null = null
let stmtInsertGoInterfaceBinding: SqliteExecStatement | null = null
let stmtInsertModuleDep: SqliteExecStatement | null = null
let stmtInsertNodeTag: SqliteRunStatement | null = null
let stmtInsertHandlerResponseFlowFact: SqliteRunStatement | null = null
let stmtInsertImpactPathProvenance: SqliteRunStatement | null = null
let stmtInsertMutatingReceiverAlias: SqliteRunStatement | null = null
let stmtInsertDeclUseImpactEdge: SqliteRunStatement | null = null
let sqliteWriteTransactionOpen = false

// 有界 LRU 避免节点缓存跨 EP 无限累积
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

// nodeId 按值对象、入口点、调用点拆分，避免跨调用点复用造成伪传播。
// 预扫描与入口点根层没有调用点，统一归入空调用点桶。
const nodeIdCache = new SimpleLRU<string, number>(300_000)
const valNodeIdCache = new WeakMap<object, Map<string, number>>()
// 二级 fallback 桶：WeakMap miss 后按 INSERT 全字段 stringKey 去重
// 解决 clone 产新对象 identity 导致 WeakMap 永远 miss 的问题。
const stringNodeCache = new SimpleLRU<string, number>(300_000)
const filePathCache = new SimpleLRU<string, string>(20_000)
const qidUnifiedCache = new SimpleLRU<string, string | null>(100_000)
type EdgeEpDedupSet = Set<number>
type EdgeTypeDedupMap = Map<number, EdgeEpDedupSet>
type EdgeToDedupMap = Map<number, EdgeTypeDedupMap>
type EdgeFromDedupMap = Map<number, EdgeToDedupMap>

// 边去重：(from_node_id, to_node_id, edge_type, ep_id) → 已写入；全程用精确 number key，避免长字符串常驻。
const edgeDedupMap: EdgeFromDedupMap = new Map()
const edgeTypeIdMap = new Map<string, number>()
let nextEdgeTypeId = 1

function getEdgeTypeId(edgeType: string): number {
  const cached = edgeTypeIdMap.get(edgeType)
  if (cached !== undefined) return cached
  const id = nextEdgeTypeId++
  edgeTypeIdMap.set(edgeType, id)
  return id
}

function edgeEpDedupKey(epRowId: number | null): number {
  return epRowId ?? -1
}

function hasOrAddEdgeDedup(fromId: number, toId: number, edgeType: string, epRowId: number | null): boolean {
  return hasOrAddEdgeDedupWith(edgeDedupMap, edgeTypeIdMap, null, fromId, toId, edgeType, epRowId)
}

interface EdgeTypeIdContext { edgeTypeIdMap: Map<string, number>; nextEdgeTypeId: number }

function getEdgeTypeIdWith(typeIdMap: Map<string, number>, ctx: EdgeTypeIdContext | null, edgeType: string): number {
  const cached = typeIdMap.get(edgeType)
  if (cached !== undefined) return cached
  let id: number
  if (ctx) {
    id = ctx.nextEdgeTypeId++
  } else {
    id = nextEdgeTypeId++
  }
  typeIdMap.set(edgeType, id)
  return id
}

function hasOrAddEdgeDedupWith(
  dedupMap: EdgeFromDedupMap,
  typeIdMap: Map<string, number>,
  ctx: EdgeTypeIdContext | null,
  fromId: number, toId: number, edgeType: string, epRowId: number | null
): boolean {
  let toMap = dedupMap.get(fromId)
  if (!toMap) {
    toMap = new Map()
    dedupMap.set(fromId, toMap)
  }

  let typeMap = toMap.get(toId)
  if (!typeMap) {
    typeMap = new Map()
    toMap.set(toId, typeMap)
  }

  const edgeTypeId = getEdgeTypeIdWith(typeIdMap, ctx, edgeType)
  let epSet = typeMap.get(edgeTypeId)
  if (!epSet) {
    epSet = new Set()
    typeMap.set(edgeTypeId, epSet)
  }

  const epKey = edgeEpDedupKey(epRowId)
  if (epSet.has(epKey)) return true
  epSet.add(epKey)
  return false
}
// ep_id text → entrypoints.id 缓存
const epIdCache = new Map<string, number>()
// 边写入缓冲（攒批后事务提交）
interface EdgeProvenanceMetadata {
  sourceNodeId?: number | null
  targetKind?: string | null
  producerKind?: string | null
  provenance?: string | null
}

const edgeBuffer: Array<[number, number, string, number | null, number | null, string | null, string | null, string | null]> = []
const EDGE_BATCH_SIZE = 10000
// project root，用于将 file 绝对路径转为相对路径写入 nodes 表
let _projectRoot: string = ''

// loc_key 只作加速键，节点唯一性仍由全字段回查兜底；用 32-bit FNV 避免热路径 BigInt/Buffer 分配。
function locKeyHash(parts: Array<string | number | null | undefined>): number {
  let hash = 0x811c9dc5
  for (const part of parts) {
    const text = part === null || part === undefined ? '' : String(part)
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0x1f
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function toProjectRelativePath(file: string): string {
  if (!_projectRoot || !file || !file.startsWith('/')) return file
  const cached = filePathCache.get(file)
  if (cached !== undefined) return cached
  const relativeFile = path.relative(_projectRoot, file)
  filePathCache.set(file, relativeFile)
  return relativeFile
}

function getQidUnified(qid: string): string | null {
  if (!qid || qid === 'unknown') return null
  const cached = qidUnifiedCache.get(qid)
  if (cached !== undefined) return cached
  const unified = QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(qid)
  qidUnifiedCache.set(qid, unified)
  return unified
}
// 建库计时统计
let insertNodeTimeMs = 0
let insertEdgeTimeMs = 0
let insertNodeCount = 0
let insertEdgeCount = 0
let selfEdgeFiltered = 0
let edgeDedupFiltered = 0
let incrementalEdgeSkipped = 0
// 探测期跳过的非-source MemberAccess 物化次数，便于解释预扫规则跳过孤儿的结果
let sourceProbeSkipped = 0
// Lazy slot materialization flush hook：由 unit-audit.ts 注册，
// 当非 slot_bind 边的 from 可能有缓存的 slot_bind 时，在写入前 flush。
let _beforeEdgeHook: ((from: unknown) => void) | null = null

/** 注册 recordEdge 前置 hook（供 unit-audit.ts 注册 flushPendingSlotBinds） */
function setBeforeEdgeHook(hook: (from: unknown) => void): void {
  _beforeEdgeHook = hook
}

/** 获取当前 module-global 的 beforeEdgeHook（供 executor 复制到 context） */
function getBeforeEdgeHook(): ((from: unknown) => void) | null {
  return _beforeEdgeHook
}

/** 将 per-executor context 的计数器聚合到 module-global（ALS scope 退出后调用） */
function aggregateContextStats(ctx: { insertNodeTimeMs: number; insertEdgeTimeMs: number; insertNodeCount: number; insertEdgeCount: number; selfEdgeFiltered: number; edgeDedupFiltered: number; incrementalEdgeSkipped: number; sourceProbeSkipped: number }): void {
  insertNodeTimeMs += ctx.insertNodeTimeMs
  insertEdgeTimeMs += ctx.insertEdgeTimeMs
  insertNodeCount += ctx.insertNodeCount
  insertEdgeCount += ctx.insertEdgeCount
  selfEdgeFiltered += ctx.selfEdgeFiltered
  edgeDedupFiltered += ctx.edgeDedupFiltered
  incrementalEdgeSkipped += ctx.incrementalEdgeSkipped
  sourceProbeSkipped += ctx.sourceProbeSkipped
}

/** 探测跳过计数器：source-util 探测分支跳过物化时调用 */
function incSourceProbeSkipped(): void {
  const ctx = getCurrentWriterContext()
  if (ctx) ctx.sourceProbeSkipped++; else sourceProbeSkipped++
}

/** 批量写入边缓冲到 SQLite（事务包裹） */
function shouldRecordEdgeInCurrentMode(edgeType: string): boolean {
  if (_dbMode !== 'incremental-facts') return true
  return !INCREMENTAL_FACTS_SKIPPED_EDGE_TYPES.has(edgeType)
}

function writeMetadataRows(): void {
  if (!stmtUpsertMetadata) return
  stmtUpsertMetadata.run('db_mode', _dbMode)
  stmtUpsertMetadata.run('dataflow_recording_mode', _dbMode)
  stmtUpsertMetadata.run('supports_trace_query', _dbMode === 'full' ? 'true' : 'false')
  stmtUpsertMetadata.run('supports_change_impact', 'true')
  stmtUpsertMetadata.run('schema_version', DATAFLOW_SCHEMA_VERSION)
  stmtUpsertMetadata.run('producer_version', String(YASA_VERSION ?? 'unknown'))
}

function writeRuntimeMetadataRows(commitSeq: number, committedAt: string, reason: string, state: DataflowDbQueryState): void {
  if (!stmtUpsertMetadata) return
  stmtUpsertMetadata.run('run_state', state)
  stmtUpsertMetadata.run('commit_seq', String(commitSeq))
  stmtUpsertMetadata.run('last_commit_at', committedAt)
  stmtUpsertMetadata.run('last_commit_reason', reason)
}

function flushEdgeBuffer(): void {
  flushEdgeBufferFrom(edgeBuffer)
}

function flushEdgeBufferFrom(buffer: Array<[number, number, string, number | null, number | null, string | null, string | null, string | null]>): void {
  if (!db || buffer.length === 0) return
  ensureDataflowDbWritable()
  const ctx = getCurrentWriterContext()
  const t0 = performance.now()
  const activeDb = requireDb()
  const insertMany = activeDb.transaction((rows: Array<[number, number, string, number | null, number | null, string | null, string | null, string | null]>) => {
    for (const row of rows) {
      requireStatement(stmtInsertEdge, 'stmtInsertEdge').run(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7])
    }
  })
  insertMany(buffer)
  const elapsed = performance.now() - t0
  if (ctx) { ctx.insertEdgeTimeMs += elapsed; ctx.insertEdgeCount += buffer.length }
  else { insertEdgeTimeMs += elapsed; insertEdgeCount += buffer.length }
  buffer.length = 0
}

/** 初始化 SQLite 数据库，建表 + 准备 prepared statements */
function initSqlite(reportDir: string, projectRoot?: string): void {
  if (!_sqliteEnabled || db) return
  if (projectRoot) _projectRoot = projectRoot
  const dbPath = path.join(reportDir, 'dataflow.db')
  sqliteDbPath = dbPath
  sqliteInitializedEver = true
  sqliteClosed = false
  // 注册 lazy slot_bind flush hook（unit-audit.ts 提供）
  if (!_beforeEdgeHook) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { flushPendingSlotBinds } = require('./value/unit-audit')
      setBeforeEdgeHook(flushPendingSlotBinds)
    } catch (_e) { /* 模块加载失败时静默 */ }
  }
  db = createSqliteDatabase(dbPath) as SqliteDatabaseLike
  const activeDb = requireDb()
  // WAL 模式提升写入性能
  activeDb.pragma('journal_mode = WAL')
  activeDb.pragma('synchronous = OFF')

  activeDb.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      loc_key         INTEGER NOT NULL,
      file            TEXT,
      line            INTEGER,
      col             INTEGER,
      node_role       TEXT NOT NULL DEFAULT 'value',
      qid             TEXT,
      qid_unified     TEXT,
      sid             TEXT,
      class_name      TEXT,
      property_path   TEXT,
      ast_name        TEXT,
      owner_func_fsig TEXT,
      param_index     INTEGER,
      ep_id           INTEGER,
      callsite_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_lookup ON nodes(loc_key, node_role, qid_unified, ep_id, callsite_id);
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY,
      from_node_id INTEGER REFERENCES nodes(id),
      to_node_id INTEGER REFERENCES nodes(id),
      edge_type TEXT,
      ep_id INTEGER,
      source_node_id INTEGER,
      target_kind TEXT,
      producer_kind TEXT,
      provenance TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
    CREATE TABLE IF NOT EXISTS node_tags (
      node_id INTEGER NOT NULL REFERENCES nodes(id),
      tag TEXT NOT NULL,
      value TEXT NOT NULL,
      provenance TEXT,
      UNIQUE(node_id, tag, value)
    );
    CREATE INDEX IF NOT EXISTS idx_node_tags_tag ON node_tags(tag, value);
    CREATE TABLE IF NOT EXISTS entrypoints (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ep_id       TEXT UNIQUE,
      file        TEXT,
      func_name   TEXT,
      start_line  INTEGER,
      end_line    INTEGER,
      ep_type     TEXT,
      framework   TEXT,
      attribute   TEXT
    );
    CREATE TABLE IF NOT EXISTS builtin_sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id     INTEGER,
      ep_id       TEXT,
      framework   TEXT,
      source_type TEXT,
      param_index INTEGER,
      file        TEXT,
      line        INTEGER,
      col         INTEGER
    );
    CREATE TABLE IF NOT EXISTS callgraph (
      id                              INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_file                     TEXT,
      caller_func                     TEXT,
      caller_qid                      TEXT,
      caller_start_line               INTEGER,
      caller_end_line                 INTEGER,
      call_site_file                  TEXT,
      call_site_line                  INTEGER,
      call_site_col                   INTEGER,
      ep_id                           INTEGER,
      call_node_id                    INTEGER,
      return_node_id                  INTEGER REFERENCES nodes(id),
      arg_count                       INTEGER,
      callee_vtype                    TEXT,
      callexpr_type                   TEXT,
      callee_name                     TEXT,
      callee_dotted_path              TEXT,
      callsite_literal                TEXT,
      callee_type_object_definite     TEXT,
      callee_type_object_vague        TEXT,
      callee_type_rtype_definite      TEXT,
      callee_type_rtype_vague         TEXT,
      callee_object_rtype             TEXT,
      callee_rtype                    TEXT,
      callee_sid                      TEXT,
      callee_property                 TEXT,
      callee_property_pretty          TEXT,
      callee_qid                      TEXT,
      callee_symbol_id                TEXT,
      callee_start_line               INTEGER,
      callee_end_line                 INTEGER,
      resolution_kind                 TEXT,
      confidence                      INTEGER,
      provenance                      TEXT,
      callee_fdef_return_type         TEXT,
      UNIQUE(caller_func, callee_dotted_path, call_site_file, call_site_line, ep_id)
    );
    CREATE TABLE IF NOT EXISTS symbols (
      symbol_id    TEXT PRIMARY KEY,
      qid          TEXT,
      sid          TEXT,
      vtype        TEXT,
      file         TEXT,
      start_line   INTEGER,
      end_line     INTEGER,
      provenance   TEXT
    );
    CREATE TABLE IF NOT EXISTS call_args (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      call_node_id  INTEGER NOT NULL,
      arg_index     INTEGER,
      arg_node_id   INTEGER NOT NULL REFERENCES nodes(id),
      arg_name      TEXT,
      is_receiver   INTEGER,
      provided      INTEGER
    );
    CREATE TABLE IF NOT EXISTS source_files (
      file_path TEXT PRIMARY KEY,
      content   TEXT
    );
    CREATE TABLE IF NOT EXISTS dataflow_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS go_interface_bindings (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      callgraph_id               INTEGER,
      call_site_file             TEXT,
      call_site_line             INTEGER,
      call_site_col              INTEGER,
      consumer_ep_id             INTEGER,
      interface_qid              TEXT,
      interface_method_file       TEXT,
      interface_method_start_line INTEGER,
      interface_method_end_line   INTEGER,
      interface_method           TEXT,
      interface_signature        TEXT,
      receiver_static_qid        TEXT,
      impl_type_qid              TEXT,
      impl_method_qid            TEXT,
      impl_method_file           TEXT,
      impl_method_start_line     INTEGER,
      impl_method_end_line       INTEGER,
      dispatch_kind              TEXT,
      dispatch_confidence        INTEGER,
      dispatch_provenance        TEXT,
      UNIQUE(call_site_file, call_site_line, call_site_col, consumer_ep_id, interface_qid, interface_method, impl_method_qid, dispatch_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_go_interface_bindings_impl ON go_interface_bindings(impl_method_qid, impl_method_file, impl_method_start_line, impl_method_end_line);
    CREATE INDEX IF NOT EXISTS idx_go_interface_bindings_iface ON go_interface_bindings(interface_qid, interface_method, interface_signature);
    CREATE INDEX IF NOT EXISTS idx_go_interface_bindings_ep ON go_interface_bindings(consumer_ep_id);
    CREATE TABLE IF NOT EXISTS module_deps (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_ep_id      INTEGER NOT NULL,
      consumer_file       TEXT NOT NULL,
      consumer_func       TEXT NOT NULL,
      import_site_file    TEXT NOT NULL,
      import_site_line    INTEGER NOT NULL,
      import_path         TEXT NOT NULL,
      imported_file       TEXT NOT NULL,
      imported_package    TEXT NOT NULL,
      imported_qid_prefix TEXT,
      dep_kind            TEXT NOT NULL,
      confidence          INTEGER NOT NULL,
      provenance          TEXT NOT NULL,
      UNIQUE(consumer_ep_id, import_site_file, import_site_line, import_path, imported_file, dep_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_module_deps_imported_file ON module_deps(imported_file);
    CREATE INDEX IF NOT EXISTS idx_module_deps_consumer ON module_deps(consumer_ep_id);
    CREATE INDEX IF NOT EXISTS idx_module_deps_kind_conf ON module_deps(dep_kind, confidence);
    CREATE TABLE IF NOT EXISTS handler_response_flow_facts (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_ep_id           INTEGER NOT NULL,
      handler_file             TEXT NOT NULL,
      handler_func             TEXT NOT NULL,
      producer_callgraph_id    INTEGER,
      producer_call_node_id    INTEGER,
      producer_return_node_id  INTEGER,
      producer_err_node_id     INTEGER,
      producer_result_node_id  INTEGER,
      receiver_callgraph_id    INTEGER,
      receiver_call_node_id    INTEGER,
      receiver_node_id         INTEGER,
      receiver_mutation_method TEXT,
      payload_callgraph_id     INTEGER,
      payload_call_node_id     INTEGER,
      payload_node_id          INTEGER,
      payload_sink_method      TEXT NOT NULL,
      ordering_kind            TEXT NOT NULL,
      evidence_kind            TEXT NOT NULL,
      confidence               INTEGER NOT NULL,
      provenance               TEXT NOT NULL,
      UNIQUE(consumer_ep_id, producer_call_node_id, receiver_call_node_id, payload_call_node_id, receiver_node_id, payload_node_id, evidence_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_handler_response_flow_ep ON handler_response_flow_facts(consumer_ep_id);
    CREATE INDEX IF NOT EXISTS idx_handler_response_flow_nodes ON handler_response_flow_facts(producer_return_node_id, receiver_node_id, payload_node_id);
    CREATE TABLE IF NOT EXISTS impact_path_provenance (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_ep_id           INTEGER,
      changed_symbol_id        TEXT,
      changed_qid              TEXT,
      changed_node_id          INTEGER REFERENCES nodes(id),
      use_symbol_id            TEXT,
      use_qid                  TEXT,
      use_node_id              INTEGER REFERENCES nodes(id),
      callgraph_id             INTEGER REFERENCES callgraph(id),
      call_node_id             INTEGER,
      return_node_id           INTEGER REFERENCES nodes(id),
      path_index               INTEGER,
      path_length              INTEGER,
      path_edge_ids            TEXT,
      evidence_kind            TEXT NOT NULL,
      order_kind               TEXT,
      confidence               INTEGER,
      provenance               TEXT NOT NULL,
      UNIQUE(consumer_ep_id, changed_symbol_id, changed_qid, changed_node_id, use_symbol_id, use_qid, use_node_id, callgraph_id, path_index, evidence_kind, provenance)
    );
    CREATE INDEX IF NOT EXISTS idx_impact_path_prov_changed ON impact_path_provenance(changed_symbol_id, changed_qid, changed_node_id);
    CREATE INDEX IF NOT EXISTS idx_impact_path_prov_use ON impact_path_provenance(use_symbol_id, use_qid, use_node_id);
    CREATE INDEX IF NOT EXISTS idx_impact_path_prov_ep ON impact_path_provenance(consumer_ep_id, evidence_kind, confidence);
    CREATE TABLE IF NOT EXISTS mutating_receiver_alias (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_ep_id           INTEGER NOT NULL,
      handler_file             TEXT NOT NULL,
      handler_func             TEXT NOT NULL,
      callgraph_id             INTEGER REFERENCES callgraph(id),
      call_node_id             INTEGER,
      call_site_file           TEXT,
      call_site_line           INTEGER,
      call_site_col            INTEGER,
      receiver_node_id         INTEGER REFERENCES nodes(id),
      receiver_qid             TEXT,
      receiver_vtype           TEXT,
      receiver_static_type     TEXT,
      mutation_method          TEXT NOT NULL,
      method_qid               TEXT,
      confidence               INTEGER NOT NULL,
      provenance               TEXT NOT NULL,
      UNIQUE(consumer_ep_id, callgraph_id, call_node_id, receiver_node_id, mutation_method)
    );
    CREATE INDEX IF NOT EXISTS idx_mutating_receiver_alias_ep ON mutating_receiver_alias(consumer_ep_id);
    CREATE INDEX IF NOT EXISTS idx_mutating_receiver_alias_callsite ON mutating_receiver_alias(call_site_file, call_site_line);
    CREATE INDEX IF NOT EXISTS idx_mutating_receiver_alias_receiver ON mutating_receiver_alias(receiver_qid, receiver_vtype);
    CREATE TABLE IF NOT EXISTS decl_use_impact_edges (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_ep_id           INTEGER NOT NULL,
      changed_symbol_id        TEXT,
      changed_qid              TEXT,
      changed_file             TEXT,
      changed_start_line       INTEGER,
      changed_end_line         INTEGER,
      callgraph_id             INTEGER REFERENCES callgraph(id),
      call_node_id             INTEGER,
      return_node_id           INTEGER REFERENCES nodes(id),
      use_kind                 TEXT NOT NULL,
      resolution_kind          TEXT,
      confidence               INTEGER NOT NULL,
      provenance               TEXT NOT NULL,
      UNIQUE(consumer_ep_id, callgraph_id, changed_symbol_id, changed_qid, use_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_decl_use_impact_edges_ep ON decl_use_impact_edges(consumer_ep_id);
    CREATE INDEX IF NOT EXISTS idx_decl_use_impact_edges_symbol ON decl_use_impact_edges(changed_symbol_id);
    CREATE INDEX IF NOT EXISTS idx_decl_use_impact_edges_qid_file ON decl_use_impact_edges(changed_qid, changed_file, changed_start_line, changed_end_line);
  `)

  // schema 迁移：已有 DB 可能缺少 P0 edge provenance / callgraph facts 列
  try {
    const existingEdgeCols = new Set((db.prepare(`PRAGMA table_info(edges)`).all() as Array<Record<string, unknown>>)
      .map((r) => r.name))
    const edgeMigrations: Array<[string, string]> = [
      ['source_node_id', 'INTEGER'],
      ['target_kind', 'TEXT'],
      ['producer_kind', 'TEXT'],
      ['provenance', 'TEXT'],
    ]
    for (const [col, colType] of edgeMigrations) {
      if (!existingEdgeCols.has(col)) {
        db.prepare(`ALTER TABLE edges ADD COLUMN ${col} ${colType}`).run()
      }
    }
    db.prepare('CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance)').run()
    db.prepare(`CREATE TABLE IF NOT EXISTS node_tags (
      node_id INTEGER NOT NULL REFERENCES nodes(id),
      tag TEXT NOT NULL,
      value TEXT NOT NULL,
      provenance TEXT,
      UNIQUE(node_id, tag, value)
    )`).run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_node_tags_tag ON node_tags(tag, value)').run()
  } catch (_e) {
    // 迁移失败不影响后续流程
  }

  // schema 迁移：已有 DB 可能缺少 P0 callgraph facts 列
  try {
    const existingCols = new Set((db.prepare(`PRAGMA table_info(callgraph)`).all() as Array<Record<string, unknown>>)
      .map((r) => r.name))
    const migrations: Array<[string, string]> = [
      ['caller_qid', 'TEXT'],
      ['caller_start_line', 'INTEGER'],
      ['caller_end_line', 'INTEGER'],
      ['callee_start_line', 'INTEGER'],
      ['callee_end_line', 'INTEGER'],
      ['resolution_kind', 'TEXT'],
      ['confidence', 'INTEGER'],
      ['provenance', 'TEXT'],
      ['callee_fdef_return_type', 'TEXT'],
      ['callee_symbol_id', 'TEXT'],
      ['interface_qid', 'TEXT'],
      ['interface_method', 'TEXT'],
      ['interface_method_file', 'TEXT'],
      ['interface_method_start_line', 'INTEGER'],
      ['interface_method_end_line', 'INTEGER'],
      ['interface_signature', 'TEXT'],
      ['receiver_static_qid', 'TEXT'],
      ['impl_type_qid', 'TEXT'],
      ['impl_method_qid', 'TEXT'],
      ['impl_method_file', 'TEXT'],
      ['impl_method_start_line', 'INTEGER'],
      ['impl_method_end_line', 'INTEGER'],
      ['dispatch_kind', 'TEXT'],
      ['dispatch_confidence', 'INTEGER'],
      ['dispatch_provenance', 'TEXT'],
    ]
    for (const [col, colType] of migrations) {
      if (!existingCols.has(col)) {
        db.prepare(`ALTER TABLE callgraph ADD COLUMN ${col} ${colType}`).run()
      }
    }
    db.prepare('CREATE INDEX IF NOT EXISTS idx_callgraph_callee_symbol ON callgraph(callee_symbol_id)').run()
  } catch (_e) {
    // 迁移失败不影响后续流程
  }

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS impact_path_provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_ep_id INTEGER,
      changed_symbol_id TEXT,
      changed_qid TEXT,
      changed_node_id INTEGER REFERENCES nodes(id),
      use_symbol_id TEXT,
      use_qid TEXT,
      use_node_id INTEGER REFERENCES nodes(id),
      callgraph_id INTEGER REFERENCES callgraph(id),
      call_node_id INTEGER,
      return_node_id INTEGER REFERENCES nodes(id),
      path_index INTEGER,
      path_length INTEGER,
      path_edge_ids TEXT,
      evidence_kind TEXT NOT NULL,
      order_kind TEXT,
      confidence INTEGER,
      provenance TEXT NOT NULL,
      UNIQUE(consumer_ep_id, changed_symbol_id, changed_qid, changed_node_id, use_symbol_id, use_qid, use_node_id, callgraph_id, path_index, evidence_kind, provenance)
    )`).run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_impact_path_prov_changed ON impact_path_provenance(changed_symbol_id, changed_qid, changed_node_id)').run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_impact_path_prov_use ON impact_path_provenance(use_symbol_id, use_qid, use_node_id)').run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_impact_path_prov_ep ON impact_path_provenance(consumer_ep_id, evidence_kind, confidence)').run()
  } catch (_e) {
    // 迁移失败不影响后续流程
  }

  // 迁移：mutating_receiver_alias / decl_use_impact_edges 旧 DB 兼容
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS mutating_receiver_alias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_ep_id INTEGER NOT NULL,
      handler_file TEXT NOT NULL,
      handler_func TEXT NOT NULL,
      callgraph_id INTEGER REFERENCES callgraph(id),
      call_node_id INTEGER,
      call_site_file TEXT,
      call_site_line INTEGER,
      call_site_col INTEGER,
      receiver_node_id INTEGER REFERENCES nodes(id),
      receiver_qid TEXT,
      receiver_vtype TEXT,
      receiver_static_type TEXT,
      mutation_method TEXT NOT NULL,
      method_qid TEXT,
      confidence INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      UNIQUE(consumer_ep_id, callgraph_id, call_node_id, receiver_node_id, mutation_method)
    )`).run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_mutating_receiver_alias_ep ON mutating_receiver_alias(consumer_ep_id)').run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_mutating_receiver_alias_callsite ON mutating_receiver_alias(call_site_file, call_site_line)').run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_mutating_receiver_alias_receiver ON mutating_receiver_alias(receiver_qid, receiver_vtype)').run()
    db.prepare(`CREATE TABLE IF NOT EXISTS decl_use_impact_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_ep_id INTEGER NOT NULL,
      changed_symbol_id TEXT,
      changed_qid TEXT,
      changed_file TEXT,
      changed_start_line INTEGER,
      changed_end_line INTEGER,
      callgraph_id INTEGER REFERENCES callgraph(id),
      call_node_id INTEGER,
      return_node_id INTEGER REFERENCES nodes(id),
      use_kind TEXT NOT NULL,
      resolution_kind TEXT,
      confidence INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      UNIQUE(consumer_ep_id, callgraph_id, changed_symbol_id, changed_qid, use_kind)
    )`).run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_decl_use_impact_edges_ep ON decl_use_impact_edges(consumer_ep_id)').run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_decl_use_impact_edges_symbol ON decl_use_impact_edges(changed_symbol_id)').run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_decl_use_impact_edges_qid_file ON decl_use_impact_edges(changed_qid, changed_file, changed_start_line, changed_end_line)').run()
  } catch (_e) {
    // 迁移失败不影响后续流程
  }

  stmtInsertNode = db.prepare(
    'INSERT INTO nodes (loc_key, file, line, col, node_role, qid, qid_unified, sid, class_name, property_path, ast_name, owner_func_fsig, param_index, ep_id, callsite_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  // LRU 淘汰后按 INSERT 全字段回查，保持原 stringKey 去重语义不变
  stmtSelectNodeByFields = db.prepare(
    'SELECT id FROM nodes WHERE loc_key IS ? AND file IS ? AND line IS ? AND col IS ? AND node_role IS ? AND qid IS ? AND qid_unified IS ? AND sid IS ? AND class_name IS ? AND property_path IS ? AND ast_name IS ? AND owner_func_fsig IS ? AND param_index IS ? AND ep_id IS ? AND callsite_id IS ? LIMIT 1'
  )
  stmtInsertEdge = db.prepare(
    'INSERT INTO edges (from_node_id, to_node_id, edge_type, ep_id, source_node_id, target_kind, producer_kind, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  stmtUpdateNodeMetadata = db.prepare(`
    UPDATE nodes SET
      node_role = COALESCE(?, node_role),
      class_name = COALESCE(?, class_name),
      property_path = COALESCE(?, property_path),
      ast_name = COALESCE(?, ast_name),
      sid = COALESCE(?, sid),
      qid_unified = COALESCE(?, qid_unified),
      owner_func_fsig = COALESCE(?, owner_func_fsig),
      param_index = COALESCE(?, param_index)
    WHERE id = ?
  `)
  stmtInsertEntrypoint = db.prepare(
    'INSERT OR IGNORE INTO entrypoints (ep_id, file, func_name, start_line, end_line, ep_type, framework, attribute) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  stmtGetEntrypointId = db.prepare(
    'SELECT id FROM entrypoints WHERE ep_id = ?'
  )
  stmtInsertBuiltinSource = db.prepare(
    'INSERT INTO builtin_sources (node_id, ep_id, framework, source_type, param_index, file, line, col) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  stmtInsertCallgraph = db.prepare(
    `INSERT OR IGNORE INTO callgraph (
      caller_file, caller_func, caller_qid, caller_start_line, caller_end_line,
      call_site_file, call_site_line, call_site_col, ep_id, call_node_id, return_node_id,
      arg_count, callee_vtype, callexpr_type, callee_name,
      callee_dotted_path, callsite_literal,
      callee_type_object_definite, callee_type_object_vague,
      callee_type_rtype_definite, callee_type_rtype_vague,
      callee_object_rtype, callee_rtype,
      callee_sid, callee_property, callee_property_pretty, callee_qid, callee_symbol_id,
      callee_start_line, callee_end_line, resolution_kind, confidence, provenance,
      callee_fdef_return_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  stmtInsertCallArg = db.prepare(
    'INSERT INTO call_args (call_node_id, arg_index, arg_node_id, arg_name, is_receiver, provided) VALUES (?, ?, ?, ?, ?, ?)'
  )
  stmtUpdateCallgraphDispatch = db.prepare(`
    UPDATE callgraph SET
      interface_qid = COALESCE(?, interface_qid),
      interface_method = COALESCE(?, interface_method),
      interface_method_file = COALESCE(?, interface_method_file),
      interface_method_start_line = COALESCE(?, interface_method_start_line),
      interface_method_end_line = COALESCE(?, interface_method_end_line),
      interface_signature = COALESCE(?, interface_signature),
      receiver_static_qid = COALESCE(?, receiver_static_qid),
      impl_type_qid = COALESCE(?, impl_type_qid),
      impl_method_qid = COALESCE(?, impl_method_qid),
      impl_method_file = COALESCE(?, impl_method_file),
      impl_method_start_line = COALESCE(?, impl_method_start_line),
      impl_method_end_line = COALESCE(?, impl_method_end_line),
      dispatch_kind = COALESCE(?, dispatch_kind),
      dispatch_confidence = COALESCE(?, dispatch_confidence),
      dispatch_provenance = COALESCE(?, dispatch_provenance)
    WHERE id = ?
  `)
  stmtInsertSymbol = db.prepare(
    'INSERT OR IGNORE INTO symbols (symbol_id, qid, sid, vtype, file, start_line, end_line, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  stmtInsertSourceFile = db.prepare(
    'INSERT OR REPLACE INTO source_files (file_path, content) VALUES (?, ?)'
  )
  stmtInsertGoInterfaceBinding = db.prepare(
    `INSERT OR IGNORE INTO go_interface_bindings (
      callgraph_id, call_site_file, call_site_line, call_site_col, consumer_ep_id,
      interface_qid, interface_method_file, interface_method_start_line, interface_method_end_line,
      interface_method, interface_signature, receiver_static_qid,
      impl_type_qid, impl_method_qid, impl_method_file, impl_method_start_line, impl_method_end_line,
      dispatch_kind, dispatch_confidence, dispatch_provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  stmtInsertModuleDep = db.prepare(
    `INSERT OR IGNORE INTO module_deps (
      consumer_ep_id, consumer_file, consumer_func, import_site_file, import_site_line,
      import_path, imported_file, imported_package, imported_qid_prefix, dep_kind, confidence, provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  stmtInsertNodeTag = db.prepare(
    'INSERT OR IGNORE INTO node_tags (node_id, tag, value, provenance) VALUES (?, ?, ?, ?)'
  )
  stmtInsertHandlerResponseFlowFact = db.prepare(
    `INSERT OR IGNORE INTO handler_response_flow_facts (
      consumer_ep_id, handler_file, handler_func,
      producer_callgraph_id, producer_call_node_id, producer_return_node_id, producer_err_node_id, producer_result_node_id,
      receiver_callgraph_id, receiver_call_node_id, receiver_node_id, receiver_mutation_method,
      payload_callgraph_id, payload_call_node_id, payload_node_id, payload_sink_method,
      ordering_kind, evidence_kind, confidence, provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  stmtInsertImpactPathProvenance = db.prepare(
    `INSERT OR IGNORE INTO impact_path_provenance (
      consumer_ep_id, changed_symbol_id, changed_qid, changed_node_id,
      use_symbol_id, use_qid, use_node_id,
      callgraph_id, call_node_id, return_node_id,
      path_index, path_length, path_edge_ids,
      evidence_kind, order_kind, confidence, provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  stmtInsertMutatingReceiverAlias = db.prepare(
    `INSERT OR IGNORE INTO mutating_receiver_alias (
      consumer_ep_id, handler_file, handler_func, callgraph_id, call_node_id,
      call_site_file, call_site_line, call_site_col,
      receiver_node_id, receiver_qid, receiver_vtype, receiver_static_type,
      mutation_method, method_qid, confidence, provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  stmtInsertDeclUseImpactEdge = db.prepare(
    `INSERT OR IGNORE INTO decl_use_impact_edges (
      consumer_ep_id, changed_symbol_id, changed_qid,
      changed_file, changed_start_line, changed_end_line,
      callgraph_id, call_node_id, return_node_id,
      use_kind, resolution_kind, confidence, provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  stmtUpsertMetadata = db.prepare(
    'INSERT OR REPLACE INTO dataflow_metadata (key, value) VALUES (?, ?)'
  )
  writeMetadataRows()
  writeRuntimeMetadataRows(sqliteCommitSeq, new Date().toISOString(), 'init', 'running')
  // 采集阶段 写入全程保持单事务，避免每个节点 INSERT 触发隐式提交。
  db.exec('BEGIN IMMEDIATE')
  sqliteWriteTransactionOpen = true
}

/** 节点元数据（ensureNode 可选参数） */
interface NodeMetadata {
  nodeRole?: string
  className?: string
  propertyPath?: string
  astName?: string
  sid?: string
  qidUnified?: string
  ownerFuncFsig?: string
  paramIndex?: number
}

interface NodeLookupFields {
  locKeyInt: number
  fileForDb: string
  line: number
  col: number
  nodeRole: string
  qid: string
  qidUnified: string | null
  sid: string | null
  className: string | null
  propertyPath: string | null
  astName: string | null
  ownerFuncFsig: string | null
  paramIndex: number | null
  epRowId: number | null
  callsiteId: string | null
}

function buildNodeLookupKey(fields: NodeLookupFields): string {
  return `${fields.locKeyInt}|${fields.fileForDb}|${fields.line}|${fields.col}|${fields.nodeRole}|${fields.qid}|${fields.qidUnified ?? '_N_'}|${fields.sid ?? '_N_'}|${fields.className ?? '_N_'}|${fields.propertyPath ?? '_N_'}|${fields.astName ?? '_N_'}|${fields.ownerFuncFsig ?? '_N_'}|${fields.paramIndex ?? '_N_'}|${fields.epRowId ?? '_N_'}|${fields.callsiteId ?? '_N_'}`
}

function selectNodeByFields(fields: NodeLookupFields): number | null {
  const row = stmtSelectNodeByFields?.get(
    fields.locKeyInt,
    fields.fileForDb,
    fields.line,
    fields.col,
    fields.nodeRole,
    fields.qid,
    fields.qidUnified,
    fields.sid,
    fields.className,
    fields.propertyPath,
    fields.astName,
    fields.ownerFuncFsig,
    fields.paramIndex,
    fields.epRowId,
    fields.callsiteId
  )
  return row?.id ?? null
}

// Value → 整数 ID 映射（供 UAUDIT 对账 + v5 event-driven SSA 识别用）
const valueIdMap = new WeakMap<object, number>()
let nextValueId = 1
function getValueId(val: unknown): number {
  if (!val || typeof val !== 'object') return 0
  let vid = valueIdMap.get(val)
  if (vid === undefined) {
    vid = nextValueId++
    valueIdMap.set(val, vid)
  }
  return vid
}

/** 从 Unit 提取节点信息并写入 nodes 表，返回 node_id
 *  调用点拆分 修：nodeId 按 (val identity, ep_id, callsite_id) 三维分裂（调用点粒度设计 N2 SSA 粒度）。
 *  callsite_id 直接读 val._callsite（创建时刻 stamp，不查全局）。同一 val 跨栈帧引用不分裂；
 *  callee 内 new 出来的新 val 自带 callee 的 callsite_id，自然分裂；clone 副本继承 callsite，与原 val 同桶。
 */
function ensureNode(val: unknown, metadata?: NodeMetadata): number | null {
  if (!val || !db) return null
  ensureDataflowDbWritable()
  const ctx = getCurrentWriterContext()
  const _epIdCache = ctx ? ctx.epIdCache : epIdCache
  const _valNodeIdCache = ctx ? ctx.valNodeIdCache : valNodeIdCache
  const _stringNodeCache = ctx ? ctx.stringNodeCache : stringNodeCache
  const _nodeIdCache = ctx ? ctx.nodeIdCache : nodeIdCache
  // 当前 EP 归属：getCurrentEntryPoint → epIdCache → epRowId；pre-scan / 未登记 entrypoints 时为 null
  const ep = getCurrentEntryPoint()
  const epText = ep ? `${ep.filePath}:${ep.functionName}` : null
  const epRowId = epText ? (_epIdCache.get(epText) ?? null) : null
  const epKey = epRowId ?? 0  // 0 专用于 pre-scan / 默认 EP 共享桶
  const valueRecord = asDataflowValue(val)
  // 调用点拆分：callsite_id 来自 val 创建时刻 stamp（_callsite），不查全局栈
  const callsiteId: string | null = typeof valueRecord?._callsite === 'string' ? valueRecord._callsite : null
  const bucketKey = `${epKey}|${callsiteId ?? ''}`
  // 调用点拆分：identity × ep × callsite 三维分桶去重
  if (typeof val === 'object') {
    const inner = _valNodeIdCache.get(val)
    if (inner) {
      const cached = inner.get(bucketKey)
      if (cached !== undefined) return cached
    }
  }
  // 直接用 val 自身位置，不做 COW 回溯（每个调用点生成独立 node，保留 SSA 语义）
  // MemberExprValue 等合成 Value 的 loc 在 val.loc 而不在 val.ast.node.loc，
  // 缺失时 fallback 到 val.loc 以保证节点 line/col 正确（runtime probe 验证：
  // c.Request 链路上承载 propagate 边的 MemberExprValue 节点 loc 在 val.loc）
  const astLoc = valueRecord?.ast?.node?.loc
  const fallbackLoc = valueRecord?.loc
  const locSource = (getRecordField(astLoc, 'start') || Array.isArray(astLoc)) ? astLoc : fallbackLoc
  const loc = extractLoc(locSource)
  const line = loc?.line ?? 0
  const col = loc?.col ?? 0
  const qid = valueRecord?.qid || valueRecord?._qid || 'unknown'
  const astLocRecord = isRecord(valueRecord?.ast?.node?.loc) ? valueRecord?.ast?.node?.loc : null
  const fallbackLocRecord = isRecord(valueRecord?.loc) ? valueRecord?.loc : null
  const file = String(
    getRecordField(astLocRecord, 'sourcefile')
    || getRecordField(getRecordField(astLocRecord, 'start'), 'sourcefile')
    || getRecordField(fallbackLocRecord, 'sourcefile')
    || getRecordField(getRecordField(fallbackLocRecord, 'start'), 'sourcefile')
    || ''
  )
  // nodes 表存相对路径（相对于 project root），sarif 不受影响
  const fileForDb = toProjectRelativePath(file)
  const locKeyInt = locKeyHash([file, line, col, qid])

  const nodeRole = metadata?.nodeRole ?? 'value'

  // 二级 fallback：stringKey 覆盖 INSERT 全部 15 字段，NULL 归一为 '_N_'
  const _sid = metadata?.sid ?? valueRecord?.sid ?? null
  const _qidUnified = metadata?.qidUnified ?? getQidUnified(qid)
  const _className = metadata?.className ?? null
  const _propertyPath = metadata?.propertyPath ?? null
  const _astName = metadata?.astName ?? valueRecord?.sid ?? valueRecord?.ast?.node?.name ?? null
  const _ownerFuncFsig = metadata?.ownerFuncFsig ?? null
  const _paramIndex = metadata?.paramIndex ?? null
  const stringKey = buildNodeLookupKey({
    locKeyInt,
    fileForDb,
    line,
    col,
    nodeRole,
    qid,
    qidUnified: _qidUnified,
    sid: _sid,
    className: _className,
    propertyPath: _propertyPath,
    astName: _astName,
    ownerFuncFsig: _ownerFuncFsig,
    paramIndex: _paramIndex,
    epRowId,
    callsiteId,
  })
  const stringCached = _stringNodeCache.get(stringKey)
  if (stringCached !== undefined) {
    // 回写 WeakMap，后续同 val 走快路径
    if (typeof val === 'object') {
      let inner = _valNodeIdCache.get(val)
      if (!inner) {
        inner = new Map<string, number>()
        _valNodeIdCache.set(val, inner)
      }
      inner.set(bucketKey, stringCached)
      _nodeIdCache.set(stringKey, stringCached)
    }
    return stringCached
  }

  let nodeId = selectNodeByFields({
    locKeyInt,
    fileForDb,
    line,
    col,
    nodeRole,
    qid,
    qidUnified: _qidUnified,
    sid: _sid,
    className: _className,
    propertyPath: _propertyPath,
    astName: _astName,
    ownerFuncFsig: _ownerFuncFsig,
    paramIndex: _paramIndex,
    epRowId,
    callsiteId,
  })
  if (nodeId === null) {
    const t0 = performance.now()
    const info = requireStatement(stmtInsertNode, 'stmtInsertNode').run(
      locKeyInt, fileForDb, line, col,
      nodeRole,
      qid,
      _qidUnified,
      _sid,
      _className,
      _propertyPath,
      _astName,
      _ownerFuncFsig,
      _paramIndex,
      epRowId,
      callsiteId
    )
    const elapsed = performance.now() - t0
    if (ctx) { ctx.insertNodeTimeMs += elapsed; ctx.insertNodeCount++ }
    else { insertNodeTimeMs += elapsed; insertNodeCount++ }
    nodeId = typeof info?.lastInsertRowid === 'bigint' ? Number(info.lastInsertRowid) : (info?.lastInsertRowid ?? null)
  }

  if (nodeId !== null) {
    // 写入二级 stringCache（无论 val 是否为 object）
    _stringNodeCache.set(stringKey, nodeId)
    if (typeof val === 'object') {
      let inner = _valNodeIdCache.get(val)
      if (!inner) {
        inner = new Map<string, number>()
        _valNodeIdCache.set(val, inner)
      }
      inner.set(bucketKey, nodeId)
      _nodeIdCache.set(stringKey, nodeId)
    }
  }
  return nodeId
}

/** 只更新非空字段，不覆盖已有值 */
function updateNodeMetadata(nodeId: number, metadata: NodeMetadata): void {
  if (!_sqliteEnabled || !db || !stmtUpdateNodeMetadata) return
  stmtUpdateNodeMetadata.run(
    metadata.nodeRole ?? null,
    metadata.className ?? null,
    metadata.propertyPath ?? null,
    metadata.astName ?? null,
    metadata.sid ?? null,
    metadata.qidUnified ?? null,
    metadata.ownerFuncFsig ?? null,
    metadata.paramIndex ?? null,
    nodeId
  )
}

function writeNodeTag(nodeId: number | null, tag: string, value: string, provenance?: string): void {
  if (!_sqliteEnabled || !db || !stmtInsertNodeTag || nodeId === null) return
  stmtInsertNodeTag.run(nodeId, tag, value, provenance ?? null)
}

function recordNodeTag(val: unknown, tag: string, value: string, provenance?: string): void {
  if (!_sqliteEnabled || !db) return
  const nodeId = ensureNode(val)
  writeNodeTag(nodeId, tag, value, provenance)
}

function provenanceRow(metadata?: EdgeProvenanceMetadata): [number | null, string | null, string | null, string | null] {
  return [
    metadata?.sourceNodeId ?? null,
    metadata?.targetKind ?? null,
    metadata?.producerKind ?? null,
    metadata?.provenance ?? null,
  ]
}

function defaultEdgeMetadata(edgeType: string): EdgeProvenanceMetadata | undefined {
  if (edgeType === 'slot_bind') {
    return { targetKind: 'slot_owner', producerKind: 'slot_bind', provenance: 'unit-audit.slot_bind' }
  }
  return undefined
}

/** 补充节点的 file/line/col（仅当已有值为空时更新） */
function updateNodeFile(nodeId: number, file: string, line: number, col: number): void {
  if (!_sqliteEnabled || !db) return
  db.prepare(
    `UPDATE nodes SET file = ?, line = ?, col = ? WHERE id = ? AND (file = '' OR file IS NULL)`
  ).run(file, line, col, nodeId)
}

/** 从 loc 提取 line:col，兼容对象和数组格式 */
function extractLoc(loc: unknown): { line: number; col: number } | null {
  if (!loc) return null
  // 对象格式：{start: {line, column}, end: {line, column}}
  if (isRecord(loc)) {
    const start = getRecordField(loc, 'start')
    const line = getRecordField(start, 'line')
    const column = getRecordField(start, 'column')
    if (typeof line === 'number') return { line, col: typeof column === 'number' ? column : 0 }
  }
  // 数组格式：[startLine, startCol, endLine, endCol]
  if (Array.isArray(loc) && loc.length >= 2) {
    return { line: loc[0], col: loc[1] }
  }
  return null
}


/** 记录一条数据流边 */
function recordEdge(from: unknown, to: unknown, edgeType: string, metadata?: EdgeProvenanceMetadata): void {
  if (!_sqliteEnabled) return

  const ctx = getCurrentWriterContext()
  const _beforeEdgeHookLocal = ctx ? ctx.beforeEdgeHook : _beforeEdgeHook

  // B1 §6.1：merge 边仅在 src 当下真携带 taint 时记录。
  // 精确复刻 runtime mergeLeafValues 调用方的 isTaintedRec 守卫 —
  // src 未 tainted 时的 mergeFrom 是结构性合并（runtime 此刻无 taint 流动），
  // 离线保留该边只会让 BFS 形成跨 EP 伪连通。
  // 注意：propagate 守卫不剥（runtime propagateFrom 调用方已有等价守卫，
  // 离线加守卫后结构剪枝只删除不可达 dead-end slot，不改变 runtime 传播。
  // union_compose 与 merge 守卫对齐：appendValue/_pushValue 路径 hook 覆盖后，
  // child 未 tainted 时不应落边，防跨 EP 伪连通（同 merge 语义）。
  if (edgeType === 'merge' || edgeType === 'union_compose') {
    if (!asDataflowValue(from)?._taint?.isTaintedRec) return
  }

  // Lazy slot materialization：非 slot_bind 边写入前，flush from 上缓存的 slot_bind 事件。
  // 由 unit-audit.ts 注册 hook（flushPendingSlotBinds），
  // 当 ownerUnit 作为 from 出现在任何非 slot_bind 边时，说明该 slot 被下游消费。
  if (edgeType !== 'slot_bind' && _beforeEdgeHookLocal && from && typeof from === 'object') {
    _beforeEdgeHookLocal(from)
  }

  // SQLite 写入（缓冲 + 去重 + 批量事务提交）
  if (_sqliteEnabled && db) {
    if (!shouldRecordEdgeInCurrentMode(edgeType)) {
      if (ctx) ctx.incrementalEdgeSkipped++; else incrementalEdgeSkipped++
      return
    }
    const fromId = ensureNode(from)
    const toId = ensureNode(to)
    if (fromId !== null && toId !== null) {
      // COW 合并后同源值映射到同一 node_id → 自环，跳过
      if (fromId === toId) {
        if (ctx) ctx.selfEdgeFiltered++; else selfEdgeFiltered++
      } else {
        // 对标 runtime 每 EP 独立执行一次完整分析：dedup 按 ep 维度，同边在不同 EP 各记一份
        const _epIdCache = ctx ? ctx.epIdCache : epIdCache
        const _edgeDedupMap = ctx ? ctx.edgeDedupMap : edgeDedupMap
        const _edgeTypeIdMap = ctx ? ctx.edgeTypeIdMap : edgeTypeIdMap
        const _edgeBuffer = ctx ? ctx.edgeBuffer : edgeBuffer
        const ep = getCurrentEntryPoint()
        const epText = ep ? `${ep.filePath}:${ep.functionName}` : 'default'
        const epRowId = _epIdCache.get(epText) ?? null
        if (hasOrAddEdgeDedupWith(_edgeDedupMap, _edgeTypeIdMap, ctx, fromId, toId, edgeType, epRowId)) {
          if (ctx) ctx.edgeDedupFiltered++; else edgeDedupFiltered++
        } else {
          _edgeBuffer.push([fromId, toId, edgeType, epRowId, ...provenanceRow(metadata ?? defaultEdgeMetadata(edgeType))])
          if (_edgeBuffer.length >= EDGE_BATCH_SIZE) {
            flushEdgeBufferFrom(_edgeBuffer)
          }
        }
      }
    }
  }
}

/** 保留 dataflowDb 兼容 API；查询计数只属于已删除的内存 profiling 输出。 */
function recordIsTaintedRecQuery(_val: unknown): void {}

/** 清理 vagueType / rtype 字符串中的引号（对齐 runtime `.replace(/"/g, '')`） */
function stripQuotes(s: string | null | undefined): string {
  if (!s) return ''
  return String(s).replace(/"/g, '')
}

type UnknownRecord = Record<string, unknown>

interface DataflowValueLike extends UnknownRecord {
  ast?: { node?: { loc?: unknown; name?: string }; fdef?: { loc?: unknown; returnType?: unknown }; [key: string]: unknown }
  loc?: unknown
  qid?: string
  _qid?: string
  sid?: string
  vtype?: string
  uuid?: string
  _callsite?: string | null
  _taint?: { isTaintedRec?: boolean }
}

interface SqliteRunInfo { lastInsertRowid?: number | bigint; changes?: number }
interface SqliteExecStatement<Row = UnknownRecord> {
  run(...params: unknown[]): SqliteRunInfo
  get(...params: unknown[]): Row | undefined
  all(...params: unknown[]): Row[]
}
interface SqliteDatabaseLike {
  prepare<Row = UnknownRecord>(sql: string): SqliteExecStatement<Row>
  transaction<T extends (...args: never[]) => unknown>(fn: T): T
  exec(sql: string): unknown
  pragma(sql: string): unknown
  close(): unknown
}

function asDataflowValue(value: unknown): DataflowValueLike | null {
  return isRecord(value) ? value as DataflowValueLike : null
}

function requireDb(): SqliteDatabaseLike {
  if (!db) throw new Error('dataflow db is not initialized')
  return db
}

function normalizeSqliteError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function markDataflowDbFatal(error: unknown): void {
  sqliteFatalError = normalizeSqliteError(error)
}

function ensureDataflowDbWritable(): void {
  if (sqliteFatalError) {
    throw new Error(`dataflow db is no longer writable: ${sqliteFatalError.message}`)
  }
  if (db && !sqliteClosed && !sqliteWriteTransactionOpen) {
    const error = new Error('dataflow db write transaction is not active')
    markDataflowDbFatal(error)
    throw error
  }
}

function requireStatement<Row = UnknownRecord>(stmt: SqliteExecStatement<Row> | null, name: string): SqliteExecStatement<Row> {
  if (!stmt) throw new Error(`${name} is not initialized`)
  return stmt
}

function getSqliteBindArgs(params?: SqliteQueryParams): unknown[] {
  if (params === undefined) return []
  return Array.isArray(params) ? [...params] : [params]
}

function buildDataflowDbQueryMetadata(state: DataflowDbQueryState): DataflowDbQueryMetadata {
  if (!sqliteDbPath) throw new Error('dataflow db path is not available')
  return {
    dbPath: sqliteDbPath,
    commitSeq: sqliteCommitSeq,
    committedAt: sqliteLastCommitAt ?? '',
    state,
  }
}

function getDataflowDbRuntimeState(): {
  enabled: boolean
  initialized: boolean
  closed: boolean
  dbPath: string | null
  transactionOpen: boolean
  commitSeq: number
  lastCommitAt: string | null
  writeFailed: boolean
  writeError: string | null
} {
  return {
    enabled: _sqliteEnabled,
    initialized: sqliteInitializedEver,
    closed: sqliteClosed,
    dbPath: sqliteDbPath,
    transactionOpen: sqliteWriteTransactionOpen,
    commitSeq: sqliteCommitSeq,
    lastCommitAt: sqliteLastCommitAt,
    writeFailed: sqliteFatalError !== null,
    writeError: sqliteFatalError?.message ?? null,
  }
}

function flushDataflowDbPendingWrites(): void {
  const contextBuffer = getCurrentWriterContext()?.edgeBuffer
  if (contextBuffer) flushEdgeBufferFrom(contextBuffer)
  flushEdgeBuffer()
}

function commitDataflowDbTransaction(reason: string, state: DataflowDbQueryState): DataflowDbQueryMetadata {
  if (!db) throw new Error('dataflow db is not initialized')
  if (sqliteFatalError) {
    throw new Error(`dataflow db is no longer writable: ${sqliteFatalError.message}`)
  }
  if (!sqliteWriteTransactionOpen) {
    return buildDataflowDbQueryMetadata(state)
  }

  flushDataflowDbPendingWrites()
  const committedAt = new Date().toISOString()
  const nextCommitSeq = sqliteCommitSeq + 1
  writeRuntimeMetadataRows(nextCommitSeq, committedAt, reason, state)
  try {
    db.exec('COMMIT')
    sqliteWriteTransactionOpen = false
    sqliteCommitSeq = nextCommitSeq
    sqliteLastCommitAt = committedAt
    sqliteClosed = state === 'closed'
    return buildDataflowDbQueryMetadata(state)
  } catch (error) {
    try { db.exec('ROLLBACK') } catch (_rollbackError) { /* 保留原始提交错误 */ }
    sqliteWriteTransactionOpen = false
    markDataflowDbFatal(error)
    throw error
  }
}

function reopenDataflowDbWriteTransaction(): void {
  if (!db) throw new Error('dataflow db is not initialized')
  if (sqliteFatalError) {
    throw new Error(`dataflow db is no longer writable: ${sqliteFatalError.message}`)
  }
  if (sqliteClosed) throw new Error('dataflow db is already closed')
  if (!sqliteWriteTransactionOpen) {
    try {
      db.exec('BEGIN IMMEDIATE')
      sqliteWriteTransactionOpen = true
    } catch (error) {
      sqliteWriteTransactionOpen = false
      markDataflowDbFatal(error)
      throw error
    }
  }
}

function getDataflowDbQueryMetadata(state: DataflowDbQueryState): DataflowDbQueryMetadata {
  return buildDataflowDbQueryMetadata(state)
}

function queryOpenDataflowDb<Row extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: SqliteReadonlyQueryParams
): Row[] {
  if (!db) throw new Error('dataflow db is not initialized')
  return db.prepare<Row>(sql).all(...getSqliteBindArgs(params))
}

function queryClosedDataflowDb<Row extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: SqliteReadonlyQueryParams
): DataflowDbQueryResult<Row> {
  if (!sqliteDbPath || !sqliteInitializedEver || !sqliteClosed) {
    throw new Error('dataflow db is not closed')
  }
  const readonlyDb = createSqliteDatabase(sqliteDbPath, { readonly: true, fileMustExist: true }) as SqliteDatabaseLike
  try {
    const rows = readonlyDb.prepare<Row>(sql).all(...getSqliteBindArgs(params))
    return { rows, metadata: buildDataflowDbQueryMetadata('closed') }
  } finally {
    readonlyDb.close()
  }
}

function countRows(sql: string): number {
  const value = requireDb().prepare<{ c: number }>(sql).get()?.c
  return typeof value === 'number' ? value : 0
}

function isSqliteRunInfo(value: unknown): value is SqliteRunInfo {
  return isRecord(value)
}

function runChanges(info: unknown): number {
  return isSqliteRunInfo(info) && typeof info.changes === 'number' ? info.changes : 0
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object'
}

function getRecordField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function getStringField(value: unknown, key: string): string | null {
  const field = getRecordField(value, key)
  return typeof field === 'string' && field.length > 0 ? field : null
}

function getLocCandidate(value: unknown): unknown {
  if (!isRecord(value)) return null
  const ast = getRecordField(value, 'ast')
  const fdef = getRecordField(ast, 'fdef')
  const astNode = getRecordField(ast, 'node')
  return getRecordField(fdef, 'loc') || getRecordField(astNode, 'loc') || getRecordField(value, 'loc')
}

function extractRange(loc: unknown): { start: number | null; end: number | null } {
  if (!loc) return { start: null, end: null }
  if (isRecord(loc)) {
    const start = getRecordField(loc, 'start')
    const end = getRecordField(loc, 'end')
    const startLine = getRecordField(start, 'line')
    if (typeof startLine === 'number') {
      const endLine = getRecordField(end, 'line')
      return { start: startLine, end: typeof endLine === 'number' ? endLine : startLine }
    }
  }
  if (Array.isArray(loc) && loc.length >= 3) {
    const start = typeof loc[0] === 'number' ? loc[0] : null
    const end = typeof loc[2] === 'number' ? loc[2] : start
    return { start, end }
  }
  return { start: null, end: null }
}

function extractFileFromLoc(loc: unknown): string {
  if (isRecord(loc)) {
    const sourcefile = getStringField(loc, 'sourcefile')
    if (sourcefile) return sourcefile
    const startSourcefile = getStringField(getRecordField(loc, 'start'), 'sourcefile')
    if (startSourcefile) return startSourcefile
  }
  if (Array.isArray(loc)) {
    const firstSourcefile = getStringField(loc[0], 'sourcefile')
    if (firstSourcefile) return firstSourcefile
    return typeof loc[4] === 'string' ? loc[4] : ''
  }
  return ''
}

function toDbFile(rawFile: string): string {
  return (_projectRoot && rawFile && rawFile.startsWith('/'))
    ? require('path').relative(_projectRoot, rawFile)
    : rawFile
}

function writeSymbolFact(symbolId: string | null, value: unknown, provenance: string): void {
  if (!symbolId || !stmtInsertSymbol) return
  const loc = getLocCandidate(value)
  const range = extractRange(loc)
  stmtInsertSymbol.run(
    symbolId,
    getStringField(value, 'qid'),
    getStringField(value, 'sid'),
    getStringField(value, 'vtype'),
    toDbFile(extractFileFromLoc(loc)),
    range.start,
    range.end,
    provenance
  )
}

function extractCallgraphP0Facts(fclos: unknown, scope: unknown, provenance: string): CallgraphP0Facts {
  const ep = getCurrentEntryPoint()
  const callerQid = getStringField(scope, 'qid') || getStringField(scope, '_qid') || getStringField(scope, 'logicalQid')
  const callerLoc = callerQid ? getLocCandidate(scope) : ep?.entryPointSymVal?.ast?.node?.loc
  const callerRange = extractRange(callerLoc)
  const callerStartLine = callerQid ? callerRange.start : (ep?.funcLocStart ?? callerRange.start)
  const callerEndLine = callerQid ? callerRange.end : (ep?.funcLocEnd ?? callerRange.end)
  const calleeLoc = getLocCandidate(fclos)
  const calleeRange = extractRange(calleeLoc)
  const fclosAst = getRecordField(fclos, 'ast')
  const hasCalleeBody = !!(getRecordField(fclosAst, 'fdef') || getRecordField(fclosAst, 'node') || getRecordField(fclos, 'loc'))
  const fclosObject = getRecordField(fclos, 'object')
  const objectRtype = getRecordField(fclosObject, 'rtype')
  const rtype = getRecordField(fclos, 'rtype')
  const hasTypedResolution = !!(
    getRecordField(objectRtype, 'definiteType') ||
    getRecordField(rtype, 'definiteType') ||
    getRecordField(objectRtype, 'vagueType') ||
    getRecordField(rtype, 'vagueType')
  )
  const resolutionKind = hasCalleeBody ? 'direct_fdef' : (hasTypedResolution ? 'type_member' : 'unresolved')
  const confidence = resolutionKind === 'direct_fdef' ? 100 : (resolutionKind === 'type_member' ? 70 : 30)
  return {
    callerQid: callerQid || ep?.entryPointSymVal?.qid || ep?.scopeVal?.qid || null,
    callerStartLine,
    callerEndLine,
    calleeStartLine: calleeRange.start,
    calleeEndLine: calleeRange.end,
    resolutionKind,
    confidence,
    provenance,
  }
}

/** 提取 callee 函数声明的返回类型注解
 *
 * 优先级：fdef.returnType（AST 类型注解，最精确） > fdef._meta.returnType（元数据）
 * 对于 Java 等强类型语言，返回类型注解如 void/boolean/String 可用于
 * source-matcher 的返回值类型过滤。
 * 第三方库方法无法获取源码，此字段为空串（source-matcher 回退到出边过滤）。
 */
function extractFdefReturnType(fclos: unknown): string {
  const fdef = asDataflowValue(fclos)?.ast?.fdef
  if (!fdef) return ''
  // Java fdef.returnType 是 UAST Identifier 节点（{type: 'Identifier', name: 'boolean'}）
  const returnType = getRecordField(fdef, 'returnType')
  if (returnType) {
    if (typeof returnType === 'string') return stripQuotes(returnType)
    const returnName = getRecordField(returnType, 'name')
    if (typeof returnName === 'string') return stripQuotes(returnName)
    // 泛型如 {type: 'ParameterizedType', id: {name: 'List'}, ...}：取 id.name
    const returnIdName = getRecordField(getRecordField(returnType, 'id'), 'name')
    if (typeof returnIdName === 'string') return stripQuotes(returnIdName)
    // 兜底：prettyPrint
    return stripQuotes(prettyPrint(returnType))
  }
  return ''
}

/** 创建 call 站点 anchor ID（不物化到 nodes 表，仅作 callgraph/call_args 的 group key）。
 *
 * 历史：原 ensureCallNode 把每个 call 站点写入 nodes 表（node_role='call'），
 * 但 BFS 永远到达不了 call 节点（incoming=0），cn.col 又不进 sarif，是死字段。
 * 现改为递增逻辑 ID，仅用于 call_args 按 call site group。
 *
 * 缓存 key 与原 ensureCallNode 的 locKey 对齐：仅 (file, line, col, calleeDottedPath)。
 * 不加 ep / callsite 维度——同一 call site 在不同 ep 上下文复用一个 anchor，与原行为一致。
 */
const callAnchorIdCache = new Map<string, number>()
let callAnchorIdSeq = 0
function ensureCallAnchorId(node: unknown, calleeDottedPath: string): number | null {
  const ctx = getCurrentWriterContext()
  const _callAnchorIdCache = ctx ? ctx.callAnchorIdCache : callAnchorIdCache
  const nodeRecord = isRecord(node) ? node : null
  const nodeLoc = getRecordField(nodeRecord, 'loc')
  const loc = extractLoc(nodeLoc)
  const line = loc?.line ?? 0
  const col = loc?.col ?? 0
  const locRecord = isRecord(nodeLoc) ? nodeLoc : null
  const file = String(getRecordField(locRecord, 'sourcefile') || getRecordField(getRecordField(locRecord, 'start'), 'sourcefile') || '')
  const key = `${file}:${line}:${col}:${calleeDottedPath}`
  const cached = _callAnchorIdCache.get(key)
  if (cached !== undefined) return cached
  let id: number
  if (ctx) {
    ctx.callAnchorIdSeq += 1
    id = ctx.callAnchorIdSeq
  } else {
    callAnchorIdSeq += 1
    id = callAnchorIdSeq
  }
  _callAnchorIdCache.set(key, id)
  return id
}

/** 记录 callgraph 条目 + call_args（从 runtime call 执行点触发）
 *
 * @param callExprValue 可选，若传入则为该 value 建 nodes 项并写入 return_node_id
 *                      （对标 runtime `markTaintSource(res, ...)` 在 executeCall 返回的 Unit 上）
 */
function recordCallgraphEntry(node: unknown, fclos: unknown, scope: unknown, callInfo?: unknown, callExprValue?: unknown): number | null {
  if (!_sqliteEnabled || !db) return null
  try {
    const nodeRecord = isRecord(node) ? node : null
    const fclosRecord = isRecord(fclos) ? fclos : null
    const callInfoRecord = isRecord(callInfo) ? callInfo : null
    const nodeLoc = nodeRecord ? getRecordField(nodeRecord, 'loc') : undefined
    const callLoc = extractLoc(nodeLoc)
    if (!callLoc) return null
    const rawCallFile = extractFileFromLoc(nodeLoc)
    const callFile = toProjectRelativePath(rawCallFile)
    const callLine = callLoc.line
    const callCol = callLoc.col ?? 0

    const callee = nodeRecord ? getRecordField(nodeRecord, 'callee') : undefined
    const calleeType = getRecordField(callee, 'type')
    const callexprType = typeof calleeType === 'string' ? calleeType : ''
    const callInfoCalleeKey = getRecordField(callInfoRecord, 'callgraphCalleeDottedPath')
    const calleeDottedPath = typeof callInfoCalleeKey === 'string' && callInfoCalleeKey.length > 0
      ? callInfoCalleeKey
      : (callee ? prettyPrint(callee) : '')
    const calleeNameField = getRecordField(callee, 'name')
    const calleeName = callexprType === 'Identifier' && typeof calleeNameField === 'string' ? calleeNameField : ''
    const callsiteLiteral = callee ? prettyPrint(callee) : calleeDottedPath

    const calleeVtype = getStringField(fclosRecord, 'vtype') || ''
    const calleeSid = getStringField(fclosRecord, 'sid') || ''
    const calleeQid = getStringField(fclosRecord, 'qid') || ''
    const calleeSymbolId = getStringField(fclosRecord, 'uuid')

    const fclosObject = getRecordField(fclosRecord, 'object')
    const fclosObjectRtype = getRecordField(fclosObject, 'rtype')
    const fclosRtype = getRecordField(fclosRecord, 'rtype')
    const fclosProperty = getRecordField(fclosRecord, 'property')
    const fclosPropertyName = getRecordField(fclosProperty, 'name')
    const calleeTypeObjectDefinite = stripQuotes(prettyPrint(getRecordField(fclosObjectRtype, 'definiteType')))
    const calleeTypeObjectVague = stripQuotes(prettyPrint(getRecordField(fclosObjectRtype, 'vagueType')))
    const calleeTypeRtypeDefinite = stripQuotes(prettyPrint(getRecordField(fclosRtype, 'definiteType')))
    const calleeTypeRtypeVague = stripQuotes(prettyPrint(getRecordField(fclosRtype, 'vagueType')))
    const calleeObjectRtype = stripQuotes(prettyPrint(fclosObjectRtype))
    const calleeRtype = stripQuotes(prettyPrint(fclosRtype))
    const calleeProperty = (typeof fclosPropertyName === 'string' ? fclosPropertyName : prettyPrint(fclosProperty)) || ''
    const calleePropertyPretty = prettyPrint(fclosProperty) || ''

    // callee 函数声明的返回类型注解（fdef.returnType）
    // Java/Go 等强类型语言有明确的返回类型声明（如 void/boolean/String），
    // 用于 source-matcher 的返回值类型过滤（boolean/void 返回值不携带 taint）
    const calleeFdefReturnType = extractFdefReturnType(fclos)
    const p0Facts = extractCallgraphP0Facts(fclos, scope, 'recordCallgraphEntry')
    writeSymbolFact(calleeSymbolId, fclos, 'recordCallgraphEntry')

    // arg_count：优先用 callInfo 的 explicit count，fallback 到 node.arguments.length
    let argCount: number | null = null
    const callArgs = getRecordField(callInfoRecord, 'callArgs')
    const callArgsArgs = getRecordField(callArgs, 'args')
    const nodeArguments = nodeRecord ? getRecordField(nodeRecord, 'arguments') : undefined
    if (Array.isArray(callArgsArgs)) {
      argCount = callArgsArgs.filter((a) => {
        const kind = getRecordField(a, 'kind')
        return kind !== 'spread' && kind !== 'kwspread'
      }).length
    } else if (Array.isArray(nodeArguments)) {
      argCount = nodeArguments.length
    }

    // 创建 call anchor ID（不物化到 nodes 表，仅作 callgraph/call_args group key）
    const callNodeId = ensureCallAnchorId(node, calleeDottedPath)
    // call 返回值节点（对标 runtime markTaintSource 打在 CallExprValue 上）：
    // 若调用方传入 callExprValue 则以其 loc/qid 为锚建节点
    const returnNodeId = callExprValue ? ensureNode(callExprValue) : null
    writeNodeTag(returnNodeId, 'call_result', calleeDottedPath || '<unknown>', 'recordCallgraphEntry')

    const ep = getCurrentEntryPoint()
    const _epIdCacheLocal = getCurrentWriterContext()?.epIdCache ?? epIdCache
    const epRowId = ep ? (_epIdCacheLocal.get(`${ep.filePath}:${ep.functionName}`) ?? null) : null
    requireStatement(stmtInsertCallgraph, 'stmtInsertCallgraph').run(
      ep?.filePath ?? '', ep?.functionName ?? '',
      p0Facts.callerQid,
      p0Facts.callerStartLine,
      p0Facts.callerEndLine,
      callFile, callLine, callCol,
      epRowId,
      callNodeId,
      returnNodeId,
      argCount,
      calleeVtype,
      callexprType,
      calleeName,
      calleeDottedPath,
      callsiteLiteral,
      calleeTypeObjectDefinite, calleeTypeObjectVague,
      calleeTypeRtypeDefinite, calleeTypeRtypeVague,
      calleeObjectRtype, calleeRtype,
      calleeSid, calleeProperty, calleePropertyPretty, calleeQid, calleeSymbolId,
      p0Facts.calleeStartLine,
      p0Facts.calleeEndLine,
      p0Facts.resolutionKind,
      p0Facts.confidence,
      p0Facts.provenance,
      calleeFdefReturnType
    )

    // 写 call_args：优先用 boundCall（能拿到 receiver / provided / paramIndex），fallback 用 callArgs
    if (callNodeId !== null) {
      writeCallArgs(callNodeId, callInfo)
    }

    const row = db.prepare(`
      SELECT id FROM callgraph
      WHERE caller_func = ?
        AND callee_dotted_path = ?
        AND call_site_file = ?
        AND call_site_line = ?
        AND (ep_id IS ? OR ep_id = ?)
      ORDER BY id DESC LIMIT 1
    `).get(ep?.functionName ?? '', calleeDottedPath, callFile, callLine, epRowId, epRowId) as { id?: number } | undefined

    const callgraphRowId = typeof row?.id === 'number' ? row.id : null

    // decl_use_impact_edges 把每条 callgraph entry 视图化为 changed_decl 到 use site 的边。
    // changed_decl = callee（被调函数）；consumer 接收 diff 后用 changed_qid/changed_file/changed_start/end
    // 去 IN 此表，直接得到使用方 ep_id 集合，避免回 callgraph 重新匹配。
    // 仅当解析到 ep 时记录；call_node_id / return_node_id 提供节点级跳点供后续证据扩展。
    if (callgraphRowId !== null && epRowId !== null) {
      const useKind = returnNodeId !== null ? 'call_with_return' : 'call_only'
      try {
        stmtInsertDeclUseImpactEdge?.run(
          epRowId,
          calleeSymbolId ?? null,
          calleeQid || null,
          p0Facts.calleeStartLine !== null ? toDbFile(extractFileFromLoc(getLocCandidate(fclos))) : null,
          p0Facts.calleeStartLine,
          p0Facts.calleeEndLine,
          callgraphRowId,
          callNodeId,
          returnNodeId,
          useKind,
          p0Facts.resolutionKind,
          p0Facts.confidence,
          'recordCallgraphEntry.decl_use_impact_edge'
        )
      } catch (_e) { /* 插桩不应影响正常分析流程 */ }
    }

    return callgraphRowId
  } catch (_e) {
    // 插桩不应影响正常分析流程
    return null
  }
}

/** 把 callInfo 的实参映射写入 call_args 表 */
function writeCallArgs(callNodeId: number, callInfo: unknown): void {
  if (!callInfo || !stmtInsertCallArg || _dbMode === 'incremental-facts') return
  const callInfoRecord = isRecord(callInfo) ? callInfo : null
  const boundCall = getRecordField(callInfoRecord, 'boundCall')
  const callArgs = getRecordField(callInfoRecord, 'callArgs')
  try {
    if (isRecord(boundCall) && Array.isArray(getRecordField(boundCall, 'params')) && (getRecordField(boundCall, 'params') as unknown[]).length > 0) {
      // boundCall 视角记录 formal_param，receiver 单独标记为 actual_arg。
      for (const bp of getRecordField(boundCall, 'params') as UnknownRecord[]) {
        if (bp?.provided !== true || bp.value === undefined) continue
        const argVal = bp.value
        const writeBoundArg = (v: unknown): void => {
          const argNodeId = ensureNode(v)
          if (argNodeId !== null) {
            requireStatement(stmtInsertCallArg, 'stmtInsertCallArg').run(callNodeId, typeof bp.index === 'number' ? bp.index : null, argNodeId, typeof bp.name === 'string' ? bp.name : null, 0, 1)
            writeNodeTag(argNodeId, 'formal_param', String(bp.index ?? ''), 'writeCallArgs.boundCall')
          }
        }
        if (Array.isArray(argVal)) {
          argVal.forEach((v: unknown) => writeBoundArg(v))
        } else {
          writeBoundArg(argVal)
        }
      }
      const receiver = getRecordField(boundCall, 'receiver')
      if (receiver) {
        const recvId = ensureNode(receiver)
        if (recvId !== null) {
          requireStatement(stmtInsertCallArg, 'stmtInsertCallArg').run(callNodeId, -1, recvId, null, 1, 1)
          writeNodeTag(recvId, 'actual_arg', 'receiver', 'writeCallArgs.receiver')
        }
      }
    } else if (isRecord(callArgs) && Array.isArray(getRecordField(callArgs, 'args'))) {
      // callArgs fallback 只能看到实际传入值，记录 actual_arg。
      for (const a of getRecordField(callArgs, 'args') as UnknownRecord[]) {
        const argNodeId = ensureNode(getRecordField(a, 'value'))
        if (argNodeId !== null) {
          requireStatement(stmtInsertCallArg, 'stmtInsertCallArg').run(
            callNodeId,
            typeof getRecordField(a, 'index') === 'number' ? getRecordField(a, 'index') as number : null,
            argNodeId,
            typeof getRecordField(a, 'name') === 'string' ? getRecordField(a, 'name') as string : null,
            0,
            1
          )
          writeNodeTag(argNodeId, 'actual_arg', String(getRecordField(a, 'index') ?? ''), 'writeCallArgs.callArgs')
        }
      }
      const callReceiver = getRecordField(callArgs, 'receiver')
      if (callReceiver) {
        const recvId = ensureNode(callReceiver)
        if (recvId !== null) {
          requireStatement(stmtInsertCallArg, 'stmtInsertCallArg').run(callNodeId, -1, recvId, null, 1, 1)
          writeNodeTag(recvId, 'actual_arg', 'receiver', 'writeCallArgs.callArgs')
        }
      }
    }
  } catch (_e) {
    // 插桩不应影响正常分析流程
  }
}


interface GoInterfaceBindingFact {
  callgraphId?: number | null
  callSiteFile?: string
  callSiteLine?: number | null
  callSiteCol?: number | null
  consumerEpId?: number | null
  interfaceQid?: string | null
  interfaceMethod?: string | null
  interfaceSignature?: string | null
  interfaceMethodFile?: string | null
  interfaceMethodStartLine?: number | null
  interfaceMethodEndLine?: number | null
  receiverStaticQid?: string | null
  implTypeQid?: string | null
  implMethodQid?: string | null
  implMethodFile?: string | null
  implMethodStartLine?: number | null
  implMethodEndLine?: number | null
  dispatchKind: string
  dispatchConfidence: number
  dispatchProvenance: string
}

interface HandlerResponseFlowFact {
  consumerEpId?: number | null
  handlerFile?: string
  handlerFunc?: string
  producerCallgraphId?: number | null
  producerCallNodeId?: number | null
  producerReturnNodeId?: number | null
  producerErrNodeId?: number | null
  producerResultNodeId?: number | null
  receiverCallgraphId?: number | null
  receiverCallNodeId?: number | null
  receiverNodeId?: number | null
  receiverMutationMethod?: string | null
  payloadCallgraphId?: number | null
  payloadCallNodeId?: number | null
  payloadNodeId?: number | null
  payloadSinkMethod: string
  orderingKind: string
  evidenceKind: string
  confidence: number
  provenance: string
}

interface ImpactPathProvenanceFact {
  consumerEpId?: number | null
  changedSymbolId?: string | null
  changedQid?: string | null
  changedNodeId?: number | null
  useSymbolId?: string | null
  useQid?: string | null
  useNodeId?: number | null
  callgraphId?: number | null
  callNodeId?: number | null
  returnNodeId?: number | null
  pathIndex?: number | null
  pathLength?: number | null
  pathEdgeIds?: Array<number | string> | string | null
  evidenceKind: string
  orderKind?: string | null
  confidence?: number | null
  provenance: string
}

interface ModuleDependencyFact {
  consumerEpId?: number | null
  consumerFile?: string
  consumerFunc?: string
  importSiteFile: string
  importSiteLine: number
  importPath: string
  importedFile: string
  importedPackage: string
  importedQidPrefix?: string | null
  depKind: string
  confidence: number
  provenance: string
}

interface MutatingReceiverAliasFact {
  consumerEpId?: number | null
  handlerFile?: string
  handlerFunc?: string
  callgraphId?: number | null
  callNodeId?: number | null
  callSiteFile?: string | null
  callSiteLine?: number | null
  callSiteCol?: number | null
  receiverNodeId?: number | null
  receiverQid?: string | null
  receiverVtype?: string | null
  receiverStaticType?: string | null
  mutationMethod: string
  methodQid?: string | null
  confidence: number
  provenance: string
}

interface DeclUseImpactEdgeFact {
  consumerEpId?: number | null
  changedSymbolId?: string | null
  changedQid?: string | null
  changedFile?: string | null
  changedStartLine?: number | null
  changedEndLine?: number | null
  callgraphId?: number | null
  callNodeId?: number | null
  returnNodeId?: number | null
  useKind: string
  resolutionKind?: string | null
  confidence: number
  provenance: string
}

function getCurrentEpRowId(): number | null {
  const ep = getCurrentEntryPoint()
  if (!ep) return null
  const ctx = getCurrentWriterContext()
  const _epIdCache = ctx ? ctx.epIdCache : epIdCache
  return _epIdCache.get(`${ep.filePath}:${ep.functionName}`) ?? null
}

function recordGoInterfaceBinding(fact: GoInterfaceBindingFact): void {
  if (!_sqliteEnabled || !db || !stmtInsertGoInterfaceBinding) return
  try {
    const epRowId = fact.consumerEpId ?? getCurrentEpRowId()
    const interfaceMethodFile = toDbFile(fact.interfaceMethodFile ?? '')
    const implMethodFile = toDbFile(fact.implMethodFile ?? '')
    stmtInsertGoInterfaceBinding.run(
      fact.callgraphId ?? null,
      toDbFile(fact.callSiteFile ?? ''),
      fact.callSiteLine ?? null,
      fact.callSiteCol ?? null,
      epRowId,
      fact.interfaceQid ?? null,
      interfaceMethodFile,
      fact.interfaceMethodStartLine ?? null,
      fact.interfaceMethodEndLine ?? null,
      fact.interfaceMethod ?? null,
      fact.interfaceSignature ?? null,
      fact.receiverStaticQid ?? null,
      fact.implTypeQid ?? null,
      fact.implMethodQid ?? null,
      implMethodFile,
      fact.implMethodStartLine ?? null,
      fact.implMethodEndLine ?? null,
      fact.dispatchKind,
      fact.dispatchConfidence,
      fact.dispatchProvenance
    )
    if (fact.callgraphId !== null && fact.callgraphId !== undefined && stmtUpdateCallgraphDispatch) {
      stmtUpdateCallgraphDispatch.run(
        fact.interfaceQid ?? null,
        fact.interfaceMethod ?? null,
        interfaceMethodFile,
        fact.interfaceMethodStartLine ?? null,
        fact.interfaceMethodEndLine ?? null,
        fact.interfaceSignature ?? null,
        fact.receiverStaticQid ?? null,
        fact.implTypeQid ?? null,
        fact.implMethodQid ?? null,
        implMethodFile,
        fact.implMethodStartLine ?? null,
        fact.implMethodEndLine ?? null,
        fact.dispatchKind,
        fact.dispatchConfidence,
        fact.dispatchProvenance,
        fact.callgraphId
      )
    }
  } catch (_e) { /* 插桩不应影响正常分析流程 */ }
}

function getCallgraphCallNodeId(callgraphId: number | null): number | null {
  if (!_sqliteEnabled || !db || callgraphId === null) return null
  try {
    const row = db.prepare('SELECT call_node_id FROM callgraph WHERE id = ?').get(callgraphId) as { call_node_id?: number | null } | undefined
    return typeof row?.call_node_id === 'number' ? row.call_node_id : null
  } catch (_e) {
    return null
  }
}

function recordHandlerResponseFlowFact(fact: HandlerResponseFlowFact): void {
  if (!_sqliteEnabled || !db || !stmtInsertHandlerResponseFlowFact) return
  try {
    const ep = getCurrentEntryPoint()
    const epRowId = fact.consumerEpId ?? getCurrentEpRowId()
    if (epRowId === null) return
    stmtInsertHandlerResponseFlowFact.run(
      epRowId,
      toDbFile(fact.handlerFile ?? ep?.filePath ?? ''),
      fact.handlerFunc ?? ep?.functionName ?? '',
      fact.producerCallgraphId ?? null,
      fact.producerCallNodeId ?? null,
      fact.producerReturnNodeId ?? null,
      fact.producerErrNodeId ?? null,
      fact.producerResultNodeId ?? null,
      fact.receiverCallgraphId ?? null,
      fact.receiverCallNodeId ?? null,
      fact.receiverNodeId ?? null,
      fact.receiverMutationMethod ?? null,
      fact.payloadCallgraphId ?? null,
      fact.payloadCallNodeId ?? null,
      fact.payloadNodeId ?? null,
      fact.payloadSinkMethod,
      fact.orderingKind,
      fact.evidenceKind,
      fact.confidence,
      fact.provenance
    )
  } catch (_e) { /* 插桩不应影响正常分析流程 */ }
}

function serializePathEdgeIds(pathEdgeIds: ImpactPathProvenanceFact['pathEdgeIds']): string | null {
  if (pathEdgeIds === null || pathEdgeIds === undefined) return null
  return Array.isArray(pathEdgeIds) ? JSON.stringify(pathEdgeIds) : pathEdgeIds
}

function recordImpactPathProvenance(fact: ImpactPathProvenanceFact): void {
  if (!_sqliteEnabled || !db || !stmtInsertImpactPathProvenance) return
  try {
    stmtInsertImpactPathProvenance.run(
      fact.consumerEpId ?? getCurrentEpRowId(),
      fact.changedSymbolId ?? null,
      fact.changedQid ?? null,
      fact.changedNodeId ?? null,
      fact.useSymbolId ?? null,
      fact.useQid ?? null,
      fact.useNodeId ?? null,
      fact.callgraphId ?? null,
      fact.callNodeId ?? null,
      fact.returnNodeId ?? null,
      fact.pathIndex ?? null,
      fact.pathLength ?? null,
      serializePathEdgeIds(fact.pathEdgeIds),
      fact.evidenceKind,
      fact.orderKind ?? null,
      fact.confidence ?? null,
      fact.provenance
    )
  } catch (_e) { /* 插桩不应影响正常分析流程 */ }
}

function recordCallPathProvenance(callgraphId: number | null, evidenceKind: string, confidence?: number, provenance?: string): void {
  if (!_sqliteEnabled || !db || callgraphId === null) return
  try {
    const row = db.prepare(`
      SELECT ep_id, call_node_id, return_node_id, callee_symbol_id, callee_qid, resolution_kind, confidence AS call_confidence
      FROM callgraph WHERE id = ?
    `).get(callgraphId) as {
      ep_id?: number | null
      call_node_id?: number | null
      return_node_id?: number | null
      callee_symbol_id?: string | null
      callee_qid?: string | null
      resolution_kind?: string | null
      call_confidence?: number | null
    } | undefined
    if (!row) return
    recordImpactPathProvenance({
      consumerEpId: row.ep_id ?? null,
      changedSymbolId: row.callee_symbol_id ?? null,
      changedQid: row.callee_qid ?? null,
      useSymbolId: row.callee_symbol_id ?? null,
      useQid: row.callee_qid ?? null,
      callgraphId,
      callNodeId: row.call_node_id ?? null,
      returnNodeId: row.return_node_id ?? null,
      pathIndex: 0,
      pathLength: 1,
      pathEdgeIds: callgraphId !== null ? [callgraphId] : null,
      evidenceKind,
      orderKind: row.resolution_kind ?? null,
      confidence: confidence ?? row.call_confidence ?? null,
      provenance: provenance ?? 'recordCallPathProvenance',
    })
  } catch (_e) { /* 插桩不应影响正常分析流程 */ }
}

function recordModuleDependency(fact: ModuleDependencyFact): void {
  if (!_sqliteEnabled || !db || !stmtInsertModuleDep) return
  try {
    const ep = getCurrentEntryPoint()
    const epRowId = fact.consumerEpId ?? getCurrentEpRowId()
    if (epRowId === null) return
    stmtInsertModuleDep.run(
      epRowId,
      fact.consumerFile ?? ep?.filePath ?? '',
      fact.consumerFunc ?? ep?.functionName ?? '',
      toDbFile(fact.importSiteFile),
      fact.importSiteLine,
      fact.importPath,
      toDbFile(fact.importedFile),
      fact.importedPackage,
      fact.importedQidPrefix ?? null,
      fact.depKind,
      fact.confidence,
      fact.provenance
    )
  } catch (_e) { /* 插桩不应影响正常分析流程 */ }
}

// receiver mutating call 的显式 producer 事实。
// 与 handler_response_flow 互补：HRF 需要 producer/receiver/payload 三连成功落地才记录，
// 这里只要看到 receiver mutating prefix（Set/Append/...）就独立记录，扩展精度证据覆盖面。
function recordMutatingReceiverAlias(fact: MutatingReceiverAliasFact): void {
  if (!_sqliteEnabled || !db || !stmtInsertMutatingReceiverAlias) return
  try {
    const ep = getCurrentEntryPoint()
    const epRowId = fact.consumerEpId ?? getCurrentEpRowId()
    if (epRowId === null) return
    stmtInsertMutatingReceiverAlias.run(
      epRowId,
      toDbFile(fact.handlerFile ?? ep?.filePath ?? ''),
      fact.handlerFunc ?? ep?.functionName ?? '',
      fact.callgraphId ?? null,
      fact.callNodeId ?? null,
      fact.callSiteFile != null ? toDbFile(fact.callSiteFile) : null,
      fact.callSiteLine ?? null,
      fact.callSiteCol ?? null,
      fact.receiverNodeId ?? null,
      fact.receiverQid ?? null,
      fact.receiverVtype ?? null,
      fact.receiverStaticType ?? null,
      fact.mutationMethod,
      fact.methodQid ?? null,
      fact.confidence,
      fact.provenance
    )
  } catch (_e) { /* 插桩不应影响正常分析流程 */ }
}

// decl-use impact edge fact 把 callgraph 行视图化为 changed_decl 到 use site 的边。
// 由 recordCallgraphEntry 在写完 callgraph 后追加；changed_decl = callee_symbol_id/qid（被调函数），
// use_node = call_node_id（调用点）/ return_node_id（返回值）。用作 consumer 跨 EP 直接证据。
function recordDeclUseImpactEdge(fact: DeclUseImpactEdgeFact): void {
  if (!_sqliteEnabled || !db || !stmtInsertDeclUseImpactEdge) return
  try {
    const epRowId = fact.consumerEpId ?? getCurrentEpRowId()
    if (epRowId === null) return
    stmtInsertDeclUseImpactEdge.run(
      epRowId,
      fact.changedSymbolId ?? null,
      fact.changedQid ?? null,
      fact.changedFile != null ? toDbFile(fact.changedFile) : null,
      fact.changedStartLine ?? null,
      fact.changedEndLine ?? null,
      fact.callgraphId ?? null,
      fact.callNodeId ?? null,
      fact.returnNodeId ?? null,
      fact.useKind,
      fact.resolutionKind ?? null,
      fact.confidence,
      fact.provenance
    )
  } catch (_e) { /* 插桩不应影响正常分析流程 */ }
}

/** 记录 entrypoint 参数节点，同时写入 builtin_sources 确保离线可匹配 */
function recordEpParam(val: unknown, epId: string, framework: string, paramIndex?: number, sourceLoc?: unknown): void {
  if (!_sqliteEnabled || !db) return
  const nodeId = ensureNode(val)
  if (nodeId === null) return
  updateNodeMetadata(nodeId, { nodeRole: 'param' })
  recordBuiltinSource(val, epId, framework, 'BuiltinEpParam', paramIndex, sourceLoc)
}

/** 获取 SQLite 统计信息 */
function getSqliteStats(): {
  nodes: number; edges: number
  insertNodeTimeMs: number; insertEdgeTimeMs: number
  insertNodeCount: number; insertEdgeCount: number
  selfEdgeFiltered: number; edgeDedupFiltered: number; incrementalEdgeSkipped: number
  dbMode: DataflowDbMode
  sourceProbeSkipped: number
} | null {
  if (!_sqliteEnabled || !db) return null
  // 确保缓冲已全部写入
  flushEdgeBuffer()
  return {
    nodes: countRows('SELECT COUNT(*) AS c FROM nodes'),
    edges: countRows('SELECT COUNT(*) AS c FROM edges'),
    insertNodeTimeMs: Math.round(insertNodeTimeMs),
    insertEdgeTimeMs: Math.round(insertEdgeTimeMs),
    insertNodeCount,
    insertEdgeCount,
    selfEdgeFiltered,
    edgeDedupFiltered,
    incrementalEdgeSkipped,
    dbMode: _dbMode,
    sourceProbeSkipped,
  }
}

/** 关闭 SQLite 连接 */
function closeSqlite(): void {
  if (!db) return
  let closeError: unknown = null
  try {
    // flush 剩余边缓冲
    flushEdgeBuffer()
    // Lazy slot materialization 统计（从 unit-audit.ts 获取）
    let lazyStats: { buffered: number; flushed: number; discarded: number } | null = null
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getLazySlotStats } = require('./value/unit-audit')
      lazyStats = getLazySlotStats()
    } catch (_e) { /* 模块加载失败时静默 */ }
    if (lazyStats && (lazyStats.buffered > 0 || lazyStats.flushed > 0)) {
      console.log('\n=== Lazy slot_bind 统计 ===')
      console.log(`  缓存: ${lazyStats.buffered.toLocaleString()} 次`)
      console.log(`  flush（下游消费）: ${lazyStats.flushed.toLocaleString()} 次`)
      console.log(`  丢弃（dead-end）: ${lazyStats.discarded.toLocaleString()} 次`)
      console.log('=== Lazy slot_bind 结束 ===\n')
    }
    commitDataflowDbTransaction('final', 'closed')
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_loc_key ON nodes(loc_key);
      CREATE INDEX IF NOT EXISTS idx_nodes_member_access ON nodes(class_name, property_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_owner ON nodes(owner_func_fsig, param_index);
      CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file, line);
      CREATE INDEX IF NOT EXISTS idx_nodes_callsite ON nodes(callsite_id);
      CREATE INDEX IF NOT EXISTS idx_callgraph_callsite ON callgraph(call_site_file, call_site_line);
      CREATE INDEX IF NOT EXISTS idx_callgraph_caller ON callgraph(caller_file, caller_func);
      CREATE INDEX IF NOT EXISTS idx_callgraph_call_node ON callgraph(call_node_id);
      CREATE INDEX IF NOT EXISTS idx_callgraph_return_node ON callgraph(return_node_id);
      CREATE INDEX IF NOT EXISTS idx_callgraph_callee_dotted ON callgraph(callee_dotted_path);
      CREATE INDEX IF NOT EXISTS idx_call_args_call ON call_args(call_node_id);
      CREATE INDEX IF NOT EXISTS idx_call_args_arg ON call_args(arg_node_id);
    `)
  } catch (e) {
    closeError = e
    if (sqliteWriteTransactionOpen) {
      try { db.exec('ROLLBACK') } catch (_rollbackError) { /* 保留原始关闭错误 */ }
      sqliteWriteTransactionOpen = false
    }
  } finally {
    try { db.close() } catch (e) { if (!closeError) closeError = e }
    db = null
    _beforeEdgeHook = null
    stmtInsertNode = null
    stmtInsertEdge = null
    stmtUpdateNodeMetadata = null
    stmtInsertEntrypoint = null
    stmtGetEntrypointId = null
    stmtInsertBuiltinSource = null
    stmtInsertCallgraph = null
    stmtUpdateCallgraphDispatch = null
    stmtInsertCallArg = null
    stmtInsertSymbol = null
    stmtInsertSourceFile = null
    stmtUpsertMetadata = null
    stmtSelectNodeByFields = null
    stmtInsertGoInterfaceBinding = null
    stmtInsertModuleDep = null
    stmtInsertNodeTag = null
    stmtInsertHandlerResponseFlowFact = null
    stmtInsertImpactPathProvenance = null
    stmtInsertMutatingReceiverAlias = null
    stmtInsertDeclUseImpactEdge = null
    sqliteWriteTransactionOpen = false
    nodeIdCache.clear()
    stringNodeCache.clear()
    filePathCache.clear()
    qidUnifiedCache.clear()
    edgeDedupMap.clear()
    edgeTypeIdMap.clear()
    nextEdgeTypeId = 1
    epIdCache.clear()
    callAnchorIdCache.clear()
    callAnchorIdSeq = 0
    insertNodeTimeMs = 0
    insertEdgeTimeMs = 0
    insertNodeCount = 0
    insertEdgeCount = 0
    selfEdgeFiltered = 0
    edgeDedupFiltered = 0
    incrementalEdgeSkipped = 0
    _sqliteEnabled = false
    _dbMode = 'full'
    sourceProbeSkipped = 0
    sqliteFatalError = null
  }
  if (closeError) throw closeError
}

/** 重置统计（测试用） */
function resetEdgeStats(): void {}


/**
 * 查已有 nodeId（不创建新节点）。
 * 只查节点缓存 + SELECT，不 INSERT。用于 var_assign 等不应改变 nodeId 分配的场景。
 */
function tryGetExistingNodeId(val: unknown): number | null {
  if (!val || !db) return null
  const valueRecord = asDataflowValue(val)
  const astLoc = valueRecord?.ast?.node?.loc
  const fallbackLoc = valueRecord?.loc
  const locSource = (getRecordField(astLoc, 'start') || Array.isArray(astLoc)) ? astLoc : fallbackLoc
  const loc = extractLoc(locSource)
  const line = loc?.line ?? 0
  const col = loc?.col ?? 0
  const qid = valueRecord?.qid || valueRecord?._qid || 'unknown'
  const astLocRecord = isRecord(valueRecord?.ast?.node?.loc) ? valueRecord?.ast?.node?.loc : null
  const fallbackLocRecord = isRecord(valueRecord?.loc) ? valueRecord?.loc : null
  const file = String(
    getRecordField(astLocRecord, 'sourcefile')
    || getRecordField(getRecordField(astLocRecord, 'start'), 'sourcefile')
    || getRecordField(fallbackLocRecord, 'sourcefile')
    || getRecordField(getRecordField(fallbackLocRecord, 'start'), 'sourcefile')
    || ''
  )
  const fileForDb = toProjectRelativePath(file)
  const locKeyInt = locKeyHash([file, line, col, qid])

  const ctxLookup = getCurrentWriterContext()
  const _epIdCacheLookup = ctxLookup ? ctxLookup.epIdCache : epIdCache
  const ep = getCurrentEntryPoint()
  const epText = ep ? `${ep.filePath}:${ep.functionName}` : null
  const epRowId = epText ? (_epIdCacheLookup.get(epText) ?? null) : null
  const callsiteId: string | null = typeof valueRecord?._callsite === 'string' ? valueRecord._callsite : null
  const qidUnified = getQidUnified(qid)
  const sid = valueRecord?.sid ?? null
  const astName = valueRecord?.sid ?? valueRecord?.ast?.node?.name ?? null
  const lookupFields: NodeLookupFields = {
    locKeyInt,
    fileForDb,
    line,
    col,
    nodeRole: 'value',
    qid,
    qidUnified,
    sid,
    className: null,
    propertyPath: null,
    astName,
    ownerFuncFsig: null,
    paramIndex: null,
    epRowId,
    callsiteId,
  }
  const lookupKey = buildNodeLookupKey(lookupFields)

  const _nodeIdCacheLookup = ctxLookup ? ctxLookup.nodeIdCache : nodeIdCache
  const cached = _nodeIdCacheLookup.get(lookupKey)
  if (cached !== undefined) return cached

  const nodeId = selectNodeByFields(lookupFields)
  if (nodeId !== null) {
    _nodeIdCacheLookup.set(lookupKey, nodeId)
    return nodeId
  }
  return null
}

/**
 * 记录一条数据流边（通过 node_id）
 * @param fromId 起点 node_id
 * @param toId 终点 node_id
 * @param edgeType 边类型
 */
function recordEdgeByNodeId(fromId: number, toId: number, edgeType: string, metadata?: EdgeProvenanceMetadata): void {
  if (!_sqliteEnabled || !db) return
  ensureDataflowDbWritable()
  const ctx = getCurrentWriterContext()
  if (!shouldRecordEdgeInCurrentMode(edgeType)) {
    if (ctx) ctx.incrementalEdgeSkipped++; else incrementalEdgeSkipped++
    return
  }

  // COW 合并后同源值映射到同一 node_id → 自环，跳过
  if (fromId === toId) {
    if (ctx) ctx.selfEdgeFiltered++; else selfEdgeFiltered++
    return
  }

  // 对标 runtime 每 EP 独立执行一次完整分析：dedup 按 ep 维度，同边在不同 EP 各记一份
  const _epIdCache = ctx ? ctx.epIdCache : epIdCache
  const _edgeDedupMap = ctx ? ctx.edgeDedupMap : edgeDedupMap
  const _edgeTypeIdMap = ctx ? ctx.edgeTypeIdMap : edgeTypeIdMap
  const _edgeBuffer = ctx ? ctx.edgeBuffer : edgeBuffer
  const ep = getCurrentEntryPoint()
  const epText = ep ? `${ep.filePath}:${ep.functionName}` : 'default'
  const epRowId = _epIdCache.get(epText) ?? null
  if (hasOrAddEdgeDedupWith(_edgeDedupMap, _edgeTypeIdMap, ctx, fromId, toId, edgeType, epRowId)) {
    if (ctx) ctx.edgeDedupFiltered++; else edgeDedupFiltered++
    return
  }

  _edgeBuffer.push([fromId, toId, edgeType, epRowId, ...provenanceRow(metadata ?? defaultEdgeMetadata(edgeType))])
  if (_edgeBuffer.length >= EDGE_BATCH_SIZE) {
    flushEdgeBufferFrom(_edgeBuffer)
  }
}

/** 记录 entrypoint 信息 */
function recordEntrypoint(ep: { filePath: string; functionName: string; attribute?: string; framework?: string }): void {
  if (!_sqliteEnabled || !db) return
  ensureDataflowDbWritable()
  const ctx = getCurrentWriterContext()
  const _epIdCache = ctx ? ctx.epIdCache : epIdCache
  const loc = getCurrentEntryPoint()
  const startLine = loc?.entryPointSymVal?.ast?.node?.loc?.start?.line ?? 0
  const endLine = loc?.entryPointSymVal?.ast?.node?.loc?.end?.line ?? 0
  const epId = `${ep.filePath}:${ep.functionName}`
  requireStatement(stmtInsertEntrypoint, 'stmtInsertEntrypoint').run(
    epId, ep.filePath, ep.functionName,
    startLine, endLine,
    loc?.type ?? '',
    ep.framework ?? '',
    ep.attribute ?? ''
  )
  const row = requireStatement(stmtGetEntrypointId, 'stmtGetEntrypointId').get(epId) as { id: number } | undefined
  if (row) _epIdCache.set(epId, row.id)
}

/** 批量写入源文件内容（文件粒度，支持增量替换） */
function recordSourceFiles(files: Map<string, string> | Record<string, string>): void {
  if (!_sqliteEnabled || !db) return
  const fs = require('fs')
  const entries = files instanceof Map ? files.entries() : Object.entries(files)
  const insert = db.transaction((rows: Array<[string, string]>) => {
    for (const [filePath, content] of rows) {
      requireStatement(stmtInsertSourceFile, 'stmtInsertSourceFile').run(filePath, content)
    }
  })
  const batch: Array<[string, string]> = []
  for (const [filePath, content] of entries) {
    if (typeof content === 'string') {
      batch.push([filePath, content])
    } else {
      // content 为 undefined 时从磁盘读
      try {
        batch.push([filePath, fs.readFileSync(filePath, 'utf8')])
      } catch (_e) { /* ignore */ }
    }
  }
  if (batch.length > 0) insert(batch)
}

/**
 * 从 dumpGraph() 结果批量写入完整调用图（与 callgraph-output-strategy 同时机）
 * cgOrGraph 支持两种格式：
 *   - dumpGraph() 结果：{ nodes: Record, edges: Record }（edges 值含 sourceNodeId/targetNodeId/callSite）
 *   - ainfo.callgraph（Graph 对象）：{ edges: Map }（边值含 sourceNodeId/targetNodeId/opts.callSite）
 */
function recordFullCallgraph(cgOrGraph: unknown, _astManager?: unknown, _symbolTable?: unknown): void {
  if (!_sqliteEnabled || !db) return
  const graphRecord = isRecord(cgOrGraph) ? cgOrGraph : null
  const edges = getRecordField(graphRecord, 'edges')
  if (!edges) return
  // dumpGraph 结果是 Record（Object），ainfo.callgraph 是 Map
  const edgeValues = isRecord(edges) && typeof getRecordField(edges, 'values') === 'function'
    ? (getRecordField(edges, 'values') as () => Iterable<unknown>)()
    : Object.values(edges as Record<string, unknown>)
  for (const edge of edgeValues) {
    try {
      const edgeRecord = isRecord(edge) ? edge : null
      const optsRecord = getRecordField(edgeRecord, 'opts')
      const callSite = getRecordField(edgeRecord, 'callSite') || getRecordField(optsRecord, 'callSite')
      const callSiteRecord = isRecord(callSite) ? callSite : null
      const callSiteLoc = getRecordField(callSiteRecord, 'loc')
      const locRecord = isRecord(callSiteLoc) ? callSiteLoc : null
      const startRecord = getRecordField(locRecord, 'start')
      const callSiteFile = toDbFile(extractFileFromLoc(callSiteLoc))
      const startLine = getRecordField(startRecord, 'line')
      const startCol = getRecordField(startRecord, 'col')
      const callSiteLine = typeof startLine === 'number' ? startLine : 0
      const callSiteCol = typeof startCol === 'number' ? startCol : null
      const calleeDotted = prettyPrint(getRecordField(callSiteRecord, 'callee')) || ''
      requireStatement(stmtInsertCallgraph, 'stmtInsertCallgraph').run(
        '', '', null, null, null,
        callSiteFile, callSiteLine, callSiteCol,
        null, null, null,
        null, '', '', '',
        calleeDotted, calleeDotted,
        '', '', '', '',
        '', '',
        '', '', '', '', null,
        null, null, 'full_callgraph_fallback', 30, 'recordFullCallgraph', ''
      )
    } catch (_e) { /* ignore */ }
  }
}

/** 记录 builtin source，sourceLoc 是 markTaintSource 的 path.loc（标记位置） */
function recordBuiltinSource(val: unknown, epId: string, framework: string, sourceType: string, paramIndex?: number, sourceLoc?: unknown): void {
  if (!_sqliteEnabled || !db) return
  const nodeId = ensureNode(val)
  if (nodeId === null) return
  const loc = extractLoc(sourceLoc)
  const sourceLocRecord = isRecord(sourceLoc) ? sourceLoc : null
  const rawFile = String(getRecordField(sourceLocRecord, 'sourcefile') || getRecordField(getRecordField(sourceLocRecord, 'start'), 'sourcefile') || '')
  const file = toProjectRelativePath(rawFile)
  requireStatement(stmtInsertBuiltinSource, 'stmtInsertBuiltinSource').run(nodeId, epId, framework, sourceType, paramIndex ?? null, file, loc?.line ?? 0, loc?.col ?? 0)
}

/** 更新 callgraph.return_node_id 为 runtime 真实 res 的节点 id
 *
 * 对标 runtime 在 executeCall 后的 `res`：checkAtFunctionCallAfter 收到 ret=res，
 * `markTaintSource(res, ...)` 打 taint。离线 BFS 起点必须是 ensureNode(res) 的节点。
 *
 * 查 callgraph 条目用 (caller_func, callee_dotted_path, call_site_file, call_site_line, ep_id)
 * —— 这组是 callgraph 的 UNIQUE 约束字段。
 */
function updateCallgraphReturnNode(node: unknown, res: unknown, _fclos?: unknown): void {
  if (!_sqliteEnabled || !db || !res) return
  try {
    const nodeRecord = isRecord(node) ? node : null
    const nodeLoc = getRecordField(nodeRecord, 'loc')
    const callLoc = extractLoc(nodeLoc)
    if (!callLoc) return
    const nodeLocRecord = isRecord(nodeLoc) ? nodeLoc : null
    const rawCallFile = String(getRecordField(nodeLocRecord, 'sourcefile') || getRecordField(getRecordField(nodeLocRecord, 'start'), 'sourcefile') || '')
    const callFile = toProjectRelativePath(rawCallFile)
    const callLine = callLoc.line
    const callee = getRecordField(nodeRecord, 'callee')
    const calleeDottedPath = callee ? prettyPrint(callee) : ''
    const ep = getCurrentEntryPoint()
    const _epIdCacheRet = getCurrentWriterContext()?.epIdCache ?? epIdCache
    const epRowId = ep ? (_epIdCacheRet.get(`${ep.filePath}:${ep.functionName}`) ?? null) : null
    const callerFunc = ep?.functionName ?? ''

    const returnNodeId = ensureNode(res)
    if (returnNodeId === null) return
    writeNodeTag(returnNodeId, 'call_result', calleeDottedPath || '<unknown>', 'updateCallgraphReturnNode')

    db.prepare(`
      UPDATE callgraph SET return_node_id = ?
      WHERE caller_func = ?
        AND callee_dotted_path = ?
        AND call_site_file = ?
        AND call_site_line = ?
        AND (ep_id IS ? OR ep_id = ?)
        AND (return_node_id IS NULL OR return_node_id = ?)
    `).run(returnNodeId, callerFunc, calleeDottedPath, callFile, callLine, epRowId, epRowId, returnNodeId)
  } catch (_e) {
    // 插桩不应影响正常分析流程
  }
}

/** 按 callgraph.id 直更 return_node_id（不依赖 UNIQUE 列匹配）。
 *
 * 适用场景：Go interface CHA dispatch 写 callgraph 时使用了
 * `callgraphCalleeDottedPath = 'go-interface-dispatch:${implKey}'`，
 * 普通的 updateCallgraphReturnNode 用 `prettyPrint(callee)` (接口方法 qid)
 * 查不到这些行 —— 必须按已知 callgraph_id 直接 UPDATE。
 */
function updateCallgraphReturnNodeById(callgraphId: number | null, res: unknown, calleeDottedPath?: string): void {
  if (!_sqliteEnabled || !db || callgraphId == null || !res) return
  try {
    const returnNodeId = ensureNode(res)
    if (returnNodeId === null) return
    const tagValue = (typeof calleeDottedPath === 'string' && calleeDottedPath.length > 0)
      ? calleeDottedPath
      : '<unknown>'
    writeNodeTag(returnNodeId, 'call_result', tagValue, 'updateCallgraphReturnNodeById')
    db.prepare(`
      UPDATE callgraph SET return_node_id = ?
      WHERE id = ?
        AND (return_node_id IS NULL OR return_node_id = ?)
    `).run(returnNodeId, callgraphId, returnNodeId)
  } catch (_e) {
    // 插桩不影响正常分析
  }
}

/** 为 Python call 节点补 `return` 出边：已废弃。
 *
 * 历史：原实现通过 ensureCallNode 物化 call 节点 + 写 call→return_value 边。
 * 但 call 节点 incoming=0（无任何代码把 call_node 写入 to_node_id），BFS 永远到不了，
 * 这条 return 边是死边。call 节点 lazy 物化后此函数已无意义。保留空实现避免外部调用方报错。
 */
function recordCallReturnEdge(_node: unknown, _res: unknown, _fclos?: unknown): void {
  // no-op: call 节点不再物化，本边已废弃
}

module.exports = {
  getValueId,
  recordEdge,
  recordEdgeByNodeId,
  recordIsTaintedRecQuery,
  resetEdgeStats,
  enableDataflowDb,
  initSqlite,
  ensureNode,
  updateNodeMetadata,
  writeNodeTag,
  recordNodeTag,
  incSourceProbeSkipped,
  updateNodeFile,
  recordCallgraphEntry,
  recordGoInterfaceBinding,
  getCallgraphCallNodeId,
  recordHandlerResponseFlowFact,
  recordImpactPathProvenance,
  recordCallPathProvenance,
  recordModuleDependency,
  recordMutatingReceiverAlias,
  recordDeclUseImpactEdge,
  updateCallgraphReturnNode,
  updateCallgraphReturnNodeById,
  recordCallReturnEdge,
  recordEpParam,
  tryGetExistingNodeId,
  getSqliteStats,
  recordEntrypoint,
  recordBuiltinSource,
  recordSourceFiles,
  recordFullCallgraph,
  setBeforeEdgeHook,
  getBeforeEdgeHook,
  flushEdgeBufferFrom,
  aggregateContextStats,
  getDataflowDbRuntimeState,
  flushDataflowDbPendingWrites,
  commitDataflowDbTransaction,
  reopenDataflowDbWriteTransaction,
  getDataflowDbQueryMetadata,
  queryOpenDataflowDb,
  queryClosedDataflowDb,
  closeSqlite,
}

// 用 getter 暴露 runtime flag，让外部 `const { SQLITE_ENABLED } = require(...)`
// 在函数内每次执行时都拿到最新值；module 顶部一次性 destructure 仍会拿到 module-load 时的值（false），
// 此类位置已重构为函数内 require（见 source-util.ts）。
Object.defineProperty(module.exports, 'SQLITE_ENABLED', { get: () => _sqliteEnabled, enumerable: true })
Object.defineProperty(module.exports, 'ENABLED', { get: () => _sqliteEnabled, enumerable: true })
