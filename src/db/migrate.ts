import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from './index.ts'

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url).pathname

/**
 * Apply every migration not yet recorded. Files named `*.optional.sql` are
 * best-effort: a failure is logged and skipped, so drivers lacking an extension
 * (PGlite has no pg_trgm) still come up cleanly.
 */
export async function migrate(db: Db, opts: { quiet?: boolean } = {}): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migration (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `)

  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migration')).rows.map((r) => r.name),
  )
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const ran: string[] = []

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    const optional = file.includes('.optional.')
    try {
      await db.exec(sql)
      await db.query('insert into schema_migration (name) values ($1)', [file])
      ran.push(file)
      if (!opts.quiet) console.log(`  applied ${file}`)
    } catch (err) {
      if (!optional) throw new Error(`migration ${file} failed: ${(err as Error).message}`)
      if (!opts.quiet) console.log(`  skipped ${file} (optional): ${(err as Error).message.split('\n')[0]}`)
      await db.query('insert into schema_migration (name) values ($1)', [`${file}#skipped`])
    }
  }
  return ran
}
