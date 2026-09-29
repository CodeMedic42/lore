/**
 * The context-file convention.
 *
 * Two tiers of knowledge, split along the line that matters:
 *
 *   THE GRAPH holds facts that cross a boundary - library-a exports TextField,
 *   TextField composes DatePicker from library-b, this service reads that database.
 *   Rare churn, global scope, no repository can hold it.
 *
 *   A CONTEXT FILE holds everything inside one boundary - props, variants,
 *   sub-components, gotchas, usage. Fast churn, local scope, and it lives beside
 *   the code so version control keeps it current for free. It branches and merges
 *   with the thing it describes, which is why it does not suffer the merge pain of
 *   a dense in-repo index: the person editing TextField.tsx is the person editing
 *   TextField.context.md, in the same commit.
 *
 * The graph stores a POINTER. Detail is loaded on demand, and when it is missing
 * the honest answer - "it is over there, go look" - is still a useful answer.
 *
 * Format: markdown, colocated, with light frontmatter.
 *
 *     src/components/TextField.tsx
 *     src/components/TextField.context.md
 *
 *     ---
 *     describes: ./TextField.tsx
 *     generated_from: 4a91c2e
 *     ---
 *
 *     # TextField
 *     ...
 *
 * `generated_from` is the commit the file was written against. That single field
 * makes staleness checkable with `git log <sha>..HEAD -- <described files>`:
 * instant, local, exact, and far better than hashing the content.
 */

export const CONTEXT_SUFFIX = '.context.md'
export const DIRECTORY_CONTEXT = '.context.md'

export interface ContextFrontmatter {
  /** Files this context describes, relative to the context file. */
  describes: string[]
  /** Commit the context was written against, for staleness checking. */
  generatedFrom?: string
  updated?: string
  /** Anything else the author put there. */
  extra: Record<string, string>
}

export interface ParsedContext {
  frontmatter: ContextFrontmatter
  body: string
  /** Frontmatter was absent or unreadable - the body is still usable. */
  malformed: boolean
}

/**
 * Parse the frontmatter block. Deliberately a tiny YAML subset - these files are
 * meant to be hand-writable, and a dependency here would be a tax on every repo
 * that adopts the convention.
 */
export function parseContext(text: string): ParsedContext {
  const empty: ContextFrontmatter = { describes: [], extra: {} }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { frontmatter: empty, body: text.trim(), malformed: true }

  const fm: ContextFrontmatter = { describes: [], extra: {} }
  const lines = match[1]!.split(/\r?\n/)
  let listKey: string | null = null

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && listKey) {
      push(fm, listKey, unquote(item[1]!))
      continue
    }

    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]!.toLowerCase().replace(/-/g, '_')
    const value = kv[2]!.trim()

    if (!value) {
      listKey = key
      continue
    }
    listKey = null
    if (value.startsWith('[')) {
      for (const v of value.replace(/^\[|\]$/g, '').split(',')) {
        const t = unquote(v.trim())
        if (t) push(fm, key, t)
      }
    } else {
      push(fm, key, unquote(value))
    }
  }

  return { frontmatter: fm, body: text.slice(match[0].length).trim(), malformed: false }
}

function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, '').trim()
}

function push(fm: ContextFrontmatter, key: string, value: string): void {
  if (key === 'describes' || key === 'describe' || key === 'files') fm.describes.push(value)
  else if (key === 'generated_from' || key === 'commit') fm.generatedFrom = value
  else if (key === 'updated' || key === 'date') fm.updated = value
  else fm.extra[key] = fm.extra[key] ? `${fm.extra[key]}, ${value}` : value
}

/**
 * Where a context file for `sourcePath` might live, most specific first.
 *
 * Colocation is deliberate: the file moves when the component moves, a human can
 * see it sitting there, and no tooling is needed to find it.
 */
export function contextCandidates(sourcePath: string): string[] {
  const clean = sourcePath.replace(/^\.\//, '').replace(/\/+$/, '')
  const out: string[] = []
  const looksLikeFile = /\.[A-Za-z0-9]+$/.test(clean)

  if (looksLikeFile) {
    const withoutExt = clean.replace(/\.[A-Za-z0-9]+$/, '')
    out.push(`${withoutExt}${CONTEXT_SUFFIX}`)      // TextField.context.md
    out.push(`${clean}${CONTEXT_SUFFIX}`)           // TextField.tsx.context.md
    const dir = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : ''
    // index.tsx inside a component folder: the folder's own context file
    if (/(^|\/)index\.[A-Za-z0-9]+$/.test(clean) && dir) {
      out.push(`${dir}/${DIRECTORY_CONTEXT}`)
      out.push(`${dir}${CONTEXT_SUFFIX}`)
    }
    if (dir) out.push(`${dir}/${DIRECTORY_CONTEXT}`)
  } else {
    out.push(`${clean}/${DIRECTORY_CONTEXT}`)
    out.push(`${clean}${CONTEXT_SUFFIX}`)
  }
  return [...new Set(out)]
}

/** Does this path look like a context file? */
export function isContextFile(path: string): boolean {
  return path.endsWith(CONTEXT_SUFFIX) || path.endsWith(`/${DIRECTORY_CONTEXT}`) || path === DIRECTORY_CONTEXT
}
