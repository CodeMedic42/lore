import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { databaseUrl, open } from '../db/index.ts'

/**
 * Preflight. Everything a live session depends on, checked in the order it would
 * break — so a manual test fails for an interesting reason rather than because
 * Docker was not running.
 */
const run = promisify(execFile)
const ok = (s: string) => `  ok    ${s}`
const warn = (s: string) => `  warn  ${s}`
const bad = (s: string) => `  FAIL  ${s}`
const out: string[] = []
let fatal = false

console.log('\nliving-ai-knowledge preflight\n')

let db
try {
  db = await open()
  const v = await db.query<{ v: string }>('select version() as v')
  out.push(ok(`database reachable (${db.driver}) — ${v.rows[0]!.v.split(',')[0]}`))
} catch (err) {
  out.push(bad(`database unreachable at ${databaseUrl()}`))
  out.push(`        ${(err as Error).message.split('\n')[0]}`)
  out.push('        fix: docker start lak-pg')
  fatal = true
}

if (db) {
  const files = (await readdir(new URL('../../migrations/', import.meta.url).pathname))
    .filter((f) => f.endsWith('.sql')).length
  const applied = await db.query<{ n: string }>('select count(*)::text n from schema_migration')
    .catch(() => ({ rows: [{ n: '0' }] }))
  const n = Number(applied.rows[0]!.n)
  out.push(n >= files ? ok(`migrations applied (${n}/${files})`)
    : bad(`migrations behind (${n}/${files}) — fix: npx tsx src/cli/migrate.ts`))
  if (n < files) fatal = true

  const vec = await db.query<{ has: boolean }>('select has_pgvector() as has').catch(() => ({ rows: [{ has: false }] }))
  out.push(vec.rows[0]!.has
    ? ok('pgvector present (similarity search uses the index)')
    : warn('no pgvector — similarity still works, computed in process'))

  const g = await db.query<any>(`
    select (select count(*) from entity where canonical_id = id)::int entities,
           (select count(*) from entity where kind = 'component' and canonical_id = id)::int components,
           (select count(*) from edge_now)::int edges,
           (select count(*) from entity_embedding)::int embedded,
           (select count(*) from repo_location)::int repos`)
  const s = g.rows[0]
  out.push(s.entities > 0
    ? ok(`graph populated — ${s.entities} entities, ${s.components} components, ${s.edges} live edges`)
    : warn('graph is empty — nothing to retrieve yet (ask an agent to scan a repo, or: npm run extract)'))
  out.push(s.embedded >= s.entities && s.entities > 0
    ? ok(`embeddings current (${s.embedded})`)
    : s.entities === 0 ? warn('embeddings: nothing to index yet')
    : warn(`embeddings behind (${s.embedded}/${s.entities}) — fix: npm run embed -- index`))
  out.push(s.repos > 0
    ? ok(`${s.repos} repository checkout(s) registered — context files can be read`)
    : warn('no repository checkouts registered — load_context will only return URLs'))

  const recent = await db.query<{ n: string }>(
    `select count(*)::text n from activity where at > now() - interval '7 days'`)
  out.push(Number(recent.rows[0]!.n) > 0
    ? ok(`${recent.rows[0]!.n} tool call(s) in the last 7 days`)
    : warn('no tool calls recorded — no agent has used this yet'))
  await db.close()
}

// The MCP registration lives in the client's config, not ours; ask the client.
try {
  const { stdout } = await run('claude', ['mcp', 'list'], { timeout: 15_000 })
  const line = stdout.split('\n').find((l) => /knowledge/i.test(l))
  const healthy = line && /✔|connected/i.test(line)
  out.push(line
    ? (healthy ? ok(`MCP registered — ${line.trim()}`) : bad(`MCP registered but unhealthy — ${line.trim()}`))
    : bad('MCP server not registered with Claude Code — an agent has no access to any of this'))
  if (!healthy) fatal = true
  if (!line) {
    out.push('        fix: claude mcp add knowledge --scope user -- \\')
    out.push(`              node ${new URL('../mcp/stdio.ts', import.meta.url).pathname}`)
  }
} catch {
  out.push(warn('could not run `claude mcp list` — check registration manually'))
}

console.log(out.join('\n'))
console.log(fatal ? '\nNot ready. Fix the FAIL lines above.\n' : '\nReady.\n')
process.exit(fatal ? 1 : 0)
