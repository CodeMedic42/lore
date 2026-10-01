import { open, type Db } from '../src/db/index.ts'
import { migrate } from '../src/db/migrate.ts'

/** A fresh in-process Postgres per test. No container required. */
export async function freshDb(): Promise<Db> {
  const db = await open({ driver: 'pglite' })
  await migrate(db, { quiet: true })
  return db
}

export async function trustOf(db: Db, propId: string): Promise<number> {
  const r = await db.query<{ trust: number }>('select trust from edge_now where proposition_id = $1', [propId])
  return r.rows[0]?.trust ?? 0
}

export async function liveEdgeCount(db: Db): Promise<number> {
  const r = await db.query<{ n: string }>('select count(*)::text as n from edge_now')
  return Number(r.rows[0]!.n)
}
