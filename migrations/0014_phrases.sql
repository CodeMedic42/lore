-- Surface forms: how people actually say each predicate out loud.
--
-- The vocabulary already has machine-ish names (reads_from) and agent-ish aliases
-- (fetches_from). This is the third layer: the phrases a person types into a chat
-- box. Longest match wins, so "stores in" beats "stores" and "is built with"
-- beats "is built".

create table predicate_phrase (
  phrase    text primary key,
  predicate text not null references predicate(name),
  -- when set, only use this phrase if the object looks like this kind
  object_kind_hint text
);

insert into predicate_phrase (phrase, predicate) values
  ('is written in','written_in'), ('written in','written_in'),
  ('is implemented in','written_in'), ('is coded in','written_in'),
  ('is styled with','written_in'), ('styled with','written_in'),

  ('uses the framework','uses_framework'), ('is built on','uses_framework'),
  ('is written using','uses_framework'), ('written using','uses_framework'),

  ('is built with','built_with'), ('built with','built_with'),
  ('is bundled with','built_with'), ('bundled with','built_with'),
  ('is packaged with','built_with'), ('builds with','built_with'),
  ('is compiled with','built_with'),

  ('is tested with','tests_with'), ('tested with','tests_with'),
  ('tests with','tests_with'),

  ('depends on the package','depends_on_package'), ('uses the library','depends_on_package'),
  ('depends on','depends_on_package'),

  ('makes a request to','calls'), ('sends requests to','calls'),
  ('calls into','calls'), ('calls','calls'), ('hits','calls'), ('requests','calls'),

  ('reads from','reads_from'), ('loads from','reads_from'), ('fetches from','reads_from'),
  ('gets data from','reads_from'), ('queries','reads_from'), ('reads','reads_from'),

  ('writes to','writes_to'), ('saves to','writes_to'), ('stores in','writes_to'),
  ('persists to','writes_to'), ('inserts into','writes_to'),

  ('publishes to','publishes_to'), ('emits to','publishes_to'), ('sends messages to','publishes_to'),
  ('subscribes to','subscribes_to'), ('consumes from','subscribes_to'), ('listens to','subscribes_to'),
  ('caches data in','caches_in'), ('caches in','caches_in'),
  ('falls back to','falls_back_to'), ('falls back on','falls_back_to'),

  ('lives in the repo','lives_in_repo'), ('lives in repo','lives_in_repo'),
  ('is in the repo','lives_in_repo'), ('is in repo','lives_in_repo'),
  ('source lives in','lives_in_repo'), ('lives in','lives_in_repo'),

  ('exposes the route','exposes_endpoint'), ('defines the route','exposes_endpoint'),
  ('exposes','exposes_endpoint'), ('defines','exposes_endpoint'),
  ('serves','exposes_endpoint'), ('handles the route','exposes_endpoint'),

  ('is provisioned by','provisioned_by'), ('provisioned by','provisioned_by'),
  ('is created by','provisioned_by'), ('is managed by','provisioned_by'),
  ('is terraformed by','provisioned_by'),

  ('is deployed to','deployed_to'), ('deployed to','deployed_to'),
  ('runs in','deployed_to'), ('runs on','deployed_to'),

  ('is owned by','owned_by'), ('owned by','owned_by'),
  ('is part of','part_of'), ('part of','part_of'),

  ('implements','implements'), ('provides','implements'),
  ('is responsible for','implements'),

  ('handles the data','handles_data'), ('handles','handles_data'),
  ('processes','handles_data'),

  ('is the replacement for','supersedes'), ('is replacing','supersedes'),
  ('replaces','supersedes'), ('supersedes','supersedes'),

  ('is built by','built_by'), ('is deployed by the pipeline','built_by'),
  ('monitors','monitors'), ('alerts on','monitors'), ('watches','monitors'),
  ('is documented at','documented_at'), ('is reachable at','serves_at'),
  ('is served at','serves_at'), ('is hosted at','serves_at');

-- 'uses' is genuinely ambiguous. Resolve it by looking at what the object IS:
-- a known technology makes it a framework claim, anything else a dependency.
insert into predicate_phrase (phrase, predicate, object_kind_hint) values
  ('uses', 'uses_framework', 'technology'),
  ('is using', 'uses_framework', 'technology');
insert into predicate_phrase (phrase, predicate) values
  ('uses ', 'depends_on_package');
delete from predicate_phrase where phrase = 'uses ';
