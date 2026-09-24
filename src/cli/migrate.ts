import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'

const db = await open()
console.log(`migrating (${db.driver})...`)
const ran = await migrate(db)
console.log(ran.length ? `done: ${ran.length} migration(s)` : 'already up to date')
await db.close()
