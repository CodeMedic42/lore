import type { Db } from '../db/index.ts'
import { normaliseIdentifier, type StrongIdentifier } from '../domain/identifiers.ts'

export type { StrongIdentifier }

export interface MentionInput {
  raw: string
  kind?: string
  env?: string
  scope?: string                  // where the name was observed, e.g. 'gitlab:4412'
  identifiers?: StrongIdentifier[]
}

export interface Resolution {
  entityId: string
  resolver: 'strong_id' | 'alias' | 'alias_global' | 'minted'
  score: number
  minted: boolean
  displayName: string
  /** A near-miss filed for review. The mention was NOT resolved onto it. */
  candidate?: { entityId: string; displayName: string; score: number }
  /** Problems worth telling the caller about, e.g. a misspelled identifier authority. */
  warnings?: string[]
}

/**
 * Similarity at or above this files a merge candidate for review. It does NOT
 * resolve: see the note on rung 4. There is deliberately no auto-accept
 * threshold - name similarity proposes, a strong identifier or a human decides.
 */
export const CANDIDATE_THRESHOLD = 0.7

/**
 * Kinds that describe source code rather than a running thing.
 *
 * A package has no prod and staging version; it is one package. A database does.
 * Partitioning code artefacts by environment is how the first real agent run
 * produced a twin of every scanned package: the extractor wrote env='prod', an
 * observation without an explicit env wrote 'unknown', and the two never met.
 */
const ENVIRONMENTLESS = new Set([
  'package', 'repo', 'component', 'technology', 'capability',
  'data_concept', 'team', 'domain', 'iac_module', 'pipeline', 'endpoint',
])

export function normaliseEnv(kind: string | undefined, env: string | undefined): string {
  const e = (env ?? 'unknown').toLowerCase()
  return kind && ENVIRONMENTLESS.has(kind) ? 'unknown' : e
}

export function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.\-/]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Follow an entity to its canonical target. Path-compressed on merge, so one hop. */
export async function canonical(db: Db, entityId: string): Promise<string> {
  const r = await db.query<{ canonical_id: string }>('select canonical_id from entity where id = $1', [entityId])
  return r.rows[0]?.canonical_id ?? entityId
}

let trigramAvailable: boolean | null = null
async function hasTrigram(db: Db): Promise<boolean> {
  if (trigramAvailable !== null) return trigramAvailable
  const r = await db.query<{ n: string }>(`select count(*)::text as n from pg_extension where extname = 'pg_trgm'`)
  trigramAvailable = Number(r.rows[0]?.n ?? 0) > 0
  return trigramAvailable
}

/**
 * The resolution ladder. Never blocks, never fails: the bottom rung always mints.
 *
 *   1. strong identifier exact  - a uniqueness CONSTRAINT, not a heuristic
 *   2. alias exact within scope - the same name in the same repo is the same thing
 *   3. alias exact globally     - same name elsewhere; weaker, still usually right
 *   4. fuzzy above threshold    - marked as such so a later pass can revisit
 *   5. mint a provisional entity
 *
 * `env` is enforced as a hard partition at every rung. Resolving a staging mention
 * onto a prod entity is the failure mode that makes "how do I connect" dangerous,
 * so a mismatch is never bridged - it mints a separate entity instead.
 */
