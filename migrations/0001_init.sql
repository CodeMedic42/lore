-- Living AI Knowledge - initial schema
--
-- Design note: the load-bearing decision in this schema is the split between
-- PROPOSITION (the edge; deduplicated, content-addressed) and ASSERTION (someone
-- saying it; many per proposition, each with polarity, provenance and validity).
-- Collapsing these into one table makes corroboration a fuzzy row-match and makes
-- refutation inexpressible.

-- ---------------------------------------------------------------------------
-- Entities: a thin identity spine. All content hangs off assertions.
-- ---------------------------------------------------------------------------

create table entity (
  id            uuid primary key default gen_random_uuid(),
  -- Canonicalisation is a READ-TIME indirection. Merges never rewrite foreign
  -- keys, so an incorrect merge is revertible. Path-compressed on merge.
  canonical_id  uuid not null,
  kind          text not null,
  -- env is a first-class discriminator, not a tag: if prod-redis and staging-redis
  -- ever merge, "how do I connect" answers confidently wrong.
  env           text not null default 'unknown',
  display_name  text not null,
  provisional   boolean not null default true,
  created_at    timestamptz not null default now()
);
create index entity_canonical_idx on entity (canonical_id);
create index entity_kind_env_idx  on entity (kind, env);

-- STRONG identifiers. The primary key IS the resolution rule: two mentions
-- carrying the same (authority, value) are the same thing, by constraint.
create table entity_identifier (
  entity_id  uuid not null references entity(id) on delete cascade,
  authority  text not null,   -- gitlab_project | git_remote | arn | tf_address | otel_service | k8s | url
  value      text not null,
  primary key (authority, value)
);
create index entity_identifier_entity_idx on entity_identifier (entity_id);

-- WEAK aliases. Never unique, never sufficient for an automatic merge.
create table entity_alias (
  id         bigserial primary key,
  entity_id  uuid not null references entity(id) on delete cascade,
  name_norm  text not null,
  scope      text,            -- e.g. the repo the name was observed in
  source     text,
  score      real not null default 0.5
);
create index entity_alias_norm_idx  on entity_alias (name_norm);
create unique index entity_alias_uniq on entity_alias (entity_id, name_norm, coalesce(scope, ''));

create table entity_merge (
  id          bigserial primary key,
  from_id     uuid not null references entity(id),
  into_id     uuid not null references entity(id),
  score       real,
  reason      text,
  decided_by  text,
  decided_at  timestamptz not null default now(),
  reverted_at timestamptz
);

-- Negative evidence is as important as positive: once a human says prod != staging,
-- the resolver is permanently barred from re-proposing that merge.
create table entity_distinct (
  a          uuid not null references entity(id),
  b          uuid not null references entity(id),
  reason     text,
  decided_by text,
  created_at timestamptz not null default now(),
  primary key (a, b)
);

-- ---------------------------------------------------------------------------
-- Predicate vocabulary: closed-but-extensible. Unknown predicates are never
-- rejected at the door; they land in predicate_alias unmapped for later review.
-- ---------------------------------------------------------------------------

create table predicate (
  name          text primary key,
  -- functional = at most one live value per subject. A new assertion auto-expires
  -- the prior one. Most predicates are NOT functional and must not do this.
  functional    boolean not null default false,
  subject_kinds text[],
  object_kinds  text[],
  description   text
);

create table predicate_alias (
  raw       text primary key,
  maps_to   text references predicate(name),   -- null = unmapped, awaiting review
  hits      integer not null default 1,
  last_seen timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Propositions and assertions
-- ---------------------------------------------------------------------------

create table proposition (
  id             uuid primary key default gen_random_uuid(),
  -- exactly one of subject_entity / subject_prop. subject_prop is how claims
  -- ABOUT claims (and descriptive qualifiers like ttl_seconds) are expressed.
  subject_entity uuid references entity(id),
  subject_prop   uuid references proposition(id),
  predicate      text not null,
  object_entity  uuid references entity(id),
  object_literal text,
  -- IDENTIFYING qualifiers only; these are inside the fingerprint. Descriptive
  -- qualifiers become separate propositions about this one.
  qualifiers     jsonb not null default '{}',
  fingerprint    bytea not null unique,
  created_at     timestamptz not null default now(),
  constraint subject_xor check ((subject_entity is null) <> (subject_prop is null)),
  constraint object_xor  check ((object_entity  is null) <> (object_literal is null))
);
create index proposition_subject_idx on proposition (subject_entity);
create index proposition_object_idx  on proposition (object_entity);
create index proposition_pred_idx    on proposition (predicate);

create table assertion (
  id             uuid primary key default gen_random_uuid(),
  proposition_id uuid not null references proposition(id) on delete cascade,
  -- false = refutation. Without this the verification agent can confirm but
  -- never contradict, which makes the whole verification loop toothless.
  polarity       boolean not null default true,
  method         text not null,   -- llm_inferred | code_derived | telemetry | human | verifier
  confidence     real,
  asserted_by    text,
  session_id     text,
  evidence       jsonb not null default '[]',
  -- world time: when the fact was/is true of the system
  valid_from     timestamptz,
  valid_to       timestamptz,
  -- system time: when we knew it. v0 writes created_at only.
  created_at     timestamptz not null default now(),
  expired_at     timestamptz,
  -- closed-world snapshot tag, e.g. 'gitlab:4412@static-scan-v3'. Scope sweeps
  -- close anything bearing this key that a later run did not re-assert.
  scope_key      text,
  raw_subject    text,
  raw_predicate  text,
  raw_object     text
);
create index assertion_prop_idx  on assertion (proposition_id);
create index assertion_scope_idx on assertion (scope_key) where scope_key is not null;

-- Every raw mention is kept verbatim regardless of how it resolved, so a bad
-- resolution can always be re-run against the original text.
create table mention (
  id              bigserial primary key,
  assertion_id    uuid not null references assertion(id) on delete cascade,
  role            text not null,            -- subject | object
  raw_text        text not null,
  resolved_entity uuid references entity(id),
  resolver        text,                     -- strong_id | alias | fuzzy | minted
  score           real
);
create index mention_assertion_idx on mention (assertion_id);

create table ingest_batch (
  idempotency_key text primary key,
  received_at     timestamptz not null default now(),
  response        jsonb
);
