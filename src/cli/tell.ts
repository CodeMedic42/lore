import { open } from '../db/index.ts'
import { tell } from '../store/tell.ts'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const text = args.filter((a) => !a.startsWith('--')).join(' ')
if (!text) {
  console.error('usage: npm run tell -- "the new client is written in TypeScript and replaces the React one"')
  process.exit(1)
}

const db = await open()
const r = await tell(db, { text, dryRun, agent: 'user/cli' })

if (!r.claims.length) {
  console.log('Nothing recognisable in that. Nothing recorded.')
} else {
  console.log(dryRun ? 'Would record:' : 'Recorded:')
  for (const c of r.claims) {
    const neg = c.polarity ? '' : '  [REFUTES]'
    console.log(`  ${c.subject} ──${c.predicate}──▶ ${c.object}${neg}`)
  }
}
for (const u of r.unparsed) console.log(`  (not understood, ignored) "${u}"`)
await db.close()
