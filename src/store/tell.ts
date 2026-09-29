import type { Db } from '../db/index.ts'
import { parse, type ParsedClaim } from '../domain/nl.ts'
import { ingest, type IngestResult, type Method, type ObservationInput } from './observations.ts'

export interface TellInput {
  text: string
  agent?: string
  session?: string
  repo?: string
  env?: string
  /** Defaults to 'human': someone stated this directly, which is the strongest source. */
  method?: Method
  impliedSubject?: string
  impliedSubjectKind?: string
  /** Parse and show what WOULD be recorded, without recording it. */
  dryRun?: boolean
}

export interface TellResult {
  claims: ParsedClaim[]
  unparsed: string[]
  ingest?: IngestResult
}

function toObservation(c: ParsedClaim, text: string): ObservationInput {
  // A note is a description of one thing, not a relation between two.
  if (c.predicate === 'note' || c.predicate === 'connect_via' || c.predicate === 'serves_at') {
    return {
      subject: c.subject, subject_kind: c.subjectKind,
      predicate: c.predicate, object_literal: c.object,
      confidence: c.confidence, polarity: c.polarity,
    }
  }
  return {
    subject: c.subject, subject_kind: c.subjectKind,
    predicate: c.predicate,
    object: c.object, object_kind: c.objectKind,
    confidence: c.confidence,
    polarity: c.polarity,
    evidence: [{ url: undefined }].slice(0, 0),
    note: undefined,
  }
}

/**
 * "Just tell it something."
 *
 * A negated sentence ("the client no longer uses Webpack") becomes a REFUTING
 * assertion rather than a deletion - the old claim stays on record with its
 * provenance, and the contradiction is visible. That is the whole reason polarity
 * exists in the schema.
 */
export async function tell(db: Db, input: TellInput): Promise<TellResult> {
  const parsed = await parse(db, input.text, {
    impliedSubject: input.impliedSubject,
    impliedSubjectKind: input.impliedSubjectKind,
  })

  if (input.dryRun || !parsed.claims.length) {
    return { claims: parsed.claims, unparsed: parsed.unparsed }
  }

  const result = await ingest(db, {
    session: input.session,
    agent: input.agent ?? 'user',
    repo: input.repo,
    env: input.env ?? 'prod',
    method: input.method ?? 'human',
    observations: parsed.claims.map((c) => toObservation(c, input.text)),
  })

  return { claims: parsed.claims, unparsed: parsed.unparsed, ingest: result }
}
