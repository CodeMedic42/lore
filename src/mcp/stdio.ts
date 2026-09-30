#!/usr/bin/env node
/**
 * Executable entrypoint for the MCP server.
 *
 * Launched as a SUBPROCESS by the MCP client (Claude Code and friends), one per
 * session, speaking JSON-RPC over stdin/stdout. There is no long-running MCP
 * service to start: the only thing that must already be up is the database.
 *
 * stdout belongs to the protocol, so every diagnostic goes to stderr. A failure
 * here surfaces in the client as an opaque "server failed to start", which is why
 * the message below works hard to say what to actually do about it.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { databaseUrl, open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { createMcpServer } from './server.ts'

function fail(lines: string[]): never {
  console.error(`\n  living-ai-knowledge could not start.\n`)
  for (const l of lines) console.error(`  ${l}`)
  console.error('')
  process.exit(1)
}

let db
try {
  db = await open()
  await migrate(db, { quiet: true })
} catch (err) {
  // node-postgres throws an AggregateError whose own `message` is EMPTY - the
  // useful part is `code` and the nested `errors`. Reading only `.message` here
  // produced a blank diagnostic, which is worse than the raw stack trace it
  // replaced.
  const describe = (e: unknown): string => {
    const x = e as any
    const parts = [x?.code, x?.message].filter(Boolean)
    const nested: unknown[] = Array.isArray(x?.errors) ? x.errors : []
    for (const n of nested.slice(0, 3)) {
      const d = describe(n)
      if (d) parts.push(d)
    }
    return [...new Set(parts)].join(' ').trim()
  }
  const message = describe(err) || String(err)
  const driver = process.env.LAK_DRIVER ?? 'pg'

  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|connect/i.test(message)) {
    fail([
      `Cannot reach the database at ${databaseUrl()}`,
      '',
      'The knowledge graph lives in PostgreSQL, and it is not running.',
      '',
      '  docker start lak-pg',
      '',
      'If that container does not exist yet:',
      '',
      '  docker run -d --name lak-pg -e POSTGRES_PASSWORD=lak -e POSTGRES_USER=lak \\',
      '    -e POSTGRES_DB=lak -p 55432:5432 pgvector/pgvector:pg17',
      '',
      'Or point somewhere else with DATABASE_URL, or run without a server at all',
      'with LAK_DRIVER=pglite (set LAK_DATA_DIR to keep the data between runs).',
      '',
      `Underlying error: ${message}`,
    ])
  }
  if (/password|authentication|role .* does not exist/i.test(message)) {
    fail([
      `The database rejected the connection at ${databaseUrl()}`,
      'Check the credentials in DATABASE_URL.',
      '',
      `Underlying error: ${message}`,
    ])
  }
  fail([`Driver: ${driver}`, `Error: ${message}`])
}

const server = createMcpServer(db)

const shutdown = async () => {
  await db.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await server.connect(new StdioServerTransport())
console.error(`living-ai-knowledge ready (driver: ${db.driver}, ${databaseUrl().replace(/:[^:@]*@/, ':***@')})`)
