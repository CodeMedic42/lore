import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { freshDb } from './helpers.ts'
import { createMcpServer } from '../src/mcp/server.ts'
import { ingest } from '../src/store/observations.ts'
import { resetPhraseCache } from '../src/domain/nl.ts'
import type { Db } from '../src/db/index.ts'

/** Wire a real MCP client to the real server, in process. */
async function connect(db: Db) {
  const server = createMcpServer(db)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return client
}

const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n')

test('the server advertises the tools an agent needs', async () => {
  const db = await freshDb()
  const client = await connect(db)
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'answer_question', 'ask_knowledge', 'draft_context', 'find_similar', 'load_context',
    'lookup_entity', 'pending_questions', 'record_observations', 'record_statement',
    'scan_repository', 'write_context',
  ])
  // The descriptions are how the model learns what is worth recording.
  const record = tools.find((t) => t.name === 'record_observations')!
  assert.match(record.description!, /crosses a repository boundary/)
  assert.match(record.description!, /NOT:.*body of a function|body of a function/s)
  await db.close()
})

test('an agent can record what it learned and read it back', async () => {
  const db = await freshDb()
  const client = await connect(db)

  const write = await client.callTool({
    name: 'record_observations',
    arguments: {
      repo: 'gitlab:2001',
      commit: 'abc123',
      env: 'prod',
      observations: [
        {
          subject: 'notification-client', subject_kind: 'client',
          subject_identifiers: [{ authority: 'git_remote', value: 'gitlab.com/acme/notification-client' }],
          predicate: 'calls', object: 'GET /v1/notifications', object_kind: 'endpoint',
          qualifiers: { path: '/v1/notifications', method: 'GET' },
          evidence: [{ path: 'src/api/notifications.js', lines: [8, 11], span_text: 'fetch(url + "/v1/notifications")' }],
        },
        {
          subject: 'notifications-service', subject_kind: 'service',
          predicate: 'exposes_endpoint', object: 'GET /v1/notifications', object_kind: 'endpoint',
          qualifiers: { path: '/v1/notifications', method: 'GET' },
        },
        {
          subject: 'notifications-service', subject_kind: 'service',
          predicate: 'reads_from', object: 'notifications-db', object_kind: 'datastore',
        },
      ],
    },
  })
  assert.match(textOf(write), /Recorded 3 observation/)

  const read = await client.callTool({
    name: 'ask_knowledge',
    arguments: { question: 'where does notification-client get its data from' },
  })
  const answer = textOf(read)
  assert.match(answer, /notifications-service/)
  assert.match(answer, /notifications-db/)
  assert.match(answer, /evidence: gitlab:2001 src\/api\/notifications\.js:8-11/)
  await db.close()
})

test('the write result nudges the agent toward strong identifiers', async () => {
  const db = await freshDb()
  const client = await connect(db)
  const r = await client.callTool({
    name: 'record_observations',
    arguments: {
      observations: [{ subject: 'mystery-service', subject_kind: 'service', predicate: 'reads_from',
        object: 'mystery-db', object_kind: 'datastore' }],
    },
  })
  const text = textOf(r)
  assert.match(text, /created new entity/)
  assert.match(text, /subject_identifiers|object_identifiers/, 'should teach the agent how to avoid duplicates')
  await db.close()
})

test('an unknown predicate is accepted and reported, not rejected', async () => {
  const db = await freshDb()
  const client = await connect(db)
  const r = await client.callTool({
    name: 'record_observations',
    arguments: {
      observations: [{ subject: 'a', subject_kind: 'service', predicate: 'frobnicates',
        object: 'b', object_kind: 'service' }],
    },
  })
  assert.match(textOf(r), /Recorded 1 observation/)
  assert.match(textOf(r), /not in the vocabulary/)
  await db.close()
})

test('a credential in a literal is refused through MCP too', async () => {
  const db = await freshDb()
  const client = await connect(db)
  const r = await client.callTool({
    name: 'record_observations',
    arguments: {
      observations: [{ subject: 'db', subject_kind: 'datastore', predicate: 'connect_via',
        object_literal: 'postgresql://admin:hunter2@db.internal:5432/app' }],
    },
  })
  assert.match(textOf(r), /REJECTED/)
  assert.match(textOf(r), /credential/i)
  await db.close()
})

