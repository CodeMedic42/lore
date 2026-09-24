-- Fix 1: as_of must respect SYSTEM time as well as world time.
--
-- assertions_live filtered valid_from/valid_to but not created_at, so a query
-- "as of last week" returned facts written today. Bi-temporal means both axes.
create or replace function assertions_live(at timestamptz)
returns table (
  proposition_id uuid,
  polarity boolean,
  method text,
  weight real
)
language sql stable as $$
  select a.proposition_id,
         a.polarity,
         a.method,
         (method_base(a.method) * freshness(a.method, a.created_at, at) * coalesce(a.confidence, 1.0))::real
  from assertion a
  where a.created_at <= at                                    -- system time
    and (a.expired_at is null or a.expired_at > at)
    and (a.valid_from is null or a.valid_from <= at)          -- world time
    and (a.valid_to   is null or a.valid_to   >  at);
$$;

-- Fix 2: name similarity proposes, it never decides.
--
-- The resolver used to auto-accept a fuzzy name match above a threshold. On real
-- data that silently merges distinct things: "service-b" and "service-c" score
-- 0.88 on trigram/Dice similarity, as do "notifications-v1"/"notifications-v2"
-- and "user-api-eu"/"user-api-us". Over-merge poisons answers invisibly and
-- permanently, while under-merge merely leaves an island someone can spot.
--
-- So a near-miss now mints a separate entity and files a CANDIDATE for review.
create table merge_candidate (
  id           bigserial primary key,
  from_id      uuid not null references entity(id) on delete cascade,
  into_id      uuid not null references entity(id) on delete cascade,
  score        real not null,
  method       text not null,
  raw_text     text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolution   text          -- 'merged' | 'distinct'
);
create index merge_candidate_open_idx on merge_candidate (score desc) where resolved_at is null;
create unique index merge_candidate_pair_idx on merge_candidate (from_id, into_id) where resolved_at is null;
