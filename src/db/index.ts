/**
 * Storage adapter.
 *
 * Two drivers behind one interface:
 *   - `pg`     : a real PostgreSQL server (dev + production). Gives pg_trgm today
 *                and pgvector later.
 *   - `pglite` : PostgreSQL compiled to WASM, in-process. Zero setup, used by the
 *                test suite so tests need no container.
 *
 * Every query in this codebase is plain SQL that runs unchanged on both.
 */

export interface QueryResult<T = any> {
  rows: T[]
}

export interface Db {
  driver: 'pg' | 'pglite'
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
  exec(sql: string): Promise<void>
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

const DEFAULT_URL = 'postgres://lak:lak@localhost:55432/lak'

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_URL
}

/**
 * Open the configured database.
 *
 *   LAK_DRIVER=pglite   run PostgreSQL in-process, no server, no container.
 *   LAK_DATA_DIR=path   where PGlite keeps its files. Without it the database
 *                       lives in memory and vanishes on exit, which is right for
 *                       tests and wrong for everything else.
 *
 * The pglite path exists so a machine with no Docker - a locked-down work laptop,
 * say - can still run the whole thing with nothing but Node.
 */
export async function open(opts: { driver?: 'pg' | 'pglite'; url?: string; dataDir?: string } = {}): Promise<Db> {
  const driver = opts.driver ?? (process.env.LAK_DRIVER as 'pg' | 'pglite' | undefined) ?? 'pg'
  if (driver !== 'pglite') return openPg(opts.url ?? databaseUrl())
  const dataDir = opts.dataDir ?? process.env.LAK_DATA_DIR
  return openPglite(dataDir)
}

async function openPg(url: string): Promise<Db> {
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: url, max: 8 })

  const wrap = (runner: { query: (sql: string, params?: unknown[]) => Promise<any> }): Omit<Db, 'close' | 'tx' | 'driver'> => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await runner.query(sql, params as any[])
      return { rows: (r.rows ?? []) as T[] }
    },
    async exec(sql: string) {
      await runner.query(sql)
    },
  })

  return {
    driver: 'pg',
    ...wrap(pool),
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const scoped: Db = {
          driver: 'pg',
          ...wrap(client),
          tx: (inner) => inner(scoped), // already inside a transaction
          close: async () => {},
        }
        const out = await fn(scoped)
        await client.query('commit')
        return out
      } catch (err) {
        await client.query('rollback').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
    async close() {
      await pool.end()
    },
  }
}

async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite')
  const pglite = await PGlite.create(dataDir ? { dataDir } : undefined)

  const base = {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await pglite.query(sql, params as any[])
      return { rows: (r.rows ?? []) as T[] }
    },
    async exec(sql: string) {
      await pglite.exec(sql)
    },
  }

  const db: Db = {
    driver: 'pglite',
    ...base,
    async tx<T>(fn: (d: Db) => Promise<T>): Promise<T> {
      // PGlite is single-connection; a nested BEGIN would error, so reuse the handle.
      return fn(db)
    },
    async close() {
      await pglite.close()
    },
  }
  return db
}
