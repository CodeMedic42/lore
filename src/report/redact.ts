import { createHash } from 'node:crypto'

/**
 * Redaction for reports that leave the machine they were generated on.
 *
 * The goal is to keep everything needed to DIAGNOSE the system - vocabulary,
 * structure, counts, path shapes - while removing everything that describes the
 * employer's actual systems. Names become stable pseudonyms, so the same service
 * reads as the same service throughout the report and across reports, without
 * ever saying what it is called.
 *
 * What is kept: predicates, entity kinds, counts, trust scores, timings, path
 * lengths, file extensions, error text from our own code.
 * What is replaced: entity names, literal values, file paths, repo names, URLs,
 * identifiers, and anything a user typed.
 */
export type Mode = 'full' | 'redacted' | 'stats'

// Changing this salt changes every pseudonym, so a report made before the change
// and one made after are not comparable - `service-a3f1` in one is not the same
// thing as in the other. Bumped deliberately with the rename, while no report
// anyone is comparing against existed.
const SALT = 'lore/report/v2'

function tag(value: string): string {
  return createHash('sha256').update(SALT).update(value.toLowerCase().trim()).digest('hex').slice(0, 4)
}

export class Redactor {
  constructor(readonly mode: Mode) {}

  get active(): boolean {
    return this.mode !== 'full'
  }

  /** A stable pseudonym that preserves kind, so structure stays readable. */
  name(value: string | null | undefined, kind?: string | null): string {
    if (value === null || value === undefined) return '(none)'
    if (!this.active) return value
    return `${(kind ?? 'thing').replace(/[^a-z_]/gi, '') || 'thing'}-${tag(value)}`
  }

  /** Free text and values: replaced entirely, shape retained. */
  literal(value: string | null | undefined): string {
    if (value === null || value === undefined) return '(none)'
    if (!this.active) return value
    return `[redacted ${value.length} chars]`
  }

  /** Paths keep the information that helps debugging: depth and file type. */
  path(value: string | null | undefined): string {
    if (!value) return '(none)'
    if (!this.active) return value
    const depth = value.split('/').filter(Boolean).length
    const ext = value.includes('.') ? `.${value.split('.').pop()}` : '(no ext)'
    return `[path depth=${depth} ${ext}]`
  }

  repo(value: string | null | undefined): string {
    if (!value) return '(none)'
    return this.active ? `repo-${tag(value)}` : value
  }

  /** Qualifiers: keys are vocabulary and safe; values may not be. */
  qualifiers(q: Record<string, unknown> | null | undefined): string {
    const entries = Object.entries(q ?? {})
    if (!entries.length) return ''
    if (!this.active) return entries.map(([k, v]) => `${k}=${v}`).join(' ')
    return entries
      .map(([k, v]) => {
        // method and role are closed vocabularies, not data.
        if (k === 'method' || k === 'role' || k === 'direction') return `${k}=${v}`
        return `${k}=${this.literal(String(v))}`
      })
      .join(' ')
  }
}
