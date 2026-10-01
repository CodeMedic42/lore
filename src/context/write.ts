import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Db } from '../db/index.ts'
import { findAnchors } from '../query/ask.ts'
import { contextCandidates, isContextFile, parseContext, type ContextFrontmatter } from './spec.ts'
import { absolutePath, locateRepo, sourceRefsFor, type RepoLocation } from './locate.ts'

const run = promisify(execFile)
const exists = async (p: string) => {
  try { await access(p); return true } catch { return false }
}

export interface DraftMaterial {
  ok: boolean
  message: string
  entity?: { id: string; name: string; kind: string }
  repoPath?: string
  sourcePath?: string
  contextPath?: string
  headCommit?: string
  /** The source as it stands now. */
  source?: string
  sourceTruncated?: boolean
  /** The context file that already exists, if any — refresh it, do not replace it. */
  existing?: string
  existingFrontmatter?: ContextFrontmatter
  /** What changed since the context was last written. */
  changedSince?: string
  commitSubjects?: string[]
  pendingDiff?: string
  /** What the graph already records — belongs in the graph, not in the file. */
  graphFacts?: string[]
  dirty?: boolean
}

/**
 * Everything needed to write or refresh a context file — except the words.
 *
 * The agent calling this IS the language model, so it writes the prose. This
 * gathers the material and keeps the mechanical parts (paths, frontmatter,
 * stamping) out of its hands, where they would be got subtly wrong.
 *
 * For a refresh, the diff matters more than the source: the goal is to update
 * what changed and leave hand-written nuance alone, not to regenerate from
 * scratch and quietly discard someone's hard-won gotcha.
 */
export async function draftMaterial(
  db: Db,
  target: string,
  opts: { since?: string; includePending?: boolean; maxChars?: number } = {},
): Promise<DraftMaterial> {
  const maxChars = opts.maxChars ?? 12000

  const anchors = await findAnchors(db, target, 3)
  const entity = /^[0-9a-f-]{36}$/i.test(target)
    ? (await db.query<any>('select id as entity_id, display_name, kind from entity where id = $1', [target])).rows[0]
    : anchors[0]
  if (!entity) return { ok: false, message: `Nothing in the graph called "${target}".` }
  const ent = { id: entity.entity_id, name: entity.display_name, kind: entity.kind }

  const refs = await sourceRefsFor(db, ent.id)
  if (!refs.length) {
    return {
      ok: false, entity: ent,
      message: `Nothing records where ${ent.name}'s source lives, so there is no file to document. Record a claim with evidence {repo, path} first.`,
    }
  }

  let loc: RepoLocation | null = null
  let ref = refs[0]!
  for (const candidate of refs) {
    const l = await locateRepo(db, candidate.repoName)
    if (l?.localPath && (await exists(absolutePath(l, candidate.path)))) {
      loc = l
      ref = candidate
      break
    }
  }
  if (!loc?.localPath) {
    return {
      ok: false, entity: ent, sourcePath: ref.path,
      message: `${ent.name}'s repository is not checked out here, so its source cannot be read. Register it with \`npm run context -- register\`.`,
    }
  }

  const repoPath = loc.localPath
  const sourceAbs = absolutePath(loc, ref.path)
  const rawSource = await readFile(sourceAbs, 'utf8').catch(() => '')
  const sourceTruncated = rawSource.length > maxChars

  const contextPath = contextCandidates(ref.path)[0]!
  const contextAbs = join(repoPath, contextPath)
  const existingRaw = (await exists(contextAbs)) ? await readFile(contextAbs, 'utf8') : null
  const parsed = existingRaw ? parseContext(existingRaw) : null

  const head = await git(repoPath, ['rev-parse', '--short', 'HEAD'])
  const since = opts.since ?? parsed?.frontmatter.generatedFrom
  const described = parsed?.frontmatter.describes.length
    ? parsed.frontmatter.describes.map((d) => join(dirname(contextPath), d).replace(/\\/g, '/'))
    : [ref.path]

  let changedSince: string | undefined
  let commitSubjects: string[] | undefined
  if (since) {
    const log = await git(repoPath, ['log', '--format=%h %s', `${since}..HEAD`, '--', ...described])
    commitSubjects = log ? log.split('\n').filter(Boolean) : []
    const diff = await git(repoPath, ['diff', `${since}..HEAD`, '--', ...described])
    if (diff) changedSince = diff.length > maxChars ? `${diff.slice(0, maxChars)}\n…[diff truncated]` : diff
  }

  const dirtyList = await git(repoPath, ['status', '--porcelain', '--', ...described])
  const dirty = Boolean(dirtyList)
  let pendingDiff: string | undefined
  if (opts.includePending && dirty) {
    const d = await git(repoPath, ['diff', 'HEAD', '--', ...described])
    if (d) pendingDiff = d.length > maxChars ? `${d.slice(0, maxChars)}\n…[diff truncated]` : d
  }

  // What the graph already holds. Repeating it in the file is duplication that
  // will drift; the point of the split is that each tier holds its own half.
  const edges = await db.query<{ predicate: string; other: string; dir: string }>(
    `select ec.predicate, oe.display_name as other, 'out' as dir
       from edges_canon(now()) ec join entity oe on oe.id = ec.object
      where ec.subject = $1 and ec.object is not null
     union all
     select ec.predicate, se.display_name, 'in'
       from edges_canon(now()) ec join entity se on se.id = ec.subject
      where ec.object = $1
      limit 40`,
    [ent.id],
  )

  return {
    ok: true,
    entity: ent,
    repoPath,
    sourcePath: ref.path,
    contextPath,
    headCommit: head ?? undefined,
    source: sourceTruncated ? `${rawSource.slice(0, maxChars)}\n…[truncated]` : rawSource,
    sourceTruncated,
    existing: parsed?.body,
    existingFrontmatter: parsed?.frontmatter,
    changedSince,
    commitSubjects,
    pendingDiff,
    dirty,
    graphFacts: edges.rows.map((e) =>
      e.dir === 'out' ? `${ent.name} ${e.predicate} ${e.other}` : `${e.other} ${e.predicate} ${ent.name}`),
    message: existingRaw
      ? `Refreshing ${contextPath}. Update what changed; keep everything still accurate.`
      : `Writing ${contextPath} for the first time.`,
  }
}

