import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshDb } from './helpers.ts'
import { parseExports, parseImports, parseJsxUsage, looksLikeComponent } from '../src/extract/typescript.ts'
import { extractMonorepo } from '../src/extract/monorepo.ts'
import { runTemplate } from '../src/query/traverse.ts'
import { loadContext } from '../src/context/load.ts'

// ── scanning ───────────────────────────────────────────────────────────────

test('imports are read in every shape people write them', () => {
  const got = parseImports(`
    import React from 'react'
    import * as utils from './utils'
    import { TextField, Button as Btn } from '@acme/library-a'
    import type { Props } from './types'
    import { type Only, Real } from './mixed'
    import './styles.scss'
  `)
  const find = (local: string) => got.find((g) => g.local === local)
  assert.equal(find('React')?.imported, 'default')
  assert.equal(find('utils')?.imported, '*')
  assert.equal(find('TextField')?.specifier, '@acme/library-a')
  assert.equal(find('Btn')?.imported, 'Button', 'the exported name matters, not the local alias')
  assert.equal(find('Props')?.typeOnly, true)
  assert.equal(find('Only')?.typeOnly, true, 'inline type specifiers are type-only too')
  assert.equal(find('Real')?.typeOnly, false)
  assert.ok(got.some((g) => g.specifier === './styles.scss'))
})

test('comments cannot fake an import', () => {
  const got = parseImports(`
    // import { Ghost } from '@acme/ghost'
    /* import { Phantom } from '@acme/phantom' */
    import { Real } from '@acme/real'
  `)
  assert.deepEqual(got.map((g) => g.local), ['Real'])
})

test('exports are read in every shape people write them', () => {
  const got = parseExports(`
    export const TextField = () => null
    export function useField() {}
    export class FieldStore {}
    export type Props = { a: string }
    export interface Other { b: string }
    export { Helper } from './Helper'
    export { Internal as Public }
    export default TextField
  `)
  const byName = Object.fromEntries(got.map((g) => [g.name, g.kind]))
  assert.equal(byName.TextField, 'const')
  assert.equal(byName.useField, 'function')
  assert.equal(byName.FieldStore, 'class')
  assert.equal(byName.Props, 'type')
  assert.equal(byName.Helper, 'reexport')
  assert.equal(byName.Public, 'const', 'aliased export uses the public name')
})

test('every shape of default export is read correctly', () => {
  const shapes: Array<[string, string[]]> = [
    ['export default ExternalBoundary;', ['ExternalBoundary']],
    ['export default function Widget() {}', ['Widget']],
    ['export default async function Loader() {}', ['Loader']],
    ['export default class Panel extends X {}', ['Panel']],
    ['export default function () {}', []],
    // A default export that is a CALL exports the wrapper's result, not the
    // wrapper. Recording the wrapper invents a component that does not exist.
    ['export default memo(Thing);', []],
    ['export default applyForwardRef(Accordion);', []],
    ['export default ApplyConsumer(SubMenu);', []],
  ]
  for (const [src, expected] of shapes) {
    assert.deepEqual(parseExports(src).map((e) => e.name), expected, src)
  }
})

test('a PascalCase type export is not a component', () => {
  // A component library exports roughly as many PascalCase interfaces as
  // components; without this a third of what is "found" is type declarations.
  const got = parseExports(`
    export interface BadgeProps { a: string }
    export type ChipVariant = 'a' | 'b'
    export const Badge = () => null
  `)
  const components = got.filter((e) => looksLikeComponent(e.name, 'x.tsx', e.kind))
  assert.deepEqual(components.map((e) => e.name), ['Badge'])
})

test('conventional companion-type names are not components either', () => {
  for (const name of ['BadgeProps', 'DatePickerHandle', 'FieldContext', 'ChipOptions', 'FormState']) {
    assert.equal(looksLikeComponent(name, 'x.tsx', 'const'), false, name)
  }
  assert.equal(looksLikeComponent('Badge', 'x.tsx', 'const'), true)
})

