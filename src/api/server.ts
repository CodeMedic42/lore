import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Db } from '../db/index.ts'
import { ingest, type IngestEnvelope } from '../store/observations.ts'
import { sweepScope } from '../store/sweep.ts'
import { markDistinct, merge, unmerge } from '../resolver/entity_resolver.ts'
import { entityFacts, runTemplate, TEMPLATES, type TemplateName } from '../query/traverse.ts'
import { ask, findAnchors } from '../query/ask.ts'
import { checkFileAnchors, reverificationQueue } from '../store/anchors.ts'
import { askableQuestions, joinCandidates, knowledgeGaps } from '../query/gaps.ts'
import { maintain } from '../store/maintain.ts'
import { tell } from '../store/tell.ts'
import { answerGap } from '../store/answers.ts'

type Handler = (ctx: {
  db: Db
  body: any
  params: Record<string, string>
  url: URL
}) => Promise<{ status?: number; body: unknown }>

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = []

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = []
  const pattern = new RegExp(
    `^${path.replace(/:([a-zA-Z_]+)/g, (_, k) => {
      keys.push(k)
      return '([^/]+)'
    })}$`,
  )
  routes.push({ method, pattern, keys, handler })
}

// ---------------------------------------------------------------------------
// Write path. Returns 202: resolution beyond exact-match, verification and
// embedding all happen out of band. Nothing here blocks on an LLM or a git host.
// ---------------------------------------------------------------------------

route('POST', '/v1/observations', async ({ db, body }) => {
  const envelope = body as IngestEnvelope
  if (!envelope?.observations?.length) {
    return { status: 400, body: { error: 'observations[] is required' } }
  }
  const result = await ingest(db, envelope)
  // Resolution hints let the agent cheaply correct a bad match on its next call.
  return { status: 202, body: result }
})

/**
 * Free text in, claims out. Expect agents to reach for this far more often than
 * the structured form, because it is what a user actually says.
 */
route('POST', '/v1/observations/text', async ({ db, body }) => {
  const text = String(body?.text ?? '')
  if (!text) return { status: 400, body: { error: '`text` is required' } }
  const result = await tell(db, {
    text,
    agent: body?.agent, session: body?.session, repo: body?.repo, env: body?.env,
    method: body?.method, impliedSubject: body?.implied_subject, dryRun: Boolean(body?.dry_run),
  })
  return { status: body?.dry_run ? 200 : 202, body: result }
})

/** Answer a question the graph asked. The gap is identified by kind + entity. */
route('POST', '/v1/gaps/answer', async ({ db, body }) => {
  const { gap_kind, entity_id, answer } = body ?? {}
  if (!gap_kind || !entity_id || !answer) {
    return { status: 400, body: { error: '`gap_kind`, `entity_id` and `answer` are required' } }
  }
  await maintain(db)
  const gap = (await knowledgeGaps(db)).find(
    (g) => g.gap_kind === gap_kind && g.entity_id === entity_id)
  if (!gap) return { status: 404, body: { error: 'no such open gap' } }
  return { body: await answerGap(db, gap, String(answer)) }
})

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

route('POST', '/v1/query/path', async ({ db, body }) => {
  const { from, template, min_trust, as_of, max_depth } = body ?? {}
  if (!from) return { status: 400, body: { error: '`from` (entity id or name) is required' } }
  const name = String(template ?? 'data_provenance') as TemplateName
  if (!(name in TEMPLATES)) {
    return { status: 400, body: { error: `unknown template`, known: Object.keys(TEMPLATES) } }
  }

  let start = String(from)
  if (!/^[0-9a-f-]{36}$/i.test(start)) {
    const anchors = await findAnchors(db, start)
    if (!anchors[0]) return { status: 404, body: { error: `no entity matching "${from}"` } }
    start = anchors[0].entity_id
  }

  const at = as_of ? new Date(as_of) : undefined
  const paths = await runTemplate(db, name, start, { minTrust: min_trust, at, maxDepth: max_depth })
  const nodes = [...new Set([start, ...paths.flatMap((p) => p.nodes)])]
  const facts = await entityFacts(db, nodes, at)
  return { body: { template: name, start, paths, facts: Object.fromEntries(facts) } }
})

