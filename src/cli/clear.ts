import { describeDatabase, open, resolveDatabase } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'

// Say which graph is about to be emptied. Clearing the wrong one is not recoverable.
const choice = resolveDatabase()
console.log(`clearing: ${describeDatabase(choice)}`)

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
