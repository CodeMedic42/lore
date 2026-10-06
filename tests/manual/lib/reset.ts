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
import { freshCheckout, loadFixtures, repoPath } from './fixtures.ts'

const args = process.argv.slice(2)
const branch = args.find((a) => a.startsWith('--branch='))?.slice(9)

const cfg = await loadFixtures()
let missing = 0

console.log('')
for (const repo of cfg.repos) {
  const path = repoPath(cfg, repo)

  let head: string
  try {
    head = await freshCheckout(cfg, repo, branch ?? 'main')
  } catch (err: any) {
    console.log(`  ${repo.name}: ${err.message}`)
    missing++
    continue
  }

  // The guard lives at the fixture root, not in the repository, so ask the resolver
  // rather than looking for a committed file.
  const choice = resolveDatabase(path)
  const graph =
    choice.url === cfg.databaseUrl
      ? 'throwaway graph'
      : `${describeDatabase(choice)} — NOT THE THROWAWAY GRAPH`

  console.log(`  ${repo.name}: clean on ${branch ?? 'main'} @ ${head}  (${graph})`)
}

console.log('')
if (missing) {
  console.log(`${missing} repository/repositories unavailable.`)
  process.exit(1)
}
console.log('Repositories reset. To empty the graph as well:  npm run clear')
