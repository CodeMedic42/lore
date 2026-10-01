import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { indexEmbeddings, localEmbedder } from '../embed/index.ts'
import { findSimilar } from '../embed/search.ts'

const args = process.argv.slice(2)
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)

const db = await open()
await migrate(db, { quiet: true })
const embedder = localEmbedder()

const query = args.filter((a) => !a.startsWith('--') && a !== 'index').join(' ')

if (!query || args[0] === 'index') {
  process.stderr.write('indexing (first run downloads the model, ~25MB)…\n')
  const r = await indexEmbeddings(db, embedder, {
    kinds: arg('kinds')?.split(','),
    force: args.includes('--force'),
  })
  console.log(`${r.embedded} embedded, ${r.unchanged} unchanged, ${r.considered} total  [${r.model}]`)
} else {
  const hits = await findSimilar(db, embedder, query, {
    kinds: arg('kinds')?.split(','),
    limit: Number(arg('limit') ?? 8),
    minScore: Number(arg('min') ?? 0.25),
  })
  if (!hits.length) {
    console.log('Nothing similar found. Has anything been indexed? Run: npm run embed -- index')
  } else {
    console.log(`Closest matches for "${query}":\n`)
    for (const h of hits) {
      console.log(`  ${h.score.toFixed(3)}  ${h.name}  (${h.kind})`)
      console.log(`         ${h.profile.slice(0, 120)}`)
    }
  }
}
await db.close()
