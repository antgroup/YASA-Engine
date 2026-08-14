import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

type SqliteDatabaseOptions = Database.Options & {
  nativeBinding?: string
}

type SqliteDatabaseConstructor = new (filename: string, options?: SqliteDatabaseOptions) => Database.Database

function isPkgRuntime(): boolean {
  return Boolean((process as unknown as { pkg?: unknown }).pkg)
}

function resolveDevelopmentNativeBinding(): string | undefined {
  if (process.versions.modules !== '108') return undefined

  const nativeBinding = path.resolve(
    __dirname,
    '..',
    '..',
    'native',
    'better-sqlite3',
    `${process.platform}-${process.arch}`,
    'better_sqlite3.node'
  )
  return fs.existsSync(nativeBinding) ? nativeBinding : undefined
}

function resolveNativeBinding(): string | undefined {
  if (!isPkgRuntime()) return resolveDevelopmentNativeBinding()

  const nativeBinding = path.join(`${process.execPath}.native`, 'better-sqlite3.node')
  if (!fs.existsSync(nativeBinding)) {
    throw new Error(`缺少 SQLite native addon: ${nativeBinding}`)
  }
  return nativeBinding
}

/** pkg 与 Node 18 开发环境均从真实文件系统加载已校验的 native addon。 */
export function createSqliteDatabase(filename: string, options?: Database.Options): Database.Database {
  const nativeBinding = resolveNativeBinding()
  const databaseOptions: SqliteDatabaseOptions = nativeBinding
    ? { ...options, nativeBinding }
    : { ...options }
  const SqliteDatabase = Database as unknown as SqliteDatabaseConstructor
  return new SqliteDatabase(filename, databaseOptions)
}