route('POST', '/v1/ask', async ({ db, body }) => {
  const question = String(body?.question ?? '')
  if (!question) return { status: 400, body: { error: '`question` is required' } }
  const result = await ask(db, question, {
    minTrust: body?.min_trust,
    at: body?.as_of ? new Date(body.as_of) : undefined,
    from: body?.from,
  })
  return { body: result }
})

route('GET', '/v1/entities/:id/neighborhood', async ({ db, params, url }) => {
  const depth = Number(url.searchParams.get('depth') ?? 2)
  const paths = await runTemplate(db, 'data_provenance', params.id!, { maxDepth: depth })
  return { body: { entity: params.id, depth, paths } }
})

route('GET', '/v1/entities', async ({ db, url }) => {
  const q = url.searchParams.get('q')
  if (q) return { body: { candidates: await findAnchors(db, q, 20) } }
  const r = await db.query(
    `select e.id, e.kind, e.env, e.display_name, e.provisional,
            (select count(*) from entity_identifier i where i.entity_id = e.id) as strong_ids
       from entity e where e.canonical_id = e.id order by e.kind, e.display_name limit 500`,
  )
  return { body: { entities: r.rows } }
})

// ---------------------------------------------------------------------------
// Operations: the review queues and the anti-rot mechanism
// ---------------------------------------------------------------------------

/** Frequent unmapped predicates. This is how the vocabulary actually extends. */
route('GET', '/v1/predicates/unmapped', async ({ db }) => {
  const r = await db.query(
    `select raw, hits, last_seen from predicate_alias
      where maps_to is null order by hits desc, last_seen desc limit 100`,
  )
  return { body: { unmapped: r.rows } }
})

route('POST', '/v1/predicates/map', async ({ db, body }) => {
  const { raw, maps_to } = body ?? {}
  if (!raw || !maps_to) return { status: 400, body: { error: '`raw` and `maps_to` are required' } }
  await db.query('update predicate_alias set maps_to = $2 where raw = $1', [raw, maps_to])
  return { body: { ok: true, raw, maps_to } }
})

/** Close everything a scoped run did not re-assert. The anti-rot mechanism. */
route('POST', '/v1/sweep', async ({ db, body }) => {
  const { scope_key, run_start } = body ?? {}
  if (!scope_key || !run_start) {
    return { status: 400, body: { error: '`scope_key` and `run_start` are required' } }
  }
  const closed = await sweepScope(db, scope_key, new Date(run_start))
  return { body: { scope_key, closed } }
})

/** Near-miss name matches awaiting a decision. Resolution never auto-merges on these. */
route('GET', '/v1/merge-candidates', async ({ db }) => {
  const r = await db.query(
    `select mc.id, mc.score, mc.raw_text, mc.method,
            a.display_name as from_name, a.kind as from_kind, a.env as from_env, mc.from_id,
            b.display_name as into_name, b.kind as into_kind, b.env as into_env, mc.into_id
       from merge_candidate mc
       join entity a on a.id = mc.from_id
       join entity b on b.id = mc.into_id
      where mc.resolved_at is null
      order by mc.score desc limit 100`,
  )
  return { body: { candidates: r.rows } }
})

/** Headline health metric: below ~60% strong-id coverage, resolution is guesswork. */
route('GET', '/v1/health/resolution', async ({ db }) => {
  const r = await db.query<{ total: string; with_strong: string; provisional: string; open_candidates: string }>(
    `select (select count(*) from entity where canonical_id = id)::text as total,
            (select count(distinct entity_id) from entity_identifier)::text as with_strong,
            (select count(*) from entity where provisional and canonical_id = id)::text as provisional,
            (select count(*) from merge_candidate where resolved_at is null)::text as open_candidates`,
  )
  const row = r.rows[0]!
  const total = Number(row.total)
  const strong = Number(row.with_strong)
  return {
    body: {
      entities: total,
      with_strong_identifier: strong,
      strong_id_coverage: total ? Number((strong / total).toFixed(3)) : 0,
      provisional: Number(row.provisional),
      open_merge_candidates: Number(row.open_candidates),
      note: 'Below ~0.6 coverage, entity resolution is running on name similarity and the graph is unreliable.',
    },
  }
})

