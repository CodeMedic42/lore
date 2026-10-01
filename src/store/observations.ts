import type { Db } from '../db/index.ts'
import { fingerprint, type ObjectRef, type SubjectRef } from '../domain/fingerprint.ts'
import { splitQualifiers } from '../domain/qualifiers.ts'
import { detectSecret, isFunctional, resolvePredicate } from '../domain/predicates.ts'
import { resolveEntity, type StrongIdentifier } from '../resolver/entity_resolver.ts'
import { digestText } from '../domain/anchor.ts'

export type Method = 'llm_inferred' | 'code_derived' | 'telemetry' | 'human' | 'verifier'

export interface Evidence {
  path?: string
  lines?: [number, number]
  repo?: string
  commit?: string
  trace_id?: string
  tf_address?: string
  url?: string
  /**
   * The actual text the agent read. The server hashes it (whitespace-normalised)
   * so a later re-check can tell a reformat from a real change. Agents already
   * have this text in context, so supplying it is nearly free - and without it
   * the claim can never be automatically re-verified.
   */
  span_text?: string
  /** The function or class the lines sat inside. Survives edits above it. */
  enclosing_symbol?: string
  /** SCIP symbol, if a code index supplied one. */
  scip_symbol?: string
}

export interface ObservationInput {
  subject?: string
  subject_kind?: string
  subject_env?: string
  subject_identifiers?: StrongIdentifier[]
  /** Index of an earlier observation in this batch: makes THIS claim about THAT edge. */
  about?: number
  predicate: string
  object?: string
  object_kind?: string
  object_env?: string
  object_identifiers?: StrongIdentifier[]
  object_literal?: string
  qualifiers?: Record<string, unknown>
  evidence?: Evidence[]
  confidence?: number
  polarity?: boolean
  note?: string
}

export interface IngestEnvelope {
  session?: string
  agent?: string
  repo?: string
  commit?: string
  env?: string
  method?: Method
  scope_key?: string
  idempotency_key?: string
  observations: ObservationInput[]
}

export interface ObservationResult {
  index: number
  accepted: boolean
  proposition_id?: string
  assertion_id?: string
  predicate?: string
  predicate_unmapped?: boolean
  subject?: { raw: string; entity_id: string; resolver: string; score: number; minted: boolean }
  object?: { raw: string; entity_id: string; resolver: string; score: number; minted: boolean } | { literal: string }
  anchors?: number
  anchors_unverifiable?: number
  descriptive_qualifiers?: string[]
  superseded?: number
  warnings?: string[]
  error?: string
}

export interface IngestResult {
  accepted: number
  rejected: number
  results: ObservationResult[]
  replayed?: boolean
}

/**
 * The write path.
 *
 * Contract: strings in, no ids required, never 400 on an unknown predicate, and
 * nothing here blocks on an LLM or a git host. Everything expensive - verification,
 * embedding, merge proposals - happens out of band.
 */
export async function ingest(db: Db, env: IngestEnvelope): Promise<IngestResult> {
  if (env.idempotency_key) {
    const prior = await db.query<{ response: IngestResult }>(
      'select response from ingest_batch where idempotency_key = $1',
      [env.idempotency_key],
    )
    if (prior.rows[0]) return { ...prior.rows[0].response, replayed: true }
  }

  const method: Method = env.method ?? 'llm_inferred'
  const results: ObservationResult[] = []
  // Propositions created in this batch, so `about` can point at them.
  const byIndex = new Map<number, string>()

  for (let i = 0; i < env.observations.length; i++) {
    const obs = env.observations[i]!
    try {
      results.push(await ingestOne(db, env, method, obs, i, byIndex))
    } catch (err) {
      results.push({ index: i, accepted: false, error: (err as Error).message })
    }
  }

  const out: IngestResult = {
    accepted: results.filter((r) => r.accepted).length,
    rejected: results.filter((r) => !r.accepted).length,
    results,
  }

  if (env.idempotency_key) {
    await db.query(
      `insert into ingest_batch (idempotency_key, response) values ($1, $2)
       on conflict (idempotency_key) do nothing`,
      [env.idempotency_key, JSON.stringify(out)],
    )
  }
  return out
}

