import { describeDatabase, open, resolveDatabase } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'

/**
 * Empty a graph.
 *
 * Defaults to the THROWAWAY database, not to whatever the working directory
 * happens to resolve to. Clearing is irreversible and the common reason to run it
 * is resetting a test, so the dangerous target is the one that needs arguing for -
 * not the safe one.
 */
const args = process.argv.slice(2)
const real = args.includes('--real')
const confirmed = args.includes('--yes')

if (real) {
  const choice = resolveDatabase()
  if (!confirmed) {
    console.error('')
    console.error(`  Refusing to empty ${describeDatabase(choice)} without --yes.`)
    console.error('')
    console.error('  This deletes every entity, claim, embedding and context pointer in that')
    console.error('  graph. There is no undo, and re-scanning will not restore anything that')
    console.error('  was recorded by hand or answered through a question.')
    console.error('')
    console.error('    npm run clear -- --real --yes')
    console.error('')
    process.exit(1)
  }
  process.env.DATABASE_URL ??= choice.url
} else {
  // Explicit, so it cannot be overridden by a stray .lak.json or a cwd default.
  process.env.LAK_PROFILE = 'test'
  delete process.env.DATABASE_URL
}

const choice = resolveDatabase()
console.log(`clearing: ${describeDatabase(choice)}`)
if (!real) console.log('(the throwaway graph — pass --real --yes to empty a real one)')

const db = await open()
await migrate(db, { quiet: true })
await db.exec(`
  truncate mention, assertion, proposition, entity_identifier, entity_alias,
           entity_merge, entity_distinct, merge_candidate, entity,
           entity_embedding, ingest_batch, activity, evidence_anchor, repo_location
  restart identity cascade;
`)
const n = await db.query<{ n: string }>('select count(*)::text n from entity')
console.log(`cleared — ${n.rows[0]!.n} entities remain. The graph knows nothing.`)
await db.close()
