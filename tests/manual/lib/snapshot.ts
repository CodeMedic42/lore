/**
 * Capture the graph's state and recent tool activity, so a manual test has
 * objective before/after evidence rather than an impression.
 *
 *   npx tsx tests/manual/lib/snapshot.ts <label>
 *
 * Writes tests/manual/results/<label>.json and prints a summary.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { open } from '../../../src/db/index.ts'

const label = process.argv[2]
if (!label) {
  console.error('usage: npx tsx tests/manual/lib/snapshot.ts <label>   e.g. "phase-b-after"')
  process.exit(1)
}

const db = await open()
const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0] ?? {}
const all = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows

const graph = await one(`
  select (select count(*) from entity where canonical_id = id)::int as entities,
         (select count(*) from entity where kind = 'component' and canonical_id = id)::int as components,
         (select count(*) from proposition)::int as propositions,
         (select count(*) from edge_now)::int as live_edges,
         (select count(*) from entity_embedding)::int as embedded,
         (select count(*) from evidence_anchor)::int as anchors`)

const activity = await all(`
  select to_char(at, 'YYYY-MM-DD HH24:MI:SS') as at, source, tool, ok, duration_ms, summary
    from activity order by at desc limit 100`)

const toolCounts = await all(`
  select tool, count(*)::int as calls from activity group by 1 order by 2 desc`)

const snapshot = { label, taken_at: new Date().toISOString(), graph, toolCounts, activity }
await mkdir(new URL('../results/', import.meta.url).pathname, { recursive: true })
const path = new URL(`../results/${label}.json`, import.meta.url).pathname
await writeFile(path, JSON.stringify(snapshot, null, 2))

console.log(`snapshot "${label}" -> tests/manual/results/${label}.json`)
console.log(`  graph:  ${graph.entities} entities (${graph.components} components), ${graph.live_edges} live edges, ${graph.embedded} embedded`)
console.log(`  tools:  ${toolCounts.length ? toolCounts.map((t: any) => `${t.tool}=${t.calls}`).join('  ') : 'NO TOOL CALLS RECORDED'}`)
await db.close()
