import type { Db } from '../db/index.ts'

export interface TraverseOptions {
  start: string
  /** Predicates walked subject -> object. */
  forward: string[]
  /** Predicates walked object -> subject (e.g. exposes_endpoint, to get from an endpoint back to its service). */
  reverse?: string[]
  maxDepth?: number
  minTrust?: number
  at?: Date
}

export interface Step {
  proposition_id: string
  subject: string
  subject_name: string
  subject_kind: string
  subject_env: string
  predicate: string
  object: string | null
  object_name: string | null
  object_kind: string | null
  object_env: string | null
  object_literal: string | null
  qualifiers: Record<string, unknown>
  trust: number
  derived: boolean
  annotations: Array<{ predicate: string; value: string; trust: number }>
  evidence: Array<Record<string, unknown>>
  support_count: number
  refute_count: number
  /**
   * Anchor state, reported alongside the answer and deliberately NOT multiplied
   * into `trust`. A changed anchor is a reason to re-check the claim, not a
   * reason to pretend we are 70% sure of it.
   */
  needs_reverification: boolean
  anchors_changed: number
  anchors_gone: number
}

export interface FoundPath {
  depth: number
  trust: number
  nodes: string[]
  steps: Step[]
  terminal_kind: string | null
  /** Highest-value entity kind reached anywhere along the path. */
  best_kind: string | null
}

/**
 * Structured traversal over the live edge set.
 *
 * Two things here are load-bearing:
 *
 *  - Directed hops. A template declares which predicates run forward and which
 *    run backward. Without the reverse hop on `exposes_endpoint`, a walk that
 *    reaches an endpoint dead-ends there and can never reach the service behind it.
 *
 *  - Context gating on derived edges. An annotation edge (e.g. `falls_back_to`,
 *    which belongs to one specific read) may only be taken if the walk arrived
 *    along the exact parent edge it annotates. Otherwise a 3-ary fact collapses
 *    into a binary one and the graph starts inventing relationships.
 */
export async function traverse(db: Db, opts: TraverseOptions): Promise<FoundPath[]> {
  const at = (opts.at ?? new Date()).toISOString()
  const maxDepth = opts.maxDepth ?? 6
  const minTrust = opts.minTrust ?? 0.05

  const walk = await db.query<{ depth: number; path: string[]; props: string[]; trust: number }>(
    `with recursive edges as materialized (
       select proposition_id, subject as src, object as dst, predicate, trust, via_proposition
         from edges_canon($1::timestamptz)
        where trust >= $2 and object is not null and predicate = any($3::text[])
       union all
       select proposition_id, object as src, subject as dst, predicate, trust, via_proposition
         from edges_canon($1::timestamptz)
        where trust >= $2 and object is not null and predicate = any($4::text[])
     ),
     walk (node, depth, path, props, trust, last_prop) as (
       select $5::uuid, 0, array[$5::uuid], array[]::uuid[], 1.0::real, null::uuid
       union all
       select e.dst,
              w.depth + 1,
              w.path || e.dst,
              w.props || e.proposition_id,
              (w.trust * e.trust)::real,
              e.proposition_id
         from walk w
         join edges e on e.src = w.node
        where w.depth < $6
          and not e.dst = any(w.path)
          and (e.via_proposition is null or e.via_proposition = w.last_prop)
     )
     select depth, path, props, trust from walk where depth > 0 order by trust desc limit 500`,
    [at, minTrust, opts.forward, opts.reverse ?? [], opts.start, maxDepth],
  )
  if (!walk.rows.length) return []

  const allProps = [...new Set(walk.rows.flatMap((r) => r.props))]
  const steps = await hydrate(db, allProps, at)
  const kinds = await entityKinds(db, [...new Set(walk.rows.flatMap((r) => r.path))])

  return walk.rows.map((r) => {
    const pathKinds = r.path.map((n) => kinds.get(n) ?? null).filter((k): k is string => Boolean(k))
    return {
      depth: r.depth,
      trust: r.trust,
      nodes: r.path,
      steps: r.props.map((p) => steps.get(p)).filter((s): s is Step => Boolean(s)),
      terminal_kind: kinds.get(r.path[r.path.length - 1]!) ?? null,
      best_kind: pathKinds.reduce<string | null>(
        (best, k) => ((KIND_VALUE[k] ?? 0) > (KIND_VALUE[best ?? ''] ?? 0) ? k : best),
        null,
      ),
    }
  })
}

