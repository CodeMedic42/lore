import { execFile } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Db } from '../db/index.ts'

const run = promisify(execFile)

export interface RepoLocation {
  repoKey: string
  displayName: string
  localPath?: string
  browseUrl?: string
  branch: string
}

export interface SourceRef {
  repoEntity: string | null
  repoName: string | null
  path: string
  /** How many live assertions cite this path — the most-cited is the likeliest home. */
  weight: number
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
 * Where an entity's source actually lives.
 *
 * Two sources, in order of authority:
 *   1. an explicit `documented_at` pointer, if someone recorded one
 *   2. the file paths cited as evidence when claims about it were recorded
 *
 * Evidence is usually the better signal in practice: it is a by-product of normal
 * recording rather than something anyone has to remember to maintain.
 */
export async function sourceRefsFor(db: Db, entityId: string): Promise<SourceRef[]> {
  const explicit = await db.query<{ value: string; repo: string | null; repo_name: string | null }>(
    `select ec.object_literal as value, null::uuid as repo, null::text as repo_name
       from edges_canon(now()) ec
      where ec.subject = $1 and ec.predicate = 'documented_at' and ec.object_literal is not null`,
    [entityId],
  )

  const fromEvidence = await db.query<{ path: string; repo: string | null; n: number }>(
    `select ev->>'path' as path, ev->>'repo' as repo, count(*)::int as n
       from assertion a
       join proposition p on p.id = a.proposition_id
       cross join lateral jsonb_array_elements(a.evidence) ev
      where p.subject_entity = $1
        and a.polarity and a.valid_to is null and a.expired_at is null
        and ev ? 'path'
      group by 1, 2 order by n desc limit 10`,
    [entityId],
  )

  // The repo an entity belongs to, for turning a relative path into a location.
  const home = await db.query<{ repo: string; display_name: string }>(
    `select er.repo, r.display_name
       from entity_repo(now()) er join entity r on r.id = er.repo
      where er.entity_id = $1 limit 1`,
    [entityId],
  )
  const homeRepo = home.rows[0]

  const refs: SourceRef[] = []
  for (const e of explicit.rows) {
    if (!e.value) continue
    refs.push({
      repoEntity: homeRepo?.repo ?? null,
      repoName: homeRepo?.display_name ?? null,
      path: e.value,
      weight: 1000, // explicit beats inferred
    })
  }
  for (const e of fromEvidence.rows) {
    refs.push({
      repoEntity: homeRepo?.repo ?? null,
      repoName: e.repo ?? homeRepo?.display_name ?? null,
      path: e.path,
      weight: e.n,
    })
  }
  return refs.sort((a, b) => b.weight - a.weight)
}

/**
 * Where a repository is on this machine, if anywhere.
 *
 * Checked in order: the registered locations table, the LAK_REPO_ROOTS search
 * path, then the current working directory if its name matches. Failing all
 * three, the caller still gets a browse URL, and "it is over there" remains a
 * useful answer.
 */
export async function locateRepo(db: Db, repoKeyOrName: string | null): Promise<RepoLocation | null> {
  if (!repoKeyOrName) return null
  const key = repoKeyOrName.trim()

  const registered = await db.query<{ repo_key: string; local_path: string; browse_url: string | null; branch: string }>(
    `select repo_key, local_path, browse_url, branch from repo_location
      where repo_key = $1
         or repo_key = split_part($1, ':', 2)
         or $1 like '%' || repo_key
      limit 1`,
    [key],
  )
  if (registered.rows[0]) {
    const row = registered.rows[0]
    return {
      repoKey: row.repo_key,
      displayName: key,
      localPath: (await exists(row.local_path)) ? row.local_path : undefined,
      browseUrl: row.browse_url ?? undefined,
      branch: row.branch ?? 'main',
    }
  }

  // Any identifier recorded against the repo entity can supply a browse URL.
  const ids = await db.query<{ authority: string; value: string }>(
    `select ei.authority, ei.value
       from entity_identifier ei join entity e on e.id = ei.entity_id
      where e.display_name = $1`,
    [key],
  )
  const remote = ids.rows.find((i) => i.authority === 'git_remote')?.value
  const url = ids.rows.find((i) => i.authority === 'url')?.value
  const browseUrl = url ?? (remote ? `https://${remote.replace(/^https?:\/\//, '')}` : undefined)

  const bare = key.replace(/^[a-z_]+:/i, '')
  const roots = (process.env.LAK_REPO_ROOTS ?? '').split(':').filter(Boolean)
  for (const root of roots) {
    const candidate = join(root, bare)
    if (await exists(candidate)) {
      return { repoKey: key, displayName: key, localPath: candidate, browseUrl, branch: 'main' }
    }
  }

  const cwd = process.cwd()
  if (cwd.split('/').pop() === bare) {
    return { repoKey: key, displayName: key, localPath: cwd, browseUrl, branch: 'main' }
  }

  return browseUrl ? { repoKey: key, displayName: key, browseUrl, branch: 'main' } : null
}

export async function registerRepo(
  db: Db,
  input: { repoKey: string; localPath: string; browseUrl?: string; branch?: string },
): Promise<void> {
  await db.query(
    `insert into repo_location (repo_key, local_path, browse_url, branch)
     values ($1,$2,$3,$4)
     on conflict (repo_key) do update
       set local_path = excluded.local_path,
           browse_url = coalesce(excluded.browse_url, repo_location.browse_url),
           branch = excluded.branch`,
    [input.repoKey, resolve(input.localPath), input.browseUrl ?? null, input.branch ?? 'main'],
  )
}

export interface Freshness {
  checked: boolean
  commitsBehind?: number
  changedFiles?: string[]
  reason?: string
}

/**
 * How far behind a context file is.
 *
 * `git log <generated_from>..HEAD -- <described files>` answers this exactly, in
 * milliseconds, with no hashing and no re-verification queue - because the file
 * lives in the same repository as the thing it describes. This is the payoff of
 * keeping fast-changing detail beside the code.
 */
export async function freshness(
  repoPath: string,
  generatedFrom: string | undefined,
  describedPaths: string[],
  contextPath?: string,
): Promise<Freshness> {
  if (!generatedFrom) {
    return { checked: false, reason: 'no `generated_from` commit recorded in the file' }
  }
  if (!(await isGitRepo(repoPath))) {
    return { checked: false, reason: 'not a git checkout, cannot compare commits' }
  }
  try {
    const paths = describedPaths.length ? describedPaths : ['.']
    const { stdout } = await run(
      'git', ['log', '--format=%H', `${generatedFrom}..HEAD`, '--', ...paths],
      { cwd: repoPath, timeout: 10_000 },
    )
    let commits = stdout.split('\n').filter(Boolean)

    // A commit that updated the context file alongside the code did not leave the
    // context behind - it is the normal way of working, and counting it would make
    // every properly-maintained file report itself stale the moment it was committed.
    if (contextPath && commits.length) {
      const { stdout: ctx } = await run(
        'git', ['log', '--format=%H', `${generatedFrom}..HEAD`, '--', contextPath],
        { cwd: repoPath, timeout: 10_000 },
      )
      const updatedAlongside = new Set(ctx.split('\n').filter(Boolean))
      commits = commits.filter((c) => !updatedAlongside.has(c))
    }
    if (!commits.length) return { checked: true, commitsBehind: 0 }

    const { stdout: files } = await run(
      'git', ['diff', '--name-only', `${generatedFrom}..HEAD`, '--', ...paths],
      { cwd: repoPath, timeout: 10_000 },
    )
    return {
      checked: true,
      commitsBehind: commits.length,
      changedFiles: files.split('\n').filter(Boolean).slice(0, 20),
    }
  } catch (err) {
    const msg = (err as Error).message
    return {
      checked: false,
      reason: /unknown revision|bad object/i.test(msg)
        ? `commit ${generatedFrom} is not in this checkout (shallow clone, or the file came from elsewhere)`
        : msg.split('\n')[0],
    }
  }
}

async function isGitRepo(p: string): Promise<boolean> {
  try {
    const s = await stat(join(p, '.git'))
    return s.isDirectory() || s.isFile()
  } catch {
    return false
  }
}

export function browseLink(loc: RepoLocation | null, path: string): string | null {
  if (!loc?.browseUrl) return null
  const base = loc.browseUrl.replace(/\/+$/, '')
  const clean = path.replace(/^\.?\//, '')
  // GitLab uses /-/blob/, GitHub uses /blob/. Guess from the host, say so if unsure.
  const segment = /gitlab/i.test(base) ? '/-/blob/' : '/blob/'
  return `${base}${segment}${loc.branch}/${clean}`
}

export function absolutePath(loc: RepoLocation, path: string): string {
  return isAbsolute(path) ? path : join(loc.localPath ?? '', path.replace(/^\.?\//, ''))
}
