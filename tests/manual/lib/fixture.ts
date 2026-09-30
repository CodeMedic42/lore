/**
 * Materialise the consuming-repo fixture used by manual test 01, phase B.
 *
 *   npx tsx tests/manual/lib/fixture.ts [destination] [--force]
 *
 * The template is committed under tests/manual/fixtures/, but the fixture cannot
 * be USED from there: a Claude session started inside this repository resolves its
 * project to this repository, and would see all of the knowledge tool's own source
 * as context. Phase B depends on the session knowing nothing except that it
 * consumes Reform — so the fixture is copied out and given its own git identity.
 */
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const run = promisify(execFile)
const args = process.argv.slice(2)
const force = args.includes('--force')
const dest = resolve(args.find((a) => !a.startsWith('--')) ?? join(homedir(), 'source/local/ai/contact-form-demo'))
const template = new URL('../fixtures/contact-form-demo/', import.meta.url).pathname

const exists = async (p: string) => {
  try { await stat(p); return true } catch { return false }
}

if (await exists(dest)) {
  if (!force) {
    console.error(`${dest} already exists. Re-run with --force to replace it.`)
    process.exit(1)
  }
  await rm(dest, { recursive: true, force: true })
}

await mkdir(dest, { recursive: true })
await cp(template, dest, { recursive: true })

// Permissions for the fixture's own project scope. Gitignored in most setups,
// which is why it is written here rather than committed with the template.
await mkdir(join(dest, '.claude'), { recursive: true })
await writeFile(
  join(dest, '.claude', 'settings.local.json'),
  `${JSON.stringify({ permissions: { allow: ['mcp__knowledge'] } }, null, 2)}\n`,
)

// Its own git identity, so a session here does not inherit an enclosing repo.
await run('git', ['init', '-q'], { cwd: dest })
await run('git', ['add', '-A'], { cwd: dest })
await run('git', ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture',
  'commit', '-q', '-m', 'Contact form built on the Reform component library'], { cwd: dest })

console.log(`fixture ready at ${dest}`)
console.log('')
console.log('  Reform source is deliberately absent — no node_modules, nothing greppable.')
console.log('  The only route to an answer is the knowledge graph.')
console.log('')
console.log(`  cd ${dest} && claude`)
