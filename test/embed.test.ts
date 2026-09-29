import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { freshDb } from './helpers.ts'
import { ingest } from '../src/store/observations.ts'
import { buildProfiles, cosine, indexEmbeddings, type Embedder } from '../src/embed/index.ts'
import { findSimilar, resetVectorCache } from '../src/embed/search.ts'
import { findAnchors, ask } from '../src/query/ask.ts'
import { createMcpServer } from '../src/mcp/server.ts'

/**
 * A deterministic stand-in for the real model: a bag-of-words vector over a small
 * vocabulary. Real enough that cosine behaves properly, and it means the suite
 * never downloads a model or depends on one staying available.
 */
const VOCAB = ['date', 'range', 'start', 'end', 'calendar', 'search', 'query', 'type',
  'text', 'input', 'button', 'click', 'notification', 'list', 'user']

const stub: Embedder = {
  id: 'stub-bow-v1',
  dims: VOCAB.length,
  async embed(texts) {
    return texts.map((t) => {
      const words = t.toLowerCase().split(/[^a-z]+/)
      const v = VOCAB.map((w) => words.filter((x) => x === w || x === `${w}s`).length)
      const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
      return v.map((x) => x / mag)
    })
  },
}

async function seedComponents(db: any) {
  await ingest(db, {
    method: 'code_derived', env: 'prod', repo: 'ui',
    observations: [
      { subject: 'DateRangePicker', subject_kind: 'component', predicate: 'note',
        object_literal: 'Pick a start and end date with a calendar' },
      { subject: 'SearchField', subject_kind: 'component', predicate: 'note',
        object_literal: 'Type a search query as text input' },
      { subject: 'SubmitButton', subject_kind: 'component', predicate: 'note',
        object_literal: 'A button the user can click' },
    ],
  })
}

test('cosine behaves', () => {
  assert.equal(cosine([1, 0], [1, 0]).toFixed(3), '1.000')
  assert.equal(cosine([1, 0], [0, 1]).toFixed(3), '0.000')
  assert.ok(cosine([1, 1], [1, 0]) > 0.7)
})

test('a profile carries the prose, not just the name', async () => {
  const db = await freshDb()
  await seedComponents(db)
  await ingest(db, { method: 'code_derived', env: 'prod', observations: [
    { subject: 'DateRangePicker', subject_kind: 'component', predicate: 'part_of',
      object: '@acme/library-b', object_kind: 'package' }] })

  const profiles = await buildProfiles(db, ['component'])
  const drp = profiles.find((p) => p.name === 'DateRangePicker')!
  assert.match(drp.profile, /Pick a start and end date/, 'the description is the useful part')
  assert.match(drp.profile, /part of @acme\/library-b/, 'and a little structural context')
  await db.close()
})

test('describing behaviour finds the thing whose name you did not know', async () => {
  const db = await freshDb()
  await seedComponents(db)
  await indexEmbeddings(db, stub)

  const hits = await findSimilar(db, stub, 'let the user choose a start and end date', { kinds: ['component'] })
  assert.equal(hits[0]?.name, 'DateRangePicker')
  assert.ok(hits[0]!.score > (hits[1]?.score ?? 0))

  const other = await findSimilar(db, stub, 'somewhere to type a search query', { kinds: ['component'] })
  assert.equal(other[0]?.name, 'SearchField')
  await db.close()
})

test('re-indexing only pays for what changed', async () => {
  const db = await freshDb()
  await seedComponents(db)
  const first = await indexEmbeddings(db, stub)
  assert.equal(first.embedded, first.considered)

  const second = await indexEmbeddings(db, stub)
  assert.equal(second.embedded, 0, 'nothing changed, nothing re-embedded')
  assert.equal(second.unchanged, first.considered)

  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'SubmitButton', subject_kind: 'component', predicate: 'note',
      object_literal: 'Now with a loading spinner' }] })
  const third = await indexEmbeddings(db, stub)
  assert.equal(third.embedded, 1, 'only the description that moved')
  await db.close()
})

test('a forced re-index rebuilds everything', async () => {
  const db = await freshDb()
  await seedComponents(db)
  await indexEmbeddings(db, stub)
  const forced = await indexEmbeddings(db, stub, { force: true })
  assert.equal(forced.embedded, forced.considered)
  await db.close()
})

