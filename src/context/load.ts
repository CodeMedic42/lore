import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '../db/index.ts'
import { findAnchors } from '../query/ask.ts'
import { contextCandidates, parseContext, type ContextFrontmatter } from './spec.ts'
import { absolutePath, browseLink, freshness, locateRepo, sourceRefsFor, type Freshness } from './locate.ts'

export type ContextStatus =
  | 'loaded'            // found and read
  | 'no_context_file'   // source located, but nobody has written context for it
  | 'repo_not_local'    // we know where it lives, but not on this machine
  | 'path_missing'      // the recorded path no longer exists — a dangling pointer
  | 'no_source'         // nothing on record says where this thing lives
  | 'unknown_entity'

export interface ContextResult {
  status: ContextStatus
  entity?: { id: string; name: string; kind: string }
  sourcePath?: string
  contextPath?: string
  localPath?: string
  browseUrl?: string
  content?: string
  frontmatter?: ContextFrontmatter
  freshness?: Freshness
  truncated?: boolean
  message: string
}

const exists = async (p: string) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve an entity to its detailed context, loading it on demand.
 *
 * The graph knows a component exists and roughly where. The dense, fast-changing
 * detail lives beside the code in a context file, so it branches and merges with
 * the thing it describes and never rots in a central index.
 *
 * Every failure mode here still returns something useful. Not checked out? Here
 * is the URL. No context file written yet? Here is the source path — go look, or
 * ask me to write one.
 */
export async function loadContext(
  db: Db,
  target: string,
  opts: { maxChars?: number } = {},
): Promise<ContextResult> {
  const maxChars = opts.maxChars ?? 8000

  const entity = await resolveEntity(db, target)
  if (!entity) {
    return { status: 'unknown_entity', message: `Nothing in the graph called "${target}".` }
  }
  const ent = { id: entity.entity_id, name: entity.display_name, kind: entity.kind }

  const refs = await sourceRefsFor(db, entity.entity_id)
  if (!refs.length) {
    return {
      status: 'no_source',
      entity: ent,
      message:
        `The graph knows about ${ent.name} (${ent.kind}) but nothing records where its source lives. ` +
        `Record a claim with evidence {repo, path}, or a documented_at pointer, and this becomes answerable.`,
    }
  }

  let firstMissing: ContextResult | null = null

  for (const ref of refs) {
    const loc = await locateRepo(db, ref.repoName)
    const link = browseLink(loc, ref.path)

    if (!loc?.localPath) {
      return {
        status: 'repo_not_local',
        entity: ent,
        sourcePath: ref.path,
        browseUrl: link ?? undefined,
        message:
          `${ent.name} lives at ${ref.path}` +
          (ref.repoName ? ` in ${ref.repoName}` : '') +
          `, which is not checked out on this machine. ` +
          (link ? `Browse: ${link}` : 'Register it with `npm run context -- register <repo> <path>` to read its context files.'),
      }
    }

    const sourceAbs = absolutePath(loc, ref.path)
    if (!(await exists(sourceAbs))) {
      // A pointer to a path that no longer exists is worse than no pointer:
      // it reads as authoritative. Report it plainly and keep looking.
      firstMissing ??= {
        status: 'path_missing',
        entity: ent,
        sourcePath: ref.path,
        localPath: loc.localPath,
        browseUrl: link ?? undefined,
        message:
          `The graph points ${ent.name} at ${ref.path}, but that path no longer exists in ${loc.localPath}. ` +
          `It was probably moved or renamed — the recorded location is stale.`,
      }
      continue
    }

    for (const candidate of contextCandidates(ref.path)) {
      const abs = join(loc.localPath, candidate)
      if (!(await exists(abs))) continue

      const raw = await readFile(abs, 'utf8')
      const parsed = parseContext(raw)
      const described = parsed.frontmatter.describes.length
        ? parsed.frontmatter.describes.map((d) => resolveRelative(candidate, d))
        : [ref.path]
      const fresh = await freshness(loc.localPath, parsed.frontmatter.generatedFrom, described, candidate)

      const truncated = parsed.body.length > maxChars
      return {
        status: 'loaded',
        entity: ent,
        sourcePath: ref.path,
        contextPath: candidate,
        localPath: loc.localPath,
        browseUrl: browseLink(loc, candidate) ?? undefined,
        content: truncated ? `${parsed.body.slice(0, maxChars)}\n\n…[truncated]` : parsed.body,
        frontmatter: parsed.frontmatter,
        freshness: fresh,
        truncated,
        message: describeFreshness(ent.name, candidate, fresh, parsed.malformed),
      }
    }

    return {
      status: 'no_context_file',
      entity: ent,
      sourcePath: ref.path,
      localPath: loc.localPath,
      browseUrl: link ?? undefined,
      message:
        `No context file has been written for ${ent.name} yet. The source is at ${ref.path}` +
        (link ? ` (${link})` : '') +
        `. Read it directly, or write ${contextCandidates(ref.path)[0]} so the next person does not have to.`,
    }
  }

  return firstMissing ?? {
    status: 'no_source',
    entity: ent,
    message: `Could not locate the source for ${ent.name}.`,
  }
}

function describeFreshness(name: string, path: string, f: Freshness, malformed: boolean): string {
  const head = `Context for ${name}, from ${path}.`
  const fm = malformed ? ' (No frontmatter — staleness cannot be checked.)' : ''
  if (!f.checked) return `${head}${fm}${f.reason ? ` Freshness unknown: ${f.reason}.` : ''}`
  if (f.commitsBehind === 0) return `${head} Up to date with the code it describes.`
  const files = f.changedFiles?.length ? ` Changed since: ${f.changedFiles.slice(0, 5).join(', ')}.` : ''
  return `${head} WARNING: ${f.commitsBehind} commit(s) have touched the described files since this was written.${files} Treat details as possibly out of date, and offer to refresh it.`
}

/** A path in frontmatter is relative to the context file, not the repo root. */
function resolveRelative(contextPath: string, described: string): string {
  if (described.startsWith('/')) return described.slice(1)
  const dir = contextPath.includes('/') ? contextPath.slice(0, contextPath.lastIndexOf('/')) : ''
  const joined = dir ? `${dir}/${described}` : described
  const parts: string[] = []
  for (const seg of joined.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

async function resolveEntity(db: Db, target: string) {
  if (/^[0-9a-f-]{36}$/i.test(target)) {
    const r = await db.query<{ entity_id: string; display_name: string; kind: string }>(
      `select id as entity_id, display_name, kind from entity where id = $1`, [target])
    return r.rows[0] ?? null
  }
  const anchors = await findAnchors(db, target, 3)
  return anchors[0] ?? null
}
