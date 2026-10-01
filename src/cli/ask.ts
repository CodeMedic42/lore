import { open } from '../db/index.ts'
import { ask, render } from '../query/ask.ts'

const args = process.argv.slice(2)
const question = args.filter((a) => !a.startsWith('--')).join(' ')
const fromArg = args.find((a) => a.startsWith('--from='))?.slice('--from='.length)
const trustArg = args.find((a) => a.startsWith('--min-trust='))?.slice('--min-trust='.length)

if (!question) {
  console.error('usage: npm run ask -- "where does the list of notifications in Client A come from" [--from=X] [--min-trust=0.1]')
  process.exit(1)
}

const db = await open()
const result = await ask(db, question, {
  from: fromArg,
  minTrust: trustArg ? Number(trustArg) : undefined,
})
console.log(render(result))
await db.close()
