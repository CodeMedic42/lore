-- The normalised line count of the anchored span. Needed to slide a same-sized
-- window over a changed file and find where the code moved to.
alter table evidence_anchor add column span_norm_lines integer;
