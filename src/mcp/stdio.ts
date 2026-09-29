#!/usr/bin/env node
/**
 * Executable entrypoint for the MCP server.
 *
 * stdio is the transport, so stdout belongs to the protocol: every diagnostic
 * line must go to stderr or the connection breaks in ways that are painful to
 * debug from the client side.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { createMcpServer } from './server.ts'

const db = await open()
await migrate(db, { quiet: true })

const server = createMcpServer(db)

const shutdown = async () => {
  await db.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await server.connect(new StdioServerTransport())
console.error(`living-ai-knowledge MCP server ready (driver: ${db.driver})`)
