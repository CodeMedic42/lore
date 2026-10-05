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
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
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

export async function ensureClone(cfg: FixtureConfig, repo: RepoSpec): Promise<boolean> {
  const path = repoPath(cfg, repo)
  if (await exists(join(path, '.git'))) return false
  await mkdir(cfg.root, { recursive: true })
  await run('git', ['clone', '-q', repo.url, path], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return true
}

/**
 * Put a repository back to exactly what the branch says, discarding everything
 * else. `-x` matters: a stray node_modules in the client would let a session answer
 * questions about the library by reading it, which is the one thing that repository
 * must not be able to do.
 */
export async function resetTo(cfg: FixtureConfig, repo: RepoSpec, branch: string) {
  const cwd = repoPath(cfg, repo)
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  await run('git', ['fetch', '-q', 'origin', '--prune'], { cwd, env })
  try {
    await run('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], { cwd })
  } catch {
    throw new Error(`${repo.name}: origin has no branch "${branch}"`)
  }
  await run('git', ['checkout', '-q', '-B', branch, `origin/${branch}`], { cwd })
  await run('git', ['reset', '-q', '--hard', `origin/${branch}`], { cwd })
  await run('git', ['clean', '-qfdx'], { cwd })
  const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd })
  return stdout.trim()
}

/**
 * Everything a fixture must never say. Checked against every blob reachable from
 * any commit and against every commit message - not just the checked-out tree,
 * because rewriting a message leaves the old content one `git log -p` away.
 *
 * `lore[-_]` catches the old repository names (lore-testing-*) and the test
 * database. Do not add a bare `lore`: it matches nothing here now that the guard
 * lives outside the repositories, but it would match any future connection string
 * and a check that cannot pass is a check you learn to ignore.
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
  '@acme',
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
