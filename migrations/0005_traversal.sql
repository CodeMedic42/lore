-- Traversal-ready edge projection.
--
-- Two jobs:
--  1. Canonicalise. Propositions store the entity AS WRITTEN; merges only repoint
--     entity.canonical_id. So every read must pass through that indirection. This
--     is what makes an incorrect merge revertible.
--  2. Project annotation edges. `falls_back_to` is asserted ABOUT the edge
--     "Service C reads_from Redis" with a datastore as its object. To make that
--     reachable by a graph walk we derive an edge from the annotated edge's object
--     to the annotation's object: Redis --falls_back_to--> Postgres.

create function edges_canon(at timestamptz)
returns table (
  proposition_id uuid,
  subject        uuid,
  predicate      text,
  object         uuid,
  object_literal text,
  qualifiers     jsonb,
  trust          real,
  derived        boolean
)
language sql stable as $$
  with e as (select * from edges_at(at))
  -- direct entity -> entity (or literal) edges
  select e.proposition_id,
         se.canonical_id,
         e.predicate,
         oe.canonical_id,
         e.object_literal,
         e.qualifiers,
         e.trust,
         false
    from e
    join entity se on se.id = e.subject_entity
    left join entity oe on oe.id = e.object_entity
   where e.subject_entity is not null

  union all

  -- annotation edges: subject is another proposition, object is an entity
  select e.proposition_id,
         poe.canonical_id,
         e.predicate,
         oe.canonical_id,
         null::text,
         e.qualifiers,
         e.trust,
         true
    from e
    join proposition child on child.id = e.proposition_id
    join proposition parent on parent.id = child.subject_prop
    join entity poe on poe.id = parent.object_entity
    join entity oe  on oe.id = e.object_entity
   where child.subject_prop is not null
     and parent.object_entity is not null
     and e.object_entity is not null;
$$;

-- Annotations on an edge (ttl_seconds, note, ...), for narration rather than walking.
create function prop_annotations(at timestamptz)
returns table (
  about_proposition uuid,
  predicate         text,
  value             text,
  trust             real
)
language sql stable as $$
  select child.subject_prop, e.predicate, e.object_literal, e.trust
    from edges_at(at) e
    join proposition child on child.id = e.proposition_id
   where child.subject_prop is not null
     and e.object_literal is not null;
$$;
