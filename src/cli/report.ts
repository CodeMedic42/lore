import { writeFile } from 'node:fs/promises'
import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { buildReport } from '../report/build.ts'
import type { Mode } from '../report/redact.ts'

const args = process.argv.slice(2)
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)

const mode = (arg('mode') ?? (args.includes('--full') ? 'full' : args.includes('--stats') ? 'stats' : 'redacted')) as Mode
if (!['full', 'redacted', 'stats'].includes(mode)) {
  console.error(`unknown mode "${mode}". Use redacted (default), stats, or full.`)
  process.exit(1)
}

const db = await open()
await migrate(db, { quiet: true })

const text = await buildReport(db, {
  mode,
  sinceDays: Number(arg('days') ?? 30),
  samples: Number(arg('samples') ?? 25),
})

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
const out = arg('out') ?? `knowledge-report-${mode}-${stamp}.md`
await writeFile(out, text, 'utf8')

console.log(`Wrote ${out}  (${(text.length / 1024).toFixed(1)} KB, mode: ${mode})`)
if (mode === 'full') {
  console.log('')
  console.log('  WARNING: this file is UNREDACTED. It names real repositories, services,')
  console.log('  databases and the locations of secrets. Read it before sending it anywhere.')
} else if (mode === 'redacted') {
  console.log('  Names are stable pseudonyms; literals, paths and identifiers are removed.')
  console.log('  Read it before sending — it is your data and your call.')
}
await db.close()