route('POST', '/v1/entities/merge', async ({ db, body }) => {
  const { from, into, reason, score, decided_by } = body ?? {}
  if (!from || !into) return { status: 400, body: { error: '`from` and `into` are required' } }
  await merge(db, from, into, { reason, score, decidedBy: decided_by })
  return { body: { ok: true, from, into } }
})

route('POST', '/v1/entities/unmerge', async ({ db, body }) => {
  if (!body?.merge_id) return { status: 400, body: { error: '`merge_id` is required' } }
  await unmerge(db, Number(body.merge_id))
  return { body: { ok: true } }
})

route('POST', '/v1/entities/distinct', async ({ db, body }) => {
  const { a, b, reason, decided_by } = body ?? {}
  if (!a || !b) return { status: 400, body: { error: '`a` and `b` are required' } }
  await markDistinct(db, a, b, reason ?? 'marked distinct', decided_by ?? 'human')
  return { body: { ok: true } }
})

/**
 * Re-check every claim that cited this file. Called by a worker watching GitLab.
 * `content: null` means the file was deleted.
 */
route('POST', '/v1/anchors/check', async ({ db, body }) => {
  const { repo, path, content, commit } = body ?? {}
  if (!path) return { status: 400, body: { error: '`path` is required' } }
  if (content === undefined) return { status: 400, body: { error: '`content` is required (null if deleted)' } }
  const summary = await checkFileAnchors(db, { repo, path, content, commit })
  return { body: { repo, path, ...summary } }
})

/** Claims whose evidence changed. The verification agent's work list. */
route('GET', '/v1/reverification-queue', async ({ db, url }) => {
  const limit = Number(url.searchParams.get('limit') ?? 50)
  return { body: { queue: await reverificationQueue(db, limit) } }
})

/** Everything the graph knows it does not know, ranked by what answering unlocks. */
route('GET', '/v1/gaps', async ({ db, url }) => {
  await maintain(db)
  const limit = url.searchParams.get('limit')
  return { body: { gaps: await knowledgeGaps(db, { limit: limit ? Number(limit) : undefined }) } }
})

/** The small set an agent should actually raise with the user right now. */
route('GET', '/v1/gaps/ask', async ({ db, url }) => {
  await maintain(db)
  const budget = Number(url.searchParams.get('budget') ?? 2)
  const near = url.searchParams.get('near') ?? undefined
  return { body: { questions: await askableQuestions(db, { budget, near }) } }
})

/** Proposed cross-repo joins: a call site in one repo matching a route in another. */
route('GET', '/v1/join-candidates', async ({ db }) => {
  return { body: { candidates: await joinCandidates(db) } }
})

route('GET', '/healthz', async ({ db }) => {
  const r = await db.query<{ n: string }>('select count(*)::text as n from proposition')
  return { body: { ok: true, driver: db.driver, propositions: Number(r.rows[0]!.n) } }
})

// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (!chunks.length) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

export function createApi(db: Db) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname))

    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body, null, 2)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(payload)
    }

    if (!match) {
      return send(404, { error: 'not found', routes: routes.map((r) => `${r.method} ${r.pattern.source}`) })
    }

    try {
      const m = match.pattern.exec(url.pathname)!
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]))
      const body = req.method === 'GET' ? undefined : await readBody(req)
      const out = await match.handler({ db, body, params, url })
      send(out.status ?? 200, out.body)
    } catch (err) {
      send(500, { error: (err as Error).message })
    }
  })
}
