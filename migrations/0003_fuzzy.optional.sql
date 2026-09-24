-- Optional: trigram matching for the fuzzy rung of the resolution ladder.
-- Skipped automatically on drivers that do not ship pg_trgm (e.g. base PGlite),
-- in which case the resolver falls back to in-process scoring.
create extension if not exists pg_trgm;
create index if not exists entity_alias_trgm_idx on entity_alias using gin (name_norm gin_trgm_ops);