test('search works with no pgvector, which is what PGlite has', async () => {
  const db = await freshDb()
  resetVectorCache()
  const has = await db.query<{ has: boolean }>('select has_pgvector() as has')
  assert.equal(has.rows[0]!.has, false, 'this suite exercises the in-process path on purpose')

  await seedComponents(db)
  await indexEmbeddings(db, stub)
  const hits = await findSimilar(db, stub, 'start and end date', { kinds: ['component'] })
  assert.equal(hits[0]?.name, 'DateRangePicker')
  await db.close()
})

test('an exact name match always beats a semantic one', async () => {
  const db = await freshDb()
  await seedComponents(db)
  await indexEmbeddings(db, stub)

  // The question names SubmitButton outright, and also describes a date range.
  const anchors = await findAnchors(db, 'what about SubmitButton for picking a date range', 5, { embedder: stub })
  assert.equal(anchors[0]?.display_name, 'SubmitButton')
  assert.notEqual(anchors[0]?.matched, 'semantic', 'naming a thing must not be overridden by resemblance')
  await db.close()
})

test('semantics only step in when nothing is named', async () => {
  const db = await freshDb()
  await seedComponents(db)
  await indexEmbeddings(db, stub)

  const without = await findAnchors(db, 'anything for choosing a start and end date', 5)
  assert.equal(without.length, 0, 'no embedder, no match — the old behaviour is unchanged')

  const withEmb = await findAnchors(db, 'anything for choosing a start and end date', 5, { embedder: stub })
  assert.equal(withEmb[0]?.display_name, 'DateRangePicker')
  assert.equal(withEmb[0]?.matched, 'semantic', 'labelled, so ranking can still prefer certainty')
  await db.close()
})

test('a rescued anchor still hands off to structural traversal', async () => {
  const db = await freshDb()
  await seedComponents(db)
  await ingest(db, { method: 'code_derived', env: 'prod', observations: [
    { subject: 'DateRangePicker', subject_kind: 'component', predicate: 'part_of',
      object: '@acme/library-b', object_kind: 'package' },
    { subject: '@acme/library-b', subject_kind: 'package', predicate: 'lives_in_repo',
      object: 'ui', object_kind: 'repo' }] })
  await indexEmbeddings(db, stub)

  const r = await ask(db, 'is there anything for choosing a start and end date', { embedder: stub })
  assert.equal(r.anchor?.display_name, 'DateRangePicker')
  assert.ok(r.paths.length > 0, 'embeddings choose where to start; the graph does the rest')
  assert.ok(r.paths.some((p) => p.steps.some((s) => s.object_name === '@acme/library-b')))
  await db.close()
})

test('searching an unindexed graph says so instead of returning nothing', async () => {
  const db = await freshDb()
  await seedComponents(db)
  const hits = await findSimilar(db, stub, 'anything at all')
  assert.deepEqual(hits, [], 'no embeddings, no guesses')
  await db.close()
})

test('find_similar over MCP describes match strength honestly', async () => {
  const db = await freshDb()
  await seedComponents(db)
  await indexEmbeddings(db, stub)

  const server = createMcpServer(db, stub)
  const [c, s] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(s), client.connect(c)])

  const { tools } = await client.listTools()
  assert.ok(tools.some((t) => t.name === 'find_similar'))
  assert.match(tools.find((t) => t.name === 'find_similar')!.description!,
    /Describe behaviour, not names/)

  const r = await client.callTool({
    name: 'find_similar',
    arguments: { description: 'pick a start and end date', kinds: ['component'] },
  })
  const text = (r as any).content.map((x: any) => x.text).join('\n')
  assert.match(text, /DateRangePicker/)
  assert.match(text, /strong match|moderate match/)
  assert.match(text, /load_context/, 'points at the next step')
  await db.close()
})

test('find_similar on an empty index explains why, rather than shrugging', async () => {
  const db = await freshDb()
  const server = createMcpServer(db, stub)
  const [c, s] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(s), client.connect(c)])

  const r = await client.callTool({ name: 'find_similar', arguments: { description: 'anything' } })
  const text = (r as any).content.map((x: any) => x.text).join('\n')
  assert.match(text, /nothing has been indexed|does not exist yet/)
  await db.close()
})
