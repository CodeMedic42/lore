-- Two things.
--
-- 1. Fix cross_repo_edges. It required BOTH ends of an edge to sit directly in a
--    repo via lives_in_repo, so "client calls endpoint" never counted - an
--    endpoint does not live in a repo, it is exposed by a service that does. The
--    metric reported 0% on a graph full of cross-repo edges, which is the worst
--    kind of wrong for the number that decides whether the premise holds.
--
-- 2. Where repositories are checked out on THIS machine. Per-machine config, so
--    it belongs next to the data rather than in the repo.

create function entity_repo(at timestamptz)
returns table (entity_id uuid, repo uuid)
language sql stable as $$
  with e as materialized (select * from edges_canon(at)),
  direct as (
    select ec.subject as entity_id, ec.object as repo from e ec where ec.predicate = 'lives_in_repo'
    union
    select ec.object, ec.subject from e ec where ec.predicate = 'contains_project'
  ),
  -- one inherited hop: things that have no repo of their own but belong to
  -- something that does.
  inherited as (
    select ec.object as entity_id, d.repo
      from e ec join direct d on d.entity_id = ec.subject
     where ec.predicate = 'exposes_endpoint'
    union
    select ec.subject, d.repo
      from e ec join direct d on d.entity_id = ec.object
     where ec.predicate in ('provisioned_by', 'part_of')
  )
  select entity_id, repo from direct
  union
  select entity_id, repo from inherited;
$$;

create or replace function cross_repo_edges(at timestamptz)
returns table (proposition_id uuid, subject_repo text, object_repo text)
language sql stable as $$
  with e as materialized (select * from edges_canon(at)),
  er as materialized (select * from entity_repo(at))
  select distinct ec.proposition_id, rs.display_name, ro.display_name
    from e ec
    join er s  on s.entity_id = ec.subject
    join er o  on o.entity_id = ec.object
    join entity rs on rs.id = s.repo
    join entity ro on ro.id = o.repo
   where ec.predicate not in ('lives_in_repo', 'contains_project')
     and s.repo <> o.repo
     -- not merely "some repos differ": the two ends must share NO repo at all
     and not exists (
       select 1 from er a join er b on a.repo = b.repo
        where a.entity_id = ec.subject and b.entity_id = ec.object);
$$;

-- Where a repository is checked out locally. Without this the system can still
-- answer "the component is over there, here is the URL"; with it, it can open the
-- file and read the detail.
create table repo_location (
  repo_key   text primary key,   -- matches an entity_identifier value, or a repo display name
  local_path text not null,
  browse_url text,               -- e.g. https://gitlab.com/acme/library-a
  branch     text default 'main',
  added_at   timestamptz not null default now()
);
