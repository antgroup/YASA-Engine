export type DataflowDbQueryParams = readonly unknown[] | Readonly<Record<string, unknown>>

export interface DataflowDbQueryMetadata {
  dbPath: string
  commitSeq: number
  committedAt: string
  state: 'running' | 'closed'
}

export interface DataflowDbQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[]
  metadata: DataflowDbQueryMetadata
}

interface DataflowDbRuntimeState {
  enabled: boolean
  initialized: boolean
  closed: boolean
  dbPath: string | null
  transactionOpen: boolean
  commitSeq: number
  lastCommitAt: string | null
  writeFailed: boolean
  writeError: string | null
}

interface DataflowDbStatsModule {
  getDataflowDbRuntimeState(): DataflowDbRuntimeState
  flushDataflowDbPendingWrites(): void
  getDataflowDbQueryMetadata(state: 'running' | 'closed'): DataflowDbQueryMetadata
  queryOpenDataflowDb<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: DataflowDbQueryParams
  ): Row[]
  queryClosedDataflowDb<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: DataflowDbQueryParams
  ): DataflowDbQueryResult<Row>
}

const WRITE_KEYWORDS = new Set([
  'alter',
  'analyze',
  'attach',
  'begin',
  'commit',
  'create',
  'delete',
  'detach',
  'drop',
  'insert',
  'pragma',
  'reindex',
  'release',
  'replace',
  'rollback',
  'savepoint',
  'truncate',
  'update',
  'vacuum',
])

/** 获取 dataflow DB writer 模块。
 *
 * @returns {DataflowDbStatsModule} dataflow DB writer 运行期接口。
 */
function loadStatsModule(): DataflowDbStatsModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./dataflow-edge-stats') as DataflowDbStatsModule
}

/** 判断值是否为命名参数对象。
 *
 * @param value 待检查值。
 * @returns {boolean} 非数组对象为 true。
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 校验 SQL 参数形态。
 *
 * @param params 查询参数。
 * @returns {void} 参数合法时无返回值。
 */
function validateParams(params: DataflowDbQueryParams | undefined): void {
  if (params === undefined) return
  if (Array.isArray(params) || isRecord(params)) return
  throw new Error('dataflow db query params must be an array or named parameter object')
}

/** 清理 SQL 注释与字面量用于只读校验。
 *
 * @param sql 原始 SQL。
 * @returns {string} 保留结构字符的清理后 SQL。
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
function stripSqlForValidation(sql: string): string {
  let output = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        output += ' '
        i++
      }
      continue
    }
    if (ch === '/' && next === '*') {
      output += '  '
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        output += sql[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < sql.length) {
        output += '  '
        i += 2
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      output += ' '
      i++
      while (i < sql.length) {
        output += sql[i] === '\n' ? '\n' : ' '
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            output += ' '
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '[') {
      output += ' '
      i++
      while (i < sql.length) {
        output += sql[i] === '\n' ? '\n' : ' '
        if (sql[i] === ']') {
          i++
          break
        }
        i++
      }
      continue
    }
    output += ch
    i++
  }
  return output
}

/** 判断 SQL 是否包含多条语句。
 *
 * @param cleanedSql 已清理 SQL。
 * @returns {boolean} 出现非尾部分号内容时为 true。
 */
function hasMultipleStatements(cleanedSql: string): boolean {
  const trimmed = cleanedSql.trim()
  const firstSemicolon = trimmed.indexOf(';')
  if (firstSemicolon === -1) return false
  return trimmed.slice(firstSemicolon + 1).trim().length > 0
}

/** 提取 SQL 关键字 token。
 *
 * @param cleanedSql 已清理 SQL。
 * @returns {string[]} 小写 token 列表。
 */
function tokens(cleanedSql: string): string[] {
  return cleanedSql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []
}

/** 判断 WITH 查询外层是否落到 SELECT。
 *
 * @param cleanedSql 已清理 SQL。
 * @returns {boolean} 顶层 SELECT 存在时为 true。
 */
function hasTopLevelSelectAfterWith(cleanedSql: string): boolean {
  let depth = 0
  let i = 0
  while (i < cleanedSql.length) {
    const ch = cleanedSql[i]
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i++
      continue
    }
    if (depth === 0 && /[a-z_]/i.test(ch)) {
      const start = i
      i++
      while (i < cleanedSql.length && /[a-z0-9_]/i.test(cleanedSql[i])) i++
      if (cleanedSql.slice(start, i).toLowerCase() === 'select') return true
      continue
    }
    i++
  }
  return false
}

// 以下为安全注释COSEC：查询 API 只接受单条只读 SELECT/WITH SELECT，用户数据必须通过 better-sqlite3 参数绑定传入。
/** 校验 SQL 为单条只读查询。
 *
 * @param sql 原始 SQL。
 * @returns {string} 原始 SQL。
 */
function validateReadonlySql(sql: string): string {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('dataflow db query SQL must be a non-empty string')
  }
  const cleaned = stripSqlForValidation(sql)
  if (hasMultipleStatements(cleaned)) {
    throw new Error('dataflow db query SQL must contain exactly one readonly statement')
  }
  const cleanedStatement = cleaned.trim().replace(/;+\s*$/, '')
  const sqlTokens = tokens(cleanedStatement)
  const firstToken = sqlTokens[0]
  if (firstToken !== 'select' && firstToken !== 'with') {
    throw new Error('dataflow db query only allows SELECT or WITH SELECT statements')
  }
  if (firstToken === 'with' && !hasTopLevelSelectAfterWith(cleanedStatement)) {
    throw new Error('dataflow db query WITH statement must resolve to SELECT')
  }
  for (const token of sqlTokens) {
    if (WRITE_KEYWORDS.has(token)) {
      throw new Error(`dataflow db query rejects write or control keyword: ${token}`)
    }
  }
  return sql
}

/** 查询运行期 dataflow DB。
 *
 * @param sql 单条只读 SELECT/WITH SELECT。
 * @param params 位置参数或命名参数。
 * @returns {DataflowDbQueryResult<Row>} 查询 rows 与运行期 metadata。
 */
export function queryDataflowDb<Row extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: DataflowDbQueryParams
): DataflowDbQueryResult<Row> {
  const safeSql = validateReadonlySql(sql)
  validateParams(params)

  const stats = loadStatsModule()
  const state = stats.getDataflowDbRuntimeState()
  if (!state.initialized || !state.dbPath) {
    throw new Error('dataflow db query requires --dataflowDb to be enabled and initialized')
  }
  if (state.closed) {
    return stats.queryClosedDataflowDb<Row>(safeSql, params)
  }
  if (state.writeFailed) {
    throw new Error(`dataflow db query cannot continue after write failure: ${state.writeError ?? 'unknown error'}`)
  }
  if (!state.enabled) {
    throw new Error('dataflow db query requires --dataflowDb to be enabled')
  }

  stats.flushDataflowDbPendingWrites()
  const rows = stats.queryOpenDataflowDb<Row>(safeSql, params)
  return { rows, metadata: stats.getDataflowDbQueryMetadata('running') }
}