test('JSX usage picks out components, not DOM elements', () => {
  const got = parseJsxUsage(`<div><TextField /><Menu.Item /><span>x</span><Button/></div>`)
  assert.deepEqual(got.sort(), ['Button', 'Menu', 'TextField'])
})

test('component detection needs PascalCase in a JSX-capable file', () => {
  assert.equal(looksLikeComponent('TextField', 'a.tsx'), true)
  assert.equal(looksLikeComponent('useField', 'a.tsx'), false, 'a hook is not a component')
  assert.equal(looksLikeComponent('MAX_WIDTH', 'a.tsx'), false, 'a constant is not a component')
  assert.equal(looksLikeComponent('TextField', 'a.ts'), false, 'no JSX, no component')
})

// ── walking a monorepo ─────────────────────────────────────────────────────

async function monorepo() {
  const dir = await mkdtemp(join(tmpdir(), 'lak-mono-'))
  const write = async (p: string, body: string) => {
    await mkdir(join(dir, p, '..'), { recursive: true })
    await writeFile(join(dir, p), body)
  }
  await write('package.json', JSON.stringify({ name: '@acme/root', private: true, workspaces: ['packages/*'] }))
  await write('packages/a/package.json', JSON.stringify({
    name: '@acme/library-a', main: 'src/index.ts',
    dependencies: { react: '^18.0.0' }, devDependencies: { jest: '^29.0.0', webpack: '^5.0.0' },
  }))
  await write('packages/a/src/TextField.tsx', 'export const TextField = () => <input />\n')
  await write('packages/a/src/index.ts', "export { TextField } from './TextField'\n")
  await write('packages/b/package.json', JSON.stringify({
    name: '@acme/library-b', main: 'src/index.ts',
    dependencies: { react: '^18.0.0', '@acme/library-a': '1.0.0' }, devDependencies: { vitest: '^1.0.0' },
  }))
  await write('packages/b/src/SearchField.tsx',
    "import { TextField } from '@acme/library-a'\nexport const SearchField = () => <TextField />\n")
  await write('packages/b/src/index.ts', "export { SearchField } from './SearchField'\n")
  // noise that must be ignored
  await write('packages/a/node_modules/junk/package.json', JSON.stringify({ name: 'junk' }))
  await write('packages/a/src/TextField.test.tsx', "import { TextField } from './TextField'\nexport const Nope = () => <TextField />\n")
  return dir
}

