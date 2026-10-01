import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshDb } from './helpers.ts'
import { ingest } from '../src/store/observations.ts'
import { tell } from '../src/store/tell.ts'
import { answerGap } from '../src/store/answers.ts'
import { knowledgeGaps } from '../src/query/gaps.ts'
import { maintain } from '../src/store/maintain.ts'
import { runTemplate } from '../src/query/traverse.ts'
import { resetPhraseCache } from '../src/domain/nl.ts'

test('one sentence can carry several relations', async () => {
  const db = await freshDb()
  resetPhraseCache()
  const r = await tell(db, {
    text: 'the new-client is written in TypeScript and uses Angular, it replaces old-client and is built with Vite',
  })
  const got = r.claims.map((c) => `${c.subject}|${c.predicate}|${c.object}`)
  assert.deepEqual(got, [
    'new-client|written_in|TypeScript',
    'new-client|uses_framework|Angular',
    'new-client|supersedes|old-client',
    'new-client|built_with|Vite',
  ])
  await db.close()
})

test('"it" carries the subject forward', async () => {
  const db = await freshDb()
  resetPhraseCache()
  const r = await tell(db, { text: 'billing-service reads from billing-db. It publishes to invoice-queue' })
  assert.deepEqual(r.claims.map((c) => c.subject), ['billing-service', 'billing-service'])
  assert.deepEqual(r.claims.map((c) => c.predicate), ['reads_from', 'publishes_to'])
  await db.close()
})

test('a negated sentence refutes rather than deletes', async () => {
  const db = await freshDb()
  resetPhraseCache()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'client-x', subject_kind: 'client', predicate: 'built_with',
      object: 'Webpack', object_kind: 'technology' }] })

  const r = await tell(db, { text: 'client-x no longer uses Webpack' })
  assert.equal(r.claims[0]!.polarity, false)
  assert.equal(r.claims[0]!.subject, 'client-x', 'negation words must not leak into the subject')
  // "uses" is ambiguous, so it defers to the relation the graph already holds.
  assert.equal(r.claims[0]!.predicate, 'built_with')

  const edge = await db.query<{ support_count: number; refute_count: number }>(
    `select support_count, refute_count from edge_now e
       join proposition p on p.id = e.proposition_id
       join entity t on t.id = p.object_entity where t.display_name = 'Webpack'`)
  assert.equal(Number(edge.rows[0]!.support_count), 1)
  assert.equal(Number(edge.rows[0]!.refute_count), 1, 'the original claim survives, contradicted')
  await db.close()
})

test('unrecognisable text is reported, never invented', async () => {
  const db = await freshDb()
  resetPhraseCache()
  const r = await tell(db, { text: 'the quarterly roadmap is looking quite ambitious this time around' })
  assert.equal(r.claims.length, 0)
  assert.equal(r.unparsed.length, 1)
  await db.close()
})

test('dry run shows what would be recorded without recording it', async () => {
  const db = await freshDb()
  resetPhraseCache()
  const r = await tell(db, { text: 'svc-a reads from db-b', dryRun: true })
  assert.equal(r.claims.length, 1)
  assert.equal(r.ingest, undefined)
  const n = await db.query<{ n: string }>('select count(*)::text n from assertion')
  assert.equal(Number(n.rows[0]!.n), 0)
  await db.close()
})

/** A client calling a route, and a service serving it, recorded separately. */
async function seedSplitRoute(db: any) {
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'web-client', subject_kind: 'client', predicate: 'calls',
      object: 'GET {svc}/v1/things', object_kind: 'endpoint',
      qualifiers: { path: '/v1/things', method: 'GET' } },
    { subject: 'thing-service', subject_kind: 'service', predicate: 'exposes_endpoint',
      object: 'GET /v1/things', object_kind: 'endpoint',
      qualifiers: { path: '/v1/things', method: 'GET' } },
    { subject: 'thing-service', subject_kind: 'service', predicate: 'reads_from',
      object: 'thing-db', object_kind: 'datastore' },
  ] })
  await maintain(db)
}

test('confirming a proposed join connects two repositories', async () => {
  const db = await freshDb()
  resetPhraseCache()
  await seedSplitRoute(db)

  const client = await db.query<{ id: string }>(`select id from entity where display_name = 'web-client'`)
  const before = await runTemplate(db, 'data_provenance', client.rows[0]!.id)
  assert.ok(!before.some((p) => p.steps.some((s) => s.object_name === 'thing-db')),
    'the call site and the route definition start out unconnected')

  const gap = (await knowledgeGaps(db)).find((g) => g.gap_kind === 'dangling_endpoint' && g.suggestion)!
  const res = await answerGap(db, gap, 'yes')
  assert.equal(res.action, 'joined')

  const after = await runTemplate(db, 'data_provenance', client.rows[0]!.id)
  assert.ok(after.some((p) => p.steps.some((s) => s.object_name === 'thing-db')),
    'answering one question traverses from the client all the way to the database')
  await db.close()
})

test('declining a proposed join records the routes as different', async () => {
  const db = await freshDb()
  resetPhraseCache()
  await seedSplitRoute(db)
  const gap = (await knowledgeGaps(db)).find((g) => g.gap_kind === 'dangling_endpoint' && g.suggestion)!
  const res = await answerGap(db, gap, 'no, different systems')
  assert.equal(res.understood, true)

  const n = await db.query<{ n: string }>('select count(*)::text n from entity_distinct')
  assert.ok(Number(n.rows[0]!.n) >= 1, 'the decision is permanent, not re-asked next week')
  await db.close()
})