export interface WriteResult {
  ok: boolean
  created: boolean
  contextPath?: string
  absolutePath?: string
  stampedCommit?: string
  warnings: string[]
  message: string
}

/**
 * Persist a context file with correct frontmatter.
 *
 * Handles the mechanics the agent should not have to: where the file goes, the
 * `describes` path relative to it, stamping `generated_from` with HEAD, and
 * preserving any frontmatter a human added (owner, status, links) rather than
 * flattening it on every rewrite.
 */
export async function writeContext(
  db: Db,
  input: { target: string; body: string; path?: string; describes?: string[] },
): Promise<WriteResult> {
  const warnings: string[] = []
  const material = await draftMaterial(db, input.target, { maxChars: 1 })
  if (!material.ok || !material.repoPath) {
    return { ok: false, created: false, warnings, message: material.message }
  }

  const contextPath = (input.path ?? material.contextPath!).replace(/^\.?\//, '')
  if (!isContextFile(contextPath)) {
    return {
      ok: false, created: false, warnings,
      message: `Refusing to write "${contextPath}": a context file must end in .context.md, so this cannot overwrite source by mistake.`,
    }
  }

  const repoPath = resolve(material.repoPath)
  const abs = resolve(join(repoPath, contextPath))
  if (!abs.startsWith(`${repoPath}/`)) {
    return { ok: false, created: false, warnings, message: 'Refusing to write outside the repository.' }
  }

  const existed = await exists(abs)
  const prior = existed ? parseContext(await readFile(abs, 'utf8')) : null

  // `describes` is relative to the context file, not the repo root.
  const describes = input.describes?.length
    ? input.describes
    : prior?.frontmatter.describes.length
      ? prior.frontmatter.describes
      : [relativeFromContext(contextPath, material.sourcePath!)]

  const head = material.headCommit ?? (await git(repoPath, ['rev-parse', '--short', 'HEAD'])) ?? undefined
  if (!head) warnings.push('not a git checkout, so `generated_from` was left empty and staleness cannot be checked later')
  if (material.dirty) {
    warnings.push(
      'the described files have uncommitted changes — `generated_from` records HEAD, which does not include them. ' +
      'Commit the code and the context together, then this reads as current.',
    )
  }

  const fm: string[] = ['---']
  fm.push(describes.length === 1 ? `describes: ${describes[0]}` : `describes: [${describes.join(', ')}]`)
  if (head) fm.push(`generated_from: ${head}`)
  // Keep whatever a human put there. Losing an `owner:` line on every refresh is
  // exactly the kind of small betrayal that stops people maintaining these.
  for (const [k, v] of Object.entries(prior?.frontmatter.extra ?? {})) fm.push(`${k}: ${v}`)
  fm.push('---', '')

  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, `${fm.join('\n')}${input.body.trim()}\n`, 'utf8')

  return {
    ok: true,
    created: !existed,
    contextPath,
    absolutePath: abs,
    stampedCommit: head,
    warnings,
    message: `${existed ? 'Updated' : 'Created'} ${contextPath}${head ? `, stamped ${head}` : ''}. Commit it alongside the code it describes.`,
  }
}

function relativeFromContext(contextPath: string, sourcePath: string): string {
  const rel = relative(dirname(contextPath), sourcePath).replace(/\\/g, '/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
    return stdout.trim()
  } catch {
    return null
  }
}
