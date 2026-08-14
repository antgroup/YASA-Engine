import fs from 'node:fs'
import path from 'node:path'

import type { IResultManager } from './result-manager'

export type FindingsCheckpointStatus = 'written' | 'skipped' | 'error'
export type FindingsCheckpointReason = 'normal' | 'timeout' | 'budget-exhausted' | 'budget-expired'
export interface FindingsCheckpointFinding { [key: string]: FindingsCheckpointValue }
export type FindingsCheckpointValue = string | number | boolean | null | FindingsCheckpointValue[] | { [key: string]: FindingsCheckpointValue }
export interface FindingsCheckpointDocument { version: 1; status: 'partial' | 'complete'; reason: FindingsCheckpointReason; findings: Record<string, FindingsCheckpointFinding[]> }
export type FindingsCheckpointErrorCode = 'mkdir_failed' | 'open_failed' | 'write_failed' | 'fsync_failed' | 'close_failed' | 'rename_failed' | 'unknown'
export interface FindingsCheckpointError { code: FindingsCheckpointErrorCode; message: string; retriable: boolean }
export interface FindingsCheckpointResult { status: FindingsCheckpointStatus; path?: string; error?: FindingsCheckpointError }
export interface FindingsCheckpointOptions { filePath: string; reason: FindingsCheckpointReason; budgetMs?: number }
export interface FindingsCheckpointFs { mkdirSync(path: string, options: { recursive: boolean }): void; openSync(path: string, flags: string, mode: number): number; writeSync(fd: number, data: string, position: undefined, encoding: 'utf8'): void; fsyncSync(fd: number): void; closeSync(fd: number): void; renameSync(oldPath: string, newPath: string): void; unlinkSync(path: string): void }
const defaultFs: FindingsCheckpointFs = fs

export function shouldRunOutputStrategies(reason: FindingsCheckpointReason): boolean {
  switch (reason) {
    case 'normal': return true
    case 'timeout':
    case 'budget-exhausted':
    case 'budget-expired': return false
    default: { const exhaustive: never = reason; return exhaustive }
  }
}

export interface FindingsFinalizationOutcome { status: 'complete' | 'partial' | 'error'; schedulingError?: FindingsCheckpointError; persistenceError?: FindingsCheckpointError }
export function combineFindingsFinalizationErrors(schedulingError: FindingsCheckpointError | undefined, persistenceError: FindingsCheckpointError | undefined): FindingsFinalizationOutcome {
  return { status: schedulingError || persistenceError ? 'error' : 'complete', ...(schedulingError ? { schedulingError } : {}), ...(persistenceError ? { persistenceError } : {}) }
}


const METADATA_KEYS = new Set(['source', 'sink', 'rule', 'ruleId', 'entrypoint', 'entryPoint', 'trace', 'sanitizer', 'location', 'locations', 'sourceLocation', 'sinkLocation'])

const OMITTED_KEYS = new Set(['node', 'scope', 'parent', 'context', 'ast'])
function toSafeValue(value: unknown, depth: number, seen: WeakSet<object>): FindingsCheckpointValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object' || depth > 4) return undefined
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.slice(0, 100).map(item => toSafeValue(item, depth + 1, seen) ?? null)
    const result: FindingsCheckpointFinding = {}
    const entries = Object.entries(value)
    const prioritized = [...entries.filter(([key]) => METADATA_KEYS.has(key)), ...entries.filter(([key]) => !METADATA_KEYS.has(key))]
    for (const [key, item] of prioritized.slice(0, 100)) {
      if (OMITTED_KEYS.has(key)) continue
      const safe = toSafeValue(item, depth + 1, seen)
      if (safe !== undefined) result[key] = safe
    }
    return result
  } finally { seen.delete(value) }
}

export function createFindingsCheckpointDocument(resultManager: IResultManager, reason: FindingsCheckpointReason): FindingsCheckpointDocument {
  const findings: Record<string, FindingsCheckpointFinding[]> = {}
  for (const [strategy, values] of Object.entries(resultManager.getFindings())) {
    findings[strategy] = values.map(value => {
      const safe = toSafeValue(value, 0, new WeakSet<object>())
      return (safe && typeof safe === 'object' && !Array.isArray(safe) ? safe : {}) as FindingsCheckpointFinding
    })
  }
  return { version: 1, status: reason === 'normal' ? 'complete' : 'partial', reason, findings }
}

export function writeFindingsCheckpoint(resultManager: IResultManager, options: FindingsCheckpointOptions, fileSystem: FindingsCheckpointFs = defaultFs): FindingsCheckpointResult {
  const directory = path.dirname(options.filePath)
  const temporaryPath = `${options.filePath}.${process.pid}.${Date.now()}.tmp`
  let fd: number | undefined
  let closeError: FindingsCheckpointError | undefined
  const fail = (code: FindingsCheckpointErrorCode, error: unknown): FindingsCheckpointResult => ({ status: 'error', error: { code, message: error instanceof Error ? error.message : String(error), retriable: code !== 'rename_failed' } })
  try { try { fileSystem.mkdirSync(directory, { recursive: true }) } catch (e) { return fail('mkdir_failed', e) }
    try { fd = fileSystem.openSync(temporaryPath, 'w', 0o600) } catch (e) { return fail('open_failed', e) }
    try { fileSystem.writeSync(fd, `${JSON.stringify(createFindingsCheckpointDocument(resultManager, options.reason))}\n`, undefined, 'utf8') } catch (e) { return fail('write_failed', e) }
    try { fileSystem.fsyncSync(fd) } catch (e) { return fail('fsync_failed', e) }
    try { fileSystem.closeSync(fd); fd = undefined } catch (e) { closeError = { code: 'close_failed', message: e instanceof Error ? e.message : String(e), retriable: true } }
    if (closeError) return { status: 'error', error: closeError }
    try { fileSystem.renameSync(temporaryPath, options.filePath) } catch (e) { return fail('rename_failed', e) }
    return { status: 'written', path: options.filePath }
  } finally {
    if (fd !== undefined) { try { fileSystem.closeSync(fd) } catch { /* 关闭失败不覆盖主错误。 */ } }
    try { fileSystem.unlinkSync(temporaryPath) } catch { /* rename 成功后临时路径不存在。 */ }
  }
}

export class FindingsCheckpointWriter {
  private finalized = false
  constructor(private readonly options: FindingsCheckpointOptions) {}
  writeOnce(resultManager: IResultManager, fileSystem?: FindingsCheckpointFs): FindingsCheckpointResult {
    if (this.finalized) return { status: 'skipped' }
    const result = writeFindingsCheckpoint(resultManager, this.options, fileSystem)
    // 仅成功或不可重试失败后终结；瞬时持久化故障必须保留重试机会。
    if (result.status === 'written' || (result.status === 'error' && !result.error?.retriable)) {
      this.finalized = true
    }
    return result
  }
}
