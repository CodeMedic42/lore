import { open } from '../db/index.ts'
import { askableQuestions, knowledgeGaps } from '../query/gaps.ts'
import { maintain } from '../store/maintain.ts'

const args = process.argv.slice(2)
const all = args.includes('--all')
const near = args.find((a) => a.startsWith('--near='))?.slice('--near='.length)

const db = await open()
// Settle anything the graph can settle itself before deciding what to ask.
const tidied = await maintain(db)
if (tidied.endpoints_distinguished && all) {
  console.log(`(auto-resolved ${tidied.endpoints_distinguished} endpoint pair(s) as definitively distinct)\n`)
}

if (all) {
  const gaps = await knowledgeGaps(db)
  console.log(`${gaps.length} gap(s), highest value first\n`)
  for (const g of gaps) {
    console.log(`[${g.score.toFixed(2)}] ${g.gap_kind}  ·  ${g.entity_name} (${g.entity_kind})`)
    console.log(`        ${g.question}`)
    console.log(`        why: ${g.why}\n`)
  }
} else {
  const ask = await askableQuestions(db, { near })
  console.log(ask.length ? 'What the assistant should ask next:\n' : 'Nothing worth asking about right now.\n')
  for (const g of ask) {
    console.log(`  ${g.question}`)
    console.log(`    (${g.why})\n`)
  }
  const total = (await knowledgeGaps(db)).length
  if (total > ask.length) console.log(`  ${total - ask.length} lower-value gap(s) held back. See --all.`)
}
await db.close()
