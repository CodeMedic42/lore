/**
 * MCP server: lets any MCP-speaking agent (Claude Code, and others) read from and
 * write to the knowledge graph while it works.
 *
 * It talks to the same core the HTTP API wraps, so there is one implementation of
 * the rules. Point DATABASE_URL at a shared Postgres and a whole team's agents
 * write into one graph; leave it at the default and it is yours alone.
 *
 * This module builds the server; `stdio.ts` is the executable that runs it.
 * Keeping them apart means the tools can be exercised in-process by the tests.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { Db } from '../db/index.ts'
import { ingest } from '../store/observations.ts'
import { tell } from '../store/tell.ts'
import { answerGap } from '../store/answers.ts'
import { maintain } from '../store/maintain.ts'
import { ask, findAnchors } from '../query/ask.ts'
import { askableQuestions, knowledgeGaps } from '../query/gaps.ts'
import { entityFacts, runTemplate, TEMPLATES, type TemplateName } from '../query/traverse.ts'
import { renderAsk, renderFacts, renderGaps, renderIngest, renderPaths } from './format.ts'
import { tracked } from '../store/activity.ts'
import { loadContext } from '../context/load.ts'

export function createMcpServer(db: Db): McpServer {
/**
 * Wrap a tool handler so every call is timed and logged.
 * The summary carries counts and vocabulary only - never names or content.
 */
const trace = <A extends Record<string, unknown>>(
  tool: string,
  fn: (args: A) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean; summary?: Record<string, unknown> }>,
) => async (args: A) => {
  return tracked(db, { source: 'mcp' as const, tool, agent: 'mcp-agent' }, async () => {
    const out = await fn(args)
    const { summary, ...result } = out
    return { result, summary }
  })
}

const server = new McpServer(
  { name: 'living-ai-knowledge', version: '0.1.0' },
  {
    instructions: [
      'A shared, durable knowledge graph about the codebases this user works on.',
      '',
      'It exists because your context window and this session both end, and because',
      'facts that span repositories cannot be seen from inside any single one.',
      '',
      'READ from it before exploring: ask_knowledge may already know how two services',
      'connect, saving you a search across repos you cannot see.',
      '',
      'WRITE to it when you learn something DURABLE and worth knowing next time -',
      'especially anything that crosses a repository boundary. Good: this client calls',
      'that service, this service reads that database, this repo is built with Webpack,',
      'this Terraform module provisions that cache, this feature is implemented here.',
      'Not worth recording: transient details, the contents of a function, anything',
      'that will be false after the next refactor.',
      '',
      'The user can also just tell you things. Relay those with record_statement.',
      'And check pending_questions occasionally - the graph knows what it is missing,',
      'and one well-timed question can connect two repositories permanently.',
    ].join('\n'),
  },
)

const strongIdentifier = z.object({
  authority: z.enum(['gitlab_project', 'git_remote', 'arn', 'tf_address', 'otel_service', 'k8s', 'url', 'scip_symbol'])
    .describe('Which namespace the identifier belongs to'),
  value: z.string(),
})

const evidence = z.object({
  repo: z.string().optional().describe('e.g. "gitlab:4412" or "gitlab.com/acme/service-c"'),
  commit: z.string().optional(),
  path: z.string().optional().describe('File path within the repo'),
  lines: z.tuple([z.number(), z.number()]).optional(),
  span_text: z.string().optional()
    .describe('The exact lines you read. Cheap to include since you already have them, and without it this claim can never be automatically re-verified when the file changes.'),
  enclosing_symbol: z.string().optional().describe('The function or class the lines sit inside'),
  trace_id: z.string().optional(),
  tf_address: z.string().optional(),
  url: z.string().optional(),
})

