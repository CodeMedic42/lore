import { open } from '../db/index.ts'
import { askableQuestions, knowledgeGaps } from '../query/gaps.ts'
import { answerGap } from '../store/answers.ts'
import { maintain } from '../store/maintain.ts'

const args = process.argv.slice(2)
const n = Number(args[0])
const answer = args.slice(1).join(' ')

const db = await open()
await maintain(db)

if (!n || !answer) {
  const qs = await askableQuestions(db, { budget: 5 })
  console.log('Answer a question by number:\n')
  qs.forEach((q, i) => console.log(`  ${i + 1}. ${q.question}`))
  console.log('\n  npm run answer -- 1 "yes"')
  console.log('  npm run answer -- 2 "common-service"')
  await db.close()
  process.exit(0)
}

const qs = await askableQuestions(db, { budget: 5 })
const gap = qs[n - 1]
if (!gap) {
  console.error(`No question ${n}. There are ${qs.length}.`)
  await db.close()
  process.exit(1)
}

console.log(`Q: ${gap.question}`)
console.log(`A: ${answer}\n`)
const result = await answerGap(db, gap, answer)
console.log(result.understood ? `✓ ${result.action}` : `✗ ${result.action}`)
if (result.detail) console.log(`  ${JSON.stringify(result.detail)}`)

const remaining = await knowledgeGaps(db)
console.log(`\n${remaining.length} gap(s) remaining.`)
await db.close()
