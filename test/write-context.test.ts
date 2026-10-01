import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { freshDb } from './helpers.ts'
import { draftMaterial, writeContext } from '../src/context/write.ts'
import { loadContext } from '../src/context/load.ts'
import { registerRepo } from '../src/context/locate.ts'
import { parseContext } from '../src/context/spec.ts'
import { ingest } from '../src/store/observations.ts'

const run = promisify(execFile)
const git = (cwd: string, args: string[]) => run('git', args, { cwd })

async function repo(sourcePath = 'src/TextField.tsx') {
  const dir = await mkdtemp(join(tmpdir(), 'lak-wctx-'))
  await mkdir(join(dir, sourcePath, '..'), { recursive: true })
  await writeFile(join(dir, sourcePath), 'export interface Props { label: string }\n')
  await git(dir, ['init', '-q'])
  await git(dir, ['config', 'user.email', 't@example.com'])
  await git(dir, ['config', 'user.name', 'T'])
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

async function seed(db: any, dir: string, sourcePath = 'src/TextField.tsx') {
  await registerRepo(db, { repoKey: 'library-a', localPath: dir })
  await ingest(db, {
    method: 'code_derived', env: 'prod', repo: 'library-a',
    observations: [
      { subject: 'library-a', subject_kind: 'package', predicate: 'lives_in_repo',
        object: 'library-a', object_kind: 'repo' },
      { subject: 'TextField', subject_kind: 'component', predicate: 'part_of',
        object: 'library-a', object_kind: 'package',
        evidence: [{ repo: 'library-a', path: sourcePath }] },
      { subject: 'SearchField', subject_kind: 'component', predicate: 'composes',
        object: 'TextField', object_kind: 'component' },
    ],
  })
}

test('drafting gathers the source, and names what the graph already holds', async () => {
  const db = await freshDb()
  const dir = await repo()
  await seed(db, dir)

  const m = await draftMaterial(db, 'TextField')
  assert.equal(m.ok, true)
  assert.match(m.source!, /label: string/)
  assert.equal(m.existing, undefined, 'nothing written yet')
  assert.equal(m.contextPath, 'src/TextField.context.md')
  assert.ok(m.graphFacts!.some((f) => /SearchField composes TextField/.test(f)),
    'cross-boundary facts are the graph\'s job and must not be duplicated into the file')
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('a context file is created with frontmatter stamped to HEAD', async () => {
  const db = await freshDb()
  const dir = await repo()
  await seed(db, dir)

  const r = await writeContext(db, { target: 'TextField', body: '# TextField\n\nRequired: label.' })
  assert.equal(r.ok, true)
  assert.equal(r.created, true)

  const written = parseContext(await readFile(join(dir, 'src/TextField.context.md'), 'utf8'))
  assert.deepEqual(written.frontmatter.describes, ['./TextField.tsx'])
  assert.equal(written.frontmatter.generatedFrom, r.stampedCommit)
  assert.match(written.body, /Required: label/)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('a refresh keeps frontmatter a human added', async () => {
  const db = await freshDb()
  const dir = await repo()
  await seed(db, dir)
  await writeFile(join(dir, 'src/TextField.context.md'),
    '---\ndescribes: ./TextField.tsx\nowner: design-systems\nstatus: stable\n---\n\nold body\n')

  const r = await writeContext(db, { target: 'TextField', body: 'new body' })
  assert.equal(r.created, false)
  const after = parseContext(await readFile(join(dir, 'src/TextField.context.md'), 'utf8'))
  assert.equal(after.frontmatter.extra.owner, 'design-systems')
  assert.equal(after.frontmatter.extra.status, 'stable')
  assert.match(after.body, /new body/)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('refreshing hands back the existing body and the commits since it was written', async () => {
  const db = await freshDb()
  const dir = await repo()
  await seed(db, dir)
  await writeContext(db, { target: 'TextField', body: '# TextField\n\nHard-won gotcha.' })
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'context'])

  await writeFile(join(dir, 'src/TextField.tsx'), 'export interface Props { label: string; value: string }\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'add value prop'])

  const m = await draftMaterial(db, 'TextField')
  assert.match(m.existing!, /Hard-won gotcha/, 'the agent must see what to preserve')
  assert.ok(m.commitSubjects!.some((c) => /add value prop/.test(c)))
  assert.match(m.changedSince!, /value: string/, 'the diff shows what actually changed')
  assert.match(m.message, /Refreshing/)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('code and context committed together does not read as stale', async () => {
  const db = await freshDb()
  const dir = await repo()
  await seed(db, dir)
  await writeContext(db, { target: 'TextField', body: 'v1' })
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'context'])

  // The normal workflow: change the code and its context in one commit.
  await writeFile(join(dir, 'src/TextField.tsx'), 'export interface Props { label: string; v2: true }\n')
  await writeFile(join(dir, 'src/TextField.context.md'),
    (await readFile(join(dir, 'src/TextField.context.md'), 'utf8')) + '\nv2 note\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'change both'])

  const r = await loadContext(db, 'TextField')
  assert.equal(r.freshness?.commitsBehind, 0,
    'counting this would make every well-maintained file report itself stale on commit')
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('code changed without its context does read as stale', async () => {
  const db = await freshDb()
  const dir = await repo()
  await seed(db, dir)
  await writeContext(db, { target: 'TextField', body: 'v1' })
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'context'])

  await writeFile(join(dir, 'src/TextField.tsx'), 'export interface Props { label: string; undocumented: true }\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'change code only'])

  const r = await loadContext(db, 'TextField')
  assert.equal(r.freshness?.commitsBehind, 1)
  assert.match(r.message, /WARNING/)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('uncommitted changes to the source are warned about', async () => {
  const db = await freshDb()
  const dir = await repo()
  await seed(db, dir)
  await writeFile(join(dir, 'src/TextField.tsx'), 'export interface Props { label: string; wip: true }\n')

  const r = await writeContext(db, { target: 'TextField', body: 'documenting work in progress' })
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => /uncommitted/.test(w)),
    'the stamp records HEAD, which does not include the uncommitted work')
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('it will not write over something that is not a context file', async () => {
  const db = await freshDb()
  const dir = await repo()
  await seed(db, dir)
  const r = await writeContext(db, { target: 'TextField', body: 'x', path: 'src/TextField.tsx' })
  assert.equal(r.ok, false)
  assert.match(r.message, /must end in \.context\.md/)

  const source = await readFile(join(dir, 'src/TextField.tsx'), 'utf8')
  assert.match(source, /label: string/, 'the source is untouched')
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('it will not write outside the repository', async () => {
  const db = await freshDb()
  const dir = await repo()
  await seed(db, dir)
  const r = await writeContext(db, { target: 'TextField', body: 'x', path: '../escape.context.md' })
  assert.equal(r.ok, false)
  assert.match(r.message, /outside the repository/)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('describes is relative to the context file, not the repo root', async () => {
  const db = await freshDb()
  const dir = await repo('packages/ui/src/deep/Widget.tsx')
  await seed(db, dir, 'packages/ui/src/deep/Widget.tsx')

  const r = await writeContext(db, { target: 'TextField', body: 'nested' })
  assert.equal(r.contextPath, 'packages/ui/src/deep/Widget.context.md')
  const fm = parseContext(await readFile(r.absolutePath!, 'utf8')).frontmatter
  assert.deepEqual(fm.describes, ['./Widget.tsx'])

  // and the loader must be able to follow it back
  const loaded = await loadContext(db, 'TextField')
  assert.equal(loaded.status, 'loaded')
  assert.equal(loaded.freshness?.commitsBehind, 0)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('a full round trip: write, read back, change the code, see it flagged', async () => {
  const db = await freshDb()
  const dir = await repo()
  await seed(db, dir)

  const m = await draftMaterial(db, 'TextField')
  assert.equal(m.ok, true)
  await writeContext(db, { target: 'TextField', body: '# TextField\n\nonChange gives you the value.' })
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'document'])

  const first = await loadContext(db, 'TextField')
  assert.match(first.content!, /onChange gives you the value/)
  assert.match(first.message, /Up to date/)

  await writeFile(join(dir, 'src/TextField.tsx'), 'export interface Props { label: string; changed: true }\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'change'])

  const second = await loadContext(db, 'TextField')
  assert.match(second.message, /WARNING: 1 commit/)
  assert.match(second.content!, /onChange gives you the value/, 'stale content is still returned, just labelled')
  await rm(dir, { recursive: true, force: true })
  await db.close()
})
