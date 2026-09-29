import type { Db } from '../db/index.ts'
import { normaliseName } from '../resolver/entity_resolver.ts'
import { entityFacts, prunePrefixes, runTemplate, type EntityFact, type FoundPath, type TemplateName } from './traverse.ts'
import type { Embedder } from '../embed/index.ts'
import { findSimilar } from '../embed/search.ts'

export interface Anchor {
  entity_id: string
  display_name: string
  kind: string
  env: string
  matched: string
  score: number
}

/**
 * Find the entities a question is *about*.
 *
 * This is the one place a fuzzy/semantic step belongs: picking the anchor. Once
 * an anchor is chosen, every hop is structural. Embeddings choosing hops would
 * return plausible, disconnected facts - which is precisely what this system
 * exists to avoid.
 */
export async function findAnchors(
  db: Db,
  question: string,
  limit = 5,
  opts: { embedder?: Embedder } = {},
): Promise<Anchor[]> {
  const q = `-${normaliseName(question)}-`
  const rows = await db.query<{ entity_id: string; name_norm: string; display_name: string; kind: string; env: string }>(
    `select a.entity_id, a.name_norm, e.display_name, e.kind, e.env
       from entity_alias a join entity e on e.id = a.entity_id
      where e.canonical_id = e.id`,
  )

  // Word-level view of the question, lightly stemmed, so "list of notifications"
  // can reach an entity called "notification list". Exact phrase matches still
  // outrank these - word order carries real information when it is present.
  const stem = (w: string) => w.replace(/(ies)$/, 'y').replace(/(?<=..)s$/, '')
  const qWords = new Set(
    normaliseName(question).split('-').filter(Boolean).map(stem))

  const hits: Anchor[] = []
  for (const r of rows.rows) {
    if (!r.name_norm) continue

    if (q.includes(`-${r.name_norm}-`)) {
      hits.push({
        entity_id: r.entity_id, display_name: r.display_name, kind: r.kind, env: r.env,
        matched: r.name_norm,
        // Longer, more specific names win; prod beats unknown when both match.
        score: r.name_norm.length + (r.env === 'prod' ? 1 : 0),
      })
      continue
    }

    // Every word of the entity's name present in the question, in any order.
    const words = r.name_norm.split('-').filter(Boolean).map(stem)
    if (words.length < 2 || !words.some((w) => w.length >= 4)) continue
    if (!words.every((w) => qWords.has(w))) continue
    hits.push({
      entity_id: r.entity_id, display_name: r.display_name, kind: r.kind, env: r.env,
      matched: r.name_norm,
      score: (r.name_norm.length + (r.env === 'prod' ? 1 : 0)) * 0.7,
    })
  }

  const seen = new Set<string>()
  const byName = hits
    .sort((a, b) => b.score - a.score)
    .filter((h) => (seen.has(h.entity_id) ? false : (seen.add(h.entity_id), true)))
    .slice(0, limit)

  // Semantic matching is a LAST RESORT, never a competitor to an exact match.
  // A question that names something gets that thing; only a question that names
  // nothing the graph knows falls through to "what does this sound like?".
  if (byName.length || !opts.embedder) return byName

  const similar = await findSimilar(db, opts.embedder, question, { limit, minScore: 0.3 })
  return similar.map((s) => ({
    entity_id: s.entityId,
    display_name: s.name,
    kind: s.kind,
    env: s.env,
    matched: 'semantic',
    // Kept below any real name match, so ranking still prefers certainty.
    score: s.score,
  }))
}

const INTENT: Array<{ re: RegExp; template: TemplateName }> = [
  { re: /how (do|can|would) (i|we) connect|connection string|credentials?|connect to|get access/i, template: 'access' },
  { re: /what (breaks|happens)|blast radius|impact of|who (uses|calls|depends)|depends on/i, template: 'blast_radius' },
  { re: /where does|come(s)? from|originate|source of|populated|loaded from/i, template: 'data_provenance' },
]

export function chooseTemplate(question: string): TemplateName {
  for (const i of INTENT) if (i.re.test(question)) return i.template
  return 'data_provenance'
}

/** Anchors that make sense as a starting point for the chosen template. */
const PREFERRED_START: Record<TemplateName, string[]> = {
  data_provenance: ['client', 'service', 'endpoint'],
  blast_radius: ['datastore', 'cache', 'queue', 'service', 'cloud_resource'],
  access: ['datastore', 'cache', 'queue', 'cloud_resource'],
  concept_map: ['capability', 'data_concept'],
}

