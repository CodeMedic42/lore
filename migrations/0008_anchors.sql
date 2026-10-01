-- Evidence anchors, and anchor state as a STATE rather than a score.
--
-- Background in plain terms: when an agent says "Service C reads Redis", it points
-- at some lines of code as proof. Later, that code changes. The question is how we
-- notice, and what we do about it.
--
-- The original plan multiplied the trust score by an "anchor integrity" factor:
-- 1.0 if the file is untouched, 0.3 if modified, 0.0 if deleted. The problem is
-- that a pure reformatting scores 0.3 (looks broken, isn't) while a one-line change
-- that inverts the logic elsewhere in the file scores 1.0 (looks fine, isn't). The
-- number would be uncalibrated, and nobody could tell whether it meant anything.
--
-- Instead: record WHAT the agent looked at, detect when it changes, and move the
-- evidence into a state. A changed anchor does not quietly lower a score - it puts
-- the claim in a re-verification queue and says so on the answer.

create table evidence_anchor (
  id               bigserial primary key,
  assertion_id     uuid not null references assertion(id) on delete cascade,
  repo             text,
  commit_sha       text,
  path             text not null,
  line_from        integer,
  line_to          integer,
  -- sha256 of the anchored lines AFTER whitespace normalisation, so reindenting,
  -- reflowing or reformatting does not read as a semantic change.
  span_sha256      bytea,
  -- the function/class the lines sat inside. Line numbers do not survive edits
  -- above them; an enclosing symbol usually does.
  enclosing_symbol text,
  -- compiler-accurate cross-repo identity for the symbol, when known.
  scip_symbol      text,
  state            text not null default 'unchecked',  -- unchecked | ok | moved | gone
  moved_to_from    integer,
  moved_to_to      integer,
  checked_at       timestamptz,
  checked_commit   text
);
create index evidence_anchor_assertion_idx on evidence_anchor (assertion_id);
create index evidence_anchor_file_idx      on evidence_anchor (repo, path);
create index evidence_anchor_state_idx     on evidence_anchor (state) where state in ('moved', 'gone');

-- Roll anchor states up to the edge. Deliberately NOT part of trust: this is
-- reported alongside an answer, not folded into a number.
create function proposition_anchor_state(at timestamptz)
returns table (
  proposition_id       uuid,
  anchors              integer,
  moved                integer,
  gone                 integer,
  needs_reverification boolean
)
language sql stable as $$
  select a.proposition_id,
         count(ea.id)::integer,
         count(*) filter (where ea.state = 'moved')::integer,
         count(*) filter (where ea.state = 'gone')::integer,
         bool_or(ea.state in ('moved', 'gone'))
    from assertion a
    join evidence_anchor ea on ea.assertion_id = a.id
   where a.created_at <= at
     and (a.expired_at is null or a.expired_at > at)
     and (a.valid_to   is null or a.valid_to   >  at)
     and a.polarity
   group by a.proposition_id;
$$;

-- The work list for the verification agent, most-suspect first.
create view reverification_queue as
  select ea.id            as anchor_id,
         ea.assertion_id,
         a.proposition_id,
         ea.repo, ea.path, ea.line_from, ea.line_to,
         ea.enclosing_symbol, ea.scip_symbol,
         ea.state, ea.checked_at,
         a.method, a.asserted_by, a.created_at as asserted_at,
         p.predicate
    from evidence_anchor ea
    join assertion a   on a.id = ea.assertion_id
    join proposition p on p.id = a.proposition_id
   where ea.state in ('moved', 'gone')
     and a.valid_to is null
     and a.expired_at is null
   order by case ea.state when 'gone' then 0 else 1 end, ea.checked_at desc nulls last;

-- Authorities for strong identifiers. These are a uniqueness CONSTRAINT, so a
-- typo that splits 'gitlab_project' from 'gitlab-project' silently destroys the
-- guarantee. Recording them makes the set reviewable and coverage measurable.
create table identifier_authority (
  name        text primary key,
  description text,
  example     text
);

insert into identifier_authority (name, description, example) values
  ('gitlab_project', 'GitLab numeric project id or full path', 'gitlab:4412'),
  ('git_remote',     'Normalised git remote URL',              'gitlab.com/acme/service-c'),
  ('arn',            'AWS resource ARN',                       'arn:aws:rds:eu-west-1:1111:db:notifications'),
  ('tf_address',     'Terraform resource or module address',   'module.notifications_db'),
  ('otel_service',   'OpenTelemetry service.name (+namespace)','notifications/service-c'),
  ('k8s',            'Kubernetes workload uid or path',        'k8s://prod/apps/deploy/service-c'),
  ('url',            'Canonical URL for the thing',            'https://api.acme.io/notifications'),
  -- Compiler-accurate, version-aware, cross-repo identity for a code symbol.
  -- Two importers emitting the same SCIP symbol are talking about the same thing
  -- by construction, which is the strongest identity signal available for code.
  ('scip_symbol',    'SCIP symbol: scheme manager package version descriptors',
                     'scip-typescript npm @acme/service-c 1.4.0 `src/notifications/cache.ts`/readNotifications().');
