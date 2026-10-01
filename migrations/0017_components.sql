-- Vocabulary for component libraries and monorepos.
--
-- The tier rule this encodes: the graph holds what crosses a boundary, the
-- context file holds what is inside one. So `library-a exports TextField` and
-- `SearchField composes TextField` are edges - they cross package lines and no
-- single-package session can see them. TextField's props, variants and gotchas
-- are not edges; they live in TextField.context.md beside the code.
--
-- Getting that line wrong in the other direction is what would sink this: a
-- 200-component library at a dozen props each is 7,000+ edges of noise that
-- drown every other question in the graph.

insert into predicate (name, family, functional, subject_kinds, object_kinds, description) values
  ('composes',   'structure', false, array['component'], array['component'],
   'Subject renders or wraps object internally. The cross-package cases are the valuable ones.'),
  ('exports',    'structure', false, array['package', 'repo'], array['component', 'service'],
   'Object is part of the subject''s public API surface.'),
  ('variant_of', 'structure', false, array['component'], array['component'],
   'Subject is a specialisation of object - SearchField is a variant_of TextField.');

insert into predicate_alias (raw, maps_to) values
  ('uses_component',    'composes'),
  ('renders',           'composes'),
  ('wraps',             'composes'),
  ('built_from',        'composes'),
  ('includes_component','composes'),
  ('exports_component', 'exports'),
  ('provides_component','exports'),
  ('publishes_component','exports'),
  ('specialises',       'variant_of'),
  ('specializes',       'variant_of'),
  ('extends_component', 'variant_of');
