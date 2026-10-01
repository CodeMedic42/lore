import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { merge, normaliseName } from '../resolver/entity_resolver.ts'
import { extractIdentifier } from '../store/answers.ts'

/**
 * Repair damage a resolution bug left behind.
 *
 * Dry by default: a merge is a real mutation and an incorrect one is expensive to
 * spot later, so it prints what it would do and does nothing until --apply.
 */
const apply = process.argv.includes('--apply')
const real = process.argv.includes('--real')

// Same inversion as clear: merging entities is hard to unpick in bulk, so the
// throwaway graph is the default target and a real one must be asked for.
if (!real) {
  process.env.LAK_PROFILE = 'test'
  delete process.env.DATABASE_URL
}

const { describeDatabase, resolveDatabase } = await import('../db/index.ts')
console.log(`repairing: ${describeDatabase(resolveDatabase())}${real ? '' : '  (pass --real to target a real graph)'}`)

const db = await open()
await migrate(db, { quiet: true })

// ── 1. identifiers that had prose stored in them ───────────────────────────
const bad = await db.query<{ entity_id: string; authority: string; value: string }>(
  `select entity_id, authority, value from entity_identifier
    where value ~ ' .* ' or length(value) > 80`,
)
console.log(`\nmalformed identifiers: ${bad.rows.length}`)
for (const row of bad.rows) {
  const fixed = extractIdentifier(row.value)
  console.log(`  ${row.authority}: "${row.value.slice(0, 60)}…"`)
  console.log(`    -> ${fixed ? `${fixed.authority} = ${fixed.value}` : 'nothing extractable, would delete'}`)
  if (!apply) continue
  await db.query('delete from entity_identifier where authority = $1 and value = $2', [row.authority, row.value])
  if (fixed) {
    await db.query(
      `insert into entity_identifier (entity_id, authority, value) values ($1,$2,$3)
       on conflict (authority, value) do nothing`,
      [row.entity_id, fixed.authority, fixed.value],
    )
  }
}

// ── 2. same-name entities that should never have been split ────────────────
const rows = await db.query<{ id: string; display_name: string; kind: string; env: string; ids: number; edges: number; provisional: boolean }>(
  `select e.id, e.display_name, e.kind, e.env, e.provisional,
          (select count(*) from entity_identifier i where i.entity_id = e.id)::int ids,
          (select count(*) from edges_canon(now()) ec where ec.subject = e.id or ec.object = e.id)::int edges
     from entity e where e.canonical_id = e.id`,
)

const groups = new Map<string, typeof rows.rows>()
for (const r of rows.rows) {
  const key = normaliseName(r.display_name)
  groups.set(key, [...(groups.get(key) ?? []), r])
}

let merges = 0
console.log('\nduplicate groups:')
for (const [name, members] of groups) {
  if (members.length < 2) continue
  // Only merge where environments are compatible - never bridge prod and staging.
  const realEnvs = new Set(members.map((m) => m.env).filter((e) => e !== 'unknown'))
  if (realEnvs.size > 1) {
    console.log(`  ${name}: ${members.length} across environments ${[...realEnvs].join('/')} — LEFT ALONE`)
    continue
  }
  // Keep the best-attested one: most identifiers, then most edges, then not provisional.
  const [keep, ...rest] = members.sort((a, b) =>
    b.ids - a.ids || b.edges - a.edges || Number(a.provisional) - Number(b.provisional))
  console.log(`  ${name}: ${members.length} -> keep ${keep!.kind} (${keep!.ids} ids, ${keep!.edges} edges)`)
  for (const dup of rest) {
    console.log(`      merge ${dup.kind} (${dup.ids} ids, ${dup.edges} edges)`)
    if (!apply) continue
    try {
      await merge(db, dup.id, keep!.id, { reason: 'resolution bug: env/kind split the same entity', decidedBy: 'repair', score: 1 })
      merges++
    } catch (err) {
      console.log(`      refused: ${(err as Error).message}`)
    }
  }
}

console.log(apply ? `\napplied — ${merges} merge(s)` : '\nDRY RUN — nothing changed. Re-run with --apply')
await db.close()
