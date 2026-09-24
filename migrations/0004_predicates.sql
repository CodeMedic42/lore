-- Seed the predicate vocabulary.
--
-- `functional` means at most one live value per subject: asserting a new one
-- auto-expires the prior. This is one of the two mechanisms that actually close
-- a stale edge (the other is scope sweeps). Marking a predicate functional when
-- it is not silently deletes true edges, so the default is false.

insert into predicate (name, functional, subject_kinds, object_kinds, description) values
  ('calls',            false, array['client','service','endpoint'], array['service','endpoint'],
   'Subject makes a request to object. Prefer the finest grain available: call site to endpoint.'),
  ('reads_from',       false, array['service'], array['datastore','cache','queue'],
   'Subject reads data from object. Use the role qualifier to distinguish cache from origin.'),
  ('writes_to',        false, array['service'], array['datastore','cache','queue'],
   'Subject writes data to object.'),
  ('publishes_to',     false, array['service'], array['queue'],
   'Subject publishes messages to object.'),
  ('subscribes_to',    false, array['service'], array['queue'],
   'Subject consumes messages from object.'),
  ('caches_in',        false, array['service'], array['cache'],
   'Subject caches data in object.'),
  ('falls_back_to',    false, null, array['datastore','cache','service'],
   'Asserted ABOUT another proposition: when that read path misses, the subject falls back to object.'),
  ('primary_cache_of', true,  array['cache'], array['service','datastore'],
   'Object''s primary cache. Functional: a thing has one primary cache at a time.'),
  ('lives_in_repo',    true,  array['client','service','iac_module'], array['repo'],
   'Source for subject lives in object. Functional: one home repo at a time.'),
  ('provisioned_by',   true,  array['datastore','cache','queue','cloud_resource'], array['iac_module'],
   'Subject is provisioned by object. Functional: one owning IaC module at a time.'),
  ('deployed_to',      false, array['service','client','cloud_resource'], array['cloud_resource'],
   'Subject runs in object (account, region, cluster).'),
  ('exposes_endpoint', false, array['service'], array['endpoint'],
   'Subject serves object.'),
  ('owned_by',         true,  null, array['team'],
   'Subject is owned by object. Functional: one owning team at a time.'),
  ('depends_on',       false, null, null,
   'Generic fallback dependency. Prefer a specific predicate; this one carries little meaning.'),
  ('connect_via',      false, array['datastore','cache','queue','cloud_resource'], null,
   'Literal object: how to reach subject (host, port, protocol, tunnel instructions).'),
  ('secret_at',        false, array['datastore','cache','queue','cloud_resource'], null,
   'Literal object: WHERE the credential lives. Never the credential itself.'),
  ('ttl_seconds',      true,  null, null,
   'Descriptive qualifier asserted about a proposition.'),
  ('note',             false, null, null,
   'Free-text annotation about an entity or a proposition.');

-- Known raw phrasings that map onto the vocabulary. The write path never rejects
-- an unknown predicate: it records the raw string here with maps_to NULL so the
-- top unmapped predicates can be reviewed and folded in. That is how a
-- "closed-but-extensible" vocabulary actually extends.
insert into predicate_alias (raw, maps_to) values
  ('uses',            'depends_on'),
  ('queries',         'reads_from'),
  ('fetches_from',    'reads_from'),
  ('fetches',         'reads_from'),
  ('loads_from',      'reads_from'),
  ('gets_data_from',  'reads_from'),
  ('selects_from',    'reads_from'),
  ('persists_to',     'writes_to'),
  ('stores_in',       'writes_to'),
  ('saves_to',        'writes_to'),
  ('inserts_into',    'writes_to'),
  ('calls_api',       'calls'),
  ('requests',        'calls'),
  ('invokes',         'calls'),
  ('http_calls',      'calls'),
  ('publishes',       'publishes_to'),
  ('emits_to',        'publishes_to'),
  ('consumes',        'subscribes_to'),
  ('listens_to',      'subscribes_to'),
  ('cached_in',       'caches_in'),
  ('caches',          'caches_in'),
  ('deployed_by',     'provisioned_by'),
  ('provisioned_in',  'provisioned_by'),
  ('managed_by',      'provisioned_by'),
  ('terraformed_by',  'provisioned_by'),
  ('in_repo',         'lives_in_repo'),
  ('source_in',       'lives_in_repo'),
  ('lives_in',        'lives_in_repo'),
  ('runs_in',         'deployed_to'),
  ('hosted_in',       'deployed_to'),
  ('owned_by_team',   'owned_by'),
  ('falls_back',      'falls_back_to'),
  ('fallback_to',     'falls_back_to');
