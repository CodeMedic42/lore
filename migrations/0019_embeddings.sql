-- Semantic search, for the one question the graph cannot otherwise answer:
-- "is there already something that does X?" when you do not know its name.
--
-- Everything else here is structural on purpose - embeddings never choose a hop,
-- because vector similarity returns plausible DISCONNECTED facts and the whole
-- value of this system is the connected path. Their job is strictly to pick an
-- entry point when a name-based match finds nothing.
--
-- Stored as real[] rather than pgvector's own type so the column works unchanged
-- on PGlite, which has no vector extension. Where pgvector IS installed it casts
-- for free (real[]::vector) and does the distance maths in SIMD; where it is not,
-- the search falls back to computing cosine in process, which at personal scale
-- is indistinguishable.

create table entity_embedding (
  entity_id    uuid primary key references entity(id) on delete cascade,
  model        text not null,
  dims         integer not null,
  embedding    real[] not null,
  -- the text that was embedded, kept so a change can be detected without re-running
  -- the model, and so a bad match can be explained
  profile      text not null,
  profile_hash bytea not null,
  updated_at   timestamptz not null default now()
);
create index entity_embedding_model_idx on entity_embedding (model);

create function has_pgvector() returns boolean
language sql stable as $$
  select exists (select 1 from pg_extension where extname = 'vector');
$$;
