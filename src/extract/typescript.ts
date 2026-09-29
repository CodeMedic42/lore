/**
 * Lightweight TypeScript/JSX scanning.
 *
 * Deliberately not the compiler API and not tree-sitter. The facts this needs -
 * what a file imports, what it exports, which imported components it renders -
 * are legible from the text, and the alternative is a heavy dependency plus
 * tsconfig resolution for a marginal gain in precision.
 *
 * The bias throughout is toward IMPORTS, because an import is the cross-boundary
 * fact: it is the one thing a file states explicitly about the world outside
 * itself, and it is exactly what no single-package session can otherwise see.
 */

export interface ImportedBinding {
  /** Name as used in this file. */
  local: string
  /** Name as exported by the source module ('default' for a default import). */
  imported: string
  specifier: string
  typeOnly: boolean
}

export interface ExportedName {
  name: string
  kind: 'const' | 'function' | 'class' | 'default' | 'reexport' | 'type'
  line: number
}

/** Strip comments and strings so their contents cannot be mistaken for code. */
function decommented(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

const IMPORT_RE = /import\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
const BARE_IMPORT_RE = /import\s*['"]([^'"]+)['"]/g
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g

export function parseImports(source: string): ImportedBinding[] {
  const src = decommented(source)
  const out: ImportedBinding[] = []

  for (const m of src.matchAll(IMPORT_RE)) {
    const typeOnly = Boolean(m[1])
    const clause = (m[2] ?? '').trim()
    const specifier = m[3]!
    if (!clause) continue

    // import Default, { a, b as c }, * as ns from '...'
    const named = /\{([\s\S]*?)\}/.exec(clause)
    if (named) {
      for (const part of named[1]!.split(',')) {
        const bit = part.trim()
        if (!bit) continue
        const alias = /^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(bit)
        if (!alias) continue
        out.push({
          imported: alias[2]!,
          local: alias[3] ?? alias[2]!,
          specifier,
          typeOnly: typeOnly || Boolean(alias[1]),
        })
      }
    }
    const beforeBraces = clause.split('{')[0]!.replace(/,\s*$/, '').trim()
    const ns = /\*\s+as\s+([\w$]+)/.exec(beforeBraces)
    if (ns) out.push({ imported: '*', local: ns[1]!, specifier, typeOnly })
    else if (beforeBraces && /^[\w$]+$/.test(beforeBraces)) {
      out.push({ imported: 'default', local: beforeBraces, specifier, typeOnly })
    }
  }

  for (const m of src.matchAll(BARE_IMPORT_RE)) {
    out.push({ imported: '*', local: '', specifier: m[1]!, typeOnly: false })
  }
  for (const m of src.matchAll(REQUIRE_RE)) {
    out.push({ imported: '*', local: '', specifier: m[1]!, typeOnly: false })
  }
  return out
}

export function parseExports(source: string): ExportedName[] {
  const src = decommented(source)
  const out: ExportedName[] = []
  const lineOf = (index: number) => src.slice(0, index).split('\n').length

  const patterns: Array<[RegExp, ExportedName['kind']]> = [
    [/export\s+(?:async\s+)?function\s+([\w$]+)/g, 'function'],
    [/export\s+class\s+([\w$]+)/g, 'class'],
    [/export\s+(?:const|let|var)\s+([\w$]+)/g, 'const'],
    [/export\s+(?:type|interface)\s+([\w$]+)/g, 'type'],
    [/export\s+default\s+(?:async\s+)?(?:function|class)?\s*([\w$]+)?/g, 'default'],
  ]
  for (const [re, kind] of patterns) {
    for (const m of src.matchAll(re)) {
      const name = m[1]
      if (!name && kind !== 'default') continue
      out.push({ name: name ?? 'default', kind, line: lineOf(m.index ?? 0) })
    }
  }

  // export { A, B as C } — with or without a `from`
  for (const m of src.matchAll(/export\s*\{([\s\S]*?)\}(\s*from\s*['"][^'"]+['"])?/g)) {
    for (const part of m[1]!.split(',')) {
      const bit = part.trim()
      if (!bit) continue
      const alias = /^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(bit)
      if (!alias) continue
      out.push({
        name: alias[3] ?? alias[2]!,
        kind: alias[1] ? 'type' : m[2] ? 'reexport' : 'const',
        line: lineOf(m.index ?? 0),
      })
    }
  }

  const seen = new Set<string>()
  return out.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)))
}

/** JSX tags that start with a capital are components; lowercase ones are DOM. */
export function parseJsxUsage(source: string): string[] {
  const src = decommented(source)
  const names = new Set<string>()
  for (const m of src.matchAll(/<([A-Z][\w$]*(?:\.[A-Z][\w$]*)?)[\s/>]/g)) {
    names.add(m[1]!.split('.')[0]!)
  }
  return [...names]
}

/** PascalCase, in a JSX-capable file, is the usual signal for a component. */
export function looksLikeComponent(name: string, path: string): boolean {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) return false
  if (!/\.(tsx|jsx)$/.test(path)) return false
  // Screaming case is a constant, not a component.
  return name !== name.toUpperCase()
}
