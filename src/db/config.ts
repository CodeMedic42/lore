import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Which database this process talks to.
 *
 * Resolution order, highest first:
 *
 *   1. DATABASE_URL          — explicit, wins over everything
 *   2. LORE_PROFILE=test      — the shared test database on the same server
 *   3. .lore.json in cwd or any ancestor — `{ "databaseUrl": "..." }`
 *   4. the personal default
 *
 * Rung 3 is what keeps testing off a real graph. The MCP server is spawned with
 * the session's working directory, so a test workspace carrying a .lore.json
 * points every session inside it at a throwaway database - without a second MCP
 * registration, and without the scope conflicts that come with one.
 */
const PERSONAL = 'postgres://lore:lore@localhost:55432/lore'
const TEST = 'postgres://lore:lore@localhost:55432/lore_dev'

export interface DatabaseChoice {
  url: string
  /** Where the choice came from, so tools can say which graph they are touching. */
  source: 'DATABASE_URL' | 'LORE_PROFILE' | '.lore.json' | 'default'
  configPath?: string
}

export function resolveDatabase(cwd = process.cwd()): DatabaseChoice {
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, source: 'DATABASE_URL' }
  }
  if (process.env.LORE_PROFILE === 'test') {
    return { url: TEST, source: 'LORE_PROFILE' }
  }

  let dir = resolve(cwd)
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, '.lore.json')
    try {
      if (statSync(candidate).isFile()) {
        const cfg = JSON.parse(readFileSync(candidate, 'utf8'))
        if (typeof cfg.databaseUrl === 'string' && cfg.databaseUrl) {
          return { url: cfg.databaseUrl, source: '.lore.json', configPath: candidate }
        }
      }
    } catch {
      // unreadable or malformed: keep walking rather than failing the session
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { url: PERSONAL, source: 'default' }
}

/** Never print a password back to a user or a log. */
export function redact(url: string): string {
  return url.replace(/:\/\/([^:/@]+):[^@]*@/, '://$1:***@')
}

/** A short label for "which graph am I touching", for doctor and startup lines. */
export function describeDatabase(choice: DatabaseChoice): string {
  const name = choice.url.split('/').pop() ?? choice.url
  const via = choice.source === 'default' ? 'default' : `via ${choice.source}`
  return `${name} (${via}${choice.configPath ? ` at ${choice.configPath}` : ''})`
}
