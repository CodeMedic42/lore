import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { loadContext } from '../context/load.ts'
import { registerRepo } from '../context/locate.ts'

const args = process.argv.slice(2)
const db = await open()
await migrate(db, { quiet: true })

if (args[0] === 'register') {
  const [, repoKey, localPath, browseUrl] = args
  if (!repoKey || !localPath) {
    console.error('usage: npm run context -- register <repo-key> <local-path> [browse-url]')
    process.exit(1)
  }
  await registerRepo(db, { repoKey, localPath, browseUrl })
  console.log(`Registered ${repoKey} -> ${localPath}`)
  await db.close()
  process.exit(0)
}

const name = args.filter((a) => !a.startsWith('--')).join(' ')
if (!name) {
  console.error('usage: npm run context -- "TextField"')
  console.error('       npm run context -- register <repo-key> <local-path> [browse-url]')
  process.exit(1)
}

const r = await loadContext(db, name)
console.log(`status: ${r.status}`)
console.log(r.message)
if (r.sourcePath) console.log(`source: ${r.sourcePath}`)
if (r.contextPath) console.log(`context: ${r.contextPath}`)
if (r.content) {
  console.log('─'.repeat(60))
  console.log(r.content)
}
await db.close()
