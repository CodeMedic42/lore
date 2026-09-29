import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshDb } from './helpers.ts'
import { ingest } from '../src/store/observations.ts'
import { maintain } from '../src/store/maintain.ts'
import { askableQuestions, joinCandidates, knowledgeGaps } from '../src/query/gaps.ts'
import { ask } from '../src/query/ask.ts'

/** A client calling two routes; only one of them has a known owner. */
async function seedCallGraph(db: any) {
  return ingest(db, {
    method: 'human', env: 'prod',
    observations: [
      { subject: 'notification-client', subject_kind: 'client', predicate: 'calls',
        object: 'GET {svc-url}/v1/notifications', object_kind: 'endpoint',
        qualifiers: { path: '/v1/notifications', method: 'GET' } },
      { subject: 'notifications-service', subject_kind: 'service', predicate: 'exposes_endpoint',
        object: 'GET /v1/notifications', object_kind: 'endpoint',
        qualifiers: { path: '/v1/notifications', method: 'GET' } },
      { subject: 'notification-client', subject_kind: 'client', predicate: 'calls',
        object: 'POST {svc-url}/v1/notifications', object_kind: 'endpoint',
        qualifiers: { path: '/v1/notifications', method: 'POST' } },
    ],
  })
}

test('a called route with no known owner is reported as a gap', async () => {
  const db = await freshDb()
  await seedCallGraph(db)
  const gaps = await knowledgeGaps(db)
  const dangling = gaps.filter((g) => g.gap_kind === 'dangling_endpoint')
  assert.ok(dangling.length >= 2, 'both client-side routes lack a recorded owner')
  assert.match(dangling[0]!.question, /Which project defines|same route as/)
  await db.close()
})

test('a matching route in another repo is proposed as a join', async () => {
  const db = await freshDb()
  await seedCallGraph(db)
  const joins = await joinCandidates(db)
  assert.equal(joins.length, 1, 'GET /v1/notifications matches on both sides')
  assert.equal(joins[0]!.path, '/v1/notifications')
  assert.equal(joins[0]!.served_by_name, 'notifications-service')

  // The gap for that endpoint should now be a yes/no confirmation, not an open question.
  const gap = (await knowledgeGaps(db)).find(
    (g) => g.gap_kind === 'dangling_endpoint' && g.suggestion)
  assert.ok(gap, 'the matching endpoint should carry a proposed answer')
  assert.match(gap!.question, /same route as/)
  await db.close()
})

test('routes differing only by HTTP method are settled without asking', async () => {
  const db = await freshDb()
  await seedCallGraph(db)

  const before = (await knowledgeGaps(db)).filter((g) => g.gap_kind === 'name_collision')
  assert.ok(before.length >= 1, 'GET and POST variants look similar by name')

  const tidied = await maintain(db)
  assert.ok(tidied.endpoints_distinguished >= 1)

  const after = (await knowledgeGaps(db)).filter((g) => g.gap_kind === 'name_collision')
  const methodPair = after.find((g) =>
    /POST/.test(g.entity_name) && /GET/.test(String(g.detail.other_name)))
  assert.equal(methodPair, undefined, 'different HTTP methods are definitively different routes')
  await db.close()
})

test('a pair already covered by a join proposal is not also asked generically', async () => {
  const db = await freshDb()
  await seedCallGraph(db)
  await maintain(db)
  const gaps = await knowledgeGaps(db)
  const joins = await joinCandidates(db)
  const pair = `${joins[0]!.called_endpoint}|${joins[0]!.served_endpoint}`
  const duplicate = gaps.find((g) =>
    g.gap_kind === 'name_collision' && `${g.entity_id}|${g.detail.other_id}` === pair)
  assert.equal(duplicate, undefined, 'the join proposal is the better-phrased version of the same question')
  await db.close()
})

test('a settled pair is never proposed again', async () => {
  const db = await freshDb()
  await seedCallGraph(db)
  await maintain(db)
  await maintain(db) // idempotent
  const collisions = (await knowledgeGaps(db)).filter((g) =>
    /POST/.test(g.entity_name) && /GET/.test(String(g.detail.other_name)))
  assert.equal(collisions.length, 0)
  await db.close()
})

test('two similarly named clients are surfaced rather than merged', async () => {
  const db = await freshDb()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'notification-client', subject_kind: 'client', predicate: 'uses_framework',
      object: 'React', object_kind: 'technology' },
    { subject: 'new-notification-client', subject_kind: 'client', predicate: 'uses_framework',
      object: 'Angular', object_kind: 'technology' },
  ] })

  const n = await db.query<{ n: string }>(`select count(*)::text n from entity where kind = 'client'`)
  assert.equal(Number(n.rows[0]!.n), 2, 'the rewrite must not be merged into the original')

  await maintain(db)
  const collision = (await knowledgeGaps(db)).find((g) => g.gap_kind === 'name_collision')
  assert.ok(collision, 'but the similarity must be raised as a question')
  assert.match(collision!.question, /same thing, or two different ones/)
  await db.close()
})

