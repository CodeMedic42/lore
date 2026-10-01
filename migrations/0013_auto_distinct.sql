-- Don't ask questions the graph can already answer.
--
-- Name similarity flagged "GET /v1/notifications" and "POST /v1/notifications"
-- as possibly the same thing - they differ by four characters. But they carry
-- different method qualifiers, and two routes with different HTTP methods are
-- different routes by definition. No human should be spending attention on that.
--
-- A question mechanism lives or dies on question quality: ask three obvious ones
-- and the user stops reading them, and then nothing is ever learned.

create function auto_distinguish_endpoints(at timestamptz)
returns integer
language plpgsql as $$
declare
  n integer := 0;
begin
  with sig as (select * from endpoint_signatures(at)),
  obvious as (
    select mc.id, mc.from_id, mc.into_id
      from merge_candidate mc
      join entity a on a.id = mc.from_id and a.kind = 'endpoint'
      join entity b on b.id = mc.into_id and b.kind = 'endpoint'
      join sig sa on sa.entity_id = mc.from_id
      join sig sb on sb.entity_id = mc.into_id
     where mc.resolved_at is null
       and (sa.path is distinct from sb.path or sa.method is distinct from sb.method)
  ),
  marked as (
    insert into entity_distinct (a, b, reason, decided_by)
    select least(from_id, into_id), greatest(from_id, into_id),
           'different HTTP route signature (path or method)', 'system:auto'
      from obvious
    on conflict (a, b) do nothing
    returning 1
  )
  update merge_candidate mc
     set resolved_at = now(), resolution = 'distinct'
    from obvious o
   where mc.id = o.id;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- And never re-propose a pair someone (or the rule above) already settled.
drop function if exists knowledge_gaps(timestamptz);

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
   and not exists (
     select 1 from entity_distinct d
      where (d.a = mc.from_id and d.b = mc.into_id)
         or (d.a = mc.into_id and d.b = mc.from_id))

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