test('naming the owning project answers a dangling route', async () => {
  const db = await freshDb()
  resetPhraseCache()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'web-client', subject_kind: 'client', predicate: 'calls',
      object: 'GET /v2/session', object_kind: 'endpoint',
      qualifiers: { path: '/v2/session', method: 'GET' } }] })

  const gap = (await knowledgeGaps(db)).find((g) => g.gap_kind === 'dangling_endpoint')!
  assert.equal(gap.suggestion, undefined, 'nothing to propose, so it asks openly')
  const res = await answerGap(db, gap, 'common-service')
  assert.equal(res.understood, true)

  const served = await db.query<{ n: string }>(
    `select count(*)::text n from edges_canon(now()) ec
       join entity s on s.id = ec.subject
      where ec.predicate = 'exposes_endpoint' and s.display_name = 'common-service'`)
  assert.equal(Number(served.rows[0]!.n), 1)
  await db.close()
})

test('a bare list answers "what is this written in"', async () => {
  const db = await freshDb()
  resetPhraseCache()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'mystery-client', subject_kind: 'client', predicate: 'calls',
      object: 'svc', object_kind: 'service' }] })

  const gap = (await knowledgeGaps(db)).find(
    (g) => g.gap_kind === 'unknown_technology' && g.entity_name === 'mystery-client')!
  const res = await answerGap(db, gap, 'JavaScript and SCSS')
  assert.equal(res.understood, true)

  const tech = await db.query<{ display_name: string }>(
    `select t.display_name from edges_canon(now()) ec
       join entity t on t.id = ec.object
      where ec.predicate = 'written_in' order by t.display_name`)
  assert.deepEqual(tech.rows.map((r) => r.display_name), ['JavaScript', 'SCSS'])
  await db.close()
})

test('answering how to connect stores the recipe, and refuses a credential', async () => {
  const db = await freshDb()
  resetPhraseCache()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'svc', subject_kind: 'service', predicate: 'reads_from',
      object: 'main-db', object_kind: 'datastore' }] })

  const gap = (await knowledgeGaps(db)).find((g) => g.gap_kind === 'no_access_info')!
  const ok = await answerGap(db, gap, 'psql -h main.internal -U readonly, over the VPN')
  assert.equal(ok.understood, true)

  const leak = await answerGap(db, gap, 'postgresql://admin:hunter2@main.internal:5432/app')
  assert.equal(leak.understood, false, 'a credential must never be stored')
  await db.close()
})

test('confirming two things are the same merges them', async () => {
  const db = await freshDb()
  resetPhraseCache()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'notifications-svc', subject_kind: 'service', predicate: 'reads_from', object: 'a', object_kind: 'datastore' },
    { subject: 'notification-svc', subject_kind: 'service', predicate: 'reads_from', object: 'b', object_kind: 'datastore' },
  ] })
  const gap = (await knowledgeGaps(db)).find((g) => g.gap_kind === 'name_collision')!
  const res = await answerGap(db, gap, 'yes, same service')
  assert.equal(res.action, 'merged')

  const subjects = await db.query<{ n: string }>(
    `select count(distinct subject)::text n from edges_canon(now()) where predicate = 'reads_from'`)
  assert.equal(Number(subjects.rows[0]!.n), 1)
  await db.close()
})

test('an identifier answer is filed under the right authority', async () => {
  const db = await freshDb()
  resetPhraseCache()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'busy-db', subject_kind: 'datastore', predicate: 'reads_from', object: 'x', object_kind: 'datastore' },
    { subject: 'svc1', subject_kind: 'service', predicate: 'reads_from', object: 'busy-db', object_kind: 'datastore' },
    { subject: 'svc2', subject_kind: 'service', predicate: 'writes_to', object: 'busy-db', object_kind: 'datastore' },
  ] })
  const gap = (await knowledgeGaps(db)).find(
    (g) => g.gap_kind === 'unidentified_entity' && g.entity_name === 'busy-db')!
  const res = await answerGap(db, gap, 'arn:aws:rds:eu-west-1:1111:db:busy')
  assert.equal(res.understood, true)
  assert.equal((res.detail as any).authority, 'arn')
  await db.close()
})

test('an identifier is extracted from a sentence, not stored as one', async () => {
  const { extractIdentifier } = await import('../src/store/answers.ts')
  // Observed verbatim on the first real run.
  const prose = 'It is the @reformjs/reactive package at projects/reactive in the monorepo https://github.com/codemedic42/reform'
  assert.deepEqual(extractIdentifier(prose), {
    authority: 'git_remote', value: 'github.com/codemedic42/reform',
  })
  // Scheme and .git normalise away, so one repo yields one identifier.
  assert.deepEqual(extractIdentifier('https://github.com/codemedic42/reform.git'),
    { authority: 'git_remote', value: 'github.com/codemedic42/reform' })
  assert.deepEqual(extractIdentifier('arn:aws:rds:eu-west-1:1111:db:notifications'),
    { authority: 'arn', value: 'arn:aws:rds:eu-west-1:1111:db:notifications' })
  assert.deepEqual(extractIdentifier('it lives at module.notifications_db in terraform'),
    { authority: 'tf_address', value: 'module.notifications_db' })
  assert.equal(extractIdentifier('I have no idea honestly'), null, 'and asks again rather than storing junk')
})
