import { createHash } from 'node:crypto'
import type { Db } from '../db/index.ts'

/**
 * Turning text into vectors.
 *
 * The default runs a small model in-process: no API key, no network after the
 * first download, no per-query cost, and nothing leaves the machine — which
 * matters when the thing being indexed is an employer's codebase.
 */
export interface Embedder {
  id: string
  dims: number
  embed(texts: string[]): Promise<number[][]>
}

export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2'

/**
 * all-MiniLM-L6-v2 via transformers.js. ~25MB, 384 dimensions, a few milliseconds
 * per text once loaded. Loading costs some seconds, so it happens on first use
 * rather than at startup — an agent that never asks a similarity question should
 * never pay for the model.
 */
export function localEmbedder(model = DEFAULT_MODEL): Embedder {
  let pipe: any | null = null
  let loading: Promise<any> | null = null

  const load = async () => {
    if (pipe) return pipe
    if (!loading) {
      loading = import('@huggingface/transformers').then(({ pipeline }) =>
        pipeline('feature-extraction', model, { dtype: 'fp32' }),
      )
    }
    pipe = await loading
    return pipe
  }

  return {
    id: model,
    dims: 384,
    async embed(texts: string[]): Promise<number[][]> {
      if (!texts.length) return []
      const extractor = await load()
      const out: number[][] = []
      // Batched: the model is happy with many at once, and memory is not.
      for (let i = 0; i < texts.length; i += 32) {
        const chunk = texts.slice(i, i + 32).map((t) => t.slice(0, 2000))
        const res = await extractor(chunk, { pooling: 'mean', normalize: true })
        out.push(...(res.tolist() as number[][]))
      }
      return out
    },
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const mag = Math.sqrt(na) * Math.sqrt(nb)
  return mag ? dot / mag : 0
}

export interface Profile {
  entityId: string
  name: string
  kind: string
  profile: string
}

/**
 * The text that stands in for an entity.
 *
 * Name, kind, whatever prose anyone wrote about it, and a little structural
 * context. The prose matters most: "DateRangePicker" alone is thin material,
 * while "Pick a start and end date" is what someone's question will resemble.
 */
export async function buildProfiles(db: Db, kinds?: string[]): Promise<Profile[]> {
  const rows = await db.query<{ id: string; display_name: string; kind: string }>(
    `select id, display_name, kind from entity
      where canonical_id = id ${kinds?.length ? 'and kind = any($1::text[])' : ''}`,
    kinds?.length ? [kinds] : [],
  )
  if (!rows.rows.length) return []

  const ids = rows.rows.map((r) => r.id)
  const notes = await db.query<{ subject: string; value: string }>(
    `select ec.subject, ec.object_literal as value
       from edges_canon(now()) ec
      where ec.predicate in ('note', 'documented_at') and ec.object_literal is not null
        and ec.subject = any($1::uuid[])`,
    [ids],
  )
  const rel = await db.query<{ subject: string; predicate: string; other: string; dir: string }>(
    `select ec.subject, ec.predicate, o.display_name as other, 'out' as dir
       from edges_canon(now()) ec join entity o on o.id = ec.object
      where ec.subject = any($1::uuid[]) and ec.object is not null
        and ec.predicate in ('part_of','composes','exports','implements','handles_data',
                             'uses_framework','written_in','lives_in_repo','variant_of')
     union all
     select ec.object, ec.predicate, s.display_name, 'in'
       from edges_canon(now()) ec join entity s on s.id = ec.subject
      where ec.object = any($1::uuid[]) and ec.predicate in ('composes','exports')`,
    [ids],
  )

  const noteBy = new Map<string, string[]>()
  for (const n of notes.rows) noteBy.set(n.subject, [...(noteBy.get(n.subject) ?? []), n.value])
  const relBy = new Map<string, string[]>()
  for (const r of rel.rows) {
    const phrase = r.dir === 'out' ? `${r.predicate.replace(/_/g, ' ')} ${r.other}` : `used by ${r.other}`
    relBy.set(r.subject, [...(relBy.get(r.subject) ?? []), phrase])
  }

  return rows.rows.map((e) => {
    const parts = [`${e.display_name} — a ${e.kind.replace(/_/g, ' ')}`]
    for (const n of noteBy.get(e.id) ?? []) parts.push(n)
    const rels = [...new Set(relBy.get(e.id) ?? [])].slice(0, 12)
    if (rels.length) parts.push(rels.join(', '))
    return { entityId: e.id, name: e.display_name, kind: e.kind, profile: parts.join('. ') }
  })
}

export const profileHash = (profile: string, model: string): Buffer =>
  createHash('sha256').update(model).update(profile).digest()

export interface IndexResult {
  considered: number
  embedded: number
  unchanged: number
  model: string
}

/**
 * Embed everything whose description has changed.
 *
 * The profile hash means a re-index after a scan only pays for what actually
 * moved, which keeps this cheap enough to run on every extraction.
 */
export async function indexEmbeddings(
  db: Db,
  embedder: Embedder,
  opts: { kinds?: string[]; force?: boolean } = {},
): Promise<IndexResult> {
  const profiles = await buildProfiles(db, opts.kinds)
  const existing = await db.query<{ entity_id: string; profile_hash: Buffer }>(
    `select entity_id, profile_hash from entity_embedding where model = $1`, [embedder.id])
  const known = new Map(existing.rows.map((r) => [r.entity_id, Buffer.from(r.profile_hash).toString('hex')]))

  const stale = profiles.filter((p) =>
    opts.force || known.get(p.entityId) !== profileHash(p.profile, embedder.id).toString('hex'))

  if (stale.length) {
    const vectors = await embedder.embed(stale.map((p) => p.profile))
    for (let i = 0; i < stale.length; i++) {
      const p = stale[i]!
      const v = vectors[i]
      if (!v) continue
      await db.query(
        `insert into entity_embedding (entity_id, model, dims, embedding, profile, profile_hash, updated_at)
         values ($1,$2,$3,$4,$5,$6, now())
         on conflict (entity_id) do update
           set model = excluded.model, dims = excluded.dims, embedding = excluded.embedding,
               profile = excluded.profile, profile_hash = excluded.profile_hash, updated_at = now()`,
        [p.entityId, embedder.id, v.length, v, p.profile, profileHash(p.profile, embedder.id)],
      )
    }
  }

  return {
    considered: profiles.length,
    embedded: stale.length,
    unchanged: profiles.length - stale.length,
    model: embedder.id,
  }
}
