import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, trustOf } from './helpers.ts'
import { ingest } from '../src/store/observations.ts'
import { sweepScope } from '../src/store/sweep.ts'
import { markDistinct, merge, unmerge } from '../src/resolver/entity_resolver.ts'
import { runTemplate } from '../src/query/traverse.ts'

test('the same edge asserted twice collapses to one proposition with two assertions', async () => {
  const db = await freshDb()
  const obs = { subject: 'svc-a', subject_kind: 'service', predicate: 'reads_from', object: 'db-x', object_kind: 'datastore' }

  const first = await ingest(db, { agent: 'agent-1', method: 'llm_inferred', observations: [obs] })
  const second = await ingest(db, { agent: 'agent-2', method: 'code_derived', observations: [obs] })

  assert.equal(first.results[0]!.proposition_id, second.results[0]!.proposition_id,
    'identical edges must share one content-addressed proposition')

  const props = await db.query<{ n: string }>(`select count(*)::text as n from proposition where predicate = 'reads_from'`)
  assert.equal(Number(props.rows[0]!.n), 1)

  const support = await db.query<{ support_count: number }>(
    'select support_count from edge_now where proposition_id = $1', [first.results[0]!.proposition_id])
  assert.equal(Number(support.rows[0]!.support_count), 2, 'corroboration is a count, not a fuzzy match')
  await db.close()
})

test('corroboration from independent methods raises trust above a single assertion', async () => {
  const db = await freshDb()
  const solo = await ingest(db, { agent: 'a', method: 'code_derived', observations: [
    { subject: 's1', subject_kind: 'service', predicate: 'reads_from', object: 'd1', object_kind: 'datastore' }] })

  const pairA = await ingest(db, { agent: 'a', method: 'code_derived', observations: [
    { subject: 's2', subject_kind: 'service', predicate: 'reads_from', object: 'd2', object_kind: 'datastore' }] })
  await ingest(db, { agent: 'b', method: 'telemetry', observations: [
    { subject: 's2', subject_kind: 'service', predicate: 'reads_from', object: 'd2', object_kind: 'datastore' }] })

  const soloTrust = await trustOf(db, solo.results[0]!.proposition_id!)
  const pairTrust = await trustOf(db, pairA.results[0]!.proposition_id!)
  assert.ok(pairTrust > soloTrust, `two methods (${pairTrust}) should beat one (${soloTrust})`)
  await db.close()
})

test('a refutation lowers trust on the edge it contradicts', async () => {
  const db = await freshDb()
  const claim = { subject: 'svc-c', subject_kind: 'service', predicate: 'reads_from', object: 'redis-e', object_kind: 'cache' }
  const r = await ingest(db, { agent: 'writer', method: 'llm_inferred', observations: [claim] })
  const before = await trustOf(db, r.results[0]!.proposition_id!)

  // The verification agent disagrees.
  await ingest(db, { agent: 'verifier', method: 'verifier', observations: [{ ...claim, polarity: false }] })
  const after = await trustOf(db, r.results[0]!.proposition_id!)

  assert.ok(after < before, `refutation must lower trust (${before} -> ${after})`)
  const counts = await db.query<{ refute_count: number }>(
    'select refute_count from edge_now where proposition_id = $1', [r.results[0]!.proposition_id])
  assert.equal(Number(counts.rows[0]!.refute_count), 1)
  await db.close()
})

test('a functional predicate closes the previous value instead of accumulating', async () => {
  const db = await freshDb()
  await ingest(db, { method: 'code_derived', observations: [
    { subject: 'svc', subject_kind: 'service', predicate: 'lives_in_repo', object: 'old-repo', object_kind: 'repo' }] })
  await ingest(db, { method: 'code_derived', observations: [
    { subject: 'svc', subject_kind: 'service', predicate: 'lives_in_repo', object: 'new-repo', object_kind: 'repo' }] })

  const live = await db.query<{ object_literal: string | null; object: string }>(
    `select ec.object from edges_canon(now()) ec where ec.predicate = 'lives_in_repo'`)
  assert.equal(live.rows.length, 1, 'only the current repo should remain live')

  const names = await db.query<{ display_name: string }>(
    `select e.display_name from edges_canon(now()) ec join entity e on e.id = ec.object where ec.predicate = 'lives_in_repo'`)
  assert.equal(names.rows[0]!.display_name, 'new-repo')
  await db.close()
})

