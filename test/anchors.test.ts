import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, trustOf } from './helpers.ts'
import { ingest } from '../src/store/observations.ts'
import { checkFileAnchors, reverificationQueue } from '../src/store/anchors.ts'
import { resetAuthorityCache } from '../src/domain/identifiers.ts'

const V1 = `export async function readNotifications(userId) {
  const cached = await redis.get('notif:' + userId)
  if (cached) return JSON.parse(cached)
  return db.query('select * from notifications where user_id = $1', [userId])
}`

const REFORMATTED = `export async function readNotifications(userId) {
    const cached = await redis.get("notif:" + userId);
    if (cached) return JSON.parse(cached);
    return db.query("select * from notifications where user_id = $1", [userId]);
}`

const SHIFTED = `// a new license header\n// another line\n// and another\n${V1}`

const REWRITTEN = `export async function readNotifications(userId) {
  return db.query('select * from notifications where user_id = $1', [userId])
}`

async function seedClaim(db: any) {
  return ingest(db, {
    agent: 'agent-1', method: 'llm_inferred', repo: 'gitlab:1', commit: 'c1',
    observations: [{
      subject: 'Service C', subject_kind: 'service', predicate: 'reads_from',
      object: 'Redis', object_kind: 'cache',
      evidence: [{
        path: 'cache.ts', lines: [1, 5], span_text: V1, enclosing_symbol: 'readNotifications',
      }],
    }],
  })
}

test('a formatter run does not look like a change', async () => {
  const db = await freshDb()
  await seedClaim(db)
  const s = await checkFileAnchors(db, { repo: 'gitlab:1', path: 'cache.ts', content: REFORMATTED })
  assert.equal(s.ok, 1, 'reindenting and requoting must not invalidate evidence')
  assert.equal(s.changed, 0)
  await db.close()
})

test('code that merely shifted stays trusted and heals its line numbers', async () => {
  const db = await freshDb()
  await seedClaim(db)
  const s = await checkFileAnchors(db, { repo: 'gitlab:1', path: 'cache.ts', content: SHIFTED })
  assert.equal(s.shifted, 1)

  const a = await db.query<{ line_from: number; line_to: number; state: string }>(
    'select line_from, line_to, state from evidence_anchor')
  assert.equal(a.rows[0]!.line_from, 4, 'line numbers follow the code')
  assert.equal(a.rows[0]!.state, 'shifted')

  const queue = await reverificationQueue(db)
  assert.equal(queue.length, 0, 'a pure shift must not flood the re-verification queue')
  await db.close()
})

test('genuinely changed code is queued for re-verification', async () => {
  const db = await freshDb()
  await seedClaim(db)
  const s = await checkFileAnchors(db, { repo: 'gitlab:1', path: 'cache.ts', content: REWRITTEN })
  assert.equal(s.changed, 1)
  const queue = await reverificationQueue(db)
  assert.equal(queue.length, 1)
  assert.equal(queue[0]!.state, 'changed')
  assert.equal(queue[0]!.predicate, 'reads_from')
  await db.close()
})

test('a deleted file marks the anchor gone', async () => {
  const db = await freshDb()
  await seedClaim(db)
  const s = await checkFileAnchors(db, { repo: 'gitlab:1', path: 'cache.ts', content: null })
  assert.equal(s.gone, 1)
  assert.equal((await reverificationQueue(db))[0]!.state, 'gone')
  await db.close()
})

test('a broken anchor changes STATE, not trust', async () => {
  const db = await freshDb()
  const r = await seedClaim(db)
  const propId = r.results[0]!.proposition_id!
  const before = await trustOf(db, propId)

  await checkFileAnchors(db, { repo: 'gitlab:1', path: 'cache.ts', content: null })
  const after = await trustOf(db, propId)

  // This is the whole point of change #3: a changed anchor produces a concrete
  // task, not a quiet nudge to an uncalibrated number.
  assert.equal(after, before, 'anchor state must not be multiplied into the trust score')

  const state = await db.query<{ needs_reverification: boolean }>(
    'select needs_reverification from proposition_anchor_state(now()) where proposition_id = $1', [propId])
  assert.equal(state.rows[0]!.needs_reverification, true, 'but it must be visible on the answer')
  await db.close()
})

