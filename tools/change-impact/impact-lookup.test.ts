/**
 * 变更影响分析手写用例（mocha）：从 tools/change-impact/test_manual_cases.py port。
 *
 * 用最小 SQLite fixture 固化人工期望，保证 ChangeImpactLookup 对核心 5 类
 * evidence 与 provenance 输出保持稳定，覆盖最小 SQLite fixture。
 *
 * 跑法：`npx mocha --require tsx/cjs tools/change-impact/impact-lookup.test.ts`
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { ChangeImpactLookup, type Change, type LookupResult } from './impact-lookup'

// === fixture 工具 ===

function mkTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cia-mocha-'))
  return path.join(dir, 'fixture.db')
}

function rmTmpDb(p: string): void {
  try {
    fs.unlinkSync(p)
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(path.dirname(p))
  } catch {
    /* ignore */
  }
}

function runLookup(dbPath: string, changes: Change[]): LookupResult {
  const lookup = new ChangeImpactLookup(dbPath)
  try {
    return lookup.lookup(changes)
  } finally {
    lookup.dispose()
  }
}

function epIds(result: LookupResult): string[] {
  return result.entrypoints.map((e) => e.ep_id)
}

function sortedEpIds(result: LookupResult): string[] {
  return epIds(result).slice().sort()
}

// === 主 fixture：ManualChangeImpactCases 等价 ===

