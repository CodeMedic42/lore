import type { Db } from '../db/index.ts'

export type GapKind =
  | 'name_collision'
  | 'dangling_endpoint'
  | 'homeless_project'
  | 'no_access_info'
  | 'unknown_technology'
  | 'unprovisioned_infra'
  | 'undescribed_concept'
  | 'unidentified_entity'
  | 'orphan_entity'

export interface JoinCandidate {
  called_endpoint: string
  called_name: string
  served_endpoint: string
  served_name: string
  path: string
  method: string
  served_by: string
  served_by_name: string
}

export interface Gap {
  gap_kind: GapKind
  entity_id: string
  entity_name: string
  entity_kind: string
  entity_env: string
  detail: Record<string, any>
  connectivity: number
  score: number
  /** What to ask the user, in plain English. */
  question: string
  /** Why this is worth asking - shown so the user can judge whether to bother. */
  why: string
  /** A proposed answer, when the graph can already guess one. */
  suggestion?: JoinCandidate
}

/**
 * Rank gaps by what answering them would unlock.
 *
 * Connectivity matters: an unknown fact about something twenty edges touch is
 * worth more than the same unknown about a leaf nobody references. And a gap the
 * system can propose an answer to is promoted, because a yes/no question costs the
 * user a second where an open one costs a minute.
 */
function score(base: number, connectivity: number, hasSuggestion: boolean): number {
  const reach = 1 + Math.min(connectivity, 8) * 0.04
  return Number((base * reach * (hasSuggestion ? 1.15 : 1)).toFixed(3))
}

function phrase(g: {
  gap_kind: GapKind
  entity_name: string
  entity_kind: string
  entity_env: string
  detail: Record<string, any>
}, suggestion?: JoinCandidate): { question: string; why: string } {
  const name = g.entity_name
  switch (g.gap_kind) {
    case 'name_collision':
      return {
        question: `Are "${name}" and "${g.detail.other_name}" the same thing, or two different ones?`,
        why: 'Two similar names left unresolved. If they are different and get merged, every answer about either becomes wrong without warning.',
      }
    case 'dangling_endpoint': {
      const callers = (g.detail.called_by ?? []).join(', ') || 'something'
      if (suggestion) {
        return {
          question: `Is ${name} (called by ${callers}) the same route as ${suggestion.served_name}, served by ${suggestion.served_by_name}?`,
          why: 'Confirming this joins two repositories: the caller and the definition are currently recorded as unrelated.',
        }
      }
      return {
        question: `Which project defines ${name}? It is called by ${callers}, but nothing on record serves it.`,
        why: 'Answering this connects two repositories that are currently unlinked.',
      }
    }
    case 'homeless_project':
      return {
        question: `Which repository is ${name} in?`,
        why: 'Without a repo, nothing can navigate from this project to its source.',
      }
    case 'no_access_info':
      return {
        question: `How do you connect to ${name}? (Host and how to reach it - where the credential lives, never the credential itself.)`,
        why: 'This is what turns "which database" into something you can actually act on.',
      }
    case 'unknown_technology':
      return {
        question: `What is ${name} written in, and what does it use to build and test?`,
        why: 'Language and framework are durable facts and the basis of "what else uses X" questions.',
      }
    case 'unprovisioned_infra':
      return {
        question: `What creates ${name} - which Terraform module or manual process?`,
        why: 'Without this, the trail from running infrastructure back to the code that defines it stops here.',
      }
    case 'undescribed_concept':
      return {
        question: `In one line, what is "${name}"?`,
        why: 'Concepts exist to be matched against questions asked in plain English. An undescribed one can never be found.',
      }
    case 'unidentified_entity':
      return {
        question: `Is there a repo URL, ARN or similar that pins down exactly which "${name}" this is?`,
        why: 'This is well connected but identified only by name, so resolution is guessing.',
      }
    case 'orphan_entity':
      return {
        question: `How does ${name} relate to anything else? Nothing on record connects it.`,
        why: 'Mentioned once and never linked. Either it matters and is missing edges, or it should be removed.',
      }
  }
}

export async function joinCandidates(db: Db, at: Date = new Date()): Promise<JoinCandidate[]> {
  const r = await db.query<JoinCandidate>('select * from endpoint_join_candidates($1::timestamptz)', [
    at.toISOString(),
  ])
  return r.rows
}

export async function knowledgeGaps(
  db: Db,
  opts: { at?: Date; kinds?: GapKind[]; limit?: number } = {},
): Promise<Gap[]> {
  const at = (opts.at ?? new Date()).toISOString()
  const rows = await db.query<any>('select * from knowledge_gaps($1::timestamptz)', [at])
  const joins = await joinCandidates(db, opts.at)
  const joinByEndpoint = new Map(joins.map((j) => [j.called_endpoint, j]))

  const gaps: Gap[] = rows.rows.map((r) => {
    const detail = r.detail ?? {}
    const suggestion = r.gap_kind === 'dangling_endpoint' ? joinByEndpoint.get(r.entity_id) : undefined
    const { question, why } = phrase({ ...r, detail }, suggestion)
    return {
      gap_kind: r.gap_kind,
      entity_id: r.entity_id,
      entity_name: r.entity_name,
      entity_kind: r.entity_kind,
      entity_env: r.entity_env,
      detail,
      connectivity: Number(r.connectivity ?? 0),
      score: score(Number(r.base_score), Number(r.connectivity ?? 0), Boolean(suggestion)),
      question,
      why,
      suggestion,
    }
  })

  // Never ask the same thing twice in different words. When two endpoints are
  // already covered by a join proposal ("is this the same route as X, served by
  // Y?"), the generic "are these the same thing?" is strictly worse - it asks the
  // user to supply an answer the graph could already propose.
  const joinedPairs = new Set(joins.flatMap((j) => [
    `${j.called_endpoint}|${j.served_endpoint}`,
    `${j.served_endpoint}|${j.called_endpoint}`,
  ]))
  const deduped = gaps.filter((g) =>
    !(g.gap_kind === 'name_collision' && joinedPairs.has(`${g.entity_id}|${g.detail.other_id}`)))

  const filtered = opts.kinds?.length ? deduped.filter((g) => opts.kinds!.includes(g.gap_kind)) : deduped
  filtered.sort((a, b) => b.score - a.score)
  return opts.limit ? filtered.slice(0, opts.limit) : filtered
}

/**
 * What the agent should actually ask right now.
 *
 * Deliberately a small number. An assistant that interrupts five times a session
 * to ask about test runners gets ignored, and then nothing is learned at all - so
 * the budget is tight and spent on the highest-reach gaps only. Everything else
 * waits until someone happens to be working nearby.
 */
export async function askableQuestions(
  db: Db,
  opts: { budget?: number; minScore?: number; near?: string } = {},
): Promise<Gap[]> {
  const budget = opts.budget ?? 2
  const minScore = opts.minScore ?? 0.5
  let gaps = (await knowledgeGaps(db)).filter((g) => g.score >= minScore)

  // If the user is working in a particular repo or project, prefer gaps about it.
  if (opts.near) {
    const near = opts.near.toLowerCase()
    gaps = gaps.sort((a, b) => {
      const an = a.entity_name.toLowerCase().includes(near) ? 1 : 0
      const bn = b.entity_name.toLowerCase().includes(near) ? 1 : 0
      return bn - an || b.score - a.score
    })
  }

  // At most one question per entity, so a single unknown project does not use up
  // the whole budget with five variations of "tell me about this".
  const seen = new Set<string>()
  return gaps.filter((g) => (seen.has(g.entity_id) ? false : (seen.add(g.entity_id), true))).slice(0, budget)
}