test('a claim with no span_text warns that it can never be re-verified', async () => {
  const db = await freshDb()
  const r = await ingest(db, {
    method: 'llm_inferred', repo: 'gitlab:1',
    observations: [{
      subject: 'a', subject_kind: 'service', predicate: 'calls', object: 'b', object_kind: 'service',
      evidence: [{ path: 'x.ts', lines: [1, 2] }],
    }],
  })
  assert.match((r.results[0]!.warnings ?? []).join(' '), /cannot be automatically re-verified/)
  await db.close()
})

test('a SCIP symbol unifies two different names for the same code', async () => {
  const db = await freshDb()
  resetAuthorityCache()
  const scip = 'scip-typescript npm @acme/service-c 1.4.0 `src/notifications/cache.ts`/readNotifications().'

  // Two agents, two different names, same underlying symbol.
  await ingest(db, { method: 'code_derived', observations: [{
    subject: 'Service C', subject_kind: 'service', subject_identifiers: [{ authority: 'scip_symbol', value: scip }],
    predicate: 'reads_from', object: 'redis', object_kind: 'cache' }] })
  await ingest(db, { method: 'llm_inferred', observations: [{
    subject: 'notification-service', subject_kind: 'service',
    subject_identifiers: [{ authority: 'scip_symbol', value: scip }],
    predicate: 'writes_to', object: 'pg', object_kind: 'datastore' }] })

  const n = await db.query<{ n: string }>(
    `select count(*)::text as n from entity where kind = 'service'`)
  assert.equal(Number(n.rows[0]!.n), 1,
    'a shared strong identifier resolves two names to one entity without any similarity guess')
  await db.close()
})

test('SCIP symbols differing only in version stay distinct', async () => {
  const db = await freshDb()
  resetAuthorityCache()
  const v1 = 'scip-typescript npm @acme/lib 1.0.0 `src/a.ts`/read().'
  const v2 = 'scip-typescript npm @acme/lib 2.0.0 `src/a.ts`/read().'
  await ingest(db, { method: 'code_derived', observations: [{
    subject: 'read v1', subject_kind: 'service', subject_identifiers: [{ authority: 'scip_symbol', value: v1 }],
    predicate: 'calls', object: 'x', object_kind: 'service' }] })
  await ingest(db, { method: 'code_derived', observations: [{
    subject: 'read v2', subject_kind: 'service', subject_identifiers: [{ authority: 'scip_symbol', value: v2 }],
    predicate: 'calls', object: 'y', object_kind: 'service' }] })
  const n = await db.query<{ n: string }>(
    `select count(distinct entity_id)::text as n from entity_identifier where authority = 'scip_symbol'`)
  assert.equal(Number(n.rows[0]!.n), 2, 'version is part of identity: v1 and v2 are different symbols')
  await db.close()
})

test('a misspelled identifier authority is accepted but warned about', async () => {
  const db = await freshDb()
  resetAuthorityCache()
  const r = await ingest(db, { method: 'code_derived', observations: [{
    subject: 'svc', subject_kind: 'service',
    subject_identifiers: [{ authority: 'gitlab-projekt', value: '4412' }],
    predicate: 'calls', object: 'other', object_kind: 'service' }] })

  assert.equal(r.results[0]!.accepted, true)
  assert.match((r.results[0]!.warnings ?? []).join(' '), /unknown identifier authority/)
  await db.close()
})

test('authority spelling is normalised so identity is not silently split', async () => {
  const db = await freshDb()
  resetAuthorityCache()
  await ingest(db, { method: 'code_derived', observations: [{
    subject: 'svc-one', subject_kind: 'service',
    subject_identifiers: [{ authority: 'gitlab_project', value: '4412' }],
    predicate: 'calls', object: 'a', object_kind: 'service' }] })
  await ingest(db, { method: 'code_derived', observations: [{
    subject: 'totally different name', subject_kind: 'service',
    subject_identifiers: [{ authority: 'GitLab-Project', value: '4412' }],
    predicate: 'calls', object: 'b', object_kind: 'service' }] })

  const n = await db.query<{ n: string }>(
    `select count(*)::text as n from entity where kind = 'service' and display_name in ('svc-one','totally different name')`)
  assert.equal(Number(n.rows[0]!.n), 1, 'GitLab-Project and gitlab_project are the same authority')
  await db.close()
})