test('the user can be quoted directly and it is trusted as human-stated', async () => {
  const db = await freshDb()
  resetPhraseCache()
  const client = await connect(db)
  const r = await client.callTool({
    name: 'record_statement',
    arguments: { text: 'billing-service reads from billing-db and publishes to invoice-queue' },
  })
  assert.match(textOf(r), /billing-service --\[reads_from\]--> billing-db/)
  assert.match(textOf(r), /publishes_to/)

  const method = await db.query<{ method: string }>('select distinct method from assertion')
  assert.deepEqual(method.rows.map((m) => m.method), ['human'])
  await db.close()
})

test('a refutation relayed from the user is labelled as such', async () => {
  const db = await freshDb()
  resetPhraseCache()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'client-x', subject_kind: 'client', predicate: 'built_with',
      object: 'Webpack', object_kind: 'technology' }] })
  const client = await connect(db)
  const r = await client.callTool({
    name: 'record_statement',
    arguments: { text: 'client-x no longer uses Webpack' },
  })
  assert.match(textOf(r), /REFUTES/)
  await db.close()
})

test('unparseable prose is handed back rather than guessed at', async () => {
  const db = await freshDb()
  resetPhraseCache()
  const client = await connect(db)
  const r = await client.callTool({
    name: 'record_statement',
    arguments: { text: 'the roadmap this quarter is looking quite ambitious' },
  })
  assert.match(textOf(r), /Could not confidently parse/)
  assert.match(textOf(r), /record_observations/, 'should point at the structured fallback')
  await db.close()
})

test('the agent can fetch questions and record the answer', async () => {
  const db = await freshDb()
  const client = await connect(db)

  await client.callTool({
    name: 'record_observations',
    arguments: {
      env: 'prod',
      observations: [
        { subject: 'web-client', subject_kind: 'client', predicate: 'calls',
          object: 'GET {svc}/v1/things', object_kind: 'endpoint',
          qualifiers: { path: '/v1/things', method: 'GET' } },
        { subject: 'thing-service', subject_kind: 'service', predicate: 'exposes_endpoint',
          object: 'GET /v1/things', object_kind: 'endpoint',
          qualifiers: { path: '/v1/things', method: 'GET' } },
        { subject: 'thing-service', subject_kind: 'service', predicate: 'reads_from',
          object: 'thing-db', object_kind: 'datastore' },
      ],
    },
  })

  const questions = await client.callTool({ name: 'pending_questions', arguments: { budget: 3 } })
  const qText = textOf(questions)
  assert.match(qText, /same route as/, 'should propose the cross-repo join')
  assert.match(qText, /answer_question\(gap_kind="dangling_endpoint", entity_id="[0-9a-f-]{36}"/)

  const m = qText.match(/gap_kind="(\w+)", entity_id="([0-9a-f-]{36})"/)!
  const answered = await client.callTool({
    name: 'answer_question',
    arguments: { gap_kind: m[1], entity_id: m[2], answer: 'yes' },
  })
  assert.match(textOf(answered), /joined/)

  // The join should now be traversable end to end.
  const after = await client.callTool({
    name: 'ask_knowledge',
    arguments: { question: 'where does web-client get its data from' },
  })
  assert.match(textOf(after), /thing-db/)
  await db.close()
})

test('answering a question that is no longer open reports an error', async () => {
  const db = await freshDb()
  const client = await connect(db)
  const r = await client.callTool({
    name: 'answer_question',
    arguments: { gap_kind: 'dangling_endpoint', entity_id: '00000000-0000-0000-0000-000000000000', answer: 'yes' },
  })
  assert.equal(r.isError, true)
  assert.match(textOf(r), /no longer open/)
  await db.close()
})

test('looking up one thing returns its neighbourhood and facts', async () => {
  const db = await freshDb()
  const client = await connect(db)
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'orders-db', subject_kind: 'datastore', predicate: 'connect_via',
      object_literal: 'psql -h orders.internal -U readonly' },
    { subject: 'orders-db', subject_kind: 'datastore', predicate: 'provisioned_by',
      object: 'orders-infra', object_kind: 'iac_module' },
  ] })

  const r = await client.callTool({ name: 'lookup_entity', arguments: { name: 'orders-db', shape: 'access' } })
  const text = textOf(r)
  assert.match(text, /orders-db — datastore/)
  assert.match(text, /psql -h orders\.internal/)
  await db.close()
})