function initManualDb(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE entrypoints (
      id INTEGER PRIMARY KEY, ep_id TEXT, file TEXT, func_name TEXT,
      start_line INTEGER, end_line INTEGER, ep_type TEXT, framework TEXT, attribute TEXT
    );
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY, ep_id INTEGER, qid TEXT, file TEXT, line INTEGER, col INTEGER
    );
    CREATE TABLE callgraph (
      id INTEGER PRIMARY KEY, ep_id INTEGER, callee_qid TEXT,
      call_site_file TEXT, call_site_line INTEGER,
      callee_start_line INTEGER, callee_end_line INTEGER
    );
    CREATE TABLE builtin_sources (
      id INTEGER PRIMARY KEY, ep_id TEXT, file TEXT, line INTEGER
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY, ep_id INTEGER, from_node_id INTEGER, to_node_id INTEGER
    );
  `)

  const insEp = db.prepare(
    'INSERT INTO entrypoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const eps: Array<[number, string, string, string, number, number, string, string, string]> = [
    [1, 'EP_A', 'src/routes/a.ts', 'handlerA', 10, 30, 'route', 'express', 'GET /a'],
    [2, 'EP_B', 'src/routes/b.ts', 'handlerB', 10, 30, 'route', 'express', 'GET /b'],
    [3, 'EP_C', 'src/routes/c.ts', 'handlerC', 10, 30, 'route', 'express', 'GET /c'],
    [4, 'EP_D', 'src/routes/d.ts', 'handlerD', 10, 30, 'route', 'express', 'GET /d'],
    [5, 'EP_E', 'src/routes/e.ts', 'handlerE', 10, 30, 'route', 'express', 'GET /e'],
    [6, 'EP_F', 'src/routes/f.go', 'handlerF', 10, 30, 'route', 'go', 'GET /f'],
    [7, 'EP_G', 'src/routes/g.go', 'handlerG', 10, 30, 'route', 'go', 'GET /g'],
    [8, 'EP_H', 'src/routes/h.go', 'handlerH', 10, 30, 'route', 'go', 'GET /h'],
    [9, 'EP_I', 'src/routes/i.ts', 'handlerI', 10, 30, 'route', 'express', 'GET /i'],
    [10, 'EP_J', 'src/routes/j.go', 'handlerJ', 10, 30, 'route', 'go', 'GET /j'],
    [11, 'EP_K', 'src/routes/k.go', 'handlerK', 10, 30, 'route', 'go', 'GET /k'],
    [12, 'EP_L', 'src/routes/l.go', 'handlerL', 10, 30, 'route', 'go', 'GET /l'],
    [13, 'EP_M', 'src/routes/m.ts', 'handlerM', 10, 30, 'route', 'express', 'GET /m'],
    [14, 'EP_N', 'src/routes/new.ts', 'handlerNew', 20, 80, 'route', 'express', 'POST /new'],
    [15, 'EP_O', 'src/routes/neighbor.ts', 'handlerNeighbor', 20, 80, 'route', 'express', 'POST /neighbor'],
    [16, 'EP_P', 'src/routes/package_consumer.go', 'handlerPackage', 10, 40, 'route', 'go', 'GET /package'],
    [17, 'EP_Q', 'src/routes/package_neighbor.go', 'handlerPackageNeighbor', 10, 40, 'route', 'go', 'GET /package-neighbor'],
    [18, 'EP_R', 'src/routes/interface_consumer.go', 'handlerInterface', 10, 40, 'route', 'go', 'GET /interface'],
  ]
  const insertManyEp = db.transaction((rows: typeof eps) => {
    for (const r of rows) insEp.run(...r)
  })
  insertManyEp(eps)

  const insNode = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?)')
  const nodes: Array<[number, number, string, string, number, number]> = [
    [10, 3, 'helper.foo', 'src/lib/helper.ts', 50, 1],
    [11, 5, 'unrelated.sameLine', 'src/lib/unrelated.ts', 50, 1],
    [12, 4, 'flow.value', 'src/lib/flow.ts', 70, 1],
    [13, 4, 'flow.sink', 'src/lib/flow.ts', 71, 1],
    [14, 5, 'flow.unrelated', 'src/lib/unrelated-flow.ts', 70, 1],
    [15, 6, 'seed.value', 'src/lib/seed.go', 90, 1],
    [16, 6, 'service.g', 'src/routes/g.go', 18, 1],
    [17, 6, 'seed.to_h', 'src/routes/h.go', 18, 1],
    [18, 9, 'seed.ts', 'src/lib/seed-ts.ts', 90, 1],
    [19, 9, 'service.j', 'src/routes/j.go', 18, 1],
    [20, 10, 'seed.go', 'src/lib/seed-go.go', 90, 1],
    [21, 10, 'service.k', 'src/routes/k.ts', 18, 1],
    [22, 11, 'seed.target', 'src/lib/seed-target.go', 90, 1],
    [23, 11, 'service.l', 'src/routes/l.ts', 18, 1],
    [24, 4, 'helper.edgeNoise', 'src/lib/helper.ts', 50, 1],
    [25, 15, 'neighbor.seed', 'src/lib/neighbor.ts', 90, 1],
    [26, 16, 'package.local', 'src/routes/package_consumer.go', 22, 1],
    [27, 17, 'config.Value', 'src/config/config.go', 20, 1],
    [28, 18, 'service.worker.Run', 'src/service/worker.go', 33, 1],
    [29, 18, 'service.producer.call', 'src/routes/handler_response.go', 40, 1],
    [30, 18, 'service.producer.return', 'src/service/producer.go', 12, 1],
    [31, 18, 'ctx.receiver.call', 'src/routes/handler_response.go', 42, 1],
    [32, 18, 'ctx.receiver', 'src/routes/handler_response.go', 42, 8],
    [33, 18, 'ctx.payload.call', 'src/routes/handler_response.go', 44, 1],
    [34, 18, 'ctx.payload', 'src/routes/handler_response.go', 44, 10],
  ]
  db.transaction((rows: typeof nodes) => {
    for (const r of rows) insNode.run(...r)
  })(nodes)

  const insCg = db.prepare(
    'INSERT INTO callgraph VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const cgRows: Array<[number, number, string, string, number, number | null, number | null]> = [
    [1, 2, 'service.fetch', 'src/routes/b.ts', 22, null, null],
    [2, 3, 'helper.foo', 'src/routes/c.ts', 18, 45, 60],
    [3, 5, 'unrelated.sameLine', 'src/routes/e.ts', 18, null, null],
    [4, 6, 'service.g', 'src/routes/g.go', 18, null, null],
    [5, 7, 'service.done', 'src/routes/g.go', 20, null, null],
    [6, 9, 'service.j', 'src/routes/i.ts', 18, null, null],
    [7, 10, 'service.k', 'src/routes/j.go', 18, null, null],
    [8, 11, 'service.l', 'src/routes/k.go', 18, null, null],
    [9, 12, 'service.done', 'src/routes/l.go', 20, null, null],
    [10, 13, 'helper.foo', 'src/routes/m.ts', 18, 45, 60],
    [11, 14, 'neighbor.call', 'src/routes/new.ts', 30, null, null],
    [12, 15, 'new.call', 'src/routes/neighbor.ts', 30, null, null],
  ]
  db.transaction((rows: typeof cgRows) => {
    for (const r of rows) insCg.run(...r)
  })(cgRows)

  db.prepare('INSERT INTO builtin_sources VALUES (?, ?, ?, ?)').run(1, 'EP_A', 'src/routes/a.ts', 14)

  const insEdge = db.prepare('INSERT INTO edges VALUES (?, ?, ?, ?)')
  const edges: Array<[number, number, number, number]> = [
    [1, 4, 12, 13],
    [2, 5, 14, 11],
    [3, 6, 15, 16],
    [4, 6, 15, 17],
    [5, 9, 18, 19],
    [6, 10, 20, 21],
    [7, 11, 22, 23],
    [8, 4, 24, 13],
    [9, 15, 25, 21],
    [10, 17, 27, 21],
  ]
  db.transaction((rows: typeof edges) => {
    for (const r of rows) insEdge.run(...r)
  })(edges)

  db.exec(`
    CREATE TABLE module_deps (
      id INTEGER PRIMARY KEY,
      consumer_ep_id INTEGER NOT NULL,
      consumer_file TEXT NOT NULL,
      consumer_func TEXT NOT NULL,
      import_site_file TEXT NOT NULL,
      import_site_line INTEGER NOT NULL,
      import_path TEXT NOT NULL,
      imported_file TEXT NOT NULL,
      imported_package TEXT NOT NULL,
      imported_qid_prefix TEXT,
      dep_kind TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      provenance TEXT NOT NULL
    );
  `)
  const insMd = db.prepare(
    'INSERT INTO module_deps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  insMd.run(1, 16, 'src/routes/package_consumer.go', 'handlerPackage', 'src/routes/package_consumer.go', 5, 'example/config', 'src/config/config.go', 'config', 'config', 'go_import_package', 100, 'manual')
  insMd.run(2, 17, 'src/routes/package_neighbor.go', 'handlerPackageNeighbor', 'src/routes/package_neighbor.go', 5, 'example/config', 'src/config/config.go', 'config', 'config', 'go_import_package', 60, 'manual')

  db.exec(`
    CREATE TABLE go_interface_bindings (
      id INTEGER PRIMARY KEY,
      consumer_ep_id INTEGER NOT NULL,
      interface_qid TEXT,
      interface_method TEXT,
      interface_signature TEXT,
      receiver_static_qid TEXT,
      impl_type_qid TEXT,
      impl_method_qid TEXT,
      impl_method_file TEXT,
      impl_method_start_line INTEGER,
      impl_method_end_line INTEGER,
      dispatch_kind TEXT NOT NULL,
      dispatch_confidence INTEGER NOT NULL,
      dispatch_provenance TEXT NOT NULL
    );
    CREATE TABLE handler_response_flow_facts (
      id INTEGER PRIMARY KEY,
      consumer_ep_id INTEGER NOT NULL,
      handler_file TEXT NOT NULL,
      handler_func TEXT NOT NULL,
      producer_callgraph_id INTEGER,
      producer_call_node_id INTEGER,
      producer_return_node_id INTEGER,
      producer_err_node_id INTEGER,
      producer_result_node_id INTEGER,
      receiver_callgraph_id INTEGER,
      receiver_call_node_id INTEGER,
      receiver_node_id INTEGER,
      receiver_mutation_method TEXT,
      payload_callgraph_id INTEGER,
      payload_call_node_id INTEGER,
      payload_node_id INTEGER,
      payload_sink_method TEXT NOT NULL,
      ordering_kind TEXT NOT NULL,
      evidence_kind TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      provenance TEXT NOT NULL
    );
  `)
  const insGib = db.prepare(
    'INSERT INTO go_interface_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  insGib.run(1, 18, 'service.Runner', 'Run', 'Run(context.Context) error', 'service.Runner', 'service.worker', 'service.worker.Run', 'src/service/worker.go', 30, 40, 'go_interface_dispatch', 90, 'manual')
  insGib.run(2, 17, 'service.Runner', 'Run', 'Run(context.Context) error', 'service.Runner', 'service.worker', 'service.worker.Run', 'src/service/worker.go', 30, 40, 'full_callgraph_fallback', 90, 'manual')

  const insHrf = db.prepare(
    'INSERT INTO handler_response_flow_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  insHrf.run(
    1, 18, 'src/routes/handler_response.go', 'handlerResponse',
    101, 29, 30, null, null,
    102, 31, 32, 'SetStatusCode',
    103, 33, 34, 'JSON',
    'producer_before_receiver_before_payload', 'go_gin_handler_response_flow', 90, 'manual',
  )
  insHrf.run(
    2, 6, 'src/routes/f.go', 'handlerF',
    104, 15, null, null, null,
    105, 16, 16, 'SetStatusCode',
    106, 16, 16, 'JSON',
    'producer_before_receiver_before_payload', 'go_gin_handler_response_flow', 90, 'manual',
  )

  db.close()
}

// === ManualChangeImpactCases 测试套 ===

describe('ManualChangeImpactCases', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = mkTmpDbPath()
    initManualDb(dbPath)
  })

  afterEach(() => {
    rmTmpDb(dbPath)
  })

  function assertCase(changes: Change[], expectedEps: string[], reasonPrefix: string): void {
    const result = runLookup(dbPath, changes)
    assert.deepStrictEqual(epIds(result), expectedEps, JSON.stringify(result, null, 2))
    const reachedVia = result.entrypoints.length > 0 ? result.entrypoints[0].reached_via : []
    assert.ok(
      reachedVia.some((r) => r.startsWith(reasonPrefix)),
      JSON.stringify(result, null, 2),
    )
  }

  it('entrypoint body change → only EP_A', () => {
    assertCase(
      [{ file: 'src/routes/a.ts', startLine: 15, endLine: 15 }],
      ['EP_A'],
      'entrypoint_body:',
    )
  })

  it('call site change → only EP_B', () => {
    assertCase(
      [{ file: 'src/routes/b.ts', startLine: 22, endLine: 22 }],
      ['EP_B'],
      'call_site:',
    )
  })

  it('callee function change → all callers + edges-only dependent', () => {
    assertCase(
      [{ file: 'src/lib/helper.ts', startLine: 50, endLine: 50 }],
      ['EP_C', 'EP_D', 'EP_M'],
      'callee_qid:',
    )
  })

  it('line change expands to enclosing callee function (no edges fanout)', () => {
    const result = runLookup(dbPath, [{ file: 'src/lib/helper.ts', startLine: 52, endLine: 52 }])
    assert.deepStrictEqual(epIds(result), ['EP_C', 'EP_M'], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.changed_nodes_total, 0)
    assert.strictEqual(result.stats.enclosing_function_dirty_ranges, 1)
    assert.strictEqual(result.stats.candidate_counts.callee_qid, 2)
    assert.strictEqual(result.stats.candidate_counts.edges_one_hop, 0)
  })

  it('shared callee keeps all callers + edges-only dependents', () => {
    const result = runLookup(dbPath, [{ file: 'src/lib/helper.ts', startLine: 50, endLine: 50 }])
    assert.deepStrictEqual(epIds(result), ['EP_C', 'EP_D', 'EP_M'], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.candidate_counts.callee_qid, 2)
    assert.strictEqual(result.stats.candidate_counts.edges_one_hop, 1)
  })

  it('multiple changes union dedupes and preserves shared callee', () => {
    const result = runLookup(dbPath, [
      { file: 'src/routes/a.ts', startLine: 15, endLine: 15 },
      { file: 'src/lib/helper.ts', startLine: 50, endLine: 50 },
    ])
    assert.deepStrictEqual(
      epIds(result),
      ['EP_A', 'EP_C', 'EP_D', 'EP_M'],
      JSON.stringify(result, null, 2),
    )
    assert.strictEqual(new Set(epIds(result)).size, epIds(result).length)
  })

  it('added entrypoint file multi-line change', () => {
    assertCase(
      [{ file: 'src/routes/new.ts', startLine: 1, endLine: 120 }],
      ['EP_N'],
      'entrypoint_body:',
    )
  })

  it('added entrypoint prefers new entrypoint body (no broad downstream)', () => {
    const result = runLookup(dbPath, [{ file: 'src/routes/new.ts', startLine: 1, endLine: 120 }])
    assert.deepStrictEqual(epIds(result), ['EP_N'], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.candidate_counts.downstream_ep_file, 0)
  })

  it('deleted shared helper range impacts all callers', () => {
    const result = runLookup(dbPath, [{ file: 'src/lib/helper.ts', startLine: 45, endLine: 60 }])
    assert.deepStrictEqual(epIds(result), ['EP_C', 'EP_D', 'EP_M'], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.candidate_counts.callee_qid, 2)
    assert.strictEqual(result.stats.candidate_counts.edges_one_hop, 1)
  })

  it('large change add+delete+modify union', () => {
    const result = runLookup(dbPath, [
      { file: 'src/routes/new.ts', startLine: 1, endLine: 120 },
      { file: 'src/lib/helper.ts', startLine: 45, endLine: 60 },
      { file: 'src/lib/seed.go', startLine: 88, endLine: 96 },
    ])
    assert.deepStrictEqual(
      epIds(result),
      ['EP_C', 'EP_D', 'EP_F', 'EP_G', 'EP_M', 'EP_N'],
      JSON.stringify(result, null, 2),
    )
    assert.strictEqual(new Set(epIds(result)).size, epIds(result).length)
  })

  it('builtin source change → only EP_A', () => {
    assertCase(
      [{ file: 'src/routes/a.ts', startLine: 14, endLine: 14 }],
      ['EP_A'],
      'builtin_sources:',
    )
  })

  it('edges one-hop change → only EP_D, no drift to EP_E', () => {
    assertCase(
      [{ file: 'src/lib/flow.ts', startLine: 70, endLine: 70 }],
      ['EP_D'],
      'edges_one_hop:',
    )
  })

  it('downstream ep_file fallback suppressed by handler_response_flow direct evidence', () => {
    const result = runLookup(dbPath, [{ file: 'src/lib/seed.go', startLine: 90, endLine: 90 }])
    assert.deepStrictEqual(epIds(result), ['EP_F'], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.candidate_counts.handler_response_flow, 1)
    assert.strictEqual(result.stats.candidate_counts.downstream_ep_file, 0)
  })

  it('downstream ep_file ignores edges without callgraph structure', () => {
    const result = runLookup(dbPath, [{ file: 'src/lib/seed.go', startLine: 90, endLine: 90 }])
    assert.ok(!epIds(result).includes('EP_H'), JSON.stringify(result, null, 2))
  })

  it('downstream ep_file requires Go seed file', () => {
    const result = runLookup(dbPath, [{ file: 'src/lib/seed-ts.ts', startLine: 90, endLine: 90 }])
    assert.deepStrictEqual(epIds(result), ['EP_I'], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.candidate_counts.downstream_ep_file, 0)
  })

  it('downstream ep_file requires Go callee file', () => {
    const result = runLookup(dbPath, [{ file: 'src/lib/seed-go.go', startLine: 90, endLine: 90 }])
    assert.deepStrictEqual(epIds(result), ['EP_J'], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.candidate_counts.downstream_ep_file, 0)
  })

  it('downstream ep_file requires Go target file', () => {
    const result = runLookup(dbPath, [{ file: 'src/lib/seed-target.go', startLine: 90, endLine: 90 }])
    assert.deepStrictEqual(epIds(result), ['EP_K'], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.candidate_counts.downstream_ep_file, 0)
  })

  it('module_deps restores import consumer without broad fanout', () => {
    const result = runLookup(dbPath, [{ file: 'src/config/config.go', startLine: 30, endLine: 81 }])
    assert.deepStrictEqual(epIds(result), ['EP_P'], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.candidate_counts.module_deps, 1)
    assert.strictEqual(result.stats.candidate_counts.downstream_ep_file, 0)
    assert.ok(
      result.entrypoints[0].reached_via.some((r) => r.startsWith('module_deps:')),
      JSON.stringify(result, null, 2),
    )
  })

  it('missing module_deps table keeps existing behavior', () => {
    const conn = new Database(dbPath)
    conn.exec('DROP TABLE module_deps')
    conn.close()
    const result = runLookup(dbPath, [{ file: 'src/config/config.go', startLine: 30, endLine: 81 }])
    assert.deepStrictEqual(epIds(result), [], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.candidate_counts.module_deps, 0)
  })

  it('go_interface_dispatch uses method-level provenance', () => {
    const result = runLookup(dbPath, [{ file: 'src/service/worker.go', startLine: 33, endLine: 33 }])
    assert.deepStrictEqual(epIds(result), ['EP_R'], JSON.stringify(result, null, 2))
    assert.strictEqual(result.stats.candidate_counts.go_interface_dispatch, 1)
    assert.ok(
      result.entrypoints[0].reached_via.some((r) => r.startsWith('go_interface_dispatch:')),
      JSON.stringify(result, null, 2),
    )
  })

  it('handler_response_flow matches call_node anchors at 3 lines', () => {
    for (const [filePath, line] of [
      ['src/routes/handler_response.go', 40],
      ['src/routes/handler_response.go', 42],
      ['src/routes/handler_response.go', 44],
    ] as Array<[string, number]>) {
      const result = runLookup(dbPath, [{ file: filePath, startLine: line, endLine: line }])
      assert.deepStrictEqual(
        epIds(result),
        ['EP_R'],
        `[${filePath}:${line}] ${JSON.stringify(result, null, 2)}`,
      )
      assert.strictEqual(result.stats.candidate_counts.handler_response_flow, 1)
      assert.ok(
        result.entrypoints[0].reached_via.some((r) => r.startsWith('handler_response_flow:')),
        JSON.stringify(result, null, 2),
      )
    }
  })
})

// === SymbolsConsumerCases 测试套：精确 symbol_id 收紧 vs fallback ===

function initSymbolsDb(dbPath: string, withSymbols: boolean, withCalleeSymbolId: boolean): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE entrypoints (
      id INTEGER PRIMARY KEY, ep_id TEXT, file TEXT, func_name TEXT,
      start_line INTEGER, end_line INTEGER, ep_type TEXT, framework TEXT, attribute TEXT
    );
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY, ep_id INTEGER, qid TEXT, file TEXT, line INTEGER, col INTEGER
    );
  `)
  const callgraphCols = [
    'id INTEGER PRIMARY KEY',
    'ep_id INTEGER',
    'callee_qid TEXT',
    'call_site_file TEXT',
    'call_site_line INTEGER',
    'callee_start_line INTEGER',
    'callee_end_line INTEGER',
  ]
  if (withCalleeSymbolId) callgraphCols.push('callee_symbol_id TEXT')
  db.exec(`CREATE TABLE callgraph (${callgraphCols.join(', ')})`)
  db.exec(`
    CREATE TABLE builtin_sources (id INTEGER PRIMARY KEY, ep_id TEXT, file TEXT, line INTEGER);
    CREATE TABLE edges (id INTEGER PRIMARY KEY, ep_id INTEGER, from_node_id INTEGER, to_node_id INTEGER);
  `)
  if (withSymbols) {
    db.exec(`
      CREATE TABLE symbols (
        symbol_id TEXT PRIMARY KEY, qid TEXT, sid TEXT, vtype TEXT,
        file TEXT, start_line INTEGER, end_line INTEGER, provenance TEXT
      );
    `)
  }
  const insEp = db.prepare('INSERT INTO entrypoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  insEp.run(1, 'EP_GT', 'src/routes/want.go', 'handlerWant', 10, 30, 'route', 'go', 'GET /want')
  insEp.run(2, 'EP_FP', 'src/routes/dup.go', 'handlerDup', 10, 30, 'route', 'go', 'GET /dup')

  const insNode = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?)')
  insNode.run(10, 1, 'pkg.DoSomething', 'src/lib/want.go', 50, 1)
  insNode.run(11, 2, 'pkg.DoSomething', 'src/lib/dup.go', 60, 1)

  if (withCalleeSymbolId) {
    const insCg = db.prepare(
      'INSERT INTO callgraph VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    insCg.run(1, 1, 'pkg.DoSomething', 'src/routes/want.go', 18, 50, 55, 'SYM-WANT')
    insCg.run(2, 2, 'pkg.DoSomething', 'src/routes/dup.go', 18, 60, 65, 'SYM-DUP')
  } else {
    const insCg = db.prepare('INSERT INTO callgraph VALUES (?, ?, ?, ?, ?, ?, ?)')
    insCg.run(1, 1, 'pkg.DoSomething', 'src/routes/want.go', 18, 50, 55)
    insCg.run(2, 2, 'pkg.DoSomething', 'src/routes/dup.go', 18, 60, 65)
  }
  if (withSymbols) {
    const insSym = db.prepare('INSERT INTO symbols VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    insSym.run('SYM-WANT', 'pkg.DoSomething', 'sid-want', 'fclos', 'src/lib/want.go', 50, 55, 'manual')
    insSym.run('SYM-DUP', 'pkg.DoSomething', 'sid-dup', 'fclos', 'src/lib/dup.go', 60, 65, 'manual')
  }
  db.close()
}

describe('SymbolsConsumerCases', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = mkTmpDbPath()
  })

  afterEach(() => {
    rmTmpDb(dbPath)
  })

  it('precise symbol_id cuts cross-file qid collision', () => {
    initSymbolsDb(dbPath, true, true)
    const result = runLookup(dbPath, [{ file: 'src/lib/want.go', startLine: 50, endLine: 50 }])
    assert.deepStrictEqual(epIds(result), ['EP_GT'], JSON.stringify(result, null, 2))
  })

  it('legacy DB without symbols keeps string qid fallback', () => {
    initSymbolsDb(dbPath, false, false)
    const result = runLookup(dbPath, [{ file: 'src/lib/want.go', startLine: 50, endLine: 50 }])
    assert.deepStrictEqual(
      sortedEpIds(result),
      ['EP_FP', 'EP_GT'],
      JSON.stringify(result, null, 2),
    )
  })

  it('callee_symbol_id present but symbols missing keeps qid fallback', () => {
    initSymbolsDb(dbPath, false, true)
    const result = runLookup(dbPath, [{ file: 'src/lib/want.go', startLine: 50, endLine: 50 }])
    assert.deepStrictEqual(
      sortedEpIds(result),
      ['EP_FP', 'EP_GT'],
      JSON.stringify(result, null, 2),
    )
  })

  it('change without callgraph symbol_id falls back to qid', () => {
    initSymbolsDb(dbPath, true, true)
    const conn = new Database(dbPath)
    conn.exec('UPDATE callgraph SET callee_symbol_id = NULL')
    conn.close()
    const result = runLookup(dbPath, [{ file: 'src/lib/want.go', startLine: 50, endLine: 50 }])
    assert.deepStrictEqual(
      sortedEpIds(result),
      ['EP_FP', 'EP_GT'],
      JSON.stringify(result, null, 2),
    )
  })
})
