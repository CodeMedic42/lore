import type { Db } from '../db/index.ts'
import { Redactor, type Mode } from './redact.ts'
import { knowledgeGaps } from '../query/gaps.ts'
import { maintain } from '../store/maintain.ts'

export interface ReportOptions {
  mode: Mode
  sinceDays?: number
  samples?: number
}

const bar = (n: number, max: number, width = 24) =>
  '█'.repeat(Math.max(0, Math.round((n / Math.max(max, 1)) * width))).padEnd(width, '·')

export async function buildReport(db: Db, opts: ReportOptions): Promise<string> {
  const r = new Redactor(opts.mode)
  const since = `now() - interval '${Math.max(1, opts.sinceDays ?? 30)} days'`
  const samples = opts.samples ?? 25
  const L: string[] = []
  const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows

  await maintain(db).catch(() => {})

  L.push('# Lore — field report')
  L.push('')
  L.push(`Generated: ${new Date().toISOString()}`)
  L.push(`Redaction: **${opts.mode}**${opts.mode === 'redacted' ? ' (names replaced with stable pseudonyms; literals and paths removed)' : ''}`)
  L.push(`Window: last ${opts.sinceDays ?? 30} days · Driver: ${db.driver}`)
  L.push('')

  // ── 1. Did an agent actually use it? ─────────────────────────────────────
  L.push('## 1. Was it used?')
  L.push('')
  const calls = await q(`
    select tool, count(*)::int n, sum(case when ok then 0 else 1 end)::int failures,
           round(avg(duration_ms))::int avg_ms, max(duration_ms)::int max_ms,
           min(at) first_at, max(at) last_at
      from activity where at >= ${since} group by tool order by n desc`)

  if (!calls.length) {
    L.push('**No tool calls recorded in this window.**')
    L.push('')
    L.push('This is the single most important signal, and it is negative: either the MCP')
    L.push('server was never connected, or the agent never chose to call it. Check that')
    L.push('the server is listed in the client, then check whether the tool descriptions')
    L.push('are persuading the model to reach for it.')
  } else {
    const max = Math.max(...calls.map((c) => c.n))
    L.push('| Tool | Calls | Failures | Avg ms | Max ms |')
    L.push('|---|---:|---:|---:|---:|')
    for (const c of calls) {
      L.push(`| \`${c.tool}\` | ${c.n} ${bar(c.n, max, 12)} | ${c.failures} | ${c.avg_ms ?? '-'} | ${c.max_ms ?? '-'} |`)
    }
    L.push('')
    const byDay = await q(`
      select to_char(date_trunc('day', at), 'YYYY-MM-DD') d, count(*)::int n
        from activity where at >= ${since} group by 1 order by 1`)
    if (byDay.length > 1) {
      L.push('Calls per day: ' + byDay.map((d) => `${d.d}:${d.n}`).join('  '))
      L.push('')
    }
    const reads = calls.filter((c) => ['ask_knowledge', 'lookup_entity'].includes(c.tool)).reduce((s, c) => s + c.n, 0)
    const writes = calls.filter((c) => ['record_observations', 'record_statement'].includes(c.tool)).reduce((s, c) => s + c.n, 0)
    L.push(`Reads: ${reads} · Writes: ${writes} · Ratio: ${writes ? (reads / writes).toFixed(1) : '∞'}:1`)
    L.push('')
    L.push('> A read-heavy ratio means the agent is consuming but not contributing;')
    L.push('> write-heavy means it is recording without ever benefiting, which tends to stop.')
  }
  L.push('')

  // ── 2. Fact density: the premise of the whole project ────────────────────
  L.push('## 2. Fact density — does the premise hold?')
  L.push('')
  const [edgeCount] = await q(`select count(*)::int n from edge_now`)
  const crossRepo = await q(`select * from cross_repo_edges(now())`)
  const total = edgeCount?.n ?? 0
  const ratio = total ? (crossRepo.length / total) * 100 : 0
  L.push(`Live edges: **${total}** · Cross-repository edges: **${crossRepo.length}** (${ratio.toFixed(1)}%)`)
  L.push('')
  L.push('> The plan named this as risk #1. Facts that span repositories are the ones a')
  L.push('> single-repo session cannot see, and therefore the only ones that justify a')
  L.push('> shared graph. Below ~10% and the agent is mostly restating what is already in')
  L.push('> front of it, which means importers should be doing the work and agents should')
  L.push('> only be annotating.')
  L.push('')

  // ── 3. What is being recorded ────────────────────────────────────────────
  L.push('## 3. What is being recorded')
  L.push('')
  const byPredicate = await q(`
    select p.predicate, coalesce(pr.family, 'other') family, count(*)::int n
      from edge_now e join proposition p on p.id = e.proposition_id
      left join predicate pr on pr.name = p.predicate
     group by 1,2 order by n desc limit 30`)
  if (byPredicate.length) {
    const max = Math.max(...byPredicate.map((p) => p.n))
    L.push('| Predicate | Family | Count |')
    L.push('|---|---|---:|')
    for (const p of byPredicate) L.push(`| \`${p.predicate}\` | ${p.family} | ${p.n} ${bar(p.n, max, 12)} |`)
    L.push('')
  }
  const byKind = await q(`
    select kind, count(*)::int n, count(*) filter (where provisional)::int provisional
      from entity where canonical_id = id group by 1 order by n desc`)
  L.push('Entities by kind: ' + (byKind.map((k) => `${k.kind}=${k.n}`).join('  ') || '(none)'))
  L.push('')

  const [quality] = await q(`
    select count(*)::int total,
           count(*) filter (where evidence <> '[]'::jsonb)::int with_evidence,
           count(distinct a.id) filter (where ea.span_sha256 is not null)::int with_span,
           count(*) filter (where method = 'llm_inferred')::int inferred,
           count(*) filter (where method = 'human')::int human,
           count(*) filter (where method = 'code_derived')::int derived,
           count(*) filter (where not polarity)::int refutations
      from assertion a left join evidence_anchor ea on ea.assertion_id = a.id`)
  if (quality) {
    L.push(`Assertions: ${quality.total} · with evidence: ${quality.with_evidence} · re-verifiable (span recorded): ${quality.with_span}`)
    L.push(`By source — inferred by agent: ${quality.inferred} · stated by human: ${quality.human} · derived from code: ${quality.derived} · refutations: ${quality.refutations}`)
    L.push('')
  }

  // ── 4. Entity resolution (risk #2) ───────────────────────────────────────
  L.push('## 4. Entity resolution — risk #2')
  L.push('')
  const [res] = await q(`
    select (select count(*) from entity where canonical_id = id)::int total,
           (select count(distinct entity_id) from entity_identifier)::int with_strong,
           (select count(*) from entity where provisional and canonical_id = id)::int provisional,
           (select count(*) from merge_candidate where resolved_at is null)::int open_candidates,
           (select count(*) from entity_merge where reverted_at is null)::int merges,
           (select count(*) from entity_distinct)::int distinctions`)
  const coverage = res.total ? res.with_strong / res.total : 0
  L.push(`Strong-identifier coverage: **${(coverage * 100).toFixed(1)}%** (${res.with_strong}/${res.total})`)
  L.push(`Provisional entities: ${res.provisional} · Open merge candidates: ${res.open_candidates} · Merges applied: ${res.merges} · Recorded as distinct: ${res.distinctions}`)
  L.push('')
  L.push(coverage < 0.6
    ? '> **Below the 60% line.** Resolution is running largely on name similarity, which means\n> duplicate entities and fragmented answers. The fix is supplying `git_remote`,\n> `gitlab_project`, `arn` or `tf_address` when recording.'
    : '> Above the 60% line: most things are pinned by a real identifier rather than a name.')
  L.push('')

  const dupes = await q(`
    select kind, count(*)::int n from (
      select e.kind, regexp_replace(lower(e.display_name), '[^a-z0-9]', '', 'g') norm
        from entity e where e.canonical_id = e.id
       group by 1,2 having count(*) > 1) x group by 1 order by n desc`)
  if (dupes.length) {
    L.push('Possible duplicates after normalisation: ' + dupes.map((d) => `${d.kind}=${d.n}`).join('  '))
    L.push('')
  }

  // ── 5. Vocabulary fit ────────────────────────────────────────────────────
  L.push('## 5. Vocabulary fit')
  L.push('')
  const unmapped = await q(`
    select raw, hits from predicate_alias where maps_to is null order by hits desc, last_seen desc limit 25`)
  if (!unmapped.length) {
    L.push('Every predicate used mapped onto the vocabulary.')
  } else {
    L.push('Predicates used that the vocabulary does not know. These are **not** errors —')
    L.push('they were accepted and stored. A frequent one is a sign the vocabulary is')
    L.push('missing a concept this codebase needs.')
    L.push('')
    L.push('| Raw predicate | Times used |')
    L.push('|---|---:|')
    for (const u of unmapped) L.push(`| \`${u.raw}\` | ${u.hits} |`)
  }
  L.push('')

  // ── 6. Failures ──────────────────────────────────────────────────────────
  L.push('## 6. Failures and rejections')
  L.push('')
  const errors = await q(`
    select tool, error, count(*)::int n from activity
     where not ok and at >= ${since} group by 1,2 order by n desc limit 20`)
  const rejections = await q(`
    select jsonb_array_elements_text(summary->'errors') err, count(*)::int n
      from activity where at >= ${since} and summary ? 'errors'
     group by 1 order by n desc limit 20`)
  if (!errors.length && !rejections.length) {
    L.push('No tool failures or rejected observations in this window.')
  } else {
    for (const e of errors) L.push(`- **${e.tool}** failed ${e.n}×: ${e.error}`)
    for (const e of rejections) L.push(`- observation rejected ${e.n}×: ${e.err}`)
  }
  L.push('')

  // ── 7. Evidence health ───────────────────────────────────────────────────
  L.push('## 7. Evidence health')
  L.push('')
  const anchors = await q(`select state, count(*)::int n from evidence_anchor group by 1 order by n desc`)
  L.push(anchors.length
    ? 'Anchor states: ' + anchors.map((a) => `${a.state}=${a.n}`).join('  ')
    : 'No evidence anchors recorded (nothing supplied `span_text`, so nothing can be auto-re-verified).')
  L.push('')

  // ── 8. Open questions ────────────────────────────────────────────────────
  L.push('## 8. What the graph knows it is missing')
  L.push('')
  const gaps = await knowledgeGaps(db).catch(() => [])
  const byGap = gaps.reduce<Record<string, number>>((acc, g) => ((acc[g.gap_kind] = (acc[g.gap_kind] ?? 0) + 1), acc), {})
  L.push(gaps.length
    ? Object.entries(byGap).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join('  ')
    : 'No gaps detected (which, on a real codebase, probably means very little has been recorded yet).')
  L.push('')
  const answered = await q(`
    select count(*)::int n from activity where tool = 'answer_question' and ok and at >= ${since}`)
  const asked = await q(`select count(*)::int n from activity where tool = 'pending_questions' and at >= ${since}`)
  L.push(`Questions fetched: ${asked[0]?.n ?? 0} · Answers recorded: ${answered[0]?.n ?? 0}`)
  L.push('')

  // ── 9. Sample of what was recorded ───────────────────────────────────────
  if (opts.mode !== 'stats') {
    L.push('## 9. Sample of recorded facts')
    L.push('')
    L.push(opts.mode === 'redacted'
      ? '_Names are stable pseudonyms; the same service reads the same throughout._'
      : '_UNREDACTED — this describes real systems._')
    L.push('')
    const rows = await q(`
      select p.predicate, p.qualifiers,
             se.display_name s_name, se.kind s_kind,
             oe.display_name o_name, oe.kind o_kind,
             p.object_literal, e.trust, a.method,
             (select jsonb_agg(ev) from jsonb_array_elements(a.evidence) ev) ev
        from edge_now e
        join proposition p on p.id = e.proposition_id
        left join entity se on se.id = p.subject_entity
        left join entity oe on oe.id = p.object_entity
        join lateral (select * from assertion x where x.proposition_id = p.id order by x.created_at desc limit 1) a on true
       order by a.created_at desc limit $1`, [samples])

    for (const row of rows) {
      const subj = row.s_name ? r.name(row.s_name, row.s_kind) : '(about another claim)'
      const obj = row.o_name ? r.name(row.o_name, row.o_kind) : r.literal(row.object_literal)
      const quals = r.qualifiers(row.qualifiers)
      L.push(`- \`${subj}\` --[${row.predicate}]--> \`${obj}\`${quals ? ` {${quals}}` : ''} · trust ${Number(row.trust).toFixed(2)} · ${row.method}`)
      const ev = (row.ev ?? [])[0]
      if (ev?.path) L.push(`    evidence: ${r.repo(ev.repo)} ${r.path(ev.path)}${ev.lines ? `:${ev.lines.join('-')}` : ''}`)
    }
    L.push('')
  }

  L.push('---')
  L.push('')
  L.push('### What to look at first')
  L.push('')
  L.push('1. Section 1 — if there are no calls, nothing else matters.')
  L.push('2. Section 2 — the cross-repo percentage decides whether the premise holds.')
  L.push('3. Section 5 — frequent unknown predicates say the vocabulary does not fit this stack.')
  L.push('4. Section 4 — coverage under 60% means answers will fragment as the graph grows.')
  return L.join('\n')
}