test('load_context reaches the detail beside the code, and reports its freshness', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const dir = await mkdtemp(join(tmpdir(), 'lak-mcp-ctx-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'TextField.tsx'), 'export const TextField = () => null\n')
  await run('git', ['init', '-q'], { cwd: dir })
  await run('git', ['config', 'user.email', 't@example.com'], { cwd: dir })
  await run('git', ['config', 'user.name', 'T'], { cwd: dir })
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  const sha = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })).stdout.trim()
  await writeFile(join(dir, 'src', 'TextField.context.md'),
    `---\ndescribes: ./TextField.tsx\ngenerated_from: ${sha}\n---\n\nonChange receives the value, not the event.\n`)
  // Commit the context on its own. If it rode along with the next commit, that
  // commit would count as having updated it - which is the behaviour we rely on
  // elsewhere, but would defeat the point of this test.
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-q', '-m', 'context'], { cwd: dir })

  const db = await freshDb()
  const { registerRepo } = await import('../src/context/locate.ts')
  await registerRepo(db, { repoKey: 'library-a', localPath: dir })
  await ingest(db, { method: 'code_derived', env: 'prod', repo: 'library-a', observations: [
    { subject: 'library-a', subject_kind: 'package', predicate: 'lives_in_repo',
      object: 'library-a', object_kind: 'repo' },
    { subject: 'TextField', subject_kind: 'component', predicate: 'part_of',
      object: 'library-a', object_kind: 'package',
      evidence: [{ repo: 'library-a', path: 'src/TextField.tsx' }] },
  ] })

  const client = await connect(db)
  const r = await client.callTool({ name: 'load_context', arguments: { name: 'TextField' } })
  const text = textOf(r)
  assert.match(text, /onChange receives the value/, 'the detail comes from the file, not the graph')
  assert.match(text, /Up to date/)

  // Change the component; the same call must now warn rather than mislead.
  await writeFile(join(dir, 'src', 'TextField.tsx'), 'export const TextField = () => null\n// changed\n')
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-q', '-m', 'change'], { cwd: dir })
  const stale = await client.callTool({ name: 'load_context', arguments: { name: 'TextField' } })
  assert.match(textOf(stale), /WARNING: 1 commit/)

  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('load_context on something with no file still points at the source', async () => {
  const db = await freshDb()
  const client = await connect(db)
  await ingest(db, { method: 'code_derived', env: 'prod', observations: [
    { subject: 'library-b', subject_kind: 'repo', predicate: 'note', object_literal: 'UI lib',
      subject_identifiers: [{ authority: 'git_remote', value: 'gitlab.com/acme/library-b' }] },
    { subject: 'DatePicker', subject_kind: 'component', predicate: 'part_of',
      object: 'library-b', object_kind: 'repo',
      evidence: [{ repo: 'library-b', path: 'src/DatePicker.tsx' }] },
  ] })
  const r = await client.callTool({ name: 'load_context', arguments: { name: 'DatePicker' } })
  assert.match(textOf(r), /not checked out/)
  assert.match(textOf(r), /gitlab\.com\/acme\/library-b/)
  await db.close()
})

test('a question about nothing known says so, and suggests recording', async () => {
  const db = await freshDb()
  const client = await connect(db)
  const r = await client.callTool({
    name: 'ask_knowledge',
    arguments: { question: 'how does the quantum flux capacitor work' },
  })
  assert.match(textOf(r), /Nothing in the graph matches/)
  assert.match(textOf(r), /record_observations/)
  await db.close()
})