/** How much reaching a given kind answers a provenance question. */
const KIND_VALUE: Record<string, number> = {
  datastore: 6,
  cloud_resource: 5,
  queue: 4,
  cache: 3,
  iac_module: 2,
  repo: 1,
}

async function hydrate(db: Db, propIds: string[], at: string): Promise<Map<string, Step>> {
  const rows = await db.query<any>(
    `select ec.proposition_id, ec.subject, ec.predicate, ec.object, ec.object_literal,
            ec.qualifiers, ec.trust, ec.derived,
            se.display_name as subject_name, se.kind as subject_kind, se.env as subject_env,
            oe.display_name as object_name,  oe.kind as object_kind,  oe.env as object_env,
            coalesce(agg.evidence, '[]'::jsonb) as evidence,
            coalesce(agg.support_count, 0) as support_count,
            coalesce(agg.refute_count, 0)  as refute_count
       from edges_canon($1::timestamptz) ec
       join entity se on se.id = ec.subject
       left join entity oe on oe.id = ec.object
       left join lateral (
         select jsonb_agg(ev) filter (where ev is not null) as evidence,
                count(*) filter (where a.polarity)     as support_count,
                count(*) filter (where not a.polarity) as refute_count
           from assertion a
           left join lateral jsonb_array_elements(a.evidence) ev on true
          where a.proposition_id = ec.proposition_id
            and (a.expired_at is null or a.expired_at > $1::timestamptz)
            and (a.valid_to   is null or a.valid_to   > $1::timestamptz)
       ) agg on true
      where ec.proposition_id = any($2::uuid[])`,
    [at, propIds],
  )

  const annots = await db.query<{ about_proposition: string; predicate: string; value: string; trust: number }>(
    `select * from prop_annotations($1::timestamptz) where about_proposition = any($2::uuid[])`,
    [at, propIds],
  )
  const byProp = new Map<string, Array<{ predicate: string; value: string; trust: number }>>()
  for (const a of annots.rows) {
    const list = byProp.get(a.about_proposition) ?? []
    list.push({ predicate: a.predicate, value: a.value, trust: a.trust })
    byProp.set(a.about_proposition, list)
  }

  const anchorRows = await db.query<{
    proposition_id: string; changed: number; gone: number; needs_reverification: boolean
  }>(
    `select proposition_id, changed, gone, needs_reverification
       from proposition_anchor_state($1::timestamptz)
      where proposition_id = any($2::uuid[])`,
    [at, propIds],
  )
  const anchorByProp = new Map(anchorRows.rows.map((a) => [a.proposition_id, a]))

  const out = new Map<string, Step>()
  for (const r of rows.rows) {
    const anchor = anchorByProp.get(r.proposition_id)
    out.set(r.proposition_id, {
      ...r,
      qualifiers: r.qualifiers ?? {},
      evidence: r.evidence ?? [],
      annotations: byProp.get(r.proposition_id) ?? [],
      support_count: Number(r.support_count),
      refute_count: Number(r.refute_count),
      needs_reverification: anchor?.needs_reverification ?? false,
      anchors_changed: Number(anchor?.changed ?? 0),
      anchors_gone: Number(anchor?.gone ?? 0),
    })
  }
  return out
}

async function entityKinds(db: Db, ids: string[]): Promise<Map<string, string>> {
  const r = await db.query<{ id: string; kind: string }>('select id, kind from entity where id = any($1::uuid[])', [ids])
  return new Map(r.rows.map((x) => [x.id, x.kind]))
}

// ---------------------------------------------------------------------------
// Path templates
// ---------------------------------------------------------------------------

export interface Template {
  forward: string[]
  reverse: string[]
  maxDepth: number
  terminals: string[]
}

