// Unit 层事件 hook（v5 event-driven SSA 核心）
// 6 hook 点统一通过本模块分发：
//   - clone / cloneAlias（Unit.clone / ValueBase.clone / Unit.cloneAlias）
//   - instance_new（clone-util.buildNewValueInstance 出口）
//   - slot_bind（ValueRefMap.set 入口）
//   - bvt_set（memStateBVT writeValueBVT 内部 setChild）
//
// 双轨：
//   - recordEdge 写入 dataflow.db。
//   - audit.jsonl 仅用于离线对账。

import * as fs from 'fs'

const Config = require('../../../../config')

type UnknownRecord = Record<string, unknown>
interface DataflowValueLike extends UnknownRecord {
  ast?: { node?: { loc?: unknown }; [key: string]: unknown }
  loc?: unknown
  qid?: string
  _qid?: string
}
interface DataflowAuditModule {
  SQLITE_ENABLED: boolean
  ENABLED: boolean
  getValueId(v: unknown): number
  recordEdge(from: unknown, to: unknown, edgeType: string): void
}
interface AuditRecord extends UnknownRecord { event: string }

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object'
}

function asDataflowValue(value: unknown): DataflowValueLike | null {
  return isRecord(value) ? value as DataflowValueLike : null
}

function getRecordField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

const UNIT_AUDIT_ENABLED = !!process.env.YASA_UNIT_AUDIT
const AUDIT_PATH = process.env.YASA_UNIT_AUDIT_PATH || '/tmp/dataflow-unit-audit.jsonl'

// 延迟加载 dataflow-edge-stats（避免循环依赖）
let _dfMod: DataflowAuditModule | null = null
let _modLoaded = false
function loadDataflowModule(): void {
  if (_modLoaded) return
  _modLoaded = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _dfMod = require('../dataflow-edge-stats') as DataflowAuditModule
  } catch (_e) {
    _dfMod = null
  }
}

function getValueIdLazy(v: unknown): number {
  loadDataflowModule()
  if (!_dfMod?.getValueId) return 0
  return _dfMod.getValueId(v)
}

/** 写 recordEdge；失败静默不阻塞原逻辑。
 *  非 slot_bind 边写入前，先 flush from 上缓存的 slot_bind 事件（lazy slot materialization）。
 */
function safeRecordEdge(from: unknown, to: unknown, edgeType: string): void {
  // 非 slot_bind 边：from 产生出边，flush 其缓存的 slot_bind
  if (edgeType !== 'slot_bind') {
    flushPendingSlotBinds(from)
  }
  loadDataflowModule()
  if (!_dfMod?.recordEdge) return
  // 用 getter 读取最新 flag，避免 module load 时冻结 false
  if (!_dfMod.SQLITE_ENABLED && !_dfMod.ENABLED) return
  try {
    _dfMod.recordEdge(from, to, edgeType)
  } catch (_e) {
    // 插桩失败不影响分析
  }
}

function extractLoc(loc: unknown): { line: number; col: number } | null {
  if (!loc) return null
  if (isRecord(loc)) {
    const start = getRecordField(loc, 'start')
    const line = getRecordField(start, 'line')
    const column = getRecordField(start, 'column')
    if (typeof line === 'number') return { line, col: typeof column === 'number' ? column : 0 }
  }
  if (Array.isArray(loc) && loc.length >= 2) {
    return { line: loc[0], col: loc[1] }
  }
  return null
}

function computeLocKey(val: unknown): string {
  if (!val) return 'unknown:0:0:unknown:v0'
  const dataflowVal = asDataflowValue(val)
  const loc = extractLoc(dataflowVal?.ast?.node?.loc)
  const line = loc?.line ?? 0
  const col = loc?.col ?? 0
  const qid = dataflowVal?.qid || dataflowVal?._qid || 'unknown'
  const locRecord = isRecord(dataflowVal?.ast?.node?.loc) ? dataflowVal?.ast?.node?.loc : null
  const file = String(getRecordField(locRecord, 'sourcefile') || getRecordField(getRecordField(locRecord, 'start'), 'sourcefile') || '')
  const vid = getValueIdLazy(val)
  return `${file}:${line}:${col}:${qid}:v${vid}`
}

