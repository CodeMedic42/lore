import type { Db } from '../db/index.ts'

/**
 * Scope sweep: the mechanism that actually removes a stale edge.
 *
 * A static scan of a repo is a CLOSED-WORLD snapshot - it sees everything that
 * repo asserts. So anything previously tagged with the same scope_key that this
 * run did not re-assert is no longer true, and gets its world-time validity closed.
 *
 * Without this, a service migrating Redis -> Memcached leaves the Redis edge in
 * place forever. Trust decay does NOT fix that: the edge is still present, the
 * traversal still finds it, and the answer is still wrong - just with a slightly
 * lower score attached.
 *
 * `runStart` must be captured BEFORE the run's assertions are written.
 */
export async function sweepScope(db: Db, scopeKey: string, runStart: Date): Promise<number> {
  const r = await db.query<{ id: string }>(
    `update assertion
        set valid_to = $2
      where scope_key = $1
        and created_at < $2
        and valid_to is null
        and expired_at is null
      returning id`,
    [scopeKey, runStart.toISOString()],
  )
  return r.rows.length
}

/** Begin a scoped run: returns the sweep you must call when the run completes. */
export function beginScopedRun(db: Db, scopeKey: string, now: Date) {
  return {
    scopeKey,
    async finish(): Promise<number> {
      return sweepScope(db, scopeKey, now)
    },
  }
}
