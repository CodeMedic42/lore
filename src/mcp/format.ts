import type { AskResult } from '../query/ask.ts'
import type { Gap } from '../query/gaps.ts'
import type { IngestResult } from '../store/observations.ts'
import type { EntityFact, FoundPath } from '../query/traverse.ts'

/** Compact, model-readable rendering. Terse on purpose: this lands in a context window. */

export function renderPaths(paths: FoundPath[], startNode: string): string {
  if (!paths.length) return '(no paths found)'
  const out: string[] = []
  paths.forEach((p, i) => {
    out.push(`Path ${i + 1} — trust ${p.trust.toFixed(2)}, ${p.depth} hop(s)`)
    let node = startNode
    for (const s of p.steps) {
      const forward = s.subject === node
      const from = forward ? s.subject_name : (s.object_name ?? s.object_literal ?? '?')
      const to = forward ? (s.object_name ?? s.object_literal ?? '?') : s.subject_name
      node = forward ? (s.object ?? node) : s.subject
      const quals = Object.entries(s.qualifiers ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')
      const pred = forward ? s.predicate : `${s.predicate} (reversed)`
      out.push(`  ${from} --[${pred}]--> ${to}${quals ? ` {${quals}}` : ''}`)
      for (const a of s.annotations) out.push(`      ${a.predicate}: ${a.value}`)
      for (const e of s.evidence.slice(0, 2)) {
        const ev = e as Record<string, unknown>
        const loc = [ev.repo, ev.path].filter(Boolean).join(' ')
        const lines = Array.isArray(ev.lines) ? `:${(ev.lines as number[]).join('-')}` : ''
        if (loc) out.push(`      evidence: ${loc}${lines}`)
      }
      if (s.refute_count > 0) out.push(`      WARNING: ${s.refute_count} source(s) contradict this`)
      if (s.needs_reverification) out.push(`      WARNING: the cited code changed; this needs re-checking`)
    }
  })
  return out.join('\n')
}

export function renderFacts(facts: Record<string, EntityFact[]>, names: Record<string, string>): string {
  const lines: string[] = []
  for (const [id, list] of Object.entries(facts)) {
    for (const f of list) {
      lines.push(`  ${names[id] ?? id} — ${f.predicate}: ${f.value}${f.refute_count ? '  (contradicted)' : ''}`)
    }
  }
  return lines.length ? `Facts on things reached:\n${lines.join('\n')}` : ''
}

export function renderAsk(r: AskResult): string {
  const parts: string[] = []
  if (r.listing) {
    parts.push(`${r.listing.entities.length} ${r.listing.kind}(s) on record:`)
    for (const e of r.listing.entities) {
      parts.push(`  ${e.display_name}${e.env !== 'unknown' ? ` [${e.env}]` : ''}`)
      for (const f of e.facts) parts.push(`      ${f.predicate}: ${f.value}`)
    }
  }
  if (r.anchor) {
    parts.push(`Starting from: ${r.anchor.display_name} (${r.anchor.kind}) — query shape: ${r.template}`)
    parts.push(renderPaths(r.paths, r.anchor.entity_id))
    const facts = renderFacts(r.facts, r.names)
    if (facts) parts.push(facts)
  } else if (!r.listing) {
    parts.push('Nothing in the graph matches that question yet.')
    if (r.candidates.length) {
      parts.push(`Closest known things: ${r.candidates.map((c) => c.display_name).join(', ')}`)
    } else {
      parts.push('Consider recording what you learn with record_observations so the next question can be answered.')
    }
  }
  return parts.filter(Boolean).join('\n\n')
}

export function renderIngest(r: IngestResult): string {
  const lines: string[] = [`Recorded ${r.accepted} observation(s)${r.rejected ? `, rejected ${r.rejected}` : ''}.`]
  if (r.replayed) lines.push('(This batch was already recorded; returned the original result.)')

  for (const o of r.results) {
    if (!o.accepted) {
      lines.push(`  [${o.index}] REJECTED: ${o.error}`)
      continue
    }
    const bits: string[] = []
    if (o.subject?.minted) bits.push(`created new entity "${o.subject.raw}"`)
    if (o.object && 'minted' in o.object && o.object.minted) bits.push(`created new entity "${o.object.raw}"`)
    if (o.predicate_unmapped) bits.push(`predicate "${o.predicate}" is not in the vocabulary (kept as-is, queued for review)`)
    if (o.superseded) bits.push(`superseded ${o.superseded} earlier value(s)`)
    for (const w of o.warnings ?? []) bits.push(w)
    if (bits.length) lines.push(`  [${o.index}] ${bits.join('; ')}`)
  }

  const minted = r.results.filter((o) => o.subject?.minted || (o.object && 'minted' in o.object && o.object.minted)).length
  if (minted) {
    lines.push('')
    lines.push('Note: new entities were created. If any of those are things the graph already')
    lines.push('knows under another name, supply subject_identifiers/object_identifiers next time')
    lines.push('(git_remote, gitlab_project, arn, tf_address) so they resolve instead of duplicating.')
  }
  return lines.join('\n')
}

export function renderGaps(gaps: Gap[]): string {
  if (!gaps.length) return 'Nothing worth asking about right now.'
  const lines = ['Questions worth asking the user. Ask at most one or two, and only when it fits the conversation.', '']
  for (const g of gaps) {
    lines.push(`- ${g.question}`)
    lines.push(`    why: ${g.why}`)
    lines.push(`    to record the answer: answer_question(gap_kind="${g.gap_kind}", entity_id="${g.entity_id}", answer=...)`)
    lines.push('')
  }
  return lines.join('\n')
}
