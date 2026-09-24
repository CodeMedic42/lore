/**
 * Qualifiers split in two, and the split is load-bearing.
 *
 *   IDENTIFYING - part of the edge's identity, hashed into the fingerprint.
 *     Reading `notif:*` and reading `session:*` are genuinely different edges.
 *
 *   DESCRIPTIVE - a property OF the edge. Stored as a proposition whose subject
 *     is the edge itself, so it versions, decays and can be refuted on its own
 *     without disturbing the edge it describes.
 *
 * Anything unrecognised is treated as descriptive. That is the safe default:
 * a wrongly-descriptive qualifier loses a distinction, while a wrongly-identifying
 * one forks an edge in two and corrupts traversal.
 */
const IDENTIFYING = new Set([
  'role',         // 'cache' vs 'origin' - distinguishes the read paths of a fallback
  'key_pattern',  // which keyspace
  'table',        // which table
  'topic',        // which topic/queue name
  'path',         // which HTTP path
  'method',       // which HTTP verb
  'index',        // which index/collection
  'schema',
  'direction',
  'env_of_target',
])

export interface SplitQualifiers {
  identifying: Record<string, unknown>
  descriptive: Record<string, unknown>
}

export function splitQualifiers(q: Record<string, unknown> | undefined | null): SplitQualifiers {
  const identifying: Record<string, unknown> = {}
  const descriptive: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(q ?? {})) {
    if (value === undefined || value === null || value === '') continue
    const key = rawKey.toLowerCase().trim()
    if (IDENTIFYING.has(key)) identifying[key] = value
    else descriptive[key] = value
  }
  return { identifying, descriptive }
}

export function isIdentifying(key: string): boolean {
  return IDENTIFYING.has(key.toLowerCase().trim())
}
