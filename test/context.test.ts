import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { freshDb } from './helpers.ts'
import { contextCandidates, parseContext } from '../src/context/spec.ts'
import { loadContext } from '../src/context/load.ts'
import { registerRepo } from '../src/context/locate.ts'
import { ingest } from '../src/store/observations.ts'

const run = promisify(execFile)

// ── the convention ─────────────────────────────────────────────────────────

test('frontmatter is parsed from a hand-writable subset of YAML', () => {
  const { frontmatter, body, malformed } = parseContext(
    `---\ndescribes: ./TextField.tsx\ngenerated_from: 4a91c2e\nowner: design-systems\n---\n\n# TextField\n\nBody here.`)
  assert.equal(malformed, false)
  assert.deepEqual(frontmatter.describes, ['./TextField.tsx'])
  assert.equal(frontmatter.generatedFrom, '4a91c2e')
  assert.equal(frontmatter.extra.owner, 'design-systems')
  assert.match(body, /^# TextField/)
})

test('describes accepts a list, in either YAML style', () => {
  const inline = parseContext(`---\ndescribes: [./A.tsx, ./B.tsx]\n---\nx`)
  assert.deepEqual(inline.frontmatter.describes, ['./A.tsx', './B.tsx'])
  const block = parseContext(`---\ndescribes:\n  - ./A.tsx\n  - ./B.tsx\n---\nx`)
  assert.deepEqual(block.frontmatter.describes, ['./A.tsx', './B.tsx'])
})

test('a file with no frontmatter is still usable, just uncheckable', () => {
  const r = parseContext('# Just some notes\n\nNo frontmatter here.')
  assert.equal(r.malformed, true)
  assert.match(r.body, /Just some notes/)
  assert.equal(r.frontmatter.generatedFrom, undefined)
})

test('context files are looked for beside the code, most specific first', () => {
  const c = contextCandidates('src/components/TextField.tsx')
  assert.equal(c[0], 'src/components/TextField.context.md')
  assert.ok(c.includes('src/components/.context.md'), 'falls back to a directory context file')

  const idx = contextCandidates('src/components/Button/index.tsx')
  assert.ok(idx.includes('src/components/Button/.context.md'),
    'a component folder can be documented by the folder')

  const dir = contextCandidates('packages/ui')
  assert.equal(dir[0], 'packages/ui/.context.md')
})

// ── loading ────────────────────────────────────────────────────────────────

async function fixture(withContext: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'lak-ctx-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'TextField.tsx'), 'export const TextField = () => null\n')
  await run('git', ['init', '-q'], { cwd: dir })
  await run('git', ['config', 'user.email', 't@example.com'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  const sha = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })).stdout.trim()

  if (withContext) {
    await writeFile(
      join(dir, 'src', 'TextField.context.md'),
      `---\ndescribes: ./TextField.tsx\ngenerated_from: ${sha}\n---\n\n# TextField\n\nRequired: label, value, onChange.\n`,
    )
    await run('git', ['add', '-A'], { cwd: dir })
    await run('git', ['commit', '-q', '-m', 'context'], { cwd: dir })
  }
  return { dir, sha }
}

async function seedComponent(db: any, repoKey: string, path = 'src/TextField.tsx') {
  await ingest(db, {
    method: 'code_derived', env: 'prod', repo: repoKey,
    observations: [
      { subject: repoKey, subject_kind: 'package', predicate: 'lives_in_repo',
        object: repoKey, object_kind: 'repo' },
      { subject: 'TextField', subject_kind: 'component', predicate: 'part_of',
        object: repoKey, object_kind: 'package',
        evidence: [{ repo: repoKey, path }] },
    ],
  })
}

