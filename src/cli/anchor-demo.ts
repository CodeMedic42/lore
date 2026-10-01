/**
 * Demonstrates evidence anchoring.
 *
 * The claim: "Service C reads notifications from Redis", proved by pointing at
 * some lines in cache.ts. Then the file changes three ways, and we watch what the
 * system concludes each time.
 */
import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { ingest } from '../store/observations.ts'
import { checkFileAnchors, reverificationQueue } from '../store/anchors.ts'

const PATH = 'src/notifications/cache.ts'
const REPO = 'gitlab:1003'

// --- version 1: what the agent actually read -------------------------------
const V1 = `import { redis } from '../redis.ts'
import { db } from '../db.ts'

const TTL_SECONDS = 60

export async function readNotifications(userId: string) {
  const cached = await redis.get(\`notif:\${userId}\`)
  if (cached) {
    return JSON.parse(cached)
  }
  const rows = await db.query('select * from notifications where user_id = $1', [userId])
  await redis.setex(\`notif:\${userId}\`, TTL_SECONDS, JSON.stringify(rows))
  return rows
}
`

// --- version 2: a formatter ran. Indentation and quoting changed, logic did not.
const V2_REFORMATTED = `import { redis } from "../redis.ts";
import { db } from "../db.ts";

const TTL_SECONDS = 60;

export async function readNotifications(userId: string) {
    const cached = await redis.get(\`notif:\${userId}\`);
    if (cached) {
        return JSON.parse(cached);
    }
    const rows = await db.query("select * from notifications where user_id = $1", [userId]);
    await redis.setex(\`notif:\${userId}\`, TTL_SECONDS, JSON.stringify(rows));
    return rows;
}
`

// --- version 3: 20 lines of unrelated code added above. Logic identical.
const V3_SHIFTED = `${'// license header\n'.repeat(20)}${V1}`

// --- version 4: the cache was ripped out. The claim is now FALSE.
const V4_CHANGED = `import { db } from '../db.ts'

export async function readNotifications(userId: string) {
  return db.query('select * from notifications where user_id = $1', [userId])
}
`

/** Locate the lines the agent cited, and return their exact text. */
function span(content: string, startsWith: string, endsWith: string) {
  const lines = content.split('\n')
  const from = lines.findIndex((l) => l.includes(startsWith)) + 1
  const to = lines.findIndex((l, i) => i >= from - 1 && l.includes(endsWith)) + 1
  return { lines: [from, to] as [number, number], text: lines.slice(from - 1, to).join('\n') }
}

const cited = span(V1, 'export async function readNotifications', 'return rows')

const db = await open()
await migrate(db, { quiet: true })
await db.query(`delete from assertion where scope_key = 'anchor-demo'`)

const r = await ingest(db, {
  agent: 'claude-code/opus',
  session: 'anchor-demo',
  method: 'llm_inferred',
  repo: REPO,
  commit: 'aaaa111',
  env: 'prod',
  scope_key: 'anchor-demo',
  observations: [{
    subject: 'Service C', subject_kind: 'service', predicate: 'reads_from',
    object: 'Redis cache E', object_kind: 'cache',
    qualifiers: { role: 'cache', key_pattern: 'notif:*' },
    confidence: 0.8,
    evidence: [{
      path: PATH,
      lines: cited.lines,
      span_text: cited.text,                    // <- the agent had this in context anyway
      enclosing_symbol: 'readNotifications',
      scip_symbol: 'scip-typescript npm @acme/service-c 1.4.0 `src/notifications/cache.ts`/readNotifications().',
    }],
  }],
})

console.log(`claim recorded (lines ${cited.lines.join('-')}), anchors: ${r.results[0]!.anchors}\n`)

const cases: Array<[string, string | null]> = [
  ['unchanged file', V1],
  ['a formatter ran (indentation + quotes changed)', V2_REFORMATTED],
  ['20 lines inserted above it', V3_SHIFTED],
  ['the cache was removed - claim is now FALSE', V4_CHANGED],
  ['file deleted', null],
]

for (const [label, content] of cases) {
  const s = await checkFileAnchors(db, { repo: REPO, path: PATH, content, commit: 'bbbb222' })
  const verdict =
    s.ok      ? 'unchanged — still trusted'
  : s.shifted ? 'shifted — line numbers healed, still trusted'
  : s.changed ? 'CHANGED — queued for re-verification'
  :             'GONE — queued for re-verification'
  console.log(`${label.padEnd(48)} → ${verdict}`)
}

console.log('\nre-verification queue (the verification agent\'s work list):')
for (const q of await reverificationQueue(db, 5)) {
  console.log(`  [${q.state}] ${q.predicate} · ${q.repo} ${q.path} · asserted by ${q.asserted_by}`)
}

await db.close()