export const TEMPLATES = {
  /** "Where does this data come from?" - the motivating query. */
  data_provenance: {
    forward: [
      'calls', 'reads_from', 'caches_in', 'falls_back_to', 'subscribes_to',
      'writes_to', 'provisioned_by', 'deployed_to', 'lives_in_repo',
    ],
    // From an endpoint, step back to the service that serves it.
    reverse: ['exposes_endpoint', 'publishes_to'],
    maxDepth: 7,
    terminals: ['datastore', 'cache', 'queue', 'cloud_resource', 'iac_module', 'repo'],
  },
  /** "What breaks if I change this?" */
  blast_radius: {
    forward: [],
    reverse: ['calls', 'reads_from', 'writes_to', 'caches_in', 'subscribes_to', 'publishes_to', 'depends_on', 'exposes_endpoint'],
    maxDepth: 5,
    terminals: ['client', 'service', 'endpoint'],
  },
  /** "How do I connect?" - yields where the secret lives, never the secret. */
  access: {
    forward: ['connect_via', 'secret_at', 'provisioned_by', 'deployed_to', 'lives_in_repo'],
    reverse: [],
    maxDepth: 3,
    terminals: ['cloud_resource', 'iac_module', 'repo'],
  },
} satisfies Record<string, Template>

export type TemplateName = keyof typeof TEMPLATES

/**
 * Run a template and rank the results.
 *
 * Ranking prefers the most valuable kind the path REACHED ANYWHERE, not just at
 * its final node: a walk that passes through the database and continues on to the
 * Terraform module that provisions it is a better answer than one that stops at
 * the database, and far better than one that only ever found a repo.
 *
 * Low-trust paths are returned labelled rather than hidden - an unverified path
 * still beats grep as a starting point.
 */
export async function runTemplate(
  db: Db,
  template: TemplateName,
  start: string,
  opts: { minTrust?: number; at?: Date; maxDepth?: number } = {},
): Promise<FoundPath[]> {
  const t: Template = TEMPLATES[template]
  const paths = await traverse(db, {
    start,
    forward: t.forward,
    reverse: t.reverse,
    maxDepth: opts.maxDepth ?? t.maxDepth,
    minTrust: opts.minTrust,
    at: opts.at,
  })

  return paths
    .sort((a, b) => {
      const av = KIND_VALUE[a.best_kind ?? ''] ?? 0
      const bv = KIND_VALUE[b.best_kind ?? ''] ?? 0
      if (av !== bv) return bv - av
      if (Math.abs(b.trust - a.trust) > 0.02) return b.trust - a.trust
      return b.depth - a.depth
    })
    .filter((p, i, arr) => arr.findIndex((q) => q.nodes.join('>') === p.nodes.join('>')) === i)
}

/** Drop paths that are a strict prefix of a longer returned path. */
export function prunePrefixes(paths: FoundPath[]): FoundPath[] {
  const keys = paths.map((p) => p.nodes.join('>'))
  return paths.filter((p, i) => !keys.some((k, j) => j !== i && k.startsWith(`${keys[i]}>`)))
}

export interface EntityFact {
  predicate: string
  value: string
  trust: number
  evidence: Array<Record<string, unknown>>
  refute_count: number
}

/**
 * Literal-valued facts attached to entities (connect_via, secret_at, note, ...).
 *
 * These are leaf attributes, not hops: traversal walks entity -> entity, and a
 * literal has no outgoing edges. They are fetched for every node on a returned
 * path so "how do I connect" can answer with the connection recipe and the
 * LOCATION of the credential.
 */
export async function entityFacts(
  db: Db,
  entityIds: string[],
  at: Date = new Date(),
): Promise<Map<string, EntityFact[]>> {
  if (!entityIds.length) return new Map()
  const r = await db.query<any>(
    `select ec.subject, ec.predicate, ec.object_literal as value, ec.trust,
            coalesce(agg.evidence, '[]'::jsonb) as evidence,
            coalesce(agg.refute_count, 0) as refute_count
       from edges_canon($1::timestamptz) ec
       left join lateral (
         select jsonb_agg(ev) filter (where ev is not null) as evidence,
                count(*) filter (where not a.polarity) as refute_count
           from assertion a
           left join lateral jsonb_array_elements(a.evidence) ev on true
          where a.proposition_id = ec.proposition_id
            and (a.expired_at is null or a.expired_at > $1::timestamptz)
            and (a.valid_to   is null or a.valid_to   > $1::timestamptz)
       ) agg on true
      where ec.object_literal is not null
        and ec.subject = any($2::uuid[])
      order by ec.trust desc`,
    [at.toISOString(), entityIds],
  )
  const out = new Map<string, EntityFact[]>()
  for (const row of r.rows) {
    const list = out.get(row.subject) ?? []
    list.push({
      predicate: row.predicate,
      value: row.value,
      trust: row.trust,
      evidence: row.evidence ?? [],
      refute_count: Number(row.refute_count),
    })
    out.set(row.subject, list)
  }
  return out
}