test('a monorepo scan finds packages, their tooling, and what they depend on', async () => {
  const db = await freshDb()
  const dir = await monorepo()
  const r = await extractMonorepo(db, { root: dir, repoKey: 'ui' })

  assert.ok(r.packages.includes('@acme/library-a'))
  assert.ok(r.packages.includes('@acme/library-b'))
  assert.ok(!r.packages.includes('junk'), 'node_modules is not part of the repo')

  const tech = await db.query<{ package: string; predicate: string; tech: string }>(`
    select p.display_name as package, ec.predicate, t.display_name as tech
      from edges_canon(now()) ec
      join entity p on p.id = ec.subject and p.kind = 'package'
      join entity t on t.id = ec.object and t.kind = 'technology'
     order by 1,2,3`)
  const say = (pkg: string, pred: string, t: string) =>
    tech.rows.some((x) => x.package === pkg && x.predicate === pred && x.tech === t)
  assert.ok(say('@acme/library-a', 'uses_framework', 'React'))
  assert.ok(say('@acme/library-a', 'built_with', 'Webpack'))
  assert.ok(say('@acme/library-a', 'tests_with', 'Jest'))
  assert.ok(say('@acme/library-b', 'tests_with', 'Vitest'))

  const deps = await db.query<{ n: string }>(`
    select count(*)::text n from edges_canon(now()) ec
      join entity s on s.id = ec.subject join entity o on o.id = ec.object
     where ec.predicate = 'depends_on_package'
       and s.display_name = '@acme/library-b' and o.display_name = '@acme/library-a'`)
  assert.equal(Number(deps.rows[0]!.n), 1, 'a workspace dependency is the cross-boundary fact that matters')

  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('cross-package composition is recorded; test files are ignored', async () => {
  const db = await freshDb()
  const dir = await monorepo()
  await extractMonorepo(db, { root: dir, repoKey: 'ui' })

  const composes = await db.query<{ s: string; o: string }>(`
    select s.display_name s, o.display_name o from edges_canon(now()) ec
      join entity s on s.id = ec.subject join entity o on o.id = ec.object
     where ec.predicate = 'composes'`)
  assert.deepEqual(composes.rows, [{ s: 'SearchField', o: 'TextField' }])

  const nope = await db.query<{ n: string }>(
    `select count(*)::text n from entity where display_name = 'Nope'`)
  assert.equal(Number(nope.rows[0]!.n), 0, 'a .test.tsx file is not part of the public surface')

  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('module_export identity means two scans agree on one component', async () => {
  const db = await freshDb()
  const dir = await monorepo()
  await extractMonorepo(db, { root: dir, repoKey: 'ui' })
  await extractMonorepo(db, { root: dir, repoKey: 'ui' })

  const n = await db.query<{ n: string }>(
    `select count(*)::text n from entity where display_name = 'TextField' and canonical_id = id`)
  assert.equal(Number(n.rows[0]!.n), 1, 're-scanning must not duplicate entities')

  const ids = await db.query<{ value: string }>(
    `select value from entity_identifier where authority = 'module_export' order by value`)
  assert.ok(ids.rows.some((i) => i.value === '@acme/library-a#TextField'),
    'identity is package plus export name, derivable from either side of the boundary')
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('"what breaks if I change this" walks composition backwards across packages', async () => {
  const db = await freshDb()
  const dir = await monorepo()
  await extractMonorepo(db, { root: dir, repoKey: 'ui' })

  const tf = await db.query<{ id: string }>(
    `select id from entity where display_name = 'TextField' and kind = 'component'`)
  const paths = await runTemplate(db, 'blast_radius', tf.rows[0]!.id)
  assert.ok(paths.some((p) => p.steps.some((s) => s.subject_name === 'SearchField' || s.object_name === 'SearchField')),
    'the consumer lives in another package and cannot be seen from inside library-a')
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('a re-scan closes what has been deleted from the code', async () => {
  const db = await freshDb()
  const dir = await monorepo()
  await extractMonorepo(db, { root: dir, repoKey: 'ui' })

  const before = await db.query<{ n: string }>(
    `select count(*)::text n from edge_now e join proposition p on p.id = e.proposition_id
      join entity o on o.id = p.object_entity where o.display_name = 'TextField'`)
  assert.ok(Number(before.rows[0]!.n) > 0)

  await rm(join(dir, 'packages/b/src/SearchField.tsx'))
  await writeFile(join(dir, 'packages/b/src/index.ts'), '\n')
  const r = await extractMonorepo(db, { root: dir, repoKey: 'ui' })
  assert.ok(r.swept > 0, 'facts about the deleted component are closed, not left to haunt the graph')

  const composes = await db.query<{ n: string }>(
    `select count(*)::text n from edge_now e join proposition p on p.id = e.proposition_id
      where p.predicate = 'composes'`)
  assert.equal(Number(composes.rows[0]!.n), 0)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('excluding a package also keeps its files out of the walk', async () => {
  const db = await freshDb()
  const dir = await mkdtemp(join(tmpdir(), 'lak-excl-'))
  const write = async (p: string, body: string) => {
    await mkdir(join(dir, p, '..'), { recursive: true })
    await writeFile(join(dir, p), body)
  }
  await write('package.json', JSON.stringify({ name: '@acme/root', private: true }))
  await write('packages/lib/package.json', JSON.stringify({ name: '@acme/lib', main: 'src/index.ts' }))
  await write('packages/lib/src/Button.tsx', 'export const Button = () => <button />\n')
  await write('packages/storybook/package.json', JSON.stringify({
    name: '@acme/storybook', dependencies: { '@acme/lib': '1.0.0' } }))
  await write('packages/storybook/src/ButtonStory.tsx',
    "import { Button } from '@acme/lib'\nexport const ButtonStory = () => <Button />\n")

  const r = await extractMonorepo(db, { root: dir, repoKey: 'ui', exclude: ['storybook'] })
  assert.ok(r.excluded.includes('@acme/storybook'))

  // Without directory exclusion the root package simply absorbs the story files
  // and the demo code reappears under a different name.
  const story = await db.query<{ n: string }>(
    `select count(*)::text n from entity where display_name = 'ButtonStory'`)
  assert.equal(Number(story.rows[0]!.n), 0, 'excluded files must not be re-attributed to a parent package')
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('doc coverage is reported, because similarity depends on it', async () => {
  const db = await freshDb()
  const dir = await mkdtemp(join(tmpdir(), 'lak-doc-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@acme/solo', main: 'src/index.ts' }))
  await writeFile(join(dir, 'src/Documented.tsx'),
    '/** Picks a start and end date. */\nexport const Documented = () => <div />\n')
  await writeFile(join(dir, 'src/Bare.tsx'), 'export const Bare = () => <div />\n')

  const r = await extractMonorepo(db, { root: dir, repoKey: 'solo' })
  assert.equal(r.components, 2)
  assert.equal(r.documented, 1)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('a dry run reports what it would do and writes nothing', async () => {
  const db = await freshDb()
  const dir = await monorepo()
  const r = await extractMonorepo(db, { root: dir, repoKey: 'ui', dryRun: true })
  assert.ok(r.observations > 0)
  assert.equal(r.accepted, 0)
  const n = await db.query<{ n: string }>('select count(*)::text n from assertion')
  assert.equal(Number(n.rows[0]!.n), 0)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('intra-package composition is excluded unless asked for', async () => {
  const db = await freshDb()
  const dir = await mkdtemp(join(tmpdir(), 'lak-intra-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@acme/solo', main: 'src/index.ts' }))
  await writeFile(join(dir, 'src/Label.tsx'), 'export const Label = () => <span />\n')
  await writeFile(join(dir, 'src/Field.tsx'),
    "import { Label } from './Label'\nexport const Field = () => <Label />\n")

  await extractMonorepo(db, { root: dir, repoKey: 'solo' })
  const off = await db.query<{ n: string }>(
    `select count(*)::text n from edge_now e join proposition p on p.id = e.proposition_id where p.predicate = 'composes'`)
  assert.equal(Number(off.rows[0]!.n), 0, 'inside one package is context-file territory, not graph territory')

  await extractMonorepo(db, { root: dir, repoKey: 'solo', includeIntraPackage: true })
  const on = await db.query<{ n: string }>(
    `select count(*)::text n from edge_now e join proposition p on p.id = e.proposition_id where p.predicate = 'composes'`)
  assert.equal(Number(on.rows[0]!.n), 1)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('extraction registers the checkout, so context files resolve immediately', async () => {
  const db = await freshDb()
  const dir = await monorepo()
  await writeFile(join(dir, 'packages/a/src/TextField.context.md'),
    '---\ndescribes: ./TextField.tsx\n---\n\nonChange gives you the value.\n')
  await extractMonorepo(db, { root: dir, repoKey: 'ui' })

  const r = await loadContext(db, 'TextField')
  assert.equal(r.status, 'loaded', 'no separate `register` step needed after a scan')
  assert.match(r.content!, /onChange gives you the value/)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})

test('a project with no package.json says so rather than failing silently', async () => {
  const db = await freshDb()
  const dir = await mkdtemp(join(tmpdir(), 'lak-empty-'))
  const r = await extractMonorepo(db, { root: dir, repoKey: 'x' })
  assert.equal(r.packages.length, 0)
  assert.match(r.warnings[0]!, /No package\.json/)
  await rm(dir, { recursive: true, force: true })
  await db.close()
})