test('a scope sweep closes edges a later run did not re-assert (Redis -> Memcached)', async () => {
  const db = await freshDb()
  const scope = 'gitlab:99@static-scan'

  await ingest(db, { method: 'code_derived', scope_key: scope, observations: [
    { subject: 'svc', subject_kind: 'service', predicate: 'caches_in', object: 'redis', object_kind: 'cache' }] })

  let live = await db.query<{ n: string }>(`select count(*)::text as n from edge_now where predicate = 'caches_in'`)
  assert.equal(Number(live.rows[0]!.n), 1)

  // Second scan: the service migrated. Redis is simply absent from the new snapshot.
  await new Promise((r) => setTimeout(r, 10))
  const runStart = new Date()
  await new Promise((r) => setTimeout(r, 10))
  await ingest(db, { method: 'code_derived', scope_key: scope, observations: [
    { subject: 'svc', subject_kind: 'service', predicate: 'caches_in', object: 'memcached', object_kind: 'cache' }] })
  const closed = await sweepScope(db, scope, runStart)

  assert.equal(closed, 1, 'the un-reasserted Redis edge must be closed')
  const after = await db.query<{ display_name: string }>(
    `select e.display_name from edge_now ec join entity e on e.id = ec.object_entity where ec.predicate = 'caches_in'`)
  assert.deepEqual(after.rows.map((r) => r.display_name), ['memcached'],
    'trust decay alone would have left the stale Redis edge traversable')
  await db.close()
})

test('the same name in different environments never becomes one entity', async () => {
  const db = await freshDb()
  await ingest(db, { env: 'prod', method: 'human', observations: [
    { subject: 'notifications-db', subject_kind: 'datastore', predicate: 'deployed_to', object: 'aws-prod', object_kind: 'cloud_resource' }] })
  await ingest(db, { env: 'staging', method: 'human', observations: [
    { subject: 'notifications-db', subject_kind: 'datastore', predicate: 'deployed_to', object: 'aws-staging', object_kind: 'cloud_resource' }] })

  const r = await db.query<{ n: string }>(
    `select count(*)::text as n from entity where kind = 'datastore' and display_name = 'notifications-db'`)
  assert.equal(Number(r.rows[0]!.n), 2, 'prod and staging must stay separate entities')
  await db.close()
})

test('merge is refused across environments and when a pair is marked distinct', async () => {
  const db = await freshDb()
  await ingest(db, { env: 'prod', method: 'human', observations: [
    { subject: 'cache', subject_kind: 'cache', predicate: 'deployed_to', object: 'aws-prod', object_kind: 'cloud_resource' }] })
  await ingest(db, { env: 'staging', method: 'human', observations: [
    { subject: 'cache', subject_kind: 'cache', predicate: 'deployed_to', object: 'aws-staging', object_kind: 'cloud_resource' }] })

  const ids = await db.query<{ id: string; env: string }>(
    `select id, env from entity where kind = 'cache' order by env`)
  const [prod, staging] = [ids.rows.find((r) => r.env === 'prod')!, ids.rows.find((r) => r.env === 'staging')!]

  await assert.rejects(() => merge(db, staging.id, prod.id), /across environments/)

  await markDistinct(db, staging.id, prod.id, 'different environments')
  await assert.rejects(() => merge(db, staging.id, prod.id), /entity_distinct|across environments/)
  await db.close()
})

test('a merge is revertible because assertions are never rewritten', async () => {
  const db = await freshDb()
  await ingest(db, { method: 'human', observations: [
    { subject: 'alpha', subject_kind: 'service', predicate: 'reads_from', object: 'db', object_kind: 'datastore' }] })
  await ingest(db, { method: 'human', observations: [
    { subject: 'alpha-service', subject_kind: 'service', predicate: 'writes_to', object: 'db', object_kind: 'datastore' }] })

  const ents = await db.query<{ id: string; display_name: string }>(
    `select id, display_name from entity where kind = 'service' order by display_name`)
  const [a, b] = [ents.rows[0]!, ents.rows[1]!]

  await merge(db, b.id, a.id, { reason: 'same service, two names' })
  const merged = await db.query<{ n: string }>(
    `select count(distinct subject)::text as n from edges_canon(now()) where predicate in ('reads_from','writes_to')`)
  assert.equal(Number(merged.rows[0]!.n), 1, 'after merge both edges share one canonical subject')

  const m = await db.query<{ id: number }>('select id from entity_merge order by id desc limit 1')
  await unmerge(db, m.rows[0]!.id)
  const split = await db.query<{ n: string }>(
    `select count(distinct subject)::text as n from edges_canon(now()) where predicate in ('reads_from','writes_to')`)
  assert.equal(Number(split.rows[0]!.n), 2, 'unmerge restores both subjects untouched')
  await db.close()
})

test('an unknown predicate is accepted and queued, never rejected', async () => {
  const db = await freshDb()
  const r = await ingest(db, { method: 'llm_inferred', observations: [
    { subject: 'svc', subject_kind: 'service', predicate: 'frobnicates', object: 'thing', object_kind: 'datastore' }] })

  assert.equal(r.results[0]!.accepted, true, 'an agent that gets a 400 stops writing forever')
  assert.equal(r.results[0]!.predicate_unmapped, true)
  const queued = await db.query<{ raw: string; hits: number }>(
    `select raw, hits from predicate_alias where raw = 'frobnicates'`)
  assert.equal(queued.rows[0]!.raw, 'frobnicates')
  await db.close()
})

