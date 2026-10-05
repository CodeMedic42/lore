/**
 * Prepare everything a manual test needs, so the only manual part is the part that
 * has to be.
 *
 *   npm run test:setup -- --testId 01
 *
 * Idempotent: run it as often as you like. It clones what is missing, resets what
 * is dirty, starts what is stopped, and refuses to continue if the fixtures would
 * write to a real graph or if anything in them reveals that they are fixtures.
 */
import { resolveDatabase, describeDatabase } from '../../../src/db/index.ts'
import {
  type FixtureConfig,
  type RepoSpec,
  ensureClone,
  exists,
  leakSweep,
  loadFixtures,
  loadTests,
  repoPath,
  resetTo,
  run,
  writeGuard,
} from './fixtures.ts'

const args = process.argv.slice(2)
const idArg = args.find((a) => a.startsWith('--testId'))
const testId = idArg?.includes('=')
  ? idArg.split('=')[1]
  : args[args.indexOf('--testId') + 1]

const CONTAINER = 'lore-pg'
const IMAGE = 'pgvector/pgvector:pg17'
const PORT = '55432'

const tests = await loadTests()
if (!testId || !tests[testId]) {
  console.error('')
  console.error(testId ? `  No manual test "${testId}".` : '  Which test? Pass --testId.')
  console.error('')
  for (const [id, t] of Object.entries(tests)) {
    console.error(`    --testId ${id}    ${t.title}  (${t.spec})`)
  }
  console.error('')
  process.exit(1)
}

const test = tests[testId]
const cfg = await loadFixtures()
const wanted = test.repos.map((name) => {
  const repo = cfg.repos.find((r) => r.name === name)
  if (!repo) throw new Error(`repos.json has no repository called "${name}"`)
  return repo
})

const fail: string[] = []
const step = (s: string) => console.log(`\n${s}`)
const ok = (s: string) => console.log(`  ok    ${s}`)
const warn = (s: string) => console.log(`  warn  ${s}`)
const bad = (s: string) => {
  console.log(`  FAIL  ${s}`)
  fail.push(s)
}

console.log('')
console.log(`manual test ${testId} — ${test.title}`)
console.log(`  spec: tests/manual/${test.spec}`)

// ── Postgres ───────────────────────────────────────────────────────────────────
step('database server')
let state = ''
try {
  const { stdout } = await run('docker', ['inspect', CONTAINER, '--format', '{{.State.Status}}'])
  state = stdout.trim()
} catch {
  state = 'absent'
}

if (state === 'absent') {
  console.log(`  creating container ${CONTAINER} (${IMAGE})`)
  await run('docker', [
    'run', '-d', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=lore', '-e', 'POSTGRES_USER=lore', '-e', 'POSTGRES_DB=lore',
    '-p', `${PORT}:5432`, IMAGE,
  ])
  ok(`created and started ${CONTAINER}`)
} else if (state !== 'running') {
  await run('docker', ['start', CONTAINER])
  ok(`started ${CONTAINER} (was ${state})`)
} else {
  ok(`${CONTAINER} already running`)
}

// Readiness, not liveness: a container can be up before Postgres accepts queries.
let ready = false
for (let i = 0; i < 40; i++) {
  try {
    await run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'lore', '-q'])
    ready = true
    break
  } catch {
    await new Promise((r) => setTimeout(r, 500))
  }
}
ready ? ok('accepting connections') : bad('Postgres never became ready')

// ── the throwaway database ─────────────────────────────────────────────────────
if (ready) {
  step('throwaway graph')
  const dbName = new URL(cfg.databaseUrl).pathname.slice(1)
  const { stdout: found } = await run('docker', [
    'exec', CONTAINER, 'psql', '-U', 'lore', '-d', 'postgres', '-tAc',
    `select 1 from pg_database where datname='${dbName}'`,
  ])
  if (!found.trim()) {
    await run('docker', ['exec', CONTAINER, 'createdb', '-U', 'lore', dbName])
    ok(`created database ${dbName}`)
  } else {
    ok(`database ${dbName} present`)
  }

  const env = { ...process.env, LORE_PROFILE: 'test', DATABASE_URL: '' }
  delete (env as any).DATABASE_URL
  const { stdout: mig } = await run('npx', ['tsx', 'src/cli/migrate.ts'], { env })
  ok(mig.trim().split('\n').pop() ?? 'migrations applied')
}

