import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { queryDataflowDb } from '../src/engine/analyzer/common/dataflow-db-query'

interface DataflowStatsModule {
  enableDataflowDb(opts?: { mode?: 'full' | 'incremental-facts' }): void
  initSqlite(reportDir: string, projectRoot?: string): void
  closeSqlite(): void
  recordEntrypoint(ep: { filePath: string; functionName: string; attribute?: string; framework?: string }): void
  recordEdge(from: unknown, to: unknown, edgeType: string): void
  recordSourceFiles(files: Map<string, string> | Record<string, string>): void
  commitDataflowDbTransaction(reason: string, state: 'running' | 'closed'): unknown
  reopenDataflowDbWriteTransaction(): void
  getDataflowDbRuntimeState(): { initialized: boolean; closed: boolean; dbPath: string | null }
}

const stats = require('../src/engine/analyzer/common/dataflow-edge-stats') as DataflowStatsModule

interface TableCounts {
  nodes: number
  edges: number
  sourceFiles: number
  runState: string | null
  lastCommitReason: string | null
}

function makeTempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
}

function initDataflowDb(name: string): string {
  const root = makeTempDir(name)
  const reportDir = path.join(root, 'report')
  fs.mkdirSync(reportDir, { recursive: true })
  stats.enableDataflowDb({ mode: 'full' })
  stats.initSqlite(reportDir, root)
  return path.join(reportDir, 'dataflow.db')
}

function readonlyEntrypointCount(dbPath: string): number {
  const reader = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = reader.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM entrypoints').get()
    return row?.c ?? 0
  } finally {
    reader.close()
  }
}

function readonlyTableCounts(dbPath: string): TableCounts {
  const reader = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const nodes = reader.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM nodes').get()?.c ?? 0
    const edges = reader.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM edges').get()?.c ?? 0
    const sourceFiles = reader.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM source_files').get()?.c ?? 0
    const runState = reader.prepare<{ value: string }>("SELECT value FROM dataflow_metadata WHERE key = 'run_state'").get()?.value ?? null
    const lastCommitReason = reader.prepare<{ value: string }>("SELECT value FROM dataflow_metadata WHERE key = 'last_commit_reason'").get()?.value ?? null
    return { nodes, edges, sourceFiles, runState, lastCommitReason }
  } finally {
    reader.close()
  }
}

function makeValue(file: string, line: number, qid: string): Record<string, unknown> {
  return {
    qid,
    sid: qid,
    ast: {
      node: {
        name: qid,
        loc: {
          sourcefile: file,
          start: { line, column: 0, sourcefile: file },
          end: { line, column: 1, sourcefile: file },
        },
      },
    },
  }
}