const observation = z.object({
  subject: z.string().optional().describe('The thing the claim is about, as you would name it'),
  subject_kind: z.string().optional()
    .describe('client | service | repo | datastore | cache | queue | cloud_resource | iac_module | endpoint | technology | capability | data_concept | pipeline | alert | team'),
  subject_identifiers: z.array(strongIdentifier).optional()
    .describe('Strongly prefer supplying these. They are how two different names for one thing get resolved without guessing.'),
  about: z.number().int().optional()
    .describe('Index of an earlier observation in THIS batch. Makes this claim about that claim - e.g. a cache read that falls back to a database.'),
  predicate: z.string()
    .describe('calls | reads_from | writes_to | publishes_to | subscribes_to | caches_in | falls_back_to | lives_in_repo | exposes_endpoint | provisioned_by | deployed_to | owned_by | written_in | uses_framework | built_with | tests_with | depends_on_package | implements | handles_data | supersedes | built_by | monitors | connect_via | secret_at | note. An unlisted predicate is accepted, not rejected - it is stored and queued for review.'),
  object: z.string().optional(),
  object_kind: z.string().optional(),
  object_identifiers: z.array(strongIdentifier).optional(),
  object_literal: z.string().optional()
    .describe('Use instead of `object` when the value is text, not a thing: a connection recipe, a note, a URL. NEVER put a credential here.'),
  qualifiers: z.record(z.string(), z.any()).optional()
    .describe('e.g. {path, method} on a call, {role: "cache"|"origin", key_pattern, table} on a read, {ttl_seconds}. path/method/role/key_pattern/table distinguish one edge from another; anything else describes it.'),
  evidence: z.array(evidence).optional(),
  confidence: z.number().min(0).max(1).optional(),
  polarity: z.boolean().optional()
    .describe('false to REFUTE a claim you now believe is wrong. The original is kept and contradicted, never deleted.'),
  note: z.string().optional().describe('Free text about this specific claim'),
})

// ── reading ────────────────────────────────────────────────────────────────

server.registerTool('ask_knowledge', {
  title: 'Ask the knowledge graph',
  description: [
    'Ask a question in plain English about how these systems fit together, and get',
    'an answer traced across repository boundaries, with evidence.',
    '',
    'Use this BEFORE searching the filesystem when a question spans more than the repo',
    'you are in - "where does this data come from", "how does authentication work",',
    '"what calls this service", "how do I connect to that database", "what alerts exist".',
    '',
    'Answers cite the repo, file and lines they came from, so you can verify cheaply.',
    'Claims that are contradicted, or whose cited code has since changed, are labelled.',
  ].join('\n'),
  inputSchema: {
    question: z.string(),
    min_trust: z.number().min(0).max(1).optional()
      .describe('Hide claims below this confidence. Default is low, so unverified leads still show up labelled.'),
    as_of: z.string().optional().describe('ISO timestamp: what was believed at that moment'),
  },
}, trace('ask_knowledge', async ({ question, min_trust, as_of }: any) => {
  const result = await ask(db, question, {
    minTrust: min_trust,
    at: as_of ? new Date(as_of) : undefined,
  })
  return {
    content: [{ type: 'text' as const, text: renderAsk(result) }],
    summary: {
      answered: Boolean(result.anchor || result.listing),
      template: result.template,
      anchor_kind: result.anchor?.kind ?? null,
      paths: result.paths.length,
      max_depth: result.paths.reduce((m, p) => Math.max(m, p.depth), 0),
      listed: result.listing?.entities.length ?? 0,
      question_words: question.split(/\s+/).length,
    },
  }
}))