/**
 * Plural words people use for a kind of thing.
 *
 * Not every question is a path. "What alerts are set up in AWS" is a filtered
 * list, and answering it with a traversal would be perverse.
 */
const KIND_WORDS: Array<[RegExp, string]> = [
  [/\balerts?\b|\balarms?\b/i, 'alert'],
  [/\bpipelines?\b|\bci\b|\bcd\b|\bbuilds?\b/i, 'pipeline'],
  [/\bdatabases?\b|\bdatastores?\b/i, 'datastore'],
  [/\bcaches?\b/i, 'cache'],
  [/\bqueues?\b|\btopics?\b/i, 'queue'],
  [/\bservices?\b/i, 'service'],
  [/\bclients?\b|\bfrontends?\b|\buis?\b/i, 'client'],
  [/\brepos?\b|\brepositor(y|ies)\b/i, 'repo'],
  [/\bendpoints?\b|\broutes?\b|\bapis?\b/i, 'endpoint'],
  [/\bcapabilit(y|ies)\b|\bfeatures?\b/i, 'capability'],
  [/\btechnolog(y|ies)\b|\bframeworks?\b|\blibrar(y|ies)\b|\blanguages?\b/i, 'technology'],
]

const LIST_INTENT = /^(what|which|list|show me|are there)\b|\bset up\b|\bdo we have\b|\bexist\b/i

export interface ListedEntity {
  entity_id: string
  display_name: string
  kind: string
  env: string
  facts: EntityFact[]
}

export interface AskResult {
  question: string
  template: TemplateName
  anchor: Anchor | null
  candidates: Anchor[]
  paths: FoundPath[]
  /** Literal facts (connect_via, secret_at, note) for every entity on a returned path. */
  facts: Record<string, EntityFact[]>
  names: Record<string, string>
  /** Populated when the question was a "what X exist" listing rather than a path. */
  listing?: { kind: string; entities: ListedEntity[] }
}

/** "What alerts are set up in AWS" - a filtered list, not a traversal. */
async function tryListing(db: Db, question: string, at?: Date): Promise<AskResult['listing']> {
  if (!LIST_INTENT.test(question.trim())) return undefined
  const hit = KIND_WORDS.find(([re]) => re.test(question))
  if (!hit) return undefined

  const rows = await db.query<{ id: string; display_name: string; kind: string; env: string }>(
    `select id, display_name, kind, env from entity
      where kind = $1 and canonical_id = id order by display_name limit 200`,
    [hit[1]],
  )
  if (!rows.rows.length) return undefined

  const factMap = await entityFacts(db, rows.rows.map((r) => r.id), at)
  return {
    kind: hit[1],
    entities: rows.rows.map((r) => ({
      entity_id: r.id, display_name: r.display_name, kind: r.kind, env: r.env,
      facts: factMap.get(r.id) ?? [],
    })),
  }
}

