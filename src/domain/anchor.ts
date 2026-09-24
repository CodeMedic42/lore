import { createHash } from 'node:crypto'

/**
 * Evidence anchoring.
 *
 * When an agent claims something, it points at lines of code as proof. We need to
 * know later whether that proof still holds. Storing the file path and line numbers
 * is not enough: line numbers shift the moment anyone edits above them, and a file
 * path tells you nothing about whether the relevant code changed.
 *
 * So we store a hash of the actual lines, with whitespace normalised first. Then:
 *   - reindenting, reflowing or running a formatter produces the SAME hash  -> ok
 *   - the code moving elsewhere in the file is found by sliding window       -> moved
 *   - the code genuinely changing or disappearing                           -> gone
 *
 * That distinction is the point. A reformat must not look like a broken claim.
 */

export type AnchorState = 'unchecked' | 'ok' | 'shifted' | 'changed' | 'gone'

/**
 * Strip purely cosmetic differences, so running a formatter does not look like a
 * change in meaning.
 *
 * Deliberately language-agnostic and deliberately shallow - it absorbs what
 * Prettier, Black and gofmt actually do (reindent, reflow, requote, add or drop
 * trailing punctuation) without pretending to parse anything. Quote style and
 * trailing semicolons carry no meaning in any language this targets; anything
 * beyond that is left alone, because guessing wrong here means hiding a real
 * change behind a "still fine" badge.
 */
export function normaliseLine(line: string): string {
  return line
    .replace(/\s+/g, ' ')
    .replace(/['\`\u2018\u2019\u201c\u201d]/g, '"')  // quote style is cosmetic
    .replace(/[;,]+\s*$/, '')                        // trailing semicolons / commas
    .trim()
}

/** Normalised, non-blank lines with their original 1-based line numbers. */
export function normaliseFile(content: string): Array<{ line: number; text: string }> {
  return content
    .split(/\r?\n/)
    .map((text, i) => ({ line: i + 1, text: normaliseLine(text) }))
    .filter((l) => l.text.length > 0)
}

export function digestOf(normalisedLines: string[]): Buffer {
  return createHash('sha256').update(normalisedLines.join('\n')).digest()
}

export interface SpanDigest {
  digest: Buffer
  normLines: number
}

/** Hash the span an agent cited, as it exists in this version of the file. */
export function digestSpan(content: string, from: number, to: number): SpanDigest | null {
  const lines = normaliseFile(content).filter((l) => l.line >= from && l.line <= to)
  if (!lines.length) return null
  return { digest: digestOf(lines.map((l) => l.text)), normLines: lines.length }
}

/** Hash a span the agent supplied directly (it already had the text in context). */
export function digestText(spanText: string): SpanDigest | null {
  const lines = normaliseFile(spanText)
  if (!lines.length) return null
  return { digest: digestOf(lines.map((l) => l.text)), normLines: lines.length }
}

export interface AnchorCheck {
  state: AnchorState
  movedTo?: { from: number; to: number }
  reason: string
}

/**
 * Re-check one anchor against the current file.
 *
 * `content` of null means the file no longer exists at that path.
 */
export function checkAnchor(
  content: string | null,
  anchor: {
    from: number | null
    to: number | null
    digest: Buffer | null
    normLines: number | null
    enclosingSymbol?: string | null
  },
): AnchorCheck {
  if (content === null) return { state: 'gone', reason: 'file no longer exists at that path' }
  if (!anchor.digest || !anchor.normLines) {
    return { state: 'unchecked', reason: 'no span hash was recorded when this was asserted' }
  }

  const file = normaliseFile(content)

  // 1. Still exactly where it was?
  if (anchor.from != null && anchor.to != null) {
    const atOriginal = file.filter((l) => l.line >= anchor.from! && l.line <= anchor.to!)
    if (atOriginal.length === anchor.normLines) {
      if (digestOf(atOriginal.map((l) => l.text)).equals(anchor.digest)) {
        return { state: 'ok', reason: 'span unchanged (ignoring formatting)' }
      }
    }
  }

  // 2. Same code, somewhere else in the file? Slide a window of the same size.
  for (let i = 0; i + anchor.normLines <= file.length; i++) {
    const window = file.slice(i, i + anchor.normLines)
    if (digestOf(window.map((l) => l.text)).equals(anchor.digest)) {
      // Same code, new position. The evidence is intact - heal the line numbers
      // and stay trusted rather than queueing noise.
      return {
        state: 'shifted',
        movedTo: { from: window[0]!.line, to: window[window.length - 1]!.line },
        reason: 'identical span found elsewhere in the file; line numbers updated',
      }
    }
  }

  // 3. The code changed. If the enclosing function/class survives, this is a
  //    revision to review rather than a vanished claim.
  if (anchor.enclosingSymbol && content.includes(anchor.enclosingSymbol)) {
    return { state: 'changed', reason: `span changed but ${anchor.enclosingSymbol} still exists` }
  }

  return { state: 'gone', reason: 'span changed and no enclosing symbol survives' }
}
