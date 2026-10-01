import type { Db } from '../db/index.ts'
import { yesNo } from '../domain/nl.ts'
import { markDistinct, merge } from '../resolver/entity_resolver.ts'
import { ingest } from './observations.ts'
import { tell } from './tell.ts'
import type { Gap } from '../query/gaps.ts'

export interface AnswerResult {
  understood: boolean
  action: string
  detail?: Record<string, unknown>
}

/**
 * When the answer is a bare value, this is the relation it belongs to.
 * Knowing what was ASKED is what makes answering reliable - there is no
 * inference to do about the predicate, only about the value.
 */
const BARE_ANSWER_PREDICATE: Partial<Record<Gap['gap_kind'], string>> = {
  homeless_project: 'lives_in_repo',
  unprovisioned_infra: 'provisioned_by',
  undescribed_concept: 'note',
  no_access_info: 'connect_via',
  unknown_technology: 'written_in',
}

const BARE_ANSWER_KIND: Partial<Record<Gap['gap_kind'], string>> = {
  homeless_project: 'repo',
  unprovisioned_infra: 'iac_module',
  unknown_technology: 'technology',
}

/**
 * Pull an identifier OUT of whatever the user typed.
 *
 * People answer "which one is this?" in sentences. Storing the sentence verbatim
 * as the identifier defeats the entire point - identifiers work because they match
 * exactly, and a paragraph never matches anything. Observed on the first real run:
 * a git_remote whose value was "It is the @reformjs/reactive package at
 * projects/reactive in the monorepo https://github.com/codemedic42/reform".
 */
