import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { loadContext } from '../context/load.ts'
import { registerRepo } from '../context/locate.ts'
import { draftMaterial } from '../context/write.ts'

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

if (args[0] === 'draft') {
  const target = args.slice(1).filter((a) => !a.startsWith('--')).join(' ')
  const m = await draftMaterial(db, target, { includePending: args.includes('--pending') })
  console.log(m.message)
  if (m.ok) {
    console.log(`source: ${m.sourcePath}\ncontext file: ${m.contextPath}\nHEAD: ${m.headCommit}`)
    if (m.dirty) console.log('NOTE: described files have uncommitted changes.')
    if (m.graphFacts?.length) console.log(`\nalready in the graph:\n  ${m.graphFacts.join('\n  ')}`)
    if (m.commitSubjects?.length) console.log(`\ncommits since written:\n  ${m.commitSubjects.join('\n  ')}`)
    if (m.existing) console.log(`\nexisting context (${m.existing.length} chars) — refresh, do not replace`)
  }
  await db.close()
  process.exit(m.ok ? 0 : 1)
}

const name = args.filter((a) => !a.startsWith('--')).join(' ')
if (!name) {
  console.error('usage: npm run context -- "TextField"')
  console.error('       npm run context -- draft "TextField" [--pending]')
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
