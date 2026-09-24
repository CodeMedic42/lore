import type { Db } from '../db/index.ts'

export interface PredicateResolution {
  /** The canonical predicate to store, or the raw string if nothing matched. */
  predicate: string
  /** True when the raw input was not a known predicate or alias. */
  unmapped: boolean
  raw: string
}

const norm = (s: string) => s.toLowerCase().trim().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '')

/**
 * Map a raw predicate onto the vocabulary.
 *
 * Hard rule from the design: NEVER reject an unknown predicate. An agent that
 * guesses `uses` instead of `reads_from` and gets a 400 will simply stop writing.
 * Unknown predicates are recorded verbatim in predicate_alias with maps_to NULL
 * so the frequent ones can be reviewed and folded into the vocabulary later.
 */
export async function resolvePredicate(db: Db, raw: string): Promise<PredicateResolution> {
  const candidate = norm(raw)

  const exact = await db.query<{ name: string }>('select name from predicate where name = $1', [candidate])
  if (exact.rows[0]) return { predicate: exact.rows[0].name, unmapped: false, raw }

  const alias = await db.query<{ maps_to: string | null }>(
    'select maps_to from predicate_alias where raw = $1',
    [candidate],
  )
  if (alias.rows[0]?.maps_to) return { predicate: alias.rows[0].maps_to, unmapped: false, raw }

  // Record the miss (or bump its counter) so the review queue is ordered by frequency.
  await db.query(
    `insert into predicate_alias (raw, maps_to, hits, last_seen)
     values ($1, null, 1, now())
     on conflict (raw) do update set hits = predicate_alias.hits + 1, last_seen = now()`,
    [candidate],
  )
  return { predicate: candidate, unmapped: true, raw }
}

export async function isFunctional(db: Db, predicate: string): Promise<boolean> {
  const r = await db.query<{ functional: boolean }>('select functional from predicate where name = $1', [predicate])
  return r.rows[0]?.functional ?? false
}

/** Predicates whose object is a literal must never carry a credential value. */
const SECRET_BEARING = new Set(['secret_at', 'connect_via', 'note'])
const SECRET_PATTERNS: RegExp[] = [
  /\b(password|passwd|pwd)\s*[=:]\s*\S+/i,
  /\b(secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*\S+/i,
  /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i,
  /redis:\/\/[^:\s]+:[^@\s]+@/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/,
]

/**
 * "How do I connect to that database" pulls agents toward recording credentials.
 * Store the LOCATION of a secret, never its value.
 */
export function detectSecret(predicate: string, literal: string | null | undefined): string | null {
  if (!literal) return null
  if (!SECRET_BEARING.has(predicate) && !/secret|credential|password|token/i.test(predicate)) {
    // still scan - a secret can be pasted into any literal
  }
  for (const re of SECRET_PATTERNS) {
    if (re.test(literal)) return `literal appears to contain a credential (matched ${re.source.slice(0, 40)})`
  }
  return null
}
