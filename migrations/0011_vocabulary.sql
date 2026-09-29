-- Vocabulary for the durable facts: what something is built from, what it does,
-- and what data it touches.
--
-- These are the facts that DON'T go stale quickly. A repo's framework changes
-- every few years; a capability description survives a rewrite. They are also the
-- facts a single-repo agent can see cheaply, which matters because they are the
-- entry points for questions that name no service at all ("how does authentication
-- work", "where is patient data stored").

alter table predicate add column family text;

update predicate set family = 'dataflow'  where name in
  ('calls','reads_from','writes_to','publishes_to','subscribes_to','caches_in','falls_back_to','primary_cache_of');
update predicate set family = 'structure' where name in ('lives_in_repo','exposes_endpoint','owned_by');
update predicate set family = 'infra'     where name in ('provisioned_by','deployed_to');
update predicate set family = 'access'    where name in ('connect_via','secret_at');
update predicate set family = 'meta'      where name in ('note','ttl_seconds','depends_on');

insert into predicate (name, family, functional, subject_kinds, object_kinds, description) values
  -- What it is made of. Technologies are ENTITIES, not tags, so "what still uses
  -- Webpack" and "we are dropping React, what breaks" are ordinary queries.
  ('written_in',         'technology', false, array['client','service','repo','iac_module'], array['technology'],
   'Implementation language of the subject. Not functional: a project may be TypeScript and SCSS.'),
  ('uses_framework',     'technology', false, array['client','service'], array['technology'],
   'Application framework: React, Angular, Spring Boot, Express.'),
  ('built_with',         'technology', false, array['client','service','repo'], array['technology'],
   'Build or packaging tool: Webpack, Vite, Maven, Gradle.'),
  ('tests_with',         'technology', false, array['client','service','repo'], array['technology'],
   'Test framework: Jest, Vitest, JUnit, Playwright.'),
  ('depends_on_package', 'technology', false, array['client','service'], array['technology'],
   'Notable external library dependency. For broad strokes, not a lockfile dump.'),

  -- What it does. The entry point for questions that name no system.
  ('implements',         'capability', false, array['client','service','endpoint'], array['capability'],
   'Subject provides this user-visible capability or feature.'),
  ('handles_data',       'capability', false, array['client','service','endpoint','datastore','cache','queue'], array['data_concept'],
   'Subject stores, transports or exposes this kind of data. Drives "where does X data live".'),
  ('part_of',            'structure',  false, null, array['capability','domain','repo','system'],
   'Subject belongs to a larger grouping.'),
  ('contains_project',   'structure',  false, array['repo'], array['client','service','iac_module'],
   'A monorepo holds this project. The inverse view of lives_in_repo.'),

  -- Lifecycle. Two things with nearly the same name, one replacing the other, is
  -- the single most common way a knowledge graph quietly starts lying.
  ('supersedes',         'lifecycle',  false, null, null,
   'Subject is the replacement for object. Both continue to exist during migration.'),

  -- Delivery and operations.
  ('built_by',           'delivery',   false, array['repo','client','service'], array['pipeline'],
   'CI/CD pipeline that builds or deploys the subject.'),
  ('monitors',           'ops',        false, array['alert'], array['service','cloud_resource','datastore','cache','queue'],
   'Subject alert watches object.'),
  ('serves_at',          'structure',  false, array['client','service','endpoint'], null,
   'Literal object: base URL this thing is reachable at in a given environment.'),
  ('documented_at',      'reference',  false, null, null,
   'Literal object: URL of a runbook, ADR, wiki page or spec.');

insert into predicate_alias (raw, maps_to) values
  ('language',          'written_in'),
  ('written_using',     'written_in'),
  ('coded_in',          'written_in'),
  ('styled_with',       'written_in'),
  ('framework',         'uses_framework'),
  ('uses_react',        'uses_framework'),
  ('build_tool',        'built_with'),
  ('bundled_with',      'built_with'),
  ('compiled_with',     'built_with'),
  ('packaged_with',     'built_with'),
  ('test_framework',    'tests_with'),
  ('tested_with',       'tests_with'),
  ('uses_library',      'depends_on_package'),
  ('depends_on_library','depends_on_package'),
  ('uses_package',      'depends_on_package'),
  ('provides_feature',  'implements'),
  ('feature',           'implements'),
  ('provides',          'implements'),
  ('stores_data',       'handles_data'),
  ('processes_data',    'handles_data'),
  ('accesses_data',     'handles_data'),
  ('handles',           'handles_data'),
  ('belongs_to',        'part_of'),
  ('replaces',          'supersedes'),
  ('supersedes_project','supersedes'),
  ('ci_pipeline',       'built_by'),
  ('pipeline',          'built_by'),
  ('deployed_by_pipeline','built_by'),
  ('alerts_on',         'monitors'),
  ('watches',           'monitors'),
  ('base_url',          'serves_at'),
  ('hosted_at',         'serves_at'),
  ('runbook',           'documented_at'),
  ('docs_at',           'documented_at');