server.registerTool('lookup_entity', {
  title: 'Look up one thing',
  description: [
    'Everything known about one specific thing, and what it connects to.',
    'Use when you have a name - a service, repo, database, framework - and want its',
    'neighbourhood rather than an answer to a question.',
  ].join('\n'),
  inputSchema: {
    name: z.string(),
    shape: z.enum(['data_provenance', 'blast_radius', 'access', 'concept_map']).optional()
      .describe('data_provenance: where its data comes from. blast_radius: what depends on it. access: how to reach it. concept_map: what implements it.'),
    depth: z.number().int().min(1).max(6).optional(),
  },
}, trace('lookup_entity', async ({ name, shape, depth }: any) => {
  const anchors = await findAnchors(db, name, 5)
  const anchor = anchors[0]
  if (!anchor) {
    return {
      content: [{ type: 'text' as const, text: `Nothing known called "${name}".` }],
      summary: { found: false },
    }
  }
  const template: TemplateName = (shape ?? 'data_provenance') as TemplateName
  if (!(template in TEMPLATES)) {
    return {
      content: [{ type: 'text' as const, text: `Unknown shape. Options: ${Object.keys(TEMPLATES).join(', ')}` }],
      summary: { found: false, bad_shape: true },
    }
  }
  const paths = await runTemplate(db, template, anchor.entity_id, { maxDepth: depth })
  const nodes = [...new Set([anchor.entity_id, ...paths.flatMap((p) => p.nodes)])]
  const facts = await entityFacts(db, nodes)
  const names = await db.query<{ id: string; display_name: string }>(
    'select id, display_name from entity where id = any($1::uuid[])', [nodes])

  const header = `${anchor.display_name} — ${anchor.kind}, environment ${anchor.env}\nid: ${anchor.entity_id}`
  const alternatives = anchors.length > 1
    ? `\n\nOther things matching that name: ${anchors.slice(1).map((a) => `${a.display_name} (${a.kind})`).join(', ')}`
    : ''
  const body = [
    renderPaths(paths, anchor.entity_id),
    renderFacts(Object.fromEntries(facts), Object.fromEntries(names.rows.map((r) => [r.id, r.display_name]))),
  ].filter(Boolean).join('\n\n')

  return {
    content: [{ type: 'text' as const, text: `${header}${alternatives}\n\n${body}` }],
    summary: { found: true, kind: anchor.kind, shape: template, paths: paths.length, ambiguous: anchors.length > 1 },
  }
}))

// ── writing ────────────────────────────────────────────────────────────────

server.registerTool('record_observations', {
  title: 'Record what you learned',
  description: [
    'Record durable facts about how these systems fit together, so this and any other',
    'agent knows them next session.',
    '',
    'WHAT IS WORTH RECORDING: anything that crosses a repository boundary (this client',
    'calls that service; this route is defined over there), how data actually flows',
    '(reads this cache, falls back to that database), what things are built from',
    '(language, framework, build tool), what a thing is FOR (implements a capability,',
    'handles a kind of data), and what provisions or monitors infrastructure.',
    '',
    'WHAT IS NOT: the body of a function, anything a refactor invalidates next week,',
    'or a dump of every dependency in a lockfile. Facts should still be true in a year.',
    '',
    'You do not need ids - use names as you would say them, and they are resolved for',
    'you. Supplying identifiers (git_remote, arn, tf_address) makes that resolution',
    'exact instead of a guess, so prefer it whenever you know one.',
    '',
    'Never blocks: an unknown predicate is stored and queued rather than rejected.',
    'A literal containing a credential IS rejected - record where a secret lives, never',
    'its value.',
  ].join('\n'),
  inputSchema: {
    observations: z.array(observation).min(1),
    repo: z.string().optional().describe('Default repo for evidence in this batch'),
    commit: z.string().optional(),
    env: z.string().optional().describe('prod | staging | dev. Keeps environments from merging into one another.'),
    session: z.string().optional(),
    confidence: z.number().min(0).max(1).optional().describe('Default confidence for the batch'),
    idempotency_key: z.string().optional(),
  },
}, trace('record_observations', async (args: any) => {
  const result = await ingest(db, {
    session: args.session,
    agent: 'mcp-agent',
    repo: args.repo,
    commit: args.commit,
    env: args.env,
    method: 'llm_inferred',
    idempotency_key: args.idempotency_key,
    observations: args.observations.map((o: any) => ({
      ...o,
      confidence: o.confidence ?? args.confidence,
    })) as any,
  })
  const predicates: Record<string, number> = {}
  for (const o of result.results) {
    if (o.predicate) predicates[o.predicate] = (predicates[o.predicate] ?? 0) + 1
  }
  return {
    content: [{ type: 'text' as const, text: renderIngest(result) }],
    summary: {
      accepted: result.accepted,
      rejected: result.rejected,
      replayed: Boolean(result.replayed),
      predicates,
      unmapped: result.results.filter((o) => o.predicate_unmapped).map((o) => o.predicate),
      minted: result.results.filter((o) => o.subject?.minted || (o.object && 'minted' in o.object && o.object.minted)).length,
      with_identifiers: args.observations.filter((o: any) => o.subject_identifiers?.length || o.object_identifiers?.length).length,
      with_evidence: args.observations.filter((o: any) => o.evidence?.length).length,
      with_span_text: args.observations.filter((o: any) => o.evidence?.some((e: any) => e.span_text)).length,
      errors: result.results.filter((o) => !o.accepted).map((o) => (o.error ?? '').slice(0, 120)),
    },
  }
}))

