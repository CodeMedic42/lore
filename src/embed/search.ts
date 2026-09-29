import type { Db } from '../db/index.ts'
import { cosine, type Embedder } from './index.ts'

export interface SimilarHit {
  entityId: string
  name: string
  kind: string
  env: string
  score: number
  profile: string
}

let pgvector: boolean | null = null
async function hasPgvector(db: Db): Promise<boolean> {
  if (pgvector !== null) return pgvector
  try {
    const r = await db.query<{ has: boolean }>('select has_pgvector() as has')
    pgvector = Boolean(r.rows[0]?.has)
  } catch {
    pgvector = false
  }
  return pgvector
}

export function resetVectorCache(): void {
  pgvector = null
}

/**
 * Find things that resemble a description.
 *
 * This is the ONLY place vector similarity is allowed to decide anything, and
 * even here it decides only where to start looking. Two paths: pgvector does the
 * distance maths in SIMD where the extension exists, and where it does not the
 * cosine is computed in process — which at personal scale is indistinguishable,
 * and keeps the whole feature working on a machine with no extension available.
 */
export async function findSimilar(
  db: Db,
  embedder: Embedder,
  text: string,
  opts: { kinds?: string[]; limit?: number; minScore?: number } = {},
): Promise<SimilarHit[]> {
  const limit = opts.limit ?? 8
  const minScore = opts.minScore ?? 0.25

  const total = await db.query<{ n: string }>('select count(*)::text n from entity_embedding')
  if (!Number(total.rows[0]?.n ?? 0)) return []

  const [vector] = await embedder.embed([text])
  if (!vector) return []

  const kindFilter = opts.kinds?.length
  let hits: SimilarHit[]

  if (await hasPgvector(db)) {
    const r = await db.query<any>(
      `select e.id, e.display_name, e.kind, e.env, em.profile,
              1 - (em.embedding::vector <=> $1::real[]::vector) as score
         from entity_embedding em
         join entity e on e.id = em.entity_id
        where e.canonical_id = e.id ${kindFilter ? 'and e.kind = any($3::text[])' : ''}
        order by em.embedding::vector <=> $1::real[]::vector
        limit $2`,
      kindFilter ? [vector, limit * 3, opts.kinds] : [vector, limit * 3],
    )
    hits = r.rows.map((x: any) => ({
      entityId: x.id, name: x.display_name, kind: x.kind, env: x.env,
      score: Number(x.score), profile: x.profile,
    }))
  } else {
    const r = await db.query<any>(
      `select e.id, e.display_name, e.kind, e.env, em.profile, em.embedding
         from entity_embedding em
         join entity e on e.id = em.entity_id
        where e.canonical_id = e.id ${kindFilter ? 'and e.kind = any($1::text[])' : ''}`,
      kindFilter ? [opts.kinds] : [],
    )
    hits = r.rows.map((x: any) => ({
      entityId: x.id, name: x.display_name, kind: x.kind, env: x.env,
      score: cosine(vector, x.embedding as number[]), profile: x.profile,
    }))
  }

  return hits
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
