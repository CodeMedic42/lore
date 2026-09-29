import type { Db } from '../db/index.ts'

/**
 * Cheap, idempotent tidying the graph can do without asking anyone.
 *
 * The rule of thumb: if the graph already contains enough information to settle a
 * question, settling it here is strictly better than spending a human's attention
 * on it. Question quality is the whole budget - a couple of obvious ones and the
 * user stops reading them.
 */
export interface MaintenanceResult {
  endpoints_distinguished: number
}

export async function maintain(db: Db, at: Date = new Date()): Promise<MaintenanceResult> {
  const r = await db.query<{ n: number }>('select auto_distinguish_endpoints($1::timestamptz) as n', [
    at.toISOString(),
  ])
  return { endpoints_distinguished: Number(r.rows[0]?.n ?? 0) }
}
