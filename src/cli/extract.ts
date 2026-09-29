import { resolve } from 'node:path'
import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { extractMonorepo } from '../extract/monorepo.ts'

const args = process.argv.slice(2)
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const root = args.find((a) => !a.startsWith('--'))

if (!root) {
  console.error('usage: npm run extract -- <path-to-repo> [--repo=key] [--url=browse-url] [--dry-run] [--intra]')
  process.exit(1)
}

const db = await open()
await migrate(db, { quiet: true })

const started = Date.now()
const r = await extractMonorepo(db, {
  root: resolve(root),
  repoKey: arg('repo'),
  browseUrl: arg('url'),
  env: arg('env'),
  includeIntraPackage: args.includes('--intra'),
  dryRun: args.includes('--dry-run'),
  maxFiles: Number(arg('max-files') ?? 5000),
})

console.log(`${args.includes('--dry-run') ? 'Would index' : 'Indexed'} ${r.repoKey} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`  packages:   ${r.packages.length}`)
console.log(`  files read: ${r.files}`)
console.log(`  components: ${r.components}`)
console.log(`  facts:      ${r.observations}${args.includes('--dry-run') ? '' : ` (${r.accepted} accepted, ${r.rejected} rejected)`}`)
if (r.swept) console.log(`  removed:    ${r.swept} fact(s) no longer present in the code`)

if (r.preview.length) {
  console.log('\ncross-package composition found:')
  for (const p of r.preview.slice(0, 15)) console.log(`  ${p}`)
  if (r.preview.length > 15) console.log(`  …and ${r.preview.length - 15} more`)
}
if (r.warnings.length) {
  console.log('\nwarnings:')
  for (const w of r.warnings.slice(0, 10)) console.log(`  ${w}`)
}
await db.close()