export async function resolveEntity(db: Db, m: MentionInput): Promise<Resolution> {
  const env = normaliseEnv(m.kind, m.env)
  const nameNorm = normaliseName(m.raw)

  // Rung 1: strong identifiers.
  const warnings: string[] = []
  for (const id of m.identifiers ?? []) {
    const norm = await normaliseIdentifier(db, id)
    if (norm.warning) warnings.push(norm.warning)
    const hit = await db.query<{ entity_id: string; display_name: string }>(
      `select ei.entity_id, e.display_name
         from entity_identifier ei join entity e on e.id = ei.entity_id
        where ei.authority = $1 and ei.value = $2`,
      [norm.authority, norm.value],
    )
    const row = hit.rows[0]
    if (row) {
      const target = await canonical(db, row.entity_id)
      warnings.push(...(await attachIdentifiers(db, target, m.identifiers ?? [])))
      await attachAlias(db, target, nameNorm, m.scope, 'strong_id', 0.9)
      return {
        entityId: target, resolver: 'strong_id', score: 1, minted: false,
        displayName: row.display_name, warnings: warnings.length ? [...new Set(warnings)] : undefined,
      }
    }
  }

  // Rungs 2 and 3: an exact name match.
  //
  // `kind` is a PREFERENCE, not a filter. An agent guesses the kind, and the same
  // thing called a "package" by one writer and a "repo" by another is far more
  // likely one entity mislabelled than two distinct things. Filtering on it
  // silently minted a duplicate every time a guess differed.
  const candidates = await db.query<{
    id: string; display_name: string; kind: string; env: string; scoped: boolean
  }>(
    `select distinct e.id, e.display_name, e.kind, e.env,
            bool_or(a.scope is not distinct from $3) as scoped
       from entity_alias a join entity e on e.id = a.entity_id
      where a.name_norm = $1 and e.canonical_id = e.id
        and (e.env = $2 or e.env = 'unknown' or $2 = 'unknown')
      group by e.id, e.display_name, e.kind, e.env`,
    [nameNorm, env, m.scope ?? null],
  )

  if (candidates.rows.length) {
    // An unknown env must not pick between prod and staging. If the name exists in
    // more than one REAL environment, minting a third is wrong but so is guessing:
    // fall through and let the merge-candidate queue surface it.
    const realEnvs = new Set(candidates.rows.map((c) => c.env).filter((e) => e !== 'unknown'))
    if (!(env === 'unknown' && realEnvs.size > 1)) {
      const ranked = candidates.rows.sort((a, b) => {
        const kindMatch = (x: typeof a) => (m.kind && x.kind === m.kind ? 1 : 0)
        const envMatch = (x: typeof a) => (x.env === env ? 1 : 0)
        return (
          kindMatch(b) - kindMatch(a) ||
          envMatch(b) - envMatch(a) ||
          Number(b.scoped) - Number(a.scoped)
        )
      })
      const row = ranked[0]!
      const viaScope = row.scoped
      warnings.push(...(await attachIdentifiers(db, row.id, m.identifiers ?? [])))
      if (!viaScope) await attachAlias(db, row.id, nameNorm, m.scope, 'alias_global', 0.7)
      if (m.kind && row.kind !== m.kind) {
        warnings.push(
          `resolved "${m.raw}" onto an existing ${row.kind} rather than creating a new ${m.kind}; ` +
          `if they are genuinely different things, give them distinct names`,
        )
      }
      return {
        entityId: row.id,
        resolver: viaScope ? 'alias' : 'alias_global',
        score: viaScope ? 0.9 : 0.75,
        minted: false,
        displayName: row.display_name,
        warnings: warnings.length ? [...new Set(warnings)] : undefined,
      }
    }
  }

  // Rung 4: fuzzy PROPOSES, it never decides.
  //
  // Auto-accepting a similar name is the over-merge failure mode: "service-b" and
  // "service-c" score ~0.88 on trigram similarity and are different services. So a
  // near-miss is recorded as a candidate and the mention still mints its own
  // entity. Under-merge leaves a visible island; over-merge corrupts answers
  // silently and forever.
  const fuzzy = await fuzzyCandidate(db, nameNorm, env, m.kind)

  // Rung 5: mint.
  const minted = await db.query<{ id: string }>(
    `insert into entity (id, canonical_id, kind, env, display_name, provisional)
     values (gen_random_uuid(), gen_random_uuid(), $1, $2, $3, true)
     returning id`,
    [m.kind ?? 'unknown', env, m.raw.trim()],
  )
  const id = minted.rows[0]!.id
  await db.query('update entity set canonical_id = id where id = $1', [id])
  await attachAlias(db, id, nameNorm, m.scope, 'minted', 0.5)
  warnings.push(...(await attachIdentifiers(db, id, m.identifiers ?? [])))

  if (fuzzy && fuzzy.score >= CANDIDATE_THRESHOLD && fuzzy.id !== id) {
    await db.query(
      `insert into merge_candidate (from_id, into_id, score, method, raw_text)
       values ($1, $2, $3, 'name_similarity', $4)
       on conflict do nothing`,
      [id, fuzzy.id, fuzzy.score, m.raw],
    )
  }

  return {
    entityId: id,
    resolver: 'minted',
    score: 0.5,
    minted: true,
    displayName: m.raw.trim(),
    candidate: fuzzy && fuzzy.score >= CANDIDATE_THRESHOLD
      ? { entityId: fuzzy.id, displayName: fuzzy.display_name, score: fuzzy.score }
      : undefined,
    warnings: warnings.length ? [...new Set(warnings)] : undefined,
  }
}

