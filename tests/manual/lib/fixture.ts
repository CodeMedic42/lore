/**
 * Materialise a manual-test fixture into the testing workspace.
 *
 *   npx tsx tests/manual/lib/fixture.ts [name] [--force] [--workspace=<path>]
 *
 * Two things this handles that matter more than they look.
 *
 * The workspace carries a `.lak.json` pointing at a THROWAWAY database, so every
 * session inside it reads and writes a graph that can be cleared without touching
 * a real one. Testing against the personal graph would pollute it permanently.
 *
 * And a fixture cannot be used from inside this repository: a Claude session
 * started there resolves its project to this repository and would carry the
 * knowledge tool's own source as context - which quietly defeats any test that
 * depends on the session knowing nothing.
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const run = promisify(execFile)
const args = process.argv.slice(2)
const force = args.includes('--force')
const workspace = resolve(
  args.find((a) => a.startsWith('--workspace='))?.slice(12) ??
    join(homedir(), 'source/local/ai/ai-knowledge-testing'),
)
const templates = new URL('../fixtures/', import.meta.url).pathname
const available = (await readdir(templates, { withFileTypes: true }))
  .filter((e) => e.isDirectory()).map((e) => e.name)

const name = args.find((a) => !a.startsWith('--')) ?? 'client-test'
if (!available.includes(name)) {
  console.error(`No fixture called "${name}". Available: ${available.join(', ')}`)
  process.exit(1)
}

const exists = async (p: string) => {
  try { await stat(p); return true } catch { return false }
}

// ── the workspace, and the database every session in it will use ───────────
await mkdir(workspace, { recursive: true })
const lakConfig = join(workspace, '.lak.json')
if (!(await exists(lakConfig))) {
  await writeFile(lakConfig, `${JSON.stringify({
    databaseUrl: 'postgres://lak:lak@localhost:55432/lak_test',
    note: 'Throwaway graph for manual tests. Anything inside this workspace reads and writes here, never the personal database.',
  }, null, 2)}\n`)
  console.log(`wrote ${lakConfig} — sessions in this workspace use the lak_test database`)
}
if (!(await exists(join(workspace, 'README.md')))) {
  await writeFile(join(workspace, 'README.md'), `# AI knowledge testing workspace

Repositories here exist to be scanned, queried and thrown away.

\`.lak.json\` points every session inside this tree at the \`lak_test\` database, so
manual tests never touch a real graph. Clear it with:

    LAK_PROFILE=test npm run clear

Each directory is a standalone git repository, materialised from a template in
\`tests/manual/fixtures/\` by \`tests/manual/lib/fixture.ts\`. They are meant to refer
to each other, so richer scenarios can be built by adding more of them.

| Repository | Stands for |
|---|---|
| \`client-test\` | A UI client consuming a component library it does not own |
`)
}

// ── the fixture itself ──────────────────────────────────────────────────────
const dest = join(workspace, name)
if (await exists(dest)) {
  if (!force) {
    console.error(`${dest} already exists. Re-run with --force to replace it.`)
    process.exit(1)
  }
  await rm(dest, { recursive: true, force: true })
}

await mkdir(dest, { recursive: true })
await cp(join(templates, name), dest, { recursive: true })

await mkdir(join(dest, '.claude'), { recursive: true })
await writeFile(
  join(dest, '.claude', 'settings.local.json'),
  `${JSON.stringify({ permissions: { allow: ['mcp__knowledge'] } }, null, 2)}\n`,
)

// Its own git identity, so a session here inherits no enclosing repository.
await run('git', ['init', '-q'], { cwd: dest })
await run('git', ['add', '-A'], { cwd: dest })
await run('git', ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture',
  'commit', '-q', '-m', `${name} fixture`], { cwd: dest })

console.log(`fixture "${name}" ready at ${dest}`)
console.log('')
console.log(`  cd ${dest} && claude`)
