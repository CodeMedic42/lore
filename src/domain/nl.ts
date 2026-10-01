import type { Db } from '../db/index.ts'

/**
 * Turning a sentence a person typed into claims.
 *
 * Deliberately deterministic and deliberately modest. It handles the statements
 * people actually make about systems - "the new client is written in TypeScript
 * and replaces the React one" - and declines anything it cannot parse confidently
 * rather than inventing structure. What it cannot parse is returned verbatim so
 * the caller can decide what to do with it.
 *
 * This is not trying to be an LLM. When an AI agent relays something a user said,
 * the agent is perfectly capable of emitting structured observations itself; this
 * exists for the times there is no model in the loop, and as a floor under the
 * times there is.
 */

export interface ParsedClaim {
  subject: string
  predicate: string
  object: string
  objectKind?: string
  subjectKind?: string
  polarity: boolean
  confidence: number
  source: string
}

export interface ParseResult {
  claims: ParsedClaim[]
  unparsed: string[]
}

interface Phrase {
  phrase: string
  predicate: string
  object_kind_hint: string | null
  subject_kinds: string[] | null
  object_kinds: string[] | null
}

let phraseCache: Phrase[] | null = null

export function resetPhraseCache(): void {
  phraseCache = null
}

async function phrases(db: Db): Promise<Phrase[]> {
  if (phraseCache) return phraseCache
  const r = await db.query<Phrase>(
    `select pp.phrase, pp.predicate, pp.object_kind_hint, p.subject_kinds, p.object_kinds
       from predicate_phrase pp join predicate p on p.name = pp.predicate`,
  )
  // Longest first: "stores in" must beat "stores", "is built with" must beat "is built".
  phraseCache = r.rows.sort((a, b) => b.phrase.length - a.phrase.length)
  return phraseCache
}

const NEGATION = /\b(no longer|not|doesn't|does not|didn't|never|stopped|removed|dropped)\b/i
const TRAILING_NEGATION = /\s*\b(no longer|does not|doesn't|didn't|never|not|stopped|dropped|removed)\b\s*$/i

/** "notification-client no longer" -> "notification-client" */
function stripNegation(s: string): string {
  let out = s
  for (let i = 0; i < 3 && TRAILING_NEGATION.test(out); i++) out = out.replace(TRAILING_NEGATION, '')
  return out.trim()
}

/**
 * Phrases whose predicate depends on what the object turns out to be.
 * "uses Webpack" and "uses React" are different relations, and the graph usually
 * already knows which - so ask it rather than guessing.
 */
const AMBIGUOUS = new Set(['uses', 'is using', 'handles', 'provides', 'serves', 'defines'])

async function existingPredicate(db: Db, subject: string, object: string): Promise<string | null> {
  const norm = (x: string) =>
    x.toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9.\-/]/g, '').replace(/-+/g, '-')
  const r = await db.query<{ predicate: string }>(
    `select ec.predicate
       from edges_canon(now()) ec
       join entity_alias sa on sa.entity_id = ec.subject
       join entity_alias oa on oa.entity_id = ec.object
      where sa.name_norm = $1 and oa.name_norm = $2
      order by ec.trust desc
      limit 1`,
    [norm(subject), norm(object)],
  )
  return r.rows[0]?.predicate ?? null
}

/** Split into clauses on sentence punctuation and a few safe connectives. */
export function clauses(text: string): string[] {
  return text
    .split(/(?:[.;!?\n]+|,\s*(?=(?:and|but|it|the|which)\b))/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 2)
}

