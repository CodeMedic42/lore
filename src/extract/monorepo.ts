import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { Db } from '../db/index.ts'
import { ingest, type ObservationInput } from '../store/observations.ts'
import { beginScopedRun } from '../store/sweep.ts'
import { registerRepo } from '../context/locate.ts'
import { looksLikeComponent, parseExports, parseImports, parseJsxUsage } from './typescript.ts'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.turbo', '.cache', 'storybook-static', '__snapshots__', '.yarn', 'vendor',
])
const SOURCE_EXT = /\.(tsx?|jsx?|mts|cts)$/
const IGNORE_FILE = /\.(test|spec|stories|d)\.[jt]sx?$/

/** Dependency names worth recording, and the relation each one represents. */
const TECHNOLOGY: Array<[RegExp, string, string]> = [
  [/^react$/, 'uses_framework', 'React'],
  [/^@angular\/core$/, 'uses_framework', 'Angular'],
  [/^vue$/, 'uses_framework', 'Vue'],
  [/^svelte$/, 'uses_framework', 'Svelte'],
  [/^next$/, 'uses_framework', 'Next.js'],
  [/^@remix-run\//, 'uses_framework', 'Remix'],
  [/^express$/, 'uses_framework', 'Express'],
  [/^fastify$/, 'uses_framework', 'Fastify'],
  [/^@nestjs\/core$/, 'uses_framework', 'NestJS'],
  [/^webpack$/, 'built_with', 'Webpack'],
  [/^vite$/, 'built_with', 'Vite'],
  [/^rollup$/, 'built_with', 'Rollup'],
  [/^esbuild$/, 'built_with', 'esbuild'],
  [/^parcel$/, 'built_with', 'Parcel'],
  [/^@swc\/core$/, 'built_with', 'SWC'],
  [/^jest$/, 'tests_with', 'Jest'],
  [/^vitest$/, 'tests_with', 'Vitest'],
  [/^@playwright\/test$/, 'tests_with', 'Playwright'],
  [/^cypress$/, 'tests_with', 'Cypress'],
  [/^mocha$/, 'tests_with', 'Mocha'],
  [/^@testing-library\//, 'tests_with', 'Testing Library'],
  [/^typescript$/, 'written_in', 'TypeScript'],
  [/^sass$|^node-sass$/, 'written_in', 'SCSS'],
  [/^less$/, 'written_in', 'Less'],
  [/^styled-components$/, 'depends_on_package', 'styled-components'],
  [/^@emotion\//, 'depends_on_package', 'Emotion'],
  [/^tailwindcss$/, 'depends_on_package', 'Tailwind CSS'],
  [/^@storybook\//, 'depends_on_package', 'Storybook'],
  [/^@mui\/material$/, 'depends_on_package', 'MUI'],
  [/^redux$|^@reduxjs\/toolkit$/, 'depends_on_package', 'Redux'],
  [/^@tanstack\/react-query$|^react-query$/, 'depends_on_package', 'TanStack Query'],
  [/^graphql$/, 'depends_on_package', 'GraphQL'],
]

const EXTENSION_LANGUAGE: Array<[RegExp, string]> = [
  [/\.tsx?$/, 'TypeScript'],
  [/\.jsx?$/, 'JavaScript'],
  [/\.scss$/, 'SCSS'],
  [/\.less$/, 'Less'],
  [/\.vue$/, 'Vue'],
  [/\.svelte$/, 'Svelte'],
]

export interface ExtractOptions {
  root: string
  repoKey?: string
  env?: string
  browseUrl?: string
  /** Also record composition between components in the SAME package. Off by default:
   *  the graph is for what crosses a boundary, and intra-package detail belongs in
   *  a context file. */
  includeIntraPackage?: boolean
  dryRun?: boolean
  maxFiles?: number
  /** Skip packages whose name or path contains any of these. Storybook and example
   *  packages import everything, so left in they dominate every "what uses this"
   *  answer with demo code rather than real consumers. */
  exclude?: string[]
}

export interface ExtractResult {
  repoKey: string
  packages: string[]
  excluded: string[]
  files: number
  components: number
  /** How many components carry a doc comment. Low coverage means similarity
   *  search will be matching on names alone, which is barely better than grep. */
  documented: number
  observations: number
  accepted: number
  rejected: number
  swept: number
  warnings: string[]
  preview: string[]
}

interface PackageInfo {
  name: string
  dir: string
  manifest: any
  isPrivate: boolean
}

/**
 * Read a monorepo into the graph.
 *
 * Emits tier-one facts only: which packages exist, what they are built from, what
 * they export, and which package uses which. Props, variants and gotchas are not
 * touched - those belong in a context file beside the code.
 *
 * The whole scan runs under one scope key, so a re-run closes anything that has
 * since been deleted instead of leaving it to haunt the graph. That is the
 * mechanism that keeps a derived view honest over time.
 */
export async function extractMonorepo(db: Db, opts: ExtractOptions): Promise<ExtractResult> {
  const root = opts.root.replace(/\/+$/, '')
  const repoKey = opts.repoKey ?? basename(root)
  const env = opts.env ?? 'prod'
  const maxFiles = opts.maxFiles ?? 5000
  const warnings: string[] = []
  const preview: string[] = []

  const manifests = await findManifests(root)
  if (!manifests.length) {
    return {
      repoKey, packages: [], excluded: [], files: 0, components: 0, documented: 0, observations: 0,
      accepted: 0, rejected: 0, swept: 0,
      warnings: [`No package.json found under ${root} — is this a JavaScript/TypeScript project?`],
      preview,
    }
  }

  const packages: PackageInfo[] = []
  const excluded: string[] = []
  // Excluding a package must also keep its FILES out of the walk, or its parent
  // simply absorbs them and the demo code reappears under another name.
  const excludedDirs: string[] = []
  for (const file of manifests) {
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8'))
      if (!manifest.name) continue
      const dir = dirname(file)
      const relDir = relative(root, dir).replace(/\\/g, '/')
      // Storybook and example packages import everything they demonstrate, so
      // left in they dominate every "what uses this" answer with demo code
      // instead of real consumers.
      if (opts.exclude?.some((p) => manifest.name.includes(p) || relDir.includes(p))) {
        excluded.push(manifest.name)
        excludedDirs.push(dir)
        continue
      }
      packages.push({ name: manifest.name, dir, manifest, isPrivate: Boolean(manifest.private) })
    } catch {
      warnings.push(`could not parse ${relative(root, file)}`)
    }
  }
  const byName = new Map(packages.map((p) => [p.name, p]))

  const obs: ObservationInput[] = []
  const id = (authority: string, value: string) => [{ authority, value }]

  obs.push({
    subject: repoKey, subject_kind: 'repo', predicate: 'note',
    object_literal: `Monorepo with ${packages.length} package(s), indexed by the monorepo extractor.`,
  })

  let fileCount = 0
  let componentCount = 0
  let documented = 0
  const seenComponents = new Set<string>()

  for (const pkg of packages) {
    const rel = (p: string) => relative(root, p).replace(/\\/g, '/')
    obs.push({
      subject: pkg.name, subject_kind: 'package',
      subject_identifiers: id('npm_package', pkg.name),
      predicate: 'lives_in_repo', object: repoKey, object_kind: 'repo',
      evidence: [{ repo: repoKey, path: rel(join(pkg.dir, 'package.json')) }],
    })

    // What the package is built from, from its declared dependencies.
    const deps = { ...(pkg.manifest.dependencies ?? {}), ...(pkg.manifest.devDependencies ?? {}) }
    for (const dep of Object.keys(deps)) {
      const hit = TECHNOLOGY.find(([re]) => re.test(dep))
      if (hit) {
        obs.push({
          subject: pkg.name, subject_kind: 'package',
          subject_identifiers: id('npm_package', pkg.name),
          predicate: hit[1], object: hit[2], object_kind: 'technology',
          evidence: [{ repo: repoKey, path: rel(join(pkg.dir, 'package.json')) }],
        })
      }
      // A dependency on another package in this monorepo is a cross-boundary fact,
      // and the single most valuable thing this extractor produces.
      const workspaceDep = byName.get(dep)
      if (workspaceDep && workspaceDep.name !== pkg.name) {
        obs.push({
          subject: pkg.name, subject_kind: 'package',
          subject_identifiers: id('npm_package', pkg.name),
          predicate: 'depends_on_package',
          object: workspaceDep.name, object_kind: 'package',
          object_identifiers: id('npm_package', workspaceDep.name),
          evidence: [{ repo: repoKey, path: rel(join(pkg.dir, 'package.json')) }],
        })
      }
    }

    const sources = await walkSources(pkg.dir, packages, maxFiles - fileCount, excludedDirs)
    const languages = new Set<string>()

    for (const file of sources) {
      fileCount++
      const relPath = rel(file)
      for (const [re, lang] of EXTENSION_LANGUAGE) if (re.test(file)) languages.add(lang)
      if (!SOURCE_EXT.test(file) || IGNORE_FILE.test(file)) continue

      let text: string
      try {
        const s = await stat(file)
        if (s.size > 400_000) continue
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }

      const imports = parseImports(text)
      const exports = parseExports(text)
      const jsx = new Set(parseJsxUsage(text))

      // Components this file exports.
      const componentExports = exports.filter((e) => looksLikeComponent(e.name, file, e.kind))
      const localComponents = componentExports.map((e) => e.name)
      const docFor = new Map(componentExports.filter((e) => e.doc).map((e) => [e.name, e.doc!]))

      for (const name of localComponents) {
        const key = `${pkg.name}#${name}`
        componentCount++
        if (!seenComponents.has(key)) {
          seenComponents.add(key)
          obs.push({
            subject: name, subject_kind: 'component',
            subject_identifiers: id('module_export', key),
            predicate: 'part_of', object: pkg.name, object_kind: 'package',
            object_identifiers: id('npm_package', pkg.name),
            evidence: [{ repo: repoKey, path: relPath }],
          })
          // The author's own description of the thing, which is far better
          // material for "does something like this already exist?" than a name.
          const doc = docFor.get(name)
          if (doc) {
            documented++
            obs.push({
              subject: name, subject_kind: 'component',
              subject_identifiers: id('module_export', key),
              predicate: 'note', object_literal: doc.slice(0, 500),
              evidence: [{ repo: repoKey, path: relPath }],
            })
          }
          if (isEntryPoint(file, pkg) || exports.some((e) => e.kind === 'reexport' && e.name === name)) {
            obs.push({
              subject: pkg.name, subject_kind: 'package',
              subject_identifiers: id('npm_package', pkg.name),
              predicate: 'exports', object: name, object_kind: 'component',
              object_identifiers: id('module_export', key),
              evidence: [{ repo: repoKey, path: relPath }],
            })
          }
        }
      }

      // Which component in this file is doing the composing. Attribute only when
      // it is unambiguous - a wrong edge is worse than a missing one.
      const fileBase = basename(file).replace(SOURCE_EXT, '')
      const primary =
        localComponents.find((c) => c === fileBase) ??
        (localComponents.length === 1 ? localComponents[0] : undefined)

      for (const imp of imports) {
        if (imp.typeOnly || !imp.local) continue
        const target = resolveSpecifier(imp.specifier, pkg, byName, file)
        if (!target) continue
        const crossPackage = target.name !== pkg.name
        if (!crossPackage && !opts.includeIntraPackage) continue
        if (!jsx.has(imp.local)) continue
        if (!looksLikeComponent(imp.imported === 'default' ? imp.local : imp.imported, 'x.tsx')) continue
        if (!primary) continue

        const importedName = imp.imported === 'default' ? imp.local : imp.imported
        obs.push({
          subject: primary, subject_kind: 'component',
          subject_identifiers: id('module_export', `${pkg.name}#${primary}`),
          predicate: 'composes',
          object: importedName, object_kind: 'component',
          object_identifiers: id('module_export', `${target.name}#${importedName}`),
          evidence: [{ repo: repoKey, path: relPath }],
        })
        if (crossPackage) preview.push(`${pkg.name}/${primary} composes ${target.name}/${importedName}`)
      }
    }

    for (const lang of languages) {
      obs.push({
        subject: pkg.name, subject_kind: 'package',
        subject_identifiers: id('npm_package', pkg.name),
        predicate: 'written_in', object: lang, object_kind: 'technology',
      })
    }
  }

  if (opts.dryRun) {
    return {
      repoKey, packages: packages.map((p) => p.name), excluded, files: fileCount,
      components: seenComponents.size, documented, observations: obs.length,
      accepted: 0, rejected: 0, swept: 0, warnings,
      preview: preview.slice(0, 40),
    }
  }

  // Register the checkout so load_context can read context files immediately.
  await registerRepo(db, { repoKey, localPath: root, browseUrl: opts.browseUrl })

  const scopeKey = `${repoKey}@monorepo-scan`
  const runStart = new Date()
  const run = beginScopedRun(db, scopeKey, runStart)

  let accepted = 0
  let rejected = 0
  for (let i = 0; i < obs.length; i += 200) {
    const batch = obs.slice(i, i + 200)
    const r = await ingest(db, {
      agent: 'monorepo-extractor', session: `scan-${runStart.toISOString()}`,
      repo: repoKey, env, method: 'code_derived', scope_key: scopeKey,
      observations: batch,
    })
    accepted += r.accepted
    rejected += r.rejected
    for (const f of r.results.filter((x) => !x.accepted)) {
      if (warnings.length < 20) warnings.push(f.error ?? 'rejected')
    }
  }

  // Anything this scan did not re-assert is gone from the code, so close it.
  const sweep = await run.finish()

  return {
    repoKey, packages: packages.map((p) => p.name), excluded, files: fileCount,
    components: seenComponents.size, documented, observations: obs.length,
    accepted, rejected, swept: sweep.removedEdges, warnings, preview: preview.slice(0, 40),
  }
}

function isEntryPoint(file: string, pkg: PackageInfo): boolean {
  const rel = relative(pkg.dir, file).replace(/\\/g, '/')
  const main = (pkg.manifest.main ?? pkg.manifest.module ?? pkg.manifest.exports?.['.'] ?? '')
  const mainStr = typeof main === 'string' ? main.replace(/^\.\//, '') : ''
  return /^(src\/)?index\.[jt]sx?$/.test(rel) || (Boolean(mainStr) && rel === mainStr)
}

/** Which package an import refers to, if any. */
function resolveSpecifier(
  specifier: string,
  from: PackageInfo,
  byName: Map<string, PackageInfo>,
  file: string,
): PackageInfo | null {
  if (specifier.startsWith('.')) return from // relative: same package
  // '@acme/library-a/components' still belongs to '@acme/library-a'
  const parts = specifier.split('/')
  const candidates = specifier.startsWith('@')
    ? [parts.slice(0, 2).join('/'), specifier]
    : [parts[0]!, specifier]
  for (const c of candidates) {
    const hit = byName.get(c)
    if (hit) return hit
  }
  return null
}

async function findManifests(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > 8) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(full, depth + 1)
      } else if (e.name === 'package.json') {
        out.push(full)
      }
    }
  }
  await walk(root, 0)
  return out
}

/** Source files belonging to this package — not to a nested one. */
async function walkSources(
  dir: string,
  packages: PackageInfo[],
  budget: number,
  excludedDirs: string[] = [],
): Promise<string[]> {
  const nested = [
    ...packages.map((p) => p.dir).filter((d) => d !== dir && d.startsWith(`${dir}/`)),
    ...excludedDirs.filter((d) => d.startsWith(`${dir}/`) || d === dir),
  ]
  const out: string[] = []
  const walk = async (current: string, depth: number) => {
    if (out.length >= budget || depth > 12) return
    if (nested.some((n) => current === n || current.startsWith(`${n}/`))) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= budget) return
      if (e.name.startsWith('.')) continue
      const full = join(current, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(full, depth + 1)
      } else if (SOURCE_EXT.test(e.name) || /\.(scss|less|vue|svelte)$/.test(e.name)) {
        out.push(full)
      }
    }
  }
  await walk(dir, 0)
  return out
}
