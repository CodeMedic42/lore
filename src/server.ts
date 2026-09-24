import { open } from './db/index.ts'
import { migrate } from './db/migrate.ts'
import { createApi } from './api/server.ts'

const port = Number(process.env.PORT ?? 4310)
const db = await open()
await migrate(db, { quiet: true })

createApi(db).listen(port, () => {
  console.log(`living-ai-knowledge listening on http://localhost:${port} (${db.driver})`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await db.close()
    process.exit(0)
  })
}
