-- Split "moved" into two outcomes, because they mean opposite things.
--
--   shifted : identical code, different line numbers (someone edited above it).
--             The evidence is INTACT. Heal the line numbers and stay trusted -
--             demanding re-verification here would flood the queue with noise
--             every time anyone adds an import.
--   changed : the code itself is different. THIS is what needs a human or the
--             verification agent to look again.
--
-- Collapsing these was the bug: it made a harmless edit above a function look
-- identical to the function's logic being rewritten.

update evidence_anchor set state = 'changed' where state = 'moved';

drop view if exists reverification_queue;
drop function if exists proposition_anchor_state(timestamptz);

create function proposition_anchor_state(at timestamptz)
returns table (
  proposition_id       uuid,
  anchors              integer,
  shifted              integer,
  changed              integer,
  gone                 integer,
  needs_reverification boolean
)
language sql stable as $$
  select a.proposition_id,
         count(ea.id)::integer,
         count(*) filter (where ea.state = 'shifted')::integer,
         count(*) filter (where ea.state = 'changed')::integer,
         count(*) filter (where ea.state = 'gone')::integer,
         bool_or(ea.state in ('changed', 'gone'))
    from assertion a
    join evidence_anchor ea on ea.assertion_id = a.id
   where a.created_at <= at
     and (a.expired_at is null or a.expired_at > at)
     and (a.valid_to   is null or a.valid_to   >  at)
     and a.polarity
   group by a.proposition_id;
$$;

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
   where ea.state in ('changed', 'gone')
     and a.valid_to is null
     and a.expired_at is null
   order by case ea.state when 'gone' then 0 else 1 end, ea.checked_at desc nulls last;
