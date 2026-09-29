import type { Db } from '../db/index.ts'

/**
 * Record what happened, without recording what it was about.
 *
 * Everything written here is counts, vocabulary and outcomes - never entity
 * names, literals, paths or code. That distinction is what lets this log leave a
 * work machine intact while the graph itself stays behind or gets redacted.
 */
export interface ActivityInput {
  source: 'mcp' | 'http' | 'cli'
  tool: string
  session?: string
  agent?: string
  ok?: boolean
  durationMs?: number
  summary?: Record<string, unknown>
  error?: string
}

export async function logActivity(db: Db, a: ActivityInput): Promise<void> {
  try {
    await db.query(
      `insert into activity (source, tool, session, agent, ok, duration_ms, summary, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        a.source, a.tool, a.session ?? null, a.agent ?? null,
        a.ok ?? true, a.durationMs ?? null,
        JSON.stringify(a.summary ?? {}),
        a.error ? a.error.slice(0, 2000) : null,
      ],
    )
  } catch {
    // Logging must never break the thing it is logging.
  }
}

/** Time a call and log it, whatever the outcome. */
export async function tracked<T>(
  db: Db,
  base: Omit<ActivityInput, 'ok' | 'durationMs' | 'summary' | 'error'>,
  fn: () => Promise<{ result: T; summary?: Record<string, unknown> }>,
): Promise<T> {
  const started = Date.now()
  try {
    const { result, summary } = await fn()
    await logActivity(db, { ...base, ok: true, durationMs: Date.now() - started, summary })
    return result
  } catch (err) {
    await logActivity(db, {
      ...base, ok: false, durationMs: Date.now() - started, error: (err as Error).message,
    })
    throw err
  }
}
