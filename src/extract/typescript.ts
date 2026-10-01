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
  /** Leading doc comment, if the author left one. */
  doc?: string
}

/**
 * The block comment immediately above a declaration.
 *
 * Worth the trouble because it is the only prose most components carry, and a
 * name alone is thin material for matching "is there already something that does
 * X?" - which is the question this whole feature exists to answer.
 */
export function leadingDoc(source: string, index: number): string | undefined {
  const before = source.slice(0, index)
  const m = /\/\*\*([\s\S]*?)\*\/\s*(?:export\s+)?$/.exec(before)
  if (!m) return undefined
  const text = m[1]!
    .split('\n')
    .map((l) => l.replace(/^\s*\*ic?/, '').replace(/^\s*\*/, '').trim())
    .filter((l) => l && !l.startsWith('@'))
    .join(' ')
    .trim()
  return text || undefined
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
    // `export default Foo` but NOT `export default Hoc(Foo)` - in the call form the
    // captured name is the wrapper (memo, applyForwardRef, ApplyConsumer), and
    // recording it would invent a component that does not exist.
    // Two separate shapes, because one pattern with an optional `function|class`
    // lets the group match empty and capture the keyword itself as the name.
    [/export\s+default\s+(?:async\s+)?(?:function|class)\s+([\w$]+)/g, 'default'],
    // `export default Foo` but NOT `export default Hoc(Foo)`. The \b matters:
    // without it the greedy capture BACKTRACKS to satisfy the lookahead, so
    // `export default ApplyConsumer(` quietly yields "ApplyConsume".
    [/export\s+default\s+(?!(?:async\s+)?(?:function|class)\b)([\w$]+)\b(?!\s*\()/g, 'default'],
    // `export default memo(TextField)` exports the COMPONENT, wrapped. Recording
    // the wrapper invents something that does not exist; recording nothing loses
    // the component and every edge into it. The inner argument is the answer.
    [/export\s+default\s+[\w$.]+\(\s*([A-Z][\w$]*)\s*[,)]/g, 'default'],
  ]
  for (const [re, kind] of patterns) {
    for (const m of src.matchAll(re)) {
      const name = m[1]
      if (!name && kind !== 'default') continue
      const chosen = name ?? 'default'
      out.push({
        name: chosen, kind, line: lineOf(m.index ?? 0),
        // Read the doc from the ORIGINAL source: decommenting blanked it out.
        // A doc comment sits above the DECLARATION, and `export default Button`
        // usually appears far below it, so fall back to finding the declaration.
        doc: leadingDoc(source, m.index ?? 0) ?? docForName(source, chosen),
      })
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

/**
 * The doc comment above wherever `name` is declared.
 *
 * `export default Button` at the bottom of a file carries no comment of its own;
 * the prose lives above `const Button = ...`. Without this, a library that exports
 * at the end of each file reports zero documentation and similarity search has
 * only names to work with.
 */
export function docForName(source: string, name: string): string | undefined {
  const decl = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:const|let|var|function|class)\\s+${name}\\b`,
  ).exec(source)
  if (!decl) return undefined
  return leadingDoc(source, decl.index + (decl[0].length - decl[0].trimStart().length))
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

/**
 * PascalCase, in a JSX-capable file, exported as a value rather than a type.
 *
 * The kind check is load-bearing. A component library exports roughly as many
 * PascalCase INTERFACES as components - BadgeProps, ChipProps, DatePickerHandle -
 * and without it a third of the "components" found are type declarations, which
 * then pollute every answer about what exists and what composes what.
 */
export function looksLikeComponent(name: string, path: string, kind?: ExportedName['kind']): boolean {
  if (kind === 'type') return false
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) return false
  if (!/\.(tsx|jsx)$/.test(path)) return false
  // Screaming case is a constant, not a component.
  if (name === name.toUpperCase()) return false
  // Conventional suffixes for the types that accompany a component.
  return !/(Props|PropsInt|Handle|Ref|Context|Options|Config|Args|State|Result)$/.test(name)
}