server.registerTool('record_statement', {
  title: 'Record something the user said',
  description: [
    'Record knowledge the user stated directly, in their own words.',
    '',
    'Use this when the user tells you how something works rather than you inferring it -',
    '"the new client is Angular and replaces the React one", "billing-service reads from',
    'billing-db". It is recorded as human-stated, which the graph trusts more highly than',
    'anything you infer from code.',
    '',
    'Negation works: "the client no longer uses Webpack" records a contradiction of the',
    'existing claim rather than deleting it, so the disagreement stays visible.',
    '',
    'Anything it cannot parse confidently is returned to you unparsed rather than guessed',
    'at. If that happens, fall back to record_observations with the structure you intend.',
  ].join('\n'),
  inputSchema: {
    text: z.string().describe("What the user said, in their words"),
    repo: z.string().optional(),
    env: z.string().optional(),
    dry_run: z.boolean().optional().describe('Parse and show what would be recorded, without recording'),
  },
}, trace('record_statement', async ({ text, repo, env, dry_run }: any) => {
  const r = await tell(db, { text, repo, env, agent: 'user (relayed)', dryRun: dry_run })
  const lines: string[] = []
  if (!r.claims.length) {
    lines.push('Could not confidently parse that into claims. Nothing recorded.')
    lines.push('Use record_observations to state it structurally instead.')
  } else {
    lines.push(dry_run ? 'Would record:' : 'Recorded (as stated by the user):')
    for (const c of r.claims) {
      lines.push(`  ${c.subject} --[${c.predicate}]--> ${c.object}${c.polarity ? '' : '   [REFUTES the existing claim]'}`)
    }
  }
  for (const u of r.unparsed) lines.push(`  not understood, ignored: "${u}"`)
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    summary: {
      claims: r.claims.length,
      unparsed: r.unparsed.length,
      refutations: r.claims.filter((c) => !c.polarity).length,
      predicates: r.claims.map((c) => c.predicate),
      chars: text.length,
    },
  }
}))

