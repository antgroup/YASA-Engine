import type { EntryPoint } from './entrypoint'

const constant = require('../../../../util/constant')
const Config = require('../../../../config')
const crypto = require('crypto')
const { AsyncLocalStorage } = require('async_hooks') as typeof import('async_hooks')

type EntryPointContextCallback<T> = () => T

function isDataflowInstrumentationEnabled(): boolean {
  return Config.dataflowDb
}

let currentEntryPoint: EntryPoint = {
  filePath: constant.YASA_DEFAULT,
  functionName: constant.YASA_DEFAULT,
  attribute: constant.YASA_DEFAULT,
  funcReceiverType: constant.YASA_DEFAULT,
}

const entryPointContext = new AsyncLocalStorage<EntryPoint>()

/**
 * setCurrentEntryPoint
 * entryPoint
 * @param entryPoint
 */
function setCurrentEntryPoint(entryPoint: EntryPoint): void {
  currentEntryPoint = entryPoint
  if (isDataflowInstrumentationEnabled()) {
    const { recordEntrypoint } = require('../dataflow-edge-stats')
    recordEntrypoint(entryPoint)
  }
}

/**
 *
 */
function getCurrentEntryPoint(): EntryPoint {
  return entryPointContext.getStore() ?? currentEntryPoint
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

// owner key 按 entryPoint 对象身份做一级缓存：同一 EP 分析期间 key 不变，
// 而读取方（TaintRecord 污点可见性判定）在热点路径上每值每步都会调用
let _ownerKeyCacheEp: EntryPoint | undefined | null = null
let _ownerKeyCacheVal: string | undefined

function getEntryPointOwnerKey(entryPoint: EntryPoint | undefined = getCurrentEntryPoint()): string | undefined {
  if (!entryPoint) return undefined
  if (entryPoint === _ownerKeyCacheEp) return _ownerKeyCacheVal
  const loc = entryPoint.entryPointSymVal?.ast?.node?.loc
  const filePath = normalizePath(String(entryPoint.filePath ?? loc?.sourcefile ?? ''))
  if (!filePath || filePath === constant.YASA_DEFAULT) {
    _ownerKeyCacheEp = entryPoint
    _ownerKeyCacheVal = undefined
    return undefined
  }
  const functionName = String(entryPoint.functionName ?? '')
  const type = String(entryPoint.type ?? '')
  const start = Number(entryPoint.funcLocStart ?? loc?.start?.line ?? 0)
  const end = Number(entryPoint.funcLocEnd ?? loc?.end?.line ?? 0)
  const attribute = String(entryPoint.attribute ?? '')
  const key = [filePath, functionName, type, String(start), String(end), attribute].join('|')
  _ownerKeyCacheEp = entryPoint
  _ownerKeyCacheVal = key
  return key
}

function runWithEntryPointContext<T>(entryPoint: EntryPoint, callback: EntryPointContextCallback<T>): T {
  return entryPointContext.run(entryPoint, callback)
}

// ===== N2 SSA callsite_id 栈 =====
// 语义：ensureNode 去重除 (val identity, ep_id) 外再叠加 callsite_id 维度，
// 避免同 Value 在不同 caller 链路下被合并成同 nodeId（违反调用点粒度设计 N2 SSA 粒度）。
// 实装：analyzer 在 processCall / executeCall 入口 push 当前 frame，函数返回后 pop 还原；
// pre-scan / 未进任何 call 时栈为空，callsite_id = null。
//
// callsite_id 用 sha1 截 12 char hex（48 bit）替代原始 frame 字符串，
// 避免深栈项目（onepaas max 8828 字符 / 平均 3752）DB 体积爆炸。
// 12 hex char ≈ 2.8e14 桶，碰撞概率极低；callsite_id 仅作 nodeId 桶 key，不参与语义。
//
// 栈存储拆分为 ALS context-local + module-global fallback。
// executor 进入隔离 scope 时绑定一份 fresh CallsiteContext（context-local owner），
// ALS 命中即操作该 context；ALS 缺失（serial / pre-scan / 未走 executor）退回 module-global，
// 保留串行兼容路径。

/**
 * CallsiteContext：单 EP 执行期间的 callsite 栈与缓存载体。
 * stack 与缓存绑定；invalidate 由 push/pop 内联完成。
 */
export interface CallsiteContext {
  stack: string[]
  cachedId: string | null
  cacheValid: boolean
}

const callsiteContextStorage = new AsyncLocalStorage<CallsiteContext>()

// module-global fallback：未进入 ALS scope 时复用，保持 serial 路径原行为。
const globalCallsiteContext: CallsiteContext = {
  stack: [],
  cachedId: null,
  cacheValid: true,
}

function createCallsiteContext(): CallsiteContext {
  return { stack: [], cachedId: null, cacheValid: true }
}

function getActiveCallsiteContext(): CallsiteContext {
  return callsiteContextStorage.getStore() ?? globalCallsiteContext
}

function runWithCallsiteContext<T>(context: CallsiteContext, callback: () => T): T {
  return callsiteContextStorage.run(context, callback)
}

function invalidateCallsiteCacheOf(context: CallsiteContext): void {
  context.cacheValid = false
}

/**
 * push 一层 callsite frame。frame 形如 "file.go:123"（callstack 新进入 fclos 的调用点 loc）。
 */
function pushCallsiteFrame(frame: string): void {
  const ctx = getActiveCallsiteContext()
  ctx.stack.push(frame)
  invalidateCallsiteCacheOf(ctx)
}

/** pop 最内层 frame，与对应 push 配对。 */
function popCallsiteFrame(): void {
  const ctx = getActiveCallsiteContext()
  ctx.stack.pop()
  invalidateCallsiteCacheOf(ctx)
}

/** 读当前 callsite_id（sha1 12 char hex）；空栈返回 null（pre-scan / EP 根层） */
function getCurrentCallsiteId(): string | null {
  const ctx = getActiveCallsiteContext()
  if (ctx.stack.length === 0) return null
  if (!ctx.cacheValid) {
    ctx.cachedId = crypto.createHash('sha1').update(ctx.stack.join('|')).digest('hex').slice(0, 12)
    ctx.cacheValid = true
  }
  return ctx.cachedId
}

/** 清空当前活跃 context 的栈（run 之间复位；测试用） */
function resetCallsiteStack(): void {
  const ctx = getActiveCallsiteContext()
  ctx.stack.length = 0
  ctx.cachedId = null
  ctx.cacheValid = true
}

module.exports = {
  getCurrentEntryPoint,
  getEntryPointOwnerKey,
  runWithEntryPointContext,
  setCurrentEntryPoint,
  pushCallsiteFrame,
  popCallsiteFrame,
  getCurrentCallsiteId,
  resetCallsiteStack,
  createCallsiteContext,
  runWithCallsiteContext,
}