function captureCallsite(): string[] {
  const stack = new Error().stack
  if (!stack) return []
  const lines = stack.split('\n')
  const frames = lines.slice(3, 8)
  const out: string[] = []
  for (const f of frames) {
    const m = f.match(/at\s+(?:.+?\s+\()?([^()\s]+):(\d+):(\d+)/)
    if (m) {
      const file = m[1]
      const short = file.includes('/src/') ? 'src/' + file.split('/src/').pop() : file.split('/').slice(-2).join('/')
      out.push(`${short}:${m[2]}`)
    }
    if (out.length >= 3) break
  }
  return out
}

// ===== Lazy slot materialization =====
// slot_bind 边延迟写入：auditSlotBindEvent 缓存事件，当 ownerUnit 产生出边时才 flush。
// dead-end slot（ownerUnit 无出边）在 Phase 结束时丢弃，避免写入无效边。
// 根因：runtime 在 ValueRefMap.set() 时无条件调用 auditSlotBindEvent → 写入 slot_bind 边 + 物化 slot 节点，
// 但 93,565 条边（15.2%）的 slot 值根本没被读，99.94% 与 taint source 断链。
// key = ownerUnit 对象，value = 该 slot 上待 flush 的 slot_bind 事件列表
const pendingSlotBinds = new WeakMap<object, Array<{ value: unknown; ownerUnit: object }>>()
let lazySlotBindBuffered = 0   // 缓存次数（set 触发）
let lazySlotBindFlushed = 0    // flush 次数（下游消费触发）

/** flush ownerUnit 上缓存的所有 slot_bind 事件。
 *  当 ownerUnit 产生出边（clone / propagate / field_write 等）时调用，
 *  将之前延迟的 slot_bind 边写入 DB。
 */
export function flushPendingSlotBinds(ownerValue: unknown): void {
  if (!ownerValue || typeof ownerValue !== 'object') return
  const pending = pendingSlotBinds.get(ownerValue)
  if (!pending || pending.length === 0) return
  pendingSlotBinds.delete(ownerValue)
  lazySlotBindFlushed += pending.length
  for (const evt of pending) {
    safeRecordEdge(evt.value, evt.ownerUnit, 'slot_bind')
  }
}

/** 获取 lazy slot_bind 统计信息（供 dataflow-edge-stats closeSqlite 输出） */
export function getLazySlotStats(): { buffered: number; flushed: number; discarded: number } {
  const discarded = lazySlotBindBuffered - lazySlotBindFlushed
  return { buffered: lazySlotBindBuffered, flushed: lazySlotBindFlushed, discarded }
}

/** 重置 lazy slot_bind 统计（测试用） */
export function resetLazySlotStats(): void {
  pendingSlotBinds.delete
  lazySlotBindBuffered = 0
  lazySlotBindFlushed = 0
}

let _fd: number | null = null
function ensureFd(): number | null {
  if (_fd !== null) return _fd
  try {
    _fd = fs.openSync(AUDIT_PATH, 'w')
    return _fd
  } catch (_e) {
    return null
  }
}

function writeAuditRecord(rec: AuditRecord): void {
  if (!UNIT_AUDIT_ENABLED) return
  const fd = ensureFd()
  if (fd === null) return
  try {
    fs.writeSync(fd, JSON.stringify(rec) + '\n')
  } catch (_e) {
    // 写入失败静默
  }
}

/** 快速通道：flag off 时所有 audit*Event 直接返回，省 safeRecordEdge / loadDataflowModule 调用开销 */
function isAuditFastOff(): boolean {
  if (UNIT_AUDIT_ENABLED) return false
  if (!Config.dataflowDb) return true
  loadDataflowModule()
  return !_dfMod || (!_dfMod.SQLITE_ENABLED && !_dfMod.ENABLED)
}

/** clone / cloneAlias 事件：from → to 新 Value 实例复制 */
export function auditCloneEvent(event: 'clone' | 'cloneAlias', from: unknown, to: unknown): void {
  if (isAuditFastOff()) return
  const edgeType = event === 'clone' ? 'cow_copy' : 'alias_clone'
  safeRecordEdge(from, to, edgeType)
  if (UNIT_AUDIT_ENABLED) {
    writeAuditRecord({
      event,
      edge_type_hint: edgeType,
      from_vid: getValueIdLazy(from),
      to_vid: getValueIdLazy(to),
      from_loc_key: computeLocKey(from),
      to_loc_key: computeLocKey(to),
      value_qid: asDataflowValue(from)?.qid || asDataflowValue(from)?._qid || null,
      callsite_top3: captureCallsite(),
      ts: Date.now(),
    })
  }
}

/** buildNewValueInstance 出口：originalObj → newObj 新 Value 实例构造 */
export function auditInstanceNewEvent(originalObj: unknown, newObj: unknown): void {
  if (isAuditFastOff()) return
  safeRecordEdge(originalObj, newObj, 'instance_new')
  if (UNIT_AUDIT_ENABLED) {
    writeAuditRecord({
      event: 'instance_new',
      edge_type_hint: 'instance_new',
      from_vid: getValueIdLazy(originalObj),
      to_vid: getValueIdLazy(newObj),
      from_loc_key: computeLocKey(originalObj),
      to_loc_key: computeLocKey(newObj),
      value_qid: asDataflowValue(originalObj)?.qid || null,
      callsite_top3: captureCallsite(),
      ts: Date.now(),
    })
  }
}

/** ValueRefMap.set 入口：value → owner slot 绑定（owner 通过 ValueRefMap 持有的 ownerUnit 关联）
 *  ownerUnit 可能为 null（ValueRefMap 未显式记录 owner），此时跳过 recordEdge。
 *
 *  Lazy slot materialization：不立即写 safeRecordEdge，而是缓存到 pendingSlotBinds。
 *  当 ownerUnit 后续产生出边时（safeRecordEdge 非 slot_bind / recordEdge 非 slot_bind），
 *  由 flushPendingSlotBinds 将缓存的 slot_bind 边写入 DB。
 *  Phase 结束时未 flush 的即 dead-end slot（99.94% 与 taint source 断链），丢弃避免写入无效边。
 */
export function auditSlotBindEvent(value: unknown, ownerUnit: unknown, key: string): void {
  if (!value || !ownerUnit || typeof value !== 'object' || typeof ownerUnit !== 'object') return
  if (isAuditFastOff()) return
  // 缓存 slot_bind 事件，延迟到 ownerUnit 产生出边时 flush
  let pending = pendingSlotBinds.get(ownerUnit)
  if (!pending) {
    pending = []
    pendingSlotBinds.set(ownerUnit, pending)
  }
  pending.push({ value, ownerUnit })
  lazySlotBindBuffered++
  // 注意：不在此处调用 safeRecordEdge 或 _recordEdge，否则 lazy 缓存失效。
  // SQLite 写入延迟到 flushPendingSlotBinds，避免无下游消费的 slot 进入数据库。
  // UNIT_AUDIT jsonl 仍记录（仅对账用，不影响 DB）
  if (UNIT_AUDIT_ENABLED) {
    writeAuditRecord({
      event: 'slot_bind',
      edge_type_hint: 'slot_bind',
      slot_key: key,
      from_vid: getValueIdLazy(value),
      to_vid: getValueIdLazy(ownerUnit),
      from_loc_key: computeLocKey(value),
      to_loc_key: computeLocKey(ownerUnit),
      owner_qid: asDataflowValue(ownerUnit)?.qid || null,
      callsite_top3: captureCallsite(),
      ts: Date.now(),
    })
  }
}

/** BVT setChild 事件：val → treeNode BVT 内部节点绑定 */
export function auditBvtSetEvent(val: unknown, treeNode: unknown): void {
  if (!val || !treeNode || typeof val !== 'object' || typeof treeNode !== 'object') return
  if (isAuditFastOff()) return
  safeRecordEdge(val, treeNode, 'bvt_set')
  if (UNIT_AUDIT_ENABLED) {
    writeAuditRecord({
      event: 'bvt_set',
      edge_type_hint: 'bvt_set',
      from_vid: getValueIdLazy(val),
      to_vid: getValueIdLazy(treeNode),
      from_loc_key: computeLocKey(val),
      to_loc_key: computeLocKey(treeNode),
      tree_qid: asDataflowValue(treeNode)?.qid || null,
      callsite_top3: captureCallsite(),
      ts: Date.now(),
    })
  }
}

/** UnionValue 构造事件：child → union 合成节点依赖（taint = children OR）
 *  runtime 语义：new UnionValue(children) 的 taint 隐式从 children 递归查；
 *  离线 DB 需要显式 edge 表达该依赖（否则 BFS 走不通 union 合成步骤）。
 *  v5 6 hook 未覆盖 UnionValue 构造（区别于 bvt_set 的 setChild hook），
 * 该边覆盖 `<union@all>` 作为 sink 但没有 incoming 的退化形态。
 */
export function auditUnionComposeEvent(child: unknown, union: unknown): void {
  if (!child || !union || typeof child !== 'object' || typeof union !== 'object') return
  if (isAuditFastOff()) return
  safeRecordEdge(child, union, 'union_compose')
  if (UNIT_AUDIT_ENABLED) {
    writeAuditRecord({
      event: 'union_compose',
      edge_type_hint: 'union_compose',
      from_vid: getValueIdLazy(child),
      to_vid: getValueIdLazy(union),
      from_loc_key: computeLocKey(child),
      to_loc_key: computeLocKey(union),
      union_qid: asDataflowValue(union)?.qid || null,
      callsite_top3: captureCallsite(),
      ts: Date.now(),
    })
  }
}

export const UNIT_AUDIT_STATE = {
  enabled: UNIT_AUDIT_ENABLED,
  path: AUDIT_PATH,
}