test('context is loaded on demand from beside the code', async () => {
  const db = await freshDb()
  const { dir } = await fixture(true)
  await registerRepo(db, { repoKey: 'library-a', localPath: dir })
  await seedComponent(db, 'library-a')

  const r = await loadContext(db, 'TextField')
  assert.equal(r.status, 'loaded')
  assert.equal(r.contextPath, 'src/TextField.context.md')
  assert.match(r.content!, /Required: label, value, onChange/)
  assert.equal(r.freshness?.commitsBehind, 0)
  assert.match(r.message, /Up to date/)

  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('a commit touching the described file makes the context report itself stale', async () => {
  const db = await freshDb()
  const { dir } = await fixture(true)
  await registerRepo(db, { repoKey: 'library-a', localPath: dir })
  await seedComponent(db, 'library-a')

  await writeFile(join(dir, 'src', 'TextField.tsx'), 'export const TextField = () => null\n// changed\n')
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-q', '-m', 'change TextField'], { cwd: dir })

  const r = await loadContext(db, 'TextField')
  assert.equal(r.status, 'loaded', 'still returns the content')
  assert.equal(r.freshness?.commitsBehind, 1)
  assert.match(r.message, /WARNING: 1 commit/)
  assert.match(r.message, /offer to refresh/)

  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('an unrelated commit does not make the context stale', async () => {
  const db = await freshDb()
  const { dir } = await fixture(true)
  await registerRepo(db, { repoKey: 'library-a', localPath: dir })
  await seedComponent(db, 'library-a')

  await writeFile(join(dir, 'README.md'), 'unrelated\n')
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-q', '-m', 'docs'], { cwd: dir })

  const r = await loadContext(db, 'TextField')
  assert.equal(r.freshness?.commitsBehind, 0, 'freshness is scoped to the described files')
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('with no context file, the source location is still a useful answer', async () => {
  const db = await freshDb()
  const { dir } = await fixture(false)
  await registerRepo(db, { repoKey: 'library-a', localPath: dir, browseUrl: 'https://gitlab.com/acme/library-a' })
  await seedComponent(db, 'library-a')

  const r = await loadContext(db, 'TextField')
  assert.equal(r.status, 'no_context_file')
  assert.match(r.message, /src\/TextField\.tsx/)
  assert.match(r.message, /gitlab\.com\/acme\/library-a\/-\/blob\/main\/src\/TextField\.tsx/)
  assert.match(r.message, /src\/TextField\.context\.md/, 'suggests where to write one')
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('a repo that is not checked out degrades to a URL', async () => {
  const db = await freshDb()
  await ingest(db, { method: 'code_derived', env: 'prod', observations: [
    { subject: 'library-b', subject_kind: 'repo', predicate: 'note',
      object_literal: 'UI library',
      subject_identifiers: [{ authority: 'git_remote', value: 'gitlab.com/acme/library-b' }] },
    { subject: 'DatePicker', subject_kind: 'component', predicate: 'part_of',
      object: 'library-b', object_kind: 'repo',
      evidence: [{ repo: 'library-b', path: 'src/DatePicker.tsx' }] },
  ] })

  const r = await loadContext(db, 'DatePicker')
  assert.equal(r.status, 'repo_not_local')
  assert.match(r.message, /not checked out/)
  assert.match(r.browseUrl ?? '', /gitlab\.com\/acme\/library-b/)
  await db.close()
})

test('a pointer to a path that no longer exists is reported as stale, not as content', async () => {
  const db = await freshDb()
  const { dir } = await fixture(true)
  await registerRepo(db, { repoKey: 'library-a', localPath: dir })
  await seedComponent(db, 'library-a', 'src/Moved.tsx')

  const r = await loadContext(db, 'TextField')
  assert.equal(r.status, 'path_missing')
  assert.match(r.message, /no longer exists/)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('an entity with no recorded source says so, and says what would fix it', async () => {
  const db = await freshDb()
  await ingest(db, { method: 'human', env: 'prod', observations: [
    { subject: 'MysteryWidget', subject_kind: 'component', predicate: 'note',
      object_literal: 'Someone mentioned this once' }] })

  const r = await loadContext(db, 'MysteryWidget')
  assert.equal(r.status, 'no_source')
  assert.match(r.message, /documented_at|evidence/)
  await db.close()
})

test('an unknown name is not confused with a missing file', async () => {
  const db = await freshDb()
  const r = await loadContext(db, 'NoSuchThingAnywhere')
  assert.equal(r.status, 'unknown_entity')
  await db.close()
})

test('a long context file is truncated rather than flooding the caller', async () => {
  const db = await freshDb()
  const { dir, sha } = await fixture(false)
  await writeFile(
    join(dir, 'src', 'TextField.context.md'),
    `---\ndescribes: ./TextField.tsx\ngenerated_from: ${sha}\n---\n\n${'x'.repeat(5000)}`,
  )
  await registerRepo(db, { repoKey: 'library-a', localPath: dir })
  await seedComponent(db, 'library-a')

  const r = await loadContext(db, 'TextField', { maxChars: 500 })
  assert.equal(r.truncated, true)
  assert.ok(r.content!.length < 700)
  assert.match(r.content!, /truncated/)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})