test('the question budget is small and never repeats an entity', async () => {
  const db = await freshDb()
  await seedCallGraph(db)
  await ingest(db, { method: 'human', observations: [
    { subject: 'orphan-a', subject_kind: 'service', predicate: 'calls', object: 'orphan-b', object_kind: 'service' },
    { subject: 'db-1', subject_kind: 'datastore', predicate: 'handles_data', object: 'stuff', object_kind: 'data_concept' },
  ] })

  const asked = await askableQuestions(db, { budget: 2 })
  assert.ok(asked.length <= 2, 'an assistant that asks five questions a session gets muted')
  assert.equal(new Set(asked.map((g) => g.entity_id)).size, asked.length, 'one question per entity')

  const all = await knowledgeGaps(db)
  assert.ok(all.length > asked.length, 'the rest are held back, not lost')
  await db.close()
})

test('gaps are ranked by how connected the subject is', async () => {
  const db = await freshDb()
  await ingest(db, { method: 'human', observations: [
    // well connected, no technology recorded
    { subject: 'busy-service', subject_kind: 'service', predicate: 'reads_from', object: 'db-a', object_kind: 'datastore' },
    { subject: 'busy-service', subject_kind: 'service', predicate: 'writes_to', object: 'db-b', object_kind: 'datastore' },
    { subject: 'busy-service', subject_kind: 'service', predicate: 'calls', object: 'svc-x', object_kind: 'service' },
    { subject: 'busy-service', subject_kind: 'service', predicate: 'lives_in_repo', object: 'r1', object_kind: 'repo' },
    // barely connected, also no technology recorded
    { subject: 'quiet-service', subject_kind: 'service', predicate: 'lives_in_repo', object: 'r2', object_kind: 'repo' },
  ] })

  const tech = (await knowledgeGaps(db)).filter((g) => g.gap_kind === 'unknown_technology')
  const busy = tech.find((g) => g.entity_name === 'busy-service')!
  const quiet = tech.find((g) => g.entity_name === 'quiet-service')!
  assert.ok(busy.score > quiet.score, 'the same unknown matters more on a well-connected thing')
  await db.close()
})

test('a question about a capability starts at the concept and walks outwards', async () => {
  const db = await freshDb()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'common-service', subject_kind: 'service', predicate: 'implements',
      object: 'authentication', object_kind: 'capability' },
    { subject: 'authentication', subject_kind: 'capability', predicate: 'note',
      object_literal: 'Session tokens issued by common-service.' },
    { subject: 'common-service', subject_kind: 'service', predicate: 'reads_from',
      object: 'session-store', object_kind: 'datastore' },
  ] })

  const result = await ask(db, 'How does authentication work for this client')
  assert.equal(result.template, 'concept_map')
  assert.equal(result.anchor?.kind, 'capability')
  assert.ok(result.paths.some((p) => p.steps.some((s) => s.object_name === 'session-store')),
    'should reach the store behind the capability')
  await db.close()
})

test('a "what X exist" question returns a list, not a path', async () => {
  const db = await freshDb()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'db-cpu-high', subject_kind: 'alert', predicate: 'monitors',
      object: 'notifications-db', object_kind: 'datastore' },
    { subject: 'db-cpu-high', subject_kind: 'alert', predicate: 'note',
      object_literal: 'RDS CPU above 80% for 5 minutes.' },
  ] })

  const result = await ask(db, 'What alerts are set up in AWS')
  assert.equal(result.listing?.kind, 'alert')
  assert.equal(result.listing?.entities.length, 1)
  assert.match(result.listing!.entities[0]!.facts[0]!.value, /RDS CPU/)
  await db.close()
})

test('technology predicates make "what uses X" answerable', async () => {
  const db = await freshDb()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'client-a', subject_kind: 'client', predicate: 'uses_framework', object: 'React', object_kind: 'technology' },
    { subject: 'client-b', subject_kind: 'client', predicate: 'uses_framework', object: 'React', object_kind: 'technology' },
    { subject: 'client-c', subject_kind: 'client', predicate: 'uses_framework', object: 'Angular', object_kind: 'technology' },
  ] })

  const users = await db.query<{ display_name: string }>(
    `select e.display_name from edges_canon(now()) ec
       join entity e on e.id = ec.subject
       join entity t on t.id = ec.object
      where ec.predicate = 'uses_framework' and t.display_name = 'React'
      order by e.display_name`)
  assert.deepEqual(users.rows.map((r) => r.display_name), ['client-a', 'client-b'])
  await db.close()
})

test('natural phrasings map onto the technology vocabulary', async () => {
  const db = await freshDb()
  const r = await ingest(db, { method: 'llm_inferred', observations: [
    { subject: 'x', subject_kind: 'client', predicate: 'bundled_with', object: 'Webpack', object_kind: 'technology' },
    { subject: 'x', subject_kind: 'client', predicate: 'language', object: 'TypeScript', object_kind: 'technology' },
    { subject: 'x', subject_kind: 'client', predicate: 'replaces', object: 'old-x', object_kind: 'client' },
  ] })
  assert.deepEqual(r.results.map((o) => o.predicate), ['built_with', 'written_in', 'supersedes'])
  assert.ok(r.results.every((o) => !o.predicate_unmapped))
  await db.close()
})