server.registerTool('load_context', {
  title: 'Load the detailed context for one thing',
  description: [
    'Get the dense, current detail about a component, module or service - props,',
    'variants, sub-components, usage, gotchas.',
    '',
    'The graph holds only what crosses a boundary: that a component exists, roughly',
    'what it does, and where it lives. Detail that changes every sprint lives in a',
    'context file NEXT TO THE CODE, so version control keeps it current. This tool',
    'follows the pointer and loads it on demand.',
    '',
    'Call this when the user moves from "does something like this exist?" to "how do',
    'I actually use it?" - especially about code in a project they are not currently',
    'working in.',
    '',
    'Every outcome is useful, so call it rather than guessing:',
    '  loaded           - here is the detail, plus how many commits behind it is',
    '  no_context_file  - here is the source path; read it, or offer to write context',
    '  repo_not_local   - here is the URL; the repo is not on this machine',
    '  path_missing     - the recorded location is stale; the thing moved',
    '',
    'If the context is several commits behind the code it describes, say so rather',
    'than presenting it as current.',
  ].join('\n'),
  inputSchema: {
    name: z.string().describe('The component, module or service to load context for'),
    max_chars: z.number().int().min(500).max(40000).optional()
      .describe('Truncate the body at this length. Default 8000.'),
  },
}, trace('load_context', async ({ name, max_chars }: any) => {
  const r = await loadContext(db, name, { maxChars: max_chars })
  const parts: string[] = [r.message]
  if (r.sourcePath) parts.push(`Source: ${r.sourcePath}${r.browseUrl ? `  (${r.browseUrl})` : ''}`)
  if (r.content) parts.push('---', r.content)
  return {
    content: [{ type: 'text' as const, text: parts.join('\n\n') }],
    isError: false,
    summary: {
      status: r.status,
      kind: r.entity?.kind ?? null,
      commits_behind: r.freshness?.commitsBehind ?? null,
      freshness_checked: r.freshness?.checked ?? false,
      truncated: Boolean(r.truncated),
      body_chars: r.content?.length ?? 0,
    },
  }
}))

// ── the learning loop ──────────────────────────────────────────────────────

server.registerTool('pending_questions', {
  title: 'What the graph is missing',
  description: [
    'Things the graph knows it does not know, ranked by how much answering would',
    'connect. Ask the user at most one or two, when it fits naturally into what you are',
    'already doing - not as an interrogation.',
    '',
    'The highest-value ones join two repositories: a route called in one repo whose',
    'definition nobody has recorded, or two names that might be the same thing.',
    '',
    'Record what the user says back with answer_question.',
  ].join('\n'),
  inputSchema: {
    budget: z.number().int().min(1).max(10).optional().describe('How many to return. Default 2.'),
    near: z.string().optional().describe('Prefer questions about this repo or project, if you are working in one'),
  },
}, trace('pending_questions', async ({ budget, near }: any) => {
  await maintain(db)
  const gaps = await askableQuestions(db, { budget: budget ?? 2, near })
  const total = (await knowledgeGaps(db)).length
  const text = renderGaps(gaps) + (total > gaps.length ? `\n(${total - gaps.length} lower-value gaps held back.)` : '')
  return {
    content: [{ type: 'text' as const, text }],
    summary: { returned: gaps.length, total_open: total, kinds: gaps.map((g) => g.gap_kind) },
  }
}))

server.registerTool('answer_question', {
  title: 'Record an answer',
  description: [
    'Record the user\'s answer to a question from pending_questions.',
    '',
    'Because the question is known, short answers work: "yes" confirms two records are',
    'the same thing and joins them, "no" records them as permanently different so it is',
    'never asked again, and a bare value ("common-service", "TypeScript and SCSS") is',
    'understood in the context of what was asked.',
  ].join('\n'),
  inputSchema: {
    gap_kind: z.string().describe('From pending_questions'),
    entity_id: z.string().describe('From pending_questions'),
    answer: z.string().describe("The user's answer, in their words"),
  },
}, trace('answer_question', async ({ gap_kind, entity_id, answer }: any) => {
  await maintain(db)
  const gap = (await knowledgeGaps(db)).find((g) => g.gap_kind === gap_kind && g.entity_id === entity_id)
  if (!gap) {
    return {
      content: [{ type: 'text' as const, text: 'That question is no longer open — it may have been answered already. Call pending_questions for the current list.' }],
      isError: true,
      summary: { gap_kind, stale: true },
    }
  }
  const result = await answerGap(db, gap, answer)
  const text = result.understood
    ? `Recorded: ${result.action}${result.detail ? `\n${JSON.stringify(result.detail, null, 2)}` : ''}`
    : `Not understood: ${result.action}. Ask the user to clarify, or use record_observations directly.`
  return {
    content: [{ type: 'text' as const, text }],
    isError: !result.understood,
    summary: { gap_kind, understood: result.understood, action: result.action, answer_chars: answer.length },
  }
}))

  return server
}
