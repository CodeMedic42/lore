-- Trust scoring and the derived "live edge" view.
--
-- IMPORTANT: this scoring is an explicit HYPOTHESIS, not settled design. The plan
-- calls for measuring AUC of trust against hand-labelled truth before relying on
-- it. anchor_integrity (is the evidence commit's path unchanged at HEAD?) is
-- deliberately absent from v0 - it needs a git host round-trip, which the write
-- path is forbidden from doing.

-- How much a method is worth before any decay.
create function method_base(m text) returns real
language sql immutable as $$
  select case m
    when 'human'        then 0.95::real
    when 'telemetry'    then 0.90::real
    when 'code_derived' then 0.85::real
    when 'verifier'     then 0.80::real
    when 'llm_inferred' then 0.40::real
    else 0.30::real
  end;
$$;

-- Exponential decay with a per-method half-life. Telemetry goes stale fast
-- (it describes a moment); human statements of intent age slowly.
create function method_half_life_days(m text) returns real
language sql immutable as $$
  select case m
    when 'telemetry'    then 14::real
    when 'llm_inferred' then 30::real
    when 'verifier'     then 60::real
    when 'code_derived' then 90::real
    when 'human'        then 180::real
    else 30::real
  end;
$$;

create function freshness(m text, ts timestamptz, at timestamptz) returns real
language sql stable as $$
  select exp(
    -ln(2) * greatest(extract(epoch from (at - ts)), 0)
           / (86400 * method_half_life_days(m))
  )::real;
$$;

-- An assertion is live at time `at` if system time has not expired it and world
-- time still covers it. Scope sweeps and functional-predicate supersession both
-- work by setting valid_to, which is what removes a stale edge from traversal.
-- Trust decay alone would leave the edge present but merely down-weighted.
create function assertions_live(at timestamptz)
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
  where (a.expired_at is null or a.expired_at > at)
    and (a.valid_from is null or a.valid_from <= at)
    and (a.valid_to   is null or a.valid_to   >  at);
$$;

-- The live edge set, with trust derived from supporting and refuting assertions.
--   support      = strongest supporting assertion
--   corroboration= small bump for independent METHODS agreeing (not row count -
--                  ten calls from one agent is one opinion)
--   refute       = strongest refutation, subtracted outright
create function edges_at(at timestamptz)
returns table (
  proposition_id uuid,
  subject_entity uuid,
  predicate      text,
  object_entity  uuid,
  object_literal text,
  qualifiers     jsonb,
  trust          real,
  support_count  integer,
  refute_count   integer
)
language sql stable as $$
  with live as (select * from assertions_live(at)),
  agg as (
    select l.proposition_id,
           max(l.weight) filter (where l.polarity)            as support,
           max(l.weight) filter (where not l.polarity)        as refute,
           count(*)      filter (where l.polarity)            as support_count,
           count(*)      filter (where not l.polarity)        as refute_count,
           count(distinct l.method) filter (where l.polarity) as methods
    from live l
    group by l.proposition_id
  )
  select p.id,
         p.subject_entity,
         p.predicate,
         p.object_entity,
         p.object_literal,
         p.qualifiers,
         greatest(
           0.0,
           coalesce(agg.support, 0) * least(1.0 + 0.1 * greatest(agg.methods - 1, 0), 1.2)
             - coalesce(agg.refute, 0)
         )::real,
         coalesce(agg.support_count, 0)::integer,
         coalesce(agg.refute_count, 0)::integer
  from proposition p
  join agg on agg.proposition_id = p.id
  where agg.support is not null;
$$;

create view edge_now as select * from edges_at(now());