async function fuzzyCandidate(
  db: Db,
  nameNorm: string,
  env: string,
  kind?: string,
): Promise<{ id: string; display_name: string; score: number } | null> {
  if (await hasTrigram(db)) {
    const r = await db.query<{ id: string; display_name: string; score: number }>(
      `select e.id, e.display_name, max(similarity(a.name_norm, $1))::real as score
         from entity_alias a join entity e on e.id = a.entity_id
        where e.env = $2 and e.canonical_id = e.id ${kind ? 'and e.kind = $3' : ''}
          and a.name_norm % $1
        group by e.id, e.display_name
        order by score desc
        limit 1`,
      kind ? [nameNorm, env, kind] : [nameNorm, env],
    )
    return r.rows[0] ?? null
  }

  // Fallback for drivers without pg_trgm: Dice coefficient over bigrams, in process.
  const r = await db.query<{ id: string; display_name: string; name_norm: string }>(
    `select e.id, e.display_name, a.name_norm
       from entity_alias a join entity e on e.id = a.entity_id
      where e.env = $1 and e.canonical_id = e.id ${kind ? 'and e.kind = $2' : ''}`,
    kind ? [env, kind] : [env],
  )
  let best: { id: string; display_name: string; score: number } | null = null
  for (const row of r.rows) {
    const score = dice(nameNorm, row.name_norm)
    if (!best || score > best.score) best = { id: row.id, display_name: row.display_name, score }
  }
  return best
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function dice(a: string, b: string): number {
  if (a === b) return 1
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let overlap = 0
  for (const g of A) if (B.has(g)) overlap++
  return (2 * overlap) / (A.size + B.size)
}

async function attachAlias(db: Db, entityId: string, nameNorm: string, scope: string | undefined, source: string, score: number) {
  if (!nameNorm) return
  await db.query(
    `insert into entity_alias (entity_id, name_norm, scope, source, score)
     values ($1, $2, $3, $4, $5)
     on conflict (entity_id, name_norm, coalesce(scope, '')) do nothing`,
    [entityId, nameNorm, scope ?? null, source, score],
  )
}

async function attachIdentifiers(db: Db, entityId: string, ids: StrongIdentifier[]): Promise<string[]> {
  const warnings: string[] = []
  for (const id of ids) {
    // Normalise first: (authority, value) is a uniqueness constraint, so
    // 'gitlab-project' and 'gitlab_project' would otherwise be different
    // namespaces and the identity guarantee silently disappears.
    const n = await normaliseIdentifier(db, id)
    if (n.warning) warnings.push(n.warning)
    await db.query(
      `insert into entity_identifier (entity_id, authority, value) values ($1, $2, $3)
       on conflict (authority, value) do nothing`,
      [entityId, n.authority, n.value],
    )
  }
  if (ids.length) await db.query('update entity set provisional = false where id = $1', [entityId])
  return warnings
}

/**
 * Merge `fromId` into `intoId`.
 *
 * A pure insert plus a canonical_id repoint: no assertion, proposition or mention
 * row is rewritten. That is what makes `unmerge` possible - every assertion still
 * points at the entity it was written against, and still carries its original raw
 * mention text.
 */
export async function merge(
  db: Db,
  fromId: string,
  intoId: string,
  opts: { score?: number; reason?: string; decidedBy?: string } = {},
): Promise<void> {
  if (fromId === intoId) return
  const blocked = await db.query<{ n: string }>(
    `select count(*)::text as n from entity_distinct
      where (a = $1 and b = $2) or (a = $2 and b = $1)`,
    [fromId, intoId],
  )
  if (Number(blocked.rows[0]?.n ?? 0) > 0) {
    throw new Error('refusing merge: this pair is recorded in entity_distinct')
  }
  const envs = await db.query<{ id: string; env: string }>(
    'select id, env from entity where id = any($1::uuid[])',
    [[fromId, intoId]],
  )
  const distinctEnvs = new Set(envs.rows.map((r) => r.env).filter((e) => e !== 'unknown'))
  if (distinctEnvs.size > 1) {
    throw new Error(`refusing merge across environments (${[...distinctEnvs].join(' vs ')})`)
  }

  await db.query('insert into entity_merge (from_id, into_id, score, reason, decided_by) values ($1,$2,$3,$4,$5)', [
    fromId, intoId, opts.score ?? null, opts.reason ?? null, opts.decidedBy ?? 'system',
  ])
  // Path-compress: anything already pointing at fromId follows along.
  await db.query('update entity set canonical_id = $2 where canonical_id = $1', [fromId, intoId])
}

export async function unmerge(db: Db, mergeId: number): Promise<void> {
  const r = await db.query<{ from_id: string; into_id: string }>(
    'select from_id, into_id from entity_merge where id = $1 and reverted_at is null',
    [mergeId],
  )
  const row = r.rows[0]
  if (!row) throw new Error(`no active merge ${mergeId}`)
  await db.query('update entity_merge set reverted_at = now() where id = $1', [mergeId])
  await db.query('update entity set canonical_id = id where id = $1', [row.from_id])
}

export async function markDistinct(db: Db, a: string, b: string, reason: string, decidedBy = 'human'): Promise<void> {
  const [x, y] = a < b ? [a, b] : [b, a]
  await db.query(
    `insert into entity_distinct (a, b, reason, decided_by) values ($1,$2,$3,$4)
     on conflict (a, b) do nothing`,
    [x, y, reason, decidedBy],
  )
}