test('a known alias is normalised onto the canonical predicate', async () => {
  const db = await freshDb()
  const r = await ingest(db, { method: 'llm_inferred', observations: [
    { subject: 'svc', subject_kind: 'service', predicate: 'queries', object: 'db', object_kind: 'datastore' }] })
  assert.equal(r.results[0]!.predicate, 'reads_from')
  assert.equal(r.results[0]!.predicate_unmapped, false)
  await db.close()
})

test('a literal containing a credential is refused', async () => {
  const db = await freshDb()
  const r = await ingest(db, { method: 'llm_inferred', observations: [
    { subject: 'db', subject_kind: 'datastore', predicate: 'connect_via',
      object_literal: 'postgresql://admin:hunter2@db.internal:5432/app' }] })

  assert.equal(r.results[0]!.accepted, false)
  assert.match(r.results[0]!.error ?? '', /credential/i)
  await db.close()
})

test('descriptive qualifiers become claims about the edge, identifying ones do not fork it', async () => {
  const db = await freshDb()
  const base = {
    subject: 'svc-c', subject_kind: 'service', predicate: 'reads_from',
    object: 'redis', object_kind: 'cache',
  }
  const first = await ingest(db, { method: 'human', observations: [
    { ...base, qualifiers: { role: 'cache', key_pattern: 'notif:*', ttl_seconds: 60 } }] })
  // Changing a DESCRIPTIVE qualifier must supersede a value, not fork the edge.
  const second = await ingest(db, { method: 'human', observations: [
    { ...base, qualifiers: { role: 'cache', key_pattern: 'notif:*', ttl_seconds: 120 } }] })
  assert.equal(first.results[0]!.proposition_id, second.results[0]!.proposition_id)

  // Changing an IDENTIFYING qualifier is genuinely a different edge.
  const third = await ingest(db, { method: 'human', observations: [
    { ...base, qualifiers: { role: 'cache', key_pattern: 'session:*' } }] })
  assert.notEqual(first.results[0]!.proposition_id, third.results[0]!.proposition_id)

  const ttl = await db.query<{ value: string }>(
    `select value from prop_annotations(now()) where predicate = 'ttl_seconds'`)
  assert.equal(ttl.rows.length, 1, 'ttl_seconds is functional: one live value')
  assert.equal(ttl.rows[0]!.value, '120')
  await db.close()
})

test('a derived fallback edge is only traversable via the read it belongs to', async () => {
  const db = await freshDb()
  // Service C reads the cache and falls back to the database.
  // Service B merely touches the same cache - it must NOT inherit the fallback.
  const r = await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'Service C', subject_kind: 'service', predicate: 'reads_from',
      object: 'Redis E', object_kind: 'cache', qualifiers: { role: 'cache' } },
    { about: 0, predicate: 'falls_back_to', object: 'notif-db', object_kind: 'datastore' },
    { subject: 'Service B', subject_kind: 'service', predicate: 'caches_in',
      object: 'Redis E', object_kind: 'cache' },
  ] })
  assert.equal(r.rejected, 0)

  const svcB = await db.query<{ id: string }>(`select id from entity where display_name = 'Service B'`)
  const svcC = await db.query<{ id: string }>(`select id from entity where display_name = 'Service C'`)

  const fromC = await runTemplate(db, 'data_provenance', svcC.rows[0]!.id)
  assert.ok(fromC.some((p) => p.steps.some((s) => s.predicate === 'falls_back_to')),
    'the service that owns the fallback must reach the database')

  const fromB = await runTemplate(db, 'data_provenance', svcB.rows[0]!.id)
  assert.ok(!fromB.some((p) => p.steps.some((s) => s.predicate === 'falls_back_to')),
    'a service sharing the cache must NOT inherit another service\'s fallback')
  await db.close()
})

test('as_of returns what was believed at a past moment', async () => {
  const db = await freshDb()
  const before = new Date()
  await new Promise((r) => setTimeout(r, 20))
  await ingest(db, { method: 'human', observations: [
    { subject: 'svc', subject_kind: 'service', predicate: 'reads_from', object: 'db', object_kind: 'datastore' }] })

  const svc = await db.query<{ id: string }>(`select id from entity where display_name = 'svc'`)
  const now = await runTemplate(db, 'data_provenance', svc.rows[0]!.id)
  const then = await runTemplate(db, 'data_provenance', svc.rows[0]!.id, { at: before })
  assert.ok(now.length > 0)
  assert.equal(then.length, 0, 'the edge did not exist yet at `before`')
  await db.close()
})

test('idempotency key replays instead of double-writing', async () => {
  const db = await freshDb()
  const env = {
    idempotency_key: 'batch-1', method: 'human' as const,
    observations: [{ subject: 'a', subject_kind: 'service', predicate: 'calls', object: 'b', object_kind: 'service' }],
  }
  await ingest(db, env)
  const again = await ingest(db, env)
  assert.equal(again.replayed, true)
  const n = await db.query<{ n: string }>('select count(*)::text as n from assertion')
  assert.equal(Number(n.rows[0]!.n), 1)
  await db.close()
})
