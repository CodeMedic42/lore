import type { Db } from '../db/index.ts'
import { normaliseName } from '../resolver/entity_resolver.ts'
import { entityFacts, prunePrefixes, runTemplate, type EntityFact, type FoundPath, type TemplateName } from './traverse.ts'

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
export async function findAnchors(db: Db, question: string, limit = 5): Promise<Anchor[]> {
  const q = `-${normaliseName(question)}-`
  const rows = await db.query<{ entity_id: string; name_norm: string; display_name: string; kind: string; env: string }>(
    `select a.entity_id, a.name_norm, e.display_name, e.kind, e.env
       from entity_alias a join entity e on e.id = a.entity_id
      where e.canonical_id = e.id`,
  )

  const hits: Anchor[] = []
  for (const r of rows.rows) {
    if (!r.name_norm) continue
    if (!q.includes(`-${r.name_norm}-`)) continue
    hits.push({
      entity_id: r.entity_id,
      display_name: r.display_name,
      kind: r.kind,
      env: r.env,
      matched: r.name_norm,
      // Longer, more specific names win; prod beats unknown when both match.
      score: r.name_norm.length + (r.env === 'prod' ? 1 : 0),
    })
  }

  const seen = new Set<string>()
  return hits
    .sort((a, b) => b.score - a.score)
    .filter((h) => (seen.has(h.entity_id) ? false : (seen.add(h.entity_id), true)))
    .slice(0, limit)
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
}

export async function ask(
  db: Db,
  question: string,
  opts: { minTrust?: number; at?: Date; from?: string } = {},
): Promise<AskResult> {
  const template = chooseTemplate(question)
  const candidates = await findAnchors(db, opts.from ? `${opts.from} ${question}` : question)

  const preferred = PREFERRED_START[template]
  const anchor =
    candidates.find((c) => (opts.from ? normaliseName(opts.from) === c.matched : false)) ??
    candidates.find((c) => preferred.includes(c.kind)) ??
    candidates[0] ??
    null

  if (!anchor) return { question, template, anchor: null, candidates, paths: [], facts: {}, names: {} }

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
