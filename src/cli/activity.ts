import { open } from '../db/index.ts'

/**
 * Where did that answer come from?
 *
 * The point of this command is evidence. An agent that quietly greps the repo and
 * an agent that queries the graph produce similar-looking answers; only the log
 * distinguishes them.
 */
const args = process.argv.slice(2)
const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) ?? 30)
const since = args.find((a) => a.startsWith('--since='))?.slice(8) ?? '1 day'

const db = await open()
const r = await db.query<any>(
  `select to_char(at, 'HH24:MI:SS') as t, source, tool, ok, duration_ms, summary, error
     from activity where at > now() - $1::interval order by at desc limit $2`,
  [since, limit],
)

if (!r.rows.length) {
  console.log(`No tool calls in the last ${since}.`)
  console.log('If a session just answered a question, it did NOT use the knowledge tools.')
} else {
  console.log(`${r.rows.length} tool call(s) in the last ${since}, newest first:\n`)
  for (const a of r.rows.reverse()) {
    const status = a.ok ? ' ' : '!'
    const ms = a.duration_ms != null ? `${String(a.duration_ms).padStart(5)}ms` : '       '
    console.log(`${status} ${a.t}  ${ms}  ${a.tool}`)
    const s = a.summary ?? {}
    const bits = Object.entries(s)
      .filter(([, v]) => v !== null && v !== undefined && v !== false && v !== 0)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : typeof v === 'object' ? JSON.stringify(v) : v}`)
    if (bits.length) console.log(`             ${bits.join('  ')}`)
    if (a.error) console.log(`             error: ${a.error}`)
  }
  const tools = new Set(r.rows.map((x: any) => x.tool))
  console.log(`\ntools used: ${[...tools].join(', ')}`)
}
await db.close()