describe('dataflow db runtime query api', () => {
  afterEach(() => {
    const state = stats.getDataflowDbRuntimeState()
    if (state.initialized && !state.closed && state.dbPath) {
      try {
        stats.closeSqlite()
      } catch (error) {
        if (!(error instanceof Error) || !/no longer writable|write transaction is not active/.test(error.message)) {
          throw error
        }
      }
    }
  })

  it('fails when dataflow db is not enabled and initialized', () => {
    assert.throws(
      () => queryDataflowDb('SELECT 1 AS c'),
      /requires --dataflowDb/
    )
  })

  it('rejects write SQL and multiple statements', () => {
    assert.throws(
      () => queryDataflowDb('DELETE FROM nodes'),
      /only allows SELECT|rejects write/
    )
    assert.throws(
      () => queryDataflowDb('SELECT 1; SELECT 2'),
      /exactly one readonly statement/
    )
    assert.throws(
      () => queryDataflowDb('WITH c AS (SELECT 1 AS value) VALUES (1)'),
      /WITH statement must resolve to SELECT/
    )
  })

  it('reads running writes without committing the outer transaction', () => {
    const dbPath = initDataflowDb('dataflow-query-running')
    stats.recordEntrypoint({ filePath: 'src/a.ts', functionName: 'handler' })

    assert.strictEqual(readonlyEntrypointCount(dbPath), 0)

    const result = queryDataflowDb<{ c: number }>('SELECT COUNT(*) AS c FROM entrypoints')
    assert.strictEqual(result.rows[0]?.c, 1)
    assert.deepStrictEqual(result.metadata, {
      dbPath,
      commitSeq: 0,
      committedAt: '',
      state: 'running',
    })
    assert.strictEqual(readonlyEntrypointCount(dbPath), 0)
  })

  it('supports positional and named query parameters', () => {
    initDataflowDb('dataflow-query-params')
    stats.recordEntrypoint({ filePath: 'src/a.ts', functionName: 'first' })
    stats.recordEntrypoint({ filePath: 'src/b.ts', functionName: 'second' })

    const positional = queryDataflowDb<{ func_name: string }>(
      'SELECT func_name FROM entrypoints WHERE file = ? ORDER BY func_name',
      ['src/a.ts']
    )
    assert.deepStrictEqual(positional.rows, [{ func_name: 'first' }])

    const named = queryDataflowDb<{ func_name: string }>(
      'WITH picked AS (SELECT func_name FROM entrypoints WHERE file = $file) SELECT func_name FROM picked',
      { file: 'src/b.ts' }
    )
    assert.deepStrictEqual(named.rows, [{ func_name: 'second' }])
  })

  it('keeps the writer transaction open for later writes after querying', () => {
    const dbPath = initDataflowDb('dataflow-query-reopen')
    stats.recordEntrypoint({ filePath: 'src/a.ts', functionName: 'first' })
    assert.strictEqual(queryDataflowDb<{ c: number }>('SELECT COUNT(*) AS c FROM entrypoints').rows[0]?.c, 1)

    stats.recordEntrypoint({ filePath: 'src/b.ts', functionName: 'second' })
    assert.strictEqual(readonlyEntrypointCount(dbPath), 0)

    const result = queryDataflowDb<{ c: number }>('SELECT COUNT(*) AS c FROM entrypoints')
    assert.strictEqual(result.rows[0]?.c, 2)
    assert.strictEqual(readonlyEntrypointCount(dbPath), 0)

    stats.closeSqlite()
    assert.strictEqual(readonlyEntrypointCount(dbPath), 2)
  })

  it('keeps runtime writes private until the final commit', () => {
    const dbPath = initDataflowDb('dataflow-query-runtime-visible')
    const firstSource = makeValue('/project/src/a.ts', 1, 'SourceA')
    const firstSink = makeValue('/project/src/a.ts', 2, 'SinkA')
    const secondSource = makeValue('/project/src/b.ts', 1, 'SourceB')
    const secondSink = makeValue('/project/src/b.ts', 2, 'SinkB')

    stats.recordSourceFiles(new Map([['src/a.ts', 'const a = 1']]))
    stats.recordEdge(firstSource, firstSink, 'assign')
    assert.deepStrictEqual(readonlyTableCounts(dbPath), {
      nodes: 0,
      edges: 0,
      sourceFiles: 0,
      runState: 'running',
      lastCommitReason: 'init',
    })

    const running = queryDataflowDb<{ nodes: number; edges: number; sourceFiles: number }>(
      'SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges, (SELECT COUNT(*) FROM source_files) AS sourceFiles'
    )
    assert.deepStrictEqual(running.rows, [{ nodes: 2, edges: 1, sourceFiles: 1 }])
    assert.deepStrictEqual(readonlyTableCounts(dbPath), {
      nodes: 0,
      edges: 0,
      sourceFiles: 0,
      runState: 'running',
      lastCommitReason: 'init',
    })

    stats.recordEdge(secondSource, secondSink, 'assign')
    assert.strictEqual(readonlyTableCounts(dbPath).edges, 0)
    stats.closeSqlite()
    assert.deepStrictEqual(readonlyTableCounts(dbPath), {
      nodes: 4,
      edges: 2,
      sourceFiles: 1,
      runState: 'closed',
      lastCommitReason: 'final',
    })
  })

  it('fails fast instead of autocommitting writes when no write transaction is active', () => {
    const dbPath = initDataflowDb('dataflow-query-invalid-transaction')
    stats.recordEntrypoint({ filePath: 'src/a.ts', functionName: 'first' })
    stats.commitDataflowDbTransaction('test-only', 'running')

    assert.throws(
      () => stats.recordEntrypoint({ filePath: 'src/b.ts', functionName: 'second' }),
      /write transaction is not active/
    )
    assert.strictEqual(readonlyEntrypointCount(dbPath), 1)
  })

  it('queries final dataflow db after close', () => {
    initDataflowDb('dataflow-query-closed')
    stats.recordEntrypoint({ filePath: 'src/a.ts', functionName: 'handler' })
    stats.closeSqlite()

    const result = queryDataflowDb<{ key: string; value: string }>(
      "SELECT key, value FROM dataflow_metadata WHERE key IN ('run_state', 'last_commit_reason') ORDER BY key"
    )
    assert.strictEqual(result.metadata.state, 'closed')
    assert.deepStrictEqual(result.rows, [
      { key: 'last_commit_reason', value: 'final' },
      { key: 'run_state', value: 'closed' },
    ])
  })
})
