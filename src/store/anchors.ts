import type { Db } from '../db/index.ts'
import { checkAnchor, type AnchorState } from '../domain/anchor.ts'

export interface AnchorCheckSummary {
  checked: number
  ok: number
  shifted: number
  changed: number
  gone: number
  unchecked: number
}

/**
 * Re-check every anchor recorded against one file.
 *
 * This is what a GitLab-watching worker calls when a file changes: hand it the new
 * contents, and every claim that cited that file is re-examined. A claim whose
 * evidence merely got reformatted or shifted stays trusted; one whose evidence
 * actually changed moves into the re-verification queue.
 *
 * Pass `content: null` when the file was deleted.
 */
export async function checkFileAnchors(
  db: Db,
  input: { repo?: string | null; path: string; content: string | null; commit?: string | null },
): Promise<AnchorCheckSummary> {
  const rows = await db.query<{
    id: string
    line_from: number | null
    line_to: number | null
    span_sha256: Buffer | null
    span_norm_lines: number | null
    enclosing_symbol: string | null
  }>(
    `select ea.id, ea.line_from, ea.line_to, ea.span_sha256, ea.span_norm_lines, ea.enclosing_symbol
       from evidence_anchor ea
       join assertion a on a.id = ea.assertion_id
      where ea.path = $1
        and ($2::text is null or ea.repo = $2)
        and a.valid_to is null and a.expired_at is null`,
    [input.path, input.repo ?? null],
  )

  const summary: AnchorCheckSummary = { checked: 0, ok: 0, shifted: 0, changed: 0, gone: 0, unchecked: 0 }

  for (const row of rows.rows) {
    const digest = row.span_sha256 ? Buffer.from(row.span_sha256) : null
    const result = checkAnchor(input.content, {
      from: row.line_from,
      to: row.line_to,
      digest,
      normLines: row.span_norm_lines,
      enclosingSymbol: row.enclosing_symbol,
    })

    // A shift heals itself: record the new location as the anchor's own lines so
    // the next check compares against where the code actually is now.
    if (result.state === 'shifted' && result.movedTo) {
      await db.query(
        `update evidence_anchor
            set state = 'shifted', line_from = $2, line_to = $3,
                moved_to_from = $2, moved_to_to = $3,
                checked_at = now(), checked_commit = $4
          where id = $1`,
        [row.id, result.movedTo.from, result.movedTo.to, input.commit ?? null],
      )
    } else {
      await db.query(
        `update evidence_anchor
            set state = $2, moved_to_from = null, moved_to_to = null,
                checked_at = now(), checked_commit = $3
          where id = $1`,
        [row.id, result.state, input.commit ?? null],
      )
    }

    summary.checked++
    summary[result.state as Exclude<AnchorState, never>]++
  }
  return summary
}

export interface QueueItem {
  anchor_id: string
  assertion_id: string
  proposition_id: string
  repo: string | null
  path: string
  line_from: number | null
  line_to: number | null
  enclosing_symbol: string | null
  state: AnchorState
  method: string
  asserted_by: string | null
  predicate: string
}

/**
 * The verification agent's work list.
 *
 * This is the point of the whole mechanism: a broken anchor does not quietly
 * lower a score that nobody can validate. It produces a concrete task - "go look
 * at this file and decide whether this claim still holds" - which the verifier
 * answers by writing a supporting or REFUTING assertion.
 */
export async function reverificationQueue(db: Db, limit = 50): Promise<QueueItem[]> {
  const r = await db.query<QueueItem>('select * from reverification_queue limit $1', [limit])
  return r.rows
}
