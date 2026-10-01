-- Knowledge gaps: the things the system knows it does NOT know.
--
-- Mirror image of the re-verification queue. That one says "this may have gone
-- stale"; this one says "this was never known". Together they are the agent's
-- to-do list - and this one is what lets it ask a USEFUL question instead of an
-- annoying one.
--
-- Every gap here is mechanically detectable from the shape of the graph. Nothing
-- is guessed.

create function knowledge_gaps(at timestamptz)
returns table (
  gap_kind     text,
  entity_id    uuid,
  entity_name  text,
  entity_kind  text,
  entity_env   text,
  detail       jsonb,
  base_score   real,
  connectivity integer
)
language sql stable as $$
with e as materialized (select * from edges_canon(at)),
live as (
  select id, display_name, kind, env, provisional
    from entity where canonical_id = id
),
conn as (
  select l.id, count(e.proposition_id)::integer as n
    from live l
    left join e on e.subject = l.id or e.object = l.id
   group by l.id
),
tech_preds as (select name from predicate where family = 'technology')

-- 1. Two similar names, same kind, unresolved. Ranked highest because an
--    unnoticed collision corrupts every answer about either one, silently.
--    (This is the "new Angular client alongside the old React one" case.)
select 'name_collision', l.id, l.display_name, l.kind, l.env,
       jsonb_build_object('other_id', mc.into_id, 'other_name', o.display_name, 'similarity', mc.score),
       0.95::real, coalesce(c.n, 0)
  from merge_candidate mc
  join live l on l.id = mc.from_id
  join entity o on o.id = mc.into_id
  left join conn c on c.id = l.id
 where mc.resolved_at is null

union all

-- 2. Something calls this endpoint, but nothing in the graph serves it. This is
--    the highest-value ordinary gap: answering it JOINS TWO REPOSITORIES.
select 'dangling_endpoint', l.id, l.display_name, l.kind, l.env,
       jsonb_build_object('called_by',
         (select jsonb_agg(distinct se.display_name)
            from e ce join entity se on se.id = ce.subject
           where ce.object = l.id and ce.predicate = 'calls')),
       0.90::real, coalesce(c.n, 0)
  from live l left join conn c on c.id = l.id
 where l.kind = 'endpoint'
   and exists (select 1 from e where e.object = l.id and e.predicate = 'calls')
   and not exists (select 1 from e where e.object = l.id and e.predicate = 'exposes_endpoint')

union all

-- 3. A project with no home repository - can't navigate to its source.
select 'homeless_project', l.id, l.display_name, l.kind, l.env, '{}'::jsonb,
       0.80::real, coalesce(c.n, 0)
  from live l left join conn c on c.id = l.id
 where l.kind in ('client', 'service', 'iac_module')
   and not exists (select 1 from e where e.subject = l.id and e.predicate = 'lives_in_repo')

union all

-- 4. A database nobody recorded how to reach. Blocks "how do I connect to it".
select 'no_access_info', l.id, l.display_name, l.kind, l.env, '{}'::jsonb,
       0.60::real, coalesce(c.n, 0)
  from live l left join conn c on c.id = l.id
 where l.kind in ('datastore', 'cache', 'queue')
   and not exists (select 1 from e where e.subject = l.id and e.predicate = 'connect_via')

union all

-- 5. A project whose language, framework and build tooling are unknown.
select 'unknown_technology', l.id, l.display_name, l.kind, l.env, '{}'::jsonb,
       0.55::real, coalesce(c.n, 0)
  from live l left join conn c on c.id = l.id
 where l.kind in ('client', 'service')
   and not exists (
     select 1 from e where e.subject = l.id and e.predicate in (select name from tech_preds))

union all

-- 6. Infrastructure with no owning IaC module - nobody knows what creates it.
select 'unprovisioned_infra', l.id, l.display_name, l.kind, l.env, '{}'::jsonb,
       0.50::real, coalesce(c.n, 0)
  from live l left join conn c on c.id = l.id
 where l.kind in ('datastore', 'cache', 'queue', 'cloud_resource')
   and not exists (select 1 from e where e.subject = l.id and e.predicate = 'provisioned_by')

union all

-- 7. A capability or data concept with no description. These exist precisely to
--    be matched against a question in plain English, so an unnamed one is inert.
select 'undescribed_concept', l.id, l.display_name, l.kind, l.env, '{}'::jsonb,
       0.45::real, coalesce(c.n, 0)
  from live l left join conn c on c.id = l.id
 where l.kind in ('capability', 'data_concept')
   and not exists (select 1 from e where e.subject = l.id and e.predicate = 'note')

union all

-- 8. A well-connected entity still identified only by its name. Resolution is
--    guessing here, and a guess at this connectivity is expensive to get wrong.
select 'unidentified_entity', l.id, l.display_name, l.kind, l.env, '{}'::jsonb,
       0.40::real, coalesce(c.n, 0)
  from live l left join conn c on c.id = l.id
 where l.provisional
   and coalesce(c.n, 0) >= 2
   and not exists (select 1 from entity_identifier i where i.entity_id = l.id)

union all

-- 9. Known to exist, connected to nothing. Someone mentioned it once.
select 'orphan_entity', l.id, l.display_name, l.kind, l.env, '{}'::jsonb,
       0.30::real, 0
  from live l left join conn c on c.id = l.id
 where coalesce(c.n, 0) = 0
   and l.kind not in ('technology');
$$;

-- The signature of an endpoint, taken from whatever edge mentions it. Needed to
-- match a call site in one repo against a route definition in another.
create function endpoint_signatures(at timestamptz)
returns table (entity_id uuid, path text, method text)
language sql stable as $$
  select distinct
         coalesce(ec.object, ec.subject),
         lower(ec.qualifiers->>'path'),
         upper(coalesce(ec.qualifiers->>'method', 'GET'))
    from edges_canon(at) ec
    join entity e on e.id = coalesce(ec.object, ec.subject)
   where e.kind = 'endpoint'
     and ec.qualifiers ? 'path';
$$;

-- Proposed cross-repo joins.
--
-- One repo says "I call GET /v1/notifications". Another, recorded weeks later by
-- someone else, says "I serve GET /v1/notifications". Those are two separate
-- endpoint entities until something notices they are the same route.
--
-- This PROPOSES the join. It never asserts it - same rule as merge candidates,
-- because a path collision across two unrelated systems is entirely possible.
create function endpoint_join_candidates(at timestamptz)
returns table (
  called_endpoint uuid,
  called_name     text,
  served_endpoint uuid,
  served_name     text,
  path            text,
  method          text,
  served_by       uuid,
  served_by_name  text
)
language sql stable as $$
  with sig as (select * from endpoint_signatures(at)),
  e as (select * from edges_canon(at)),
  called as (
    select s.* from sig s
     where exists (select 1 from e where e.object = s.entity_id and e.predicate = 'calls')
       and not exists (select 1 from e where e.object = s.entity_id and e.predicate = 'exposes_endpoint')
  ),
  served as (
    select s.*, e.subject as server
      from sig s
      join e on e.object = s.entity_id and e.predicate = 'exposes_endpoint'
  )
  select c.entity_id, ce.display_name,
         sv.entity_id, se.display_name,
         c.path, c.method,
         sv.server, sb.display_name
    from called c
    join served sv on sv.path = c.path and sv.method = c.method and sv.entity_id <> c.entity_id
    join entity ce on ce.id = c.entity_id
    join entity se on se.id = sv.entity_id
    join entity sb on sb.id = sv.server;
$$;
