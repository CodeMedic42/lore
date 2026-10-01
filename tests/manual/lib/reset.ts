/**
 * Return the test repositories to a clean state between runs.
 *
 *   npx tsx tests/manual/lib/reset.ts [--workspace=<path>] [--branch=<name>]
 *
 * The repositories under the workspace ARE the source of truth — they are real
 * git repositories, so git is the reset mechanism and branches are how scenarios
 * vary. Nothing is copied from anywhere.
 *
 * Also ensures the workspace carries a `.lak.json`, which is what points every
 * session inside it at the throwaway database rather than a real graph.
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const run = promisify(execFile)
const args = process.argv.slice(2)
const workspace = resolve(
  args.find((a) => a.startsWith('--workspace='))?.slice(12) ??
    join(homedir(), 'source/local/ai/ai-knowledge-testing'),
)
const branch = args.find((a) => a.startsWith('--branch='))?.slice(9)

const exists = async (p: string) => {
  try { await stat(p); return true } catch { return false }
}

await mkdir(workspace, { recursive: true })

const lakConfig = join(workspace, '.lak.json')
if (!(await exists(lakConfig))) {
  await writeFile(lakConfig, `${JSON.stringify({
    databaseUrl: 'postgres://lak:lak@localhost:55432/lak_test',
    note: 'Throwaway graph. Every session inside this workspace reads and writes here, never a real graph.',
  }, null, 2)}\n`)
  console.log(`created ${lakConfig}`)
}

const entries = await readdir(workspace, { withFileTypes: true })
const repos = []
for (const e of entries) {
  if (!e.isDirectory() || e.name.startsWith('.')) continue
  if (await exists(join(workspace, e.name, '.git'))) repos.push(e.name)
}

if (!repos.length) {
  console.log(`No git repositories under ${workspace}.`)
  process.exit(0)
}

for (const name of repos) {
  const cwd = join(workspace, name)
  if (branch) {
    try {
      await run('git', ['checkout', '-q', branch], { cwd })
    } catch {
      console.log(`  ${name}: no branch "${branch}", staying on current`)
    }
  }
  await run('git', ['reset', '-q', '--hard'], { cwd })
  await run('git', ['clean', '-qfd'], { cwd })
  const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  console.log(`  ${name}: clean on ${stdout.trim()}`)
}

console.log('')
console.log('Repositories reset. To empty the graph as well:')
console.log('  LAK_PROFILE=test npm run clear')
