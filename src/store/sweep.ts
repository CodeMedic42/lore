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

export interface SweepSummary {
  /** Assertion rows closed. Mostly the previous run's, superseded by this one. */
  closedAssertions: number
  /** Edges that lost ALL support and are therefore gone from the graph.
   *  This is the number worth reporting: things that really left the code. */
  removedEdges: number
}

/** Begin a scoped run: returns the sweep you must call when the run completes. */
export function beginScopedRun(db: Db, scopeKey: string, now: Date) {
  return {
    scopeKey,
    async finish(): Promise<SweepSummary> {
      const closedAssertions = await sweepScope(db, scopeKey, now)
      // A re-asserted fact has a fresh assertion and is still live, so counting
      // closed rows would report every scan as a mass deletion. What matters is
      // how many propositions this scope no longer supports at all.
      const gone = await db.query<{ n: string }>(
        `select count(*)::text as n
           from (select distinct proposition_id from assertion where scope_key = $1) x
          where not exists (select 1 from edge_now e where e.proposition_id = x.proposition_id)`,
        [scopeKey],
      )
      return { closedAssertions, removedEdges: Number(gone.rows[0]?.n ?? 0) }
    },
  }
}
