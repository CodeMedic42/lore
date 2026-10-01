-- Linting and formatting are part of "what is this built from", and a library
-- fixture that declares eslint/stylelint/prettier should not have them vanish.
insert into predicate (name, family, functional, subject_kinds, object_kinds, description) values
  ('lints_with', 'technology', false, array['package','repo','client','service'], array['technology'],
   'Linter or formatter the subject is checked with: ESLint, Stylelint, Prettier.');

insert into predicate_alias (raw, maps_to) values
  ('linted_with',    'lints_with'),
  ('formatted_with', 'lints_with'),
  ('checked_with',   'lints_with');