async function ingestOne(
  db: Db,
  env: IngestEnvelope,
  method: Method,
  obs: ObservationInput,
  index: number,
  byIndex: Map<number, string>,
): Promise<ObservationResult> {
  const warnings: string[] = []
  const scope = env.repo
  const defaultEnv = env.env ?? 'unknown'

  const pred = await resolvePredicate(db, obs.predicate)
  if (pred.unmapped) {
    warnings.push(`predicate "${obs.predicate}" is not in the vocabulary; stored raw and queued for review`)
  }

  const { identifying, descriptive } = splitQualifiers(obs.qualifiers)

  // --- subject: either an entity mention, or another proposition (claims about claims)
  let subjectRef: SubjectRef
  let subjectOut: ObservationResult['subject']
  if (obs.about !== undefined) {
    const target = byIndex.get(obs.about)
    if (!target) throw new Error(`about: ${obs.about} does not refer to an accepted observation in this batch`)
    subjectRef = { proposition: target }
  } else {
    if (!obs.subject) throw new Error('observation needs either `subject` or `about`')
    const r = await resolveEntity(db, {
      raw: obs.subject,
      kind: obs.subject_kind,
      env: obs.subject_env ?? defaultEnv,
      scope,
      identifiers: obs.subject_identifiers,
    })
    subjectRef = { entity: r.entityId }
    subjectOut = { raw: obs.subject, entity_id: r.entityId, resolver: r.resolver, score: r.score, minted: r.minted }
    if (r.warnings) warnings.push(...r.warnings)
  }

  // --- object: entity mention or literal
  let objectRef: ObjectRef
  let objectOut: ObservationResult['object']
  if (obs.object_literal !== undefined && obs.object_literal !== null) {
    const leak = detectSecret(pred.predicate, obs.object_literal)
    if (leak) throw new Error(`refusing to store literal: ${leak}. Record where the secret lives, not its value.`)
    objectRef = { literal: obs.object_literal }
    objectOut = { literal: obs.object_literal }
  } else {
    if (!obs.object) throw new Error('observation needs either `object` or `object_literal`')
    const r = await resolveEntity(db, {
      raw: obs.object,
      kind: obs.object_kind,
      env: obs.object_env ?? defaultEnv,
      scope,
      identifiers: obs.object_identifiers,
    })
    objectRef = { entity: r.entityId }
    objectOut = { raw: obs.object, entity_id: r.entityId, resolver: r.resolver, score: r.score, minted: r.minted }
    if (r.warnings) warnings.push(...r.warnings)
  }

  // --- proposition: content-addressed, so re-assertion collapses onto one row
  const fp = fingerprint(subjectRef, pred.predicate, objectRef, identifying)
  const propId = await upsertProposition(db, subjectRef, pred.predicate, objectRef, identifying, fp)
  byIndex.set(index, propId)

  // --- functional predicates close the previous value. This is one of the two
  //     mechanisms that actually removes a stale edge from traversal.
  let superseded = 0
  if (await isFunctional(db, pred.predicate)) {
    superseded = await supersedePrior(db, subjectRef, pred.predicate, propId)
  }

  const evidence = (obs.evidence ?? []).map((e) => ({
    ...e,
    repo: e.repo ?? env.repo,
    commit: e.commit ?? env.commit,
  }))

  const assertion = await db.query<{ id: string }>(
    `insert into assertion
       (proposition_id, polarity, method, confidence, asserted_by, session_id,
        evidence, scope_key, raw_subject, raw_predicate, raw_object)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning id`,
    [
      propId,
      obs.polarity ?? true,
      method,
      obs.confidence ?? null,
      env.agent ?? null,
      env.session ?? null,
      JSON.stringify(evidence),
      env.scope_key ?? null,
      obs.subject ?? null,
      obs.predicate,
      obs.object ?? obs.object_literal ?? null,
    ],
  )
  const assertionId = assertion.rows[0]!.id

  // Raw mentions are kept verbatim so a bad resolution can be re-run later.
  if (subjectOut) await recordMention(db, assertionId, 'subject', subjectOut)
  if (objectOut && 'entity_id' in objectOut) await recordMention(db, assertionId, 'object', objectOut)

  // Evidence anchors: what the agent actually looked at, hashed so a later check
  // can distinguish a reformat from a real change.
  let anchors = 0
  let unverifiable = 0
  for (const e of evidence) {
    if (!e.path) continue
    const span = e.span_text ? digestText(e.span_text) : null
    if (!span) unverifiable++
    anchors++
    await db.query(
      `insert into evidence_anchor
         (assertion_id, repo, commit_sha, path, line_from, line_to,
          span_sha256, span_norm_lines, enclosing_symbol, scip_symbol, state)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        assertionId, e.repo ?? null, e.commit ?? null, e.path,
        e.lines?.[0] ?? null, e.lines?.[1] ?? null,
        span?.digest ?? null, span?.normLines ?? null,
        e.enclosing_symbol ?? null, e.scip_symbol ?? null,
        span ? 'unchecked' : 'unchecked',
      ],
    )
  }
  if (unverifiable) {
    warnings.push(
      `${unverifiable} evidence item(s) had no span_text, so this claim cannot be automatically re-verified later`,
    )
  }

  // --- descriptive qualifiers become propositions ABOUT this edge, so they
  //     version and can be refuted without disturbing the edge itself.
  const descriptiveKeys: string[] = []
  for (const [key, value] of Object.entries(descriptive)) {
    await assertAboutProposition(db, env, method, propId, key, String(value))
    descriptiveKeys.push(key)
  }
  if (obs.note) {
    await assertAboutProposition(db, env, method, propId, 'note', obs.note)
    descriptiveKeys.push('note')
  }

  return {
    index,
    accepted: true,
    proposition_id: propId,
    assertion_id: assertionId,
    predicate: pred.predicate,
    predicate_unmapped: pred.unmapped,
    subject: subjectOut,
    object: objectOut,
    descriptive_qualifiers: descriptiveKeys.length ? descriptiveKeys : undefined,
    superseded: superseded || undefined,
    anchors: anchors || undefined,
    anchors_unverifiable: unverifiable || undefined,
    warnings: warnings.length ? warnings : undefined,
  }
}

async function upsertProposition(
  db: Db,
  subject: SubjectRef,
  predicate: string,
  object: ObjectRef,
  identifying: Record<string, unknown>,
  fp: Buffer,
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into proposition (subject_entity, subject_prop, predicate, object_entity, object_literal, qualifiers, fingerprint)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (fingerprint) do update set predicate = excluded.predicate
     returning id`,
    [
      'entity' in subject ? subject.entity : null,
      'proposition' in subject ? subject.proposition : null,
      predicate,
      'entity' in object ? object.entity : null,
      'literal' in object ? object.literal : null,
      JSON.stringify(identifying),
      fp,
    ],
  )
  return r.rows[0]!.id
}

/** Close live assertions on OTHER propositions sharing this subject+predicate. */
async function supersedePrior(db: Db, subject: SubjectRef, predicate: string, keepPropId: string): Promise<number> {
  const col = 'entity' in subject ? 'subject_entity' : 'subject_prop'
  const val = 'entity' in subject ? subject.entity : subject.proposition
  const r = await db.query<{ id: string }>(
    `update assertion a
        set valid_to = now()
       from proposition p
      where a.proposition_id = p.id
        and p.${col} = $1
        and p.predicate = $2
        and p.id <> $3
        and a.polarity
        and a.valid_to is null
        and a.expired_at is null
      returning a.id`,
    [val, predicate, keepPropId],
  )
  return r.rows.length
}

async function assertAboutProposition(
  db: Db,
  env: IngestEnvelope,
  method: Method,
  aboutPropId: string,
  predicate: string,
  literal: string,
): Promise<void> {
  const leak = detectSecret(predicate, literal)
  if (leak) throw new Error(`refusing to store qualifier "${predicate}": ${leak}`)
  const subject: SubjectRef = { proposition: aboutPropId }
  const object: ObjectRef = { literal }
  const fp = fingerprint(subject, predicate, object, {})
  const propId = await upsertProposition(db, subject, predicate, object, {}, fp)
  if (await isFunctional(db, predicate)) await supersedePrior(db, subject, predicate, propId)
  await db.query(
    `insert into assertion (proposition_id, method, asserted_by, session_id, scope_key, raw_predicate, raw_object)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [propId, method, env.agent ?? null, env.session ?? null, env.scope_key ?? null, predicate, literal],
  )
}

async function recordMention(
  db: Db,
  assertionId: string,
  role: 'subject' | 'object',
  out: { raw: string; entity_id: string; resolver: string; score: number },
): Promise<void> {
  await db.query(
    'insert into mention (assertion_id, role, raw_text, resolved_entity, resolver, score) values ($1,$2,$3,$4,$5,$6)',
    [assertionId, role, out.raw, out.entity_id, out.resolver, out.score],
  )
}