// ── MCP registration ──────────────────────────────────────────────────────────
step('MCP server')
const serverPath = new URL('../../../src/mcp/stdio.ts', import.meta.url).pathname
try {
  const { stdout } = await run('claude', ['mcp', 'get', 'knowledge'])
  const registered = stdout.match(/Args:\s*(\S+)/)?.[1]
  if (registered === serverPath) {
    ok('knowledge registered, pointing at this checkout')
  } else {
    console.log(`  re-pointing knowledge: ${registered} -> ${serverPath}`)
    await run('claude', ['mcp', 'remove', 'knowledge', '-s', 'user'])
    await run('claude', ['mcp', 'add', 'knowledge', '-s', 'user', '--', 'node', serverPath])
    ok('knowledge re-registered at this checkout')
  }
} catch {
  await run('claude', ['mcp', 'add', 'knowledge', '-s', 'user', '--', 'node', serverPath])
  ok('knowledge registered (user scope)')
}

// ── the guard ─────────────────────────────────────────────────────────────────
step('fixture root')
const guard = await writeGuard(cfg)
ok(`${cfg.root}/.lore.json ${guard === 'ok' ? 'already correct' : guard}`)

// ── the fixtures ──────────────────────────────────────────────────────────────
step(`fixtures on "${test.branch}"`)
for (const repo of wanted) {
  const path = repoPath(cfg, repo)
  try {
    const cloned = await ensureClone(cfg, repo)
    const head = await resetTo(cfg, repo, test.branch)

    // The safety gate. If this resolves anywhere but the throwaway graph, a run
    // would write into a real one, so nothing else matters.
    const choice = resolveDatabase(path)
    if (choice.url !== cfg.databaseUrl) {
      bad(`${repo.name}: resolves to ${describeDatabase(choice)} — NOT the throwaway graph`)
      continue
    }

    const hits = await leakSweep(path)
    if (hits.length) {
      bad(`${repo.name}: ${hits.length} leak(s) in git history`)
      for (const h of hits.slice(0, 4)) console.log(`          ${h.where}: ${h.line}`)
      continue
    }
    ok(`${repo.name}: ${cloned ? 'cloned, ' : ''}clean at ${head}, throwaway graph, 0 leaks`)
  } catch (err: any) {
    bad(`${repo.name}: ${err.message}`)
  }
}

// ── graph state ───────────────────────────────────────────────────────────────
if (!fail.length && test.graph === 'empty') {
  step('graph')
  const { stdout } = await run('npm', ['run', 'clear'])
  ok(stdout.trim().split('\n').filter(Boolean).pop() ?? 'cleared')
  if (test.snapshot) {
    await run('npm', ['run', 'test:snapshot', '--', test.snapshot])
    ok(`snapshot "${test.snapshot}" taken`)
  }
}

// ── verdict ───────────────────────────────────────────────────────────────────
console.log('')
if (fail.length) {
  console.log(`${fail.length} problem(s) — do not start the test:`)
  for (const f of fail) console.log(`  - ${f}`)
  console.log('')
  process.exit(1)
}

const start = wanted.find((r) => r.name === test.starts_in) ?? wanted[0]
console.log(`Ready. Start phase A in a fresh session:`)
console.log('')
console.log(`    cd ${repoPath(cfg, start)}`)
console.log('')
console.log(`Then follow tests/manual/${test.spec} — it carries the prompts and the`)
console.log('pass criteria, and the contamination grep to run after each phase.')
console.log('')
