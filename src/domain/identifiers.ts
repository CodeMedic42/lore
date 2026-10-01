import type { Db } from '../db/index.ts'

/**
 * Strong identifiers.
 *
 * These are the only thing in the system that decides two mentions are the same
 * entity without a human. They work because (authority, value) is a uniqueness
 * constraint in the database - so a typo that splits `gitlab_project` from
 * `gitlab-project` does not cause a visible error, it silently destroys the
 * guarantee and the graph fragments. Hence the normalisation here.
 */

export interface StrongIdentifier {
  authority: string
  value: string
}

export function normaliseAuthority(raw: string): string {
  return raw.toLowerCase().trim().replace(/[\s-]+/g, '_')
}

let knownCache: Set<string> | null = null
export async function knownAuthorities(db: Db): Promise<Set<string>> {
  if (knownCache) return knownCache
  const r = await db.query<{ name: string }>('select name from identifier_authority')
  knownCache = new Set(r.rows.map((x) => x.name))
  return knownCache
}

/**
 * A SCIP symbol is Sourcegraph's cross-repository name for a code symbol:
 *
 *   scip-typescript npm @acme/service-c 1.4.0 `src/notifications/cache.ts`/read().
 *   └─ scheme ───┘ └mgr┘ └── package ──┘ └ver┘ └────── descriptors ──────────┘
 *
 * It is worth special handling because two different tools that both emit SCIP
 * will produce byte-identical symbols for the same function - which makes it the
 * strongest identity signal available for code, and free if a SCIP index exists.
 * The version is part of the identity, which is exactly why it resolves correctly
 * across dependency boundaries.
 */
export interface ScipSymbol {
  scheme: string
  manager: string
  packageName: string
  version: string
  descriptors: string
}

export function parseScipSymbol(raw: string): ScipSymbol | null {
  const s = raw.trim().replace(/\s+/g, ' ')
  if (s.startsWith('local ')) return null // local symbols are file-scoped, not identities
  const parts = s.split(' ')
  if (parts.length < 5) return null
  const [scheme, manager, packageName, version, ...rest] = parts
  if (!scheme || !manager || !packageName || !version || !rest.length) return null
  return { scheme, manager, packageName, version, descriptors: rest.join(' ') }
}

export function formatScipSymbol(s: ScipSymbol): string {
  return `${s.scheme} ${s.manager} ${s.packageName} ${s.version} ${s.descriptors}`
}

export interface NormalisedIdentifier extends StrongIdentifier {
  warning?: string
  scip?: ScipSymbol
}

/**
 * Normalise an identifier for storage. Unknown authorities are accepted with a
 * warning rather than rejected - same reasoning as unknown predicates: an agent
 * that gets an error back stops writing. But they are surfaced, because an
 * unknown authority is far more likely to be a typo than a new namespace.
 */
export async function normaliseIdentifier(db: Db, id: StrongIdentifier): Promise<NormalisedIdentifier> {
  const authority = normaliseAuthority(id.authority)
  const known = await knownAuthorities(db)
  const out: NormalisedIdentifier = { authority, value: id.value.trim() }

  if (!known.has(authority)) {
    out.warning = `unknown identifier authority "${id.authority}" - check for a typo; strong identifiers only work when the authority matches exactly`
  }

  if (authority === 'scip_symbol') {
    const parsed = parseScipSymbol(id.value)
    if (!parsed) {
      out.warning = 'value does not parse as a SCIP symbol; stored verbatim but it will not match other SCIP sources'
    } else {
      out.scip = parsed
      out.value = formatScipSymbol(parsed) // canonical spacing
    }
  }
  return out
}

/** Reset the cached authority list (tests create fresh databases). */
export function resetAuthorityCache(): void {
  knownCache = null
}
