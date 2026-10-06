/**
 * Shared plumbing for the manual-test fixtures.
 *
 * The fixture repositories in ../repos.json ARE the source of truth. They are real
 * git repositories, so git is the reset mechanism and branches are how scenarios
 * vary. Nothing is copied from a template.
 *
 * The one rule this file enforces mechanically: a fixture must contain nothing that
 * reveals it is a fixture. See `leakSweep` and context.md.
 */
import { readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const run = promisify(execFile)

export interface RepoSpec {
  name: string
  dir: string
  url: string
  stands_for?: string
}

export interface FixtureConfig {
  root: string
  databaseUrl: string
  repos: RepoSpec[]
}

export interface TestSpec {
  title: string
  spec: string
  branch: string
  repos: string[]
  graph: 'empty' | 'keep'
  snapshot?: string
  starts_in?: string
}

export const expand = (p: string) =>
  resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

export const exists = async (p: string) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function loadFixtures(): Promise<FixtureConfig> {
  const cfg = JSON.parse(
    await readFile(new URL('../repos.json', import.meta.url), 'utf8'),
  ) as FixtureConfig
  return { ...cfg, root: expand(cfg.root) }
}

export async function loadTests(): Promise<Record<string, TestSpec>> {
  const cfg = JSON.parse(
    await readFile(new URL('../tests.json', import.meta.url), 'utf8'),
  ) as { tests: Record<string, TestSpec> }
  return cfg.tests
}

export const repoPath = (cfg: FixtureConfig, repo: RepoSpec) => join(cfg.root, repo.dir)

/**
 * The guard that keeps a test off a real graph. It lives at the fixture root rather
 * than inside either repository: a committed .lore.json is a thing an agent reads
 * and reasons about, and "why does this repo pin a database?" is one inference away
 * from "I am inside a test".
 */
export async function writeGuard(cfg: FixtureConfig): Promise<'created' | 'updated' | 'ok'> {
  await mkdir(cfg.root, { recursive: true })
  const path = join(cfg.root, '.lore.json')
  const want = {
    databaseUrl: cfg.databaseUrl,
    note: 'Selects the graph for sessions under this directory.',
  }
  if (await exists(path)) {
    try {
      const have = JSON.parse(await readFile(path, 'utf8'))
      if (have.databaseUrl === want.databaseUrl) return 'ok'
    } catch {
      // malformed: rewrite it
    }
    await writeFile(path, JSON.stringify(want, null, 2) + '\n')
    return 'updated'
  }
  await writeFile(path, JSON.stringify(want, null, 2) + '\n')
  return 'created'
}

/**
 * Replace a fixture with a fresh clone at `branch`.
 *
 * Deliberately a clone rather than `reset --hard` + `clean -fdx`, which is the
 * cheaper thing and leaves a trail. Resetting in place leaves local state that
 * describes the harness rather than the project:
 *
 *   - `.git/logs/*` recording "reset: moving to origin/baseline" a minute before
 *     the session, in both repositories a second apart;
 *   - `.git/COMMIT_EDITMSG`, whose mtime contradicts the commit date it holds;
 *   - working-tree mtimes from whenever the fixture was last edited.
 *
 * Expiring the reflog to hide the first is worse than leaving it: zero-byte log
 * files under `logallrefupdates = true` are evidence of deliberate erasure, where a
 * reset is only evidence of a reset. A fresh clone has none of it - one `clone:`
 * reflog entry, no COMMIT_EDITMSG, and uniform mtimes that differ from the commit
 * dates exactly the way every clone on earth does.
 *
 * It also guarantees what `-x` used to: no stray node_modules in the client, which
 * would let a session answer questions about the library by reading it.
 */
export async function freshCheckout(cfg: FixtureConfig, repo: RepoSpec, branch: string) {
  const path = repoPath(cfg, repo)
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  await rm(path, { recursive: true, force: true })
  await mkdir(cfg.root, { recursive: true })
  try {
    await run('git', ['clone', '-q', '--branch', branch, repo.url, path], { env })
  } catch (err: any) {
    const detail = String(err?.stderr || err?.message || '')
    if (/Remote branch .* not found/i.test(detail)) {
      throw new Error(`${repo.name}: origin has no branch "${branch}"`)
    }
    throw new Error(`${repo.name}: clone failed - ${detail.trim().split('\n')[0]}`)
  }
  const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: path })
  return stdout.trim()
}

/**
 * Everything a fixture must never say. Checked against every blob reachable from
 * any commit and against every commit message - not just the checked-out tree,
 * because rewriting a message leaves the old content one `git log -p` away.
 *
 * `lore[-_]` catches the old repository names (lore-testing-*) and the database.
 * `acme` is bare rather than `@acme` because the stale metadata that survived a
 * rename was `https://github.com/acme/ui-kit.git` - no `@`, and so invisible to a
 * pattern anchored on the npm scope.
 *
 * Do not add a bare `lore`: it matches nothing here now that the guard lives
 * outside the repositories, but it would match any future connection string, and a
 * check that cannot pass is a check you learn to ignore.
 */
export const LEAK_PATTERN = [
  'fixture',
  'manual test',
  'pass criteri',
  'knowledge graph',
  'throwaway',
  'contaminat',
  'absence is the test',
  'extraction',
  'lore[-_]',
  'living-ai',
  'acme',
].join('|')

export interface LeakHit {
  where: string
  line: string
}

export async function leakSweep(dir: string): Promise<LeakHit[]> {
  const hits: LeakHit[] = []
  const { stdout: revs } = await run('git', ['rev-list', '--all'], { cwd: dir })
  const commits = revs.split('\n').filter(Boolean)

  if (commits.length) {
    // git grep over every commit searches content as it was then, which is where a
    // scrub of the working tree leaves everything behind.
    try {
      const { stdout } = await run(
        'git',
        ['grep', '-I', '-i', '-n', '-E', LEAK_PATTERN, ...commits],
        { cwd: dir, maxBuffer: 32 * 1024 * 1024 },
      )
      for (const line of stdout.split('\n').filter(Boolean)) {
        hits.push({ where: 'content', line: line.slice(0, 200) })
      }
    } catch (err: any) {
      // exit 1 means no matches, which is the passing case
      if (err?.code !== 1) throw err
    }
  }

  const { stdout: msgs } = await run('git', ['log', '--all', '--format=%B'], { cwd: dir })
  for (const line of msgs.split('\n')) {
    if (new RegExp(LEAK_PATTERN, 'i').test(line)) {
      hits.push({ where: 'message', line: line.trim().slice(0, 200) })
    }
  }
  return hits
}
