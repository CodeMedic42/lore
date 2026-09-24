import { createHash } from 'node:crypto'

export type SubjectRef = { entity: string } | { proposition: string }
export type ObjectRef = { entity: string } | { literal: string }

/**
 * Content address for a proposition.
 *
 * Deterministic over (subject, predicate, object, IDENTIFYING qualifiers) so the
 * same edge asserted by ten different agents collapses to one row and
 * corroboration becomes a count rather than a fuzzy match.
 *
 * Descriptive qualifiers are deliberately excluded: if `ttl_seconds` were in
 * here, changing a TTL would fork a second edge instead of superseding a value,
 * and traversal would then return both.
 *
 * Subject/object carry the entity id AS WRITTEN. Canonicalisation happens at read
 * time, so a later merge does not invalidate previously computed fingerprints.
 */
export function fingerprint(
  subject: SubjectRef,
  predicate: string,
  object: ObjectRef,
  identifyingQualifiers: Record<string, unknown> = {},
): Buffer {
  const canonical = JSON.stringify([
    'entity' in subject ? ['e', subject.entity] : ['p', subject.proposition],
    predicate,
    'entity' in object ? ['e', object.entity] : ['l', object.literal],
    stableEntries(identifyingQualifiers),
  ])
  return createHash('sha256').update(canonical).digest()
}

/** Sort keys and normalise values so key order and number formatting cannot fork an edge. */
function stableEntries(obj: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k.toLowerCase().trim(), String(v).trim()] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
