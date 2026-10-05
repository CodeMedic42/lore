/**
 * Return the test repositories to a clean state between phases.
 *
 *   npx tsx tests/manual/lib/reset.ts [--branch=<name>]
 *
 * This is the subset of `test:setup` you want mid-test: it touches git and nothing
 * else - no docker, no migrations, no clearing the graph. For a full preparation
 * use `npm run test:setup -- --testId <id>`.
 */
import { resolveDatabase, describeDatabase } from '../../../src/db/index.ts'
import { exists, loadFixtures, repoPath, resetTo, run } from './fixtures.ts'
import { join } from 'node:path'

const args = process.argv.slice(2)
const branch = args.find((a) => a.startsWith('--branch='))?.slice(9)

const cfg = await loadFixtures()
let missing = 0

console.log('')
for (const repo of cfg.repos) {
  const path = repoPath(cfg, repo)

  if (!(await exists(join(path, '.git')))) {
    console.log(`  ${repo.name}: not found at ${path}`)
    console.log(`      npm run test:setup -- --testId <id>   # clones it`)
    missing++
    continue
  }

  let head: string
  if (branch) {
    try {
      head = await resetTo(cfg, repo, branch)
    } catch (err: any) {
      console.log(`  ${repo.name}: ${err.message}`)
      missing++
      continue
    }
  } else {
    await run('git', ['reset', '-q', '--hard'], { cwd: path })
    await run('git', ['clean', '-qfdx'], { cwd: path })
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: path })
    head = stdout.trim()
  }

  const { stdout: ref } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path })

  // The guard lives at the fixture root, not in the repository, so ask the resolver
  // rather than looking for a committed file.
  const choice = resolveDatabase(path)
  const graph =
    choice.url === cfg.databaseUrl
      ? 'throwaway graph'
      : `${describeDatabase(choice)} — NOT THE THROWAWAY GRAPH`

  console.log(`  ${repo.name}: clean on ${ref.trim()} @ ${head}  (${graph})`)
}

console.log('')
if (missing) {
  console.log(`${missing} repository/repositories unavailable.`)
  process.exit(1)
}
console.log('Repositories reset. To empty the graph as well:  npm run clear')
