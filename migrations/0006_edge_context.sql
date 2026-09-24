-- Fix: an annotation edge must not lose its context.
--
-- "Service C reads Redis, falling back to Postgres" is a 3-ary fact. Projecting
-- it as a bare binary edge (Redis -> falls_back_to -> Postgres) drops the subject,
-- so ANY service touching that Redis appears to fall back to the notifications
-- database. That is a confidently-wrong answer, which is worse than no answer.
--
-- Fix: a derived edge carries `via_proposition` - the parent edge it belongs to.
-- The traversal may only take that hop if it ARRIVED along that exact parent.

drop function if exists edges_canon(timestamptz);

create function edges_canon(at timestamptz)
returns table (
  proposition_id  uuid,
  subject         uuid,
  predicate       text,
  object          uuid,
  object_literal  text,
  qualifiers      jsonb,
  trust           real,
  derived         boolean,
  via_proposition uuid
)
language sql stable as $$
  with e as (select * from edges_at(at))
  select e.proposition_id, se.canonical_id, e.predicate, oe.canonical_id,
         e.object_literal, e.qualifiers, e.trust, false, null::uuid
    from e
    join entity se on se.id = e.subject_entity
    left join entity oe on oe.id = e.object_entity
   where e.subject_entity is not null

  union all

  select e.proposition_id, poe.canonical_id, e.predicate, oe.canonical_id,
         null::text, e.qualifiers, e.trust, true, parent.id
    from e
    join proposition child  on child.id = e.proposition_id
    join proposition parent on parent.id = child.subject_prop
    join entity poe on poe.id = parent.object_entity
    join entity oe  on oe.id = e.object_entity
   where child.subject_prop is not null
     and parent.object_entity is not null
     and e.object_entity is not null;
$$;
