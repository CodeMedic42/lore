-- Identity for packages and their exports.
--
-- `module_export` is the important one. A component's identity is the package it
-- comes from plus the name it is exported under: "@acme/library-a#TextField".
--
-- That string is derivable from BOTH sides of a boundary - the package that
-- exports it and any file that imports it - so a scan of library-a and a scan of
-- an app consuming it independently produce byte-identical identifiers. Component
-- resolution stops being a name-similarity guess and becomes a uniqueness
-- constraint, which is the whole difference between a graph that answers
-- questions and one that fragments.

insert into identifier_authority (name, description, example) values
  ('npm_package',   'Package name from package.json', '@acme/library-a'),
  ('module_export', 'Package plus the name it exports, as written in an import',
                    '@acme/library-a#TextField');