function tidy(s: string): string {
  return s
    .replace(/^(the|a|an|our|its|their|this|that)\s+/i, '')
    .replace(/^(and|but|also|then)\s+/i, '')
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "JavaScript and SCSS" / "Redis, Postgres" -> several objects, one claim each. */
function splitObjects(s: string): string[] {
  return s
    .split(/\s*(?:,|\band\b|\balso\b)\s*/i)
    .map(tidy)
    .filter((o) => o.length > 0 && !/^(it|them|this|that)$/i.test(o))
}

/**
 * Parse free text into claims.
 *
 * `impliedSubject` lets a caller supply context - answering "what is X written
 * in?" with "TypeScript and SCSS" needs no subject in the sentence at all.
 */
export async function parse(
  db: Db,
  text: string,
  opts: { impliedSubject?: string; impliedSubjectKind?: string } = {},
): Promise<ParseResult> {
  const table = await phrases(db)
  const claims: ParsedClaim[] = []
  const unparsed: string[] = []
  let lastSubject = opts.impliedSubject

  /** Earliest phrase in `s`, preferring the longest at that position. */
  const findPhrase = (s: string, from = 0): { p: Phrase; at: number } | null => {
    const lower = s.toLowerCase()
    let best: { p: Phrase; at: number } | null = null
    for (const p of table) {
      const mid = lower.indexOf(` ${p.phrase} `, from)
      const start = from === 0 && lower.startsWith(`${p.phrase} `) ? 0 : -1
      const pos = mid >= 0 ? mid + 1 : start
      if (pos < 0) continue
      if (!best || pos < best.at || (pos === best.at && p.phrase.length > best.p.phrase.length)) {
        best = { p, at: pos }
      }
    }
    return best
  }

  // A work queue, because one clause can contain several relations:
  // "is written in TypeScript and uses Angular" is two claims, not one with a
  // strange object.
  const queue = clauses(text)

  while (queue.length) {
    const clause = queue.shift()!
    const lower = clause.toLowerCase()
    const negated = NEGATION.test(lower)

    const hit = findPhrase(clause)

    if (!hit) {
      // "X is a UI client that shows notifications" - a description, not a relation.
      const desc = clause.match(/^(.+?)\s+is\s+(?:a|an|the)\s+(.+)$/i)
      if (desc && (tidy(desc[1]!) || lastSubject)) {
        const subject = tidy(desc[1]!) || lastSubject!
        claims.push({
          subject, predicate: 'note', object: tidy(desc[2]!),
          polarity: true, confidence: 0.6, source: clause,
        })
        lastSubject = subject
        continue
      }
      unparsed.push(clause)
      continue
    }

    const rawSubject = stripNegation(tidy(clause.slice(0, hit.at)))
    let rawObjects = clause.slice(hit.at + hit.p.phrase.length)

    // If another relation starts inside the object region, the object ends there
    // and the rest is a separate claim about the same subject.
    const next = findPhrase(rawObjects, 1)
    if (next && next.at > 0) {
      const tail = rawObjects.slice(next.at)
      rawObjects = rawObjects.slice(0, next.at).replace(/\s*(?:,|\band\b|\bthen\b|\bit\b)\s*$/i, '')
      queue.unshift(tail.trim())
    }

    // "it uses Angular" / "and replaces the old one" - carry the subject forward.
    const subject =
      !rawSubject || /^(it|they|this|that|which)$/i.test(rawSubject) ? lastSubject : rawSubject
    if (!subject) {
      unparsed.push(clause)
      continue
    }
    lastSubject = subject

    const objectKind =
      hit.p.object_kind_hint ??
      (hit.p.object_kinds?.length === 1 ? hit.p.object_kinds[0] : undefined)
    const subjectKind =
      opts.impliedSubjectKind ??
      (hit.p.subject_kinds?.length === 1 ? hit.p.subject_kinds[0] : undefined)

    for (const object of splitObjects(rawObjects)) {
      // An ambiguous phrase defers to whatever relation the graph already records
      // between these two, so "no longer uses Webpack" refutes the build-tool
      // claim rather than inventing a framework claim to contradict.
      let predicate = hit.p.predicate
      if (AMBIGUOUS.has(hit.p.phrase)) {
        const known = await existingPredicate(db, subject, object)
        if (known) predicate = known
      }
      claims.push({
        subject,
        predicate,
        object,
        objectKind: hit.p.predicate === predicate ? (objectKind ?? undefined) : undefined,
        subjectKind: subjectKind ?? undefined,
        polarity: !negated,
        // A negation is a strong signal; a bare phrase match is a decent one.
        confidence: negated ? 0.8 : 0.75,
        source: clause,
      })
    }
  }

  return { claims, unparsed }
}

const YES = /^\s*(y|yes|yep|yeah|correct|right|same|they are|it is|confirmed|true)\b/i
const NO = /^\s*(n|no|nope|different|not the same|they are not|separate|distinct|false)\b/i

export type YesNo = 'yes' | 'no' | 'unclear'

export function yesNo(text: string): YesNo {
  if (NO.test(text)) return 'no'
  if (YES.test(text)) return 'yes'
  return 'unclear'
}
