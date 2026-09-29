-- Activity log.
--
-- Needed to answer the question this project cannot yet answer about itself:
-- does an agent actually use this while it works? The plan's biggest risk was
-- never the schema, it was whether anyone writes to it - and whether what they
-- write is worth keeping.
--
-- DELIBERATELY CONTENT-FREE. `summary` holds counts, predicate names, kinds and
-- outcomes; never entity names, literals, file paths or code. That is what makes
-- this table safe to export from a work machine and read somewhere else. The
-- sensitive material lives in the graph itself, and the report tool redacts it
-- separately and on purpose.

create table activity (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  source      text not null,              -- mcp | http | cli
  tool        text not null,              -- tool or endpoint name
  session     text,
  agent       text,
  ok          boolean not null default true,
  duration_ms integer,
  summary     jsonb not null default '{}',
  error       text
);
create index activity_at_idx   on activity (at desc);
create index activity_tool_idx on activity (tool, at desc);

-- Was a recorded edge one that a single-repo session could NOT have seen?
-- This is the number that decides whether the premise of the project holds:
-- if agents only ever restate what is in the file in front of them, the
-- valuable cross-repo facts are not arriving and the product is really an
-- importer with annotations.
create function cross_repo_edges(at timestamptz)
returns table (proposition_id uuid, subject_repo text, object_repo text)
language sql stable as $$
  with e as (select * from edges_canon(at)),
  -- which repo each entity belongs to, via lives_in_repo
  home as (
    select ec.subject as entity_id, r.display_name as repo
      from e ec join entity r on r.id = ec.object
     where ec.predicate = 'lives_in_repo'
  )
  select ec.proposition_id, hs.repo, ho.repo
    from e ec
    join home hs on hs.entity_id = ec.subject
    join home ho on ho.entity_id = ec.object
   where ec.predicate <> 'lives_in_repo'
     and hs.repo is distinct from ho.repo;
$$;