export async function ask(
  db: Db,
  question: string,
  opts: { minTrust?: number; at?: Date; from?: string; embedder?: Embedder } = {},
): Promise<AskResult> {
  let template = chooseTemplate(question)
  const candidates = await findAnchors(
    db, opts.from ? `${opts.from} ${question}` : question, 5, { embedder: opts.embedder })

  const preferred = PREFERRED_START[template]
  const anchor =
    candidates.find((c) => (opts.from ? normaliseName(opts.from) === c.matched : false)) ??
    candidates.find((c) => preferred.includes(c.kind)) ??
    candidates[0] ??
    null

  // A question about a capability or a kind of data is answered by starting at
  // the concept and walking outwards, regardless of how it was phrased.
  if (anchor && (anchor.kind === 'capability' || anchor.kind === 'data_concept')) {
    template = 'concept_map'
  }

  const listing = await tryListing(db, question, opts.at)
  if (!anchor) {
    return { question, template, anchor: null, candidates, paths: [], facts: {}, names: {}, listing }
  }

  const all = await runTemplate(db, template, anchor.entity_id, { minTrust: opts.minTrust, at: opts.at })
  const paths = prunePrefixes(all).slice(0, 8)

  // Leaf attributes for every node reached, plus the anchor itself - this is what
  // turns "which database" into "and here is how you reach it".
  const nodes = [...new Set([anchor.entity_id, ...paths.flatMap((p) => p.nodes)])]
  const factMap = await entityFacts(db, nodes, opts.at)
  const nameRows = await db.query<{ id: string; display_name: string }>(
    'select id, display_name from entity where id = any($1::uuid[])',
    [nodes],
  )

  return {
    question,
    template,
    anchor,
    candidates,
    paths,
    facts: Object.fromEntries(factMap),
    names: Object.fromEntries(nameRows.rows.map((r) => [r.id, r.display_name])),
    listing,
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const label = (t: number) => (t >= 0.7 ? 'high' : t >= 0.4 ? 'medium' : t >= 0.15 ? 'low' : 'very low')

export function render(result: AskResult): string {
  const out: string[] = []
  out.push(`Q: ${result.question}`)
  out.push(`   template: ${result.template}`)

  if (result.listing) {
    out.push('')
    out.push(`── ${result.listing.entities.length} ${result.listing.kind}(s) on record ──────────────`)
    for (const e of result.listing.entities) {
      out.push(`   ${e.display_name}${e.env !== 'unknown' ? `  [${e.env}]` : ''}`)
      for (const f of e.facts) out.push(`        · ${f.predicate}: ${f.value}`)
    }
    out.push('')
    if (!result.anchor) return out.join('\n')
  }

  if (!result.anchor) {
    out.push('')
    out.push('   No known entity in that question. Nothing to traverse from.')
    return out.join('\n')
  }
  out.push(`   anchor:   ${result.anchor.display_name} (${result.anchor.kind}, env=${result.anchor.env})`)
  out.push('')

  if (!result.paths.length) {
    out.push('   No paths found from that anchor.')
    return out.join('\n')
  }

  result.paths.forEach((p, i) => {
    out.push(`── path ${i + 1} ─ trust ${p.trust.toFixed(2)} (${label(p.trust)}), ${p.depth} hop${p.depth === 1 ? '' : 's'}`)
    // Steps are stored in their asserted direction; a template may have walked one
    // backwards (endpoint -> service). Render in the direction actually travelled.
    let node = p.nodes[0]
    for (const s of p.steps) {
      const forward = s.subject === node
      const fromName = forward ? s.subject_name : (s.object_name ?? s.object_literal ?? '?')
      const toName = forward ? (s.object_name ?? s.object_literal ?? '?') : s.subject_name
      node = forward ? (s.object ?? node) : s.subject
      const quals = Object.entries(s.qualifiers ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
      const arrow = forward ? '──▶' : '──▶'
      const via = forward ? s.predicate : `${s.predicate}⁻¹`
      const derived = s.derived ? ' [derived]' : ''
      out.push(`   ${fromName} ──${via}${arrow} ${toName}${quals ? `  {${quals}}` : ''}${derived}`)
      for (const a of s.annotations) out.push(`        · ${a.predicate}: ${a.value}`)
      for (const e of s.evidence.slice(0, 2)) {
        const ev = e as Record<string, unknown>
        const loc = [ev.repo, ev.path].filter(Boolean).join(' ')
        const lines = Array.isArray(ev.lines) ? `:${(ev.lines as number[]).join('-')}` : ''
        if (loc) out.push(`        ⤷ ${loc}${lines}`)
      }
      if (s.refute_count > 0) out.push(`        ⚠ ${s.refute_count} refutation(s) on record`)
      if (s.needs_reverification) {
        const bits = [s.anchors_gone ? `${s.anchors_gone} gone` : '', s.anchors_changed ? `${s.anchors_changed} changed` : '']
          .filter(Boolean).join(', ')
        out.push(`        ⟳ evidence changed (${bits}) — queued for re-verification`)
      }
    }
    out.push('')
  })

  const shown = new Set<string>()
  const factLines: string[] = []
  for (const id of [result.anchor.entity_id, ...result.paths.flatMap((p) => p.nodes)]) {
    if (shown.has(id)) continue
    shown.add(id)
    for (const f of result.facts[id] ?? []) {
      const warn = f.refute_count > 0 ? `  ⚠ ${f.refute_count} refutation(s)` : ''
      factLines.push(`   ${result.names[id] ?? id} · ${f.predicate}: ${f.value}${warn}`)
    }
  }
  if (factLines.length) {
    out.push('── facts on nodes reached ─────────────────────────────')
    out.push(...factLines)
    out.push('')
  }
  return out.join('\n')
}