export function extractIdentifier(text: string): { authority: string; value: string } | null {
  const t = text.trim()

  const arn = /arn:aws:[^\s,;)'"]+/i.exec(t)
  if (arn) return { authority: 'arn', value: arn[0] }

  const url = /https?:\/\/[^\s,;)'"]+/i.exec(t)
  if (url) {
    const clean = url[0].replace(/[.,;]+$/, '').replace(/\.git$/, '')
    // A repository URL is a git_remote, normalised to host/owner/repo so the same
    // repo referred to with or without a scheme resolves to one identifier.
    const repo = /^https?:\/\/([^/]+\/[^/]+\/[^/?#]+)/i.exec(clean)
    if (repo && /github|gitlab|bitbucket|git\./i.test(clean)) {
      return { authority: 'git_remote', value: repo[1]!.toLowerCase() }
    }
    return { authority: 'url', value: clean }
  }

  const tf = /\b(?:module|resource)\.[\w.\-\[\]"]+/i.exec(t)
  if (tf) return { authority: 'tf_address', value: tf[0] }

  // host/owner/repo written without a scheme
  const bare = /\b((?:github|gitlab|bitbucket)\.[a-z.]+\/[\w.\-]+\/[\w.\-]+)/i.exec(t)
  if (bare) return { authority: 'git_remote', value: bare[1]!.toLowerCase().replace(/\.git$/, '') }

  // a bare value only counts when it is the WHOLE answer
  if (/^\d+$/.test(t)) return { authority: 'gitlab_project', value: t }
  if (/^[\w@/.\-]+$/.test(t) && t.includes('/')) return { authority: 'git_remote', value: t.toLowerCase() }
  return null
}

/**
 * Apply a user's answer to a question the system asked.
 *
 * Because the gap is known, this is far more reliable than parsing a sentence
 * out of nowhere: the subject and usually the predicate are already settled, so
 * only the value has to be understood.
 */
export async function answerGap(db: Db, gap: Gap, answer: string): Promise<AnswerResult> {
  const text = answer.trim()
  if (!text) return { understood: false, action: 'empty answer' }

  const verdict = yesNo(text)

  // ── confirmations ────────────────────────────────────────────────────────
  if (gap.gap_kind === 'name_collision') {
    const other = String(gap.detail.other_id)
    if (verdict === 'yes') {
      await merge(db, gap.entity_id, other, { reason: 'confirmed by user', decidedBy: 'human', score: 1 })
      await resolveCandidate(db, gap.entity_id, other, 'merged')
      return { understood: true, action: 'merged', detail: { into: gap.detail.other_name } }
    }
    if (verdict === 'no') {
      await markDistinct(db, gap.entity_id, other, 'confirmed different by user')
      await resolveCandidate(db, gap.entity_id, other, 'distinct')
      return { understood: true, action: 'recorded as permanently distinct' }
    }
    return { understood: false, action: 'expected yes or no' }
  }

  if (gap.gap_kind === 'dangling_endpoint' && gap.suggestion) {
    if (verdict === 'yes') {
      // The caller's endpoint and the served route are one route. Merging them is
      // what actually joins the two repositories.
      await merge(db, gap.suggestion.called_endpoint, gap.suggestion.served_endpoint, {
        reason: 'confirmed same route by user', decidedBy: 'human', score: 1,
      })
      return {
        understood: true,
        action: 'joined',
        detail: { route: gap.suggestion.path, served_by: gap.suggestion.served_by_name },
      }
    }
    if (verdict === 'no') {
      await markDistinct(db, gap.suggestion.called_endpoint, gap.suggestion.served_endpoint,
        'user says these are different routes')
      return { understood: true, action: 'recorded as different routes' }
    }
    // Not a yes/no - fall through and treat it as naming the owning project.
  }

  if (gap.gap_kind === 'dangling_endpoint') {
    const r = await ingest(db, {
      agent: 'user', method: 'human', env: gap.entity_env,
      observations: [{
        subject: text, subject_kind: 'service',
        predicate: 'exposes_endpoint', object: gap.entity_name, object_kind: 'endpoint',
        confidence: 1,
      }],
    })
    return { understood: r.accepted > 0, action: 'recorded route owner', detail: { owner: text } }
  }

  if (gap.gap_kind === 'unidentified_entity') {
    const found = extractIdentifier(text)
    if (!found) {
      return {
        understood: false,
        action: 'no identifier found in that answer — give a repository URL, an ARN, or a Terraform address',
      }
    }
    await db.query(
      `insert into entity_identifier (entity_id, authority, value) values ($1,$2,$3)
       on conflict (authority, value) do nothing`,
      [gap.entity_id, found.authority, found.value],
    )
    await db.query('update entity set provisional = false where id = $1', [gap.entity_id])
    return { understood: true, action: 'attached identifier', detail: found }
  }

  // ── everything else: try a full sentence first, then a bare value ────────
  const asSentence = await tell(db, {
    text, impliedSubject: gap.entity_name, impliedSubjectKind: gap.entity_kind,
    env: gap.entity_env, agent: 'user',
  })
  if (asSentence.claims.length) {
    return {
      understood: true,
      action: 'recorded',
      detail: { claims: asSentence.claims.map((c) => `${c.subject} ${c.predicate} ${c.object}`) },
    }
  }

  const predicate = BARE_ANSWER_PREDICATE[gap.gap_kind]
  if (!predicate) return { understood: false, action: 'did not understand that answer' }

  const literal = predicate === 'note' || predicate === 'connect_via'
  const values = literal ? [text] : text.split(/\s*(?:,|\band\b)\s*/).map((v) => v.trim()).filter(Boolean)

  const r = await ingest(db, {
    agent: 'user', method: 'human', env: gap.entity_env,
    observations: values.map((v) => ({
      subject: gap.entity_name, subject_kind: gap.entity_kind,
      predicate,
      ...(literal ? { object_literal: v } : { object: v, object_kind: BARE_ANSWER_KIND[gap.gap_kind] }),
      confidence: 1,
    })),
  })
  return { understood: r.accepted > 0, action: 'recorded', detail: { predicate, values } }
}

async function resolveCandidate(db: Db, a: string, b: string, resolution: string) {
  await db.query(
    `update merge_candidate set resolved_at = now(), resolution = $3
      where resolved_at is null
        and ((from_id = $1 and into_id = $2) or (from_id = $2 and into_id = $1))`,
    [a, b, resolution],
  )
}
