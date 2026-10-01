/**
 * Return the test repositories to a clean state between runs.
 *
 *   npx tsx tests/manual/lib/reset.ts [--branch=<name>] [--clone]
 *
 * The repositories listed in ../repos.json ARE the source of truth — they are real
 * git repositories, so git is the reset mechanism and branches are how scenarios
 * vary. Nothing is copied from a template.
 */
import { readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const run = promisify(execFile)
const args = process.argv.slice(2)
const branch = args.find((a) => a.startsWith('--branch='))?.slice(9)
const allowClone = args.includes('--clone')

interface RepoSpec { name: string; path: string; url: string; stands_for?: string }
const config = JSON.parse(
  await readFile(new URL('../repos.json', import.meta.url), 'utf8'),
) as { repos: RepoSpec[] }

const expand = (p: string) => resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
const exists = async (p: string) => {
  try { await stat(p); return true } catch { return false }
}

let missing = 0
for (const repo of config.repos) {
  const path = expand(repo.path)

  if (!(await exists(join(path, '.git')))) {
    if (!allowClone) {
      console.log(`  ${repo.name}: not found at ${path}`)
      console.log(`      clone it, or re-run with --clone`)
      missing++
      continue
    }
    console.log(`  ${repo.name}: cloning from ${repo.url}`)
    await run('git', ['clone', '-q', repo.url, path], { cwd: dirname(path) })
  }

  if (branch) {
    try {
      await run('git', ['checkout', '-q', branch], { cwd: path })
    } catch {
      console.log(`  ${repo.name}: no branch "${branch}", staying put`)
    }
  }
  await run('git', ['reset', '-q', '--hard'], { cwd: path })
  await run('git', ['clean', '-qfd'], { cwd: path })

  const { stdout: head } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path })
  const { stdout: lore } = await run('git', ['ls-files', '.lore.json'], { cwd: path })
  const graph = lore.trim() ? 'throwaway graph' : 'NO .lore.json — would use the real graph'
  console.log(`  ${repo.name}: clean on ${head.trim()}  (${graph})`)
}

if (missing) {
  console.log('')
  console.log(`${missing} repository/repositories missing. Re-run with --clone to fetch them.`)
  process.exit(1)
}
console.log('')
console.log('Repositories reset. To empty the graph as well:  npm run clear')
