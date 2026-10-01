-- Environment is a property of a DEPLOYED thing, not of source code.
--
-- The bug this fixes, found on the first real agent run: the extractor defaults
-- env='prod', record_observations without an explicit env defaults to 'unknown',
-- and resolveEntity partitions HARD on env. So every observation an agent made
-- about a scanned package created a twin - same name, same kind, split only by
-- an environment neither of them meaningfully has.
--
-- A package does not have a prod and a staging version; it is one package. A
-- database does. So env only partitions the kinds where an environment is a real
-- distinction, and code-artifact kinds are normalised to 'unknown'.

create function is_environmentless(kind text) returns boolean
language sql immutable as $$
  select kind in ('package','repo','component','technology','capability',
                  'data_concept','team','domain','iac_module','pipeline','endpoint');
$$;

-- Normalise what is already there, so existing twins can merge.
update entity set env = 'unknown' where is_environmentless(kind) and env <> 'unknown';
