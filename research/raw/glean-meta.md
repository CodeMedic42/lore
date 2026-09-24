# Glean (Meta) — glean.software / facebookincubator/Glean

**Research date:** 2026-09-24. Repo read at commit `e32e6d0d1643eb32227d7544c5d8a06449f78e06` (2026-09-24). Docs read from `glean/website/docs` in that checkout (the site at glean.software is built from it). Latest Hackage release `glean-0.2.0.1`, uploaded 2026-02-13.

## Name collision (read this first)

There are two unrelated products called Glean. **This dossier is about Meta's open-source code indexer** at `glean.software` / `github.com/facebookincubator/Glean`: a Haskell/C++ Datalog-ish fact store for source code, BSD-3 licensed, no company, no pricing, no hosted service.

**glean.com is Glean Technologies**, an enterprise-search/AI-assistant company: connectors to 275+ SaaS sources, a permission-aware "Knowledge Graph", Search / Assistant / Agents products, a published **Glean MCP Gateway and MCP server** usable from Claude Code and Cursor, and a developer platform at developers.glean.com. Commercial, sales-led. Almost every "Glean MCP" search result belongs to glean.com, *not* to Meta's Glean. Do not conflate them.

## What it is

Repo description (primary source): *"System for collecting, deriving and working with facts about source code."* Created 2020-08-24, ~1,412 stars / 93 forks, active daily (last push 2026-09-24). No GitHub tags or releases; releases go to Hackage (`glean-0.1.0.0`, `0.2.0.0`, `0.2.0.1`). License: BSD-3-Clause.

Components, per `docs/introduction.md`:

- **Storage backend** on RocksDB (and now LMDB) — "Facts are immutable terms described by user-defined schemas, and form a DAG. Facts are automatically de-duplicated by the storage backend."
- **Angle**, the query *and* schema language: "a logic language with similarities to Datalog". Footnote, documented: *"currently Angle is limited to non-recursive queries only."*
- **Thrift server** managing many DBs, designed for replicated deployment.
- **Interactive shell**, **CLI (`glean`)**, **indexers**, **Glass** (language-agnostic symbol server), **`glean-lsp`** (generic LSP server, new in 0.2.0.0).

Documented as explicitly not code-only: *"you can also define your own schemas and store whatever data you like… so, for example, you could store test coverage data or profiling data."*

**Marketing vs documented.** The landing page (`website/src/pages/index.js`) is new AI-agent-flavoured copy: "Agent- and tool-friendly… ideal for IDEs, code review bots, refactoring tools, **LLM coding agents**"; "Coding agents, IDEs, and developer tools query Glean instead of relying on grep"; "designed to index monorepos with **billions of facts**". None of that is backed by an agent integration in the repo — there is no MCP server, no agent SDK, no retrieval API. `grep -ril "mcp\|model context protocol\|modelcontextprotocol"` over the whole repo returns **zero matches**. Meta's own 2024-12-19 engineering post (Marlow & Iborra) lists "RAG in AI coding assistants" as an *emerging* application.

## Data model (exact)

A DB is a set of **facts**; facts are unique and stored once. The **schema** is a set of **predicates** — "you can think of the predicates as the types of the facts."

```
predicate P : KeyType            # key-only
predicate P : KeyType -> ValueType   # key-value ("functional") predicate
```

Every fact has a 64-bit **Fact ID**, a **key** term, and optionally a **value** term. For key-value predicates Glean enforces that "each unique key has exactly one value. It is illegal to insert two facts with the same key and different values." That is the only integrity constraint in the system.

Type language (`docs/schema/types.md`): `nat` (64-bit), `byte`, `string` (UTF-8), `[T]`, `set T`, records `{f:T,…}`, sum/union `{f:T | …}`, `bool`, `maybe T`, `enum {a|b}`, and `P` — a reference to a fact of predicate `P`. Predicate references are what make the fact store a graph rather than a table set.

`type N = T` names a type; types are expanded inline and **cannot be recursive**. Recursion must pass through a predicate. Facts may be recursive in *values* but not *keys*, and facts cannot form cycles — enforced at write time, because "each new fact added to the database can only refer to earlier facts via its key."

**Schemas are namespaces**: `schema java.1 { … }`, with `import src.1` to reference another schema's predicates (qualified, version dropped) and a legacy `schema x.2 : x.1` inheritance form the docs mark as "a legacy feature and may be removed."

**Extensibility is real and unbounded.** The OSS schema source is ~95 `.angle` files / ~20,900 lines. The special `all` schema resolves unversioned names; the OSS `all.1` lists ~70 schemas. Beyond per-language schemas (`cxx` 1546 lines, `hack` 1209, `python` 898, `flow` 778, `java.alpha` 666, `erlang` 614, `buck` 606, `fbthrift` 535, `csharp` 510, `scip` 413, `lsif` 404, `hs` 336, `graphql` 306, …) there are cross-cutting ones worth noting for a knowledge-graph comparison: `codemarkup.31` (36 language-neutral predicates over a `code.Entity` union spanning 18 languages), `search.code`, `codemetrics`, `codelens` (LSP CodeLens), `gencode` (generated-code provenance: which source file and command produced a file), `dyn.7` (dynamic dispatch / runtime-observed usage with an explicit `Unused | Enumerated | Used` confidence enum), `digest`, `glass`, `indexer.Config : string -> string`. `code.Language` enumerates 31 languages.

The Angle syntax version in this checkout is **12** (`glean/schema/source/VERSION`, `latestAngleVersion = AngleVersion 12`).

## Angle: query surface

Form: `term where stmt₀; …; stmtₙ`. Documented semantics are both declarative and operational — "a query corresponds to a nested loop, where *statement₀* is the outermost loop… The ordering of the statements can therefore have a significant effect on performance."

Patterns/terms: variables (must start uppercase), `_`, `never`, `predicate pat [-> pat]`, sub-queries `( … )`, `term[..]` (iterate array or set), `|` choice (in patterns and expressions), `all query` (construct a set), `!term` (negation-as-failure), `if t then t else t`, literals, **string prefix match `"F"..`** and prefix-plus-rest, record/sum/enum/`maybe`/bool patterns, tuple shorthand, array patterns `[_,X,..]`, type signatures `t : T`, and literal fact IDs `$1026`. Dot syntax: `P.child.name`, union selection `H.has.variable?.name`, key extraction `X.*`.

Documented primitives: `prim.toLower`, `prim.length`, `prim.size`, `>` `>=` `<` `<=` `!==` (nat only), `!=` (any type), `zip`, `concat`, `reverse`. **The docs are incomplete**: the compiler (`glean/angle/Glean/Angle/Types.hs`) also defines `prim.addNat`, `prim.relToAbsByteSpans`, `prim.unpackByteSpans`, plus internal `prim.gtNat/geNat/ltNat/leNat/neNat/neExpr`. `prim.unpackByteSpans` is referenced by `src.angle` but absent from the reference page.

Queries are strongly typed and type-checked server-side before execution; the type-checker "isn't very clever… it mostly doesn't do type *inference*". Queries compile to bytecode run on a VM (`:debug ir`, `:debug bytecode`). No substring/regex matching by design — only prefix, "because prefix matching can be supported efficiently by Glean's prefix-tree representation."

**Derived predicates** are the central abstraction. Two kinds:
- `stored { … } where …` — materialised into the DB by `glean derive` / Thrift `deriveStored`. "Rather like a materialized view in SQL" (Marlow). Used to create reverse indexes, because facts are indexed by a *prefix of their key fields*, so `Parent { parent = X }` is O(n) while a derived `Child { parent, child }` makes it O(log n).
- on-demand (no `stored`) — computed at query time, never stored. Used to build "libraries representing whole abstraction layers over the raw data"; `codemarkup` is exactly that.
- `derive P.1 [default] <query>` — a compatibility shim. `default` "only takes effect when the DB is complete (i.e. read-only) and **contains no facts** of the predicate," giving both backwards and forwards compatibility during migrations.
- Restriction: `if` (and negation generally) is disallowed in stored derived predicates.

## Schema versioning and evolution

Best-in-class part of the system, and unusually well specified.

- A schema instance is identified by a **`SchemaId`**, "a hash value computed from the full contents of the schema," exposed as `schema_id` in the `builtin` schema.
- The server keeps a **schema index** of many schema instances (`--schema index:FILE` / `indexconfig:PATH`, built by `gen-schema --update-index`). Each DB stores the schema it was written with (`glean.schema_id` property at `kickOff`).
- **Clients send their `SchemaId` with every query** (`UserQuery.schema_id`); "the server knows which schema the client is using, so it can translate the data in the database into the client's schema automatically." Old client × new data and new client × old data both work.
- **Compatible changes** (enforced; incompatible changes are rejected): add/remove a record field of a *defaultable* type; add/remove a sum alternative; add/remove a predicate or type; swap list↔set. Incompatible: changing a field's type. "Defaultable" = any non-predicate type, with a documented default table (`nat`→0, `string`→"", `[T]`→[], `maybe`→nothing, enum→first label…).
- Missing fields are filled with defaults; unknown sum alternatives surface to clients as `unknown`/`EMPTY`.
- `schema x.2 evolves x.1` transforms `x.2` facts into `x.1` shape at query time — but **only if the DB contains zero facts of the old schema**; otherwise the evolution is ignored.
- Tooling: `glean validate-schema`, Thrift `validateSchema`/`validateSchemaV2`, server config `enable_schema_evolution`, `use_schema_id`, `strict_query_schema_id`, `check_write_schema_id`.
- Schema compiles to Thrift types (`make gen-schema`), with a documented schema-type ↔ Thrift ↔ JSON mapping table.

## Incrementality

Documented in `docs/implementation/incrementality.md` and the 2022-12-01 blog post, and it is the most distinctive engineering idea here.

Indexers label facts with **units** — arbitrary strings, undeclared, typically one per file or module. A new DB is **stacked** on a base DB with some units excluded: `glean create --repo <new> --incremental <old> --exclude A,B,C` (Thrift `Pruned { base, units, exclude }`). The base DB is never modified; stacks form a *tree* and every node is simultaneously queryable — "no data is being modified, only shared and viewed differently." To a querying client a stack is one DB.

Correctness is maintained by **ownership sets**: `set ::= unit | set₁ || … || setₙ | set₁ && … && setₙ`, each interned to a `UsetId`. Visibility is a bitmap **slice**. Ownership is propagated to referenced facts (`A || B`) so hiding a unit never dangles a reference; a derived fact's owner is the **conjunction** of its sources' owners. Sets are stored with Elias-Fano coding and fact→uset as an interval map; total overhead "only adds about 7% to the DB size."

Measured costs, as published: indexing overhead 2–3% (Python), in the noise (Hack); query overhead <10% for typical Glass-style queries, "around 3x" for search-heavy queries; incremental derivation implemented "for some kinds of query" only — "optimising queries to achieve this in general is a hard problem." The implementation notes still say incremental derivation across stacked ownership "isn't implemented yet."

There is a Thrift entry point for change-driven indexing: `GleanIndexingService.index(IndexRequest { repo, base: Revision, changes: map<FilePath, FileChange> })` where `FileChange` is modified (with line-level `Diff`s) / moved / deleted.

## Storage

Pluggable embeddable KV store with a documented requirements list (prefix seek + bidirectional scan, concurrent readers with one writer, fast whole-DB snapshot/restore, ideally read-only mode and compression). Two backends: **RocksDB** (default) and **LMDB** (experimental, `--lmdb`, "30-40% faster" in some benchmarks per CHANGELOG 0.2.0.0). Tables: `entities` (factID→key,value), `keys` (key→factID), `admin`, `meta` (holds the schema), `stats`, plus ownership tables. LMDB's ~2kB key limit is handled by storing only a truncated key prefix with duplicate entries sorted by fact ID.

Ops surface (`server_config.thrift`): retention policies (`delete_if_older`, `retain_at_least/at_most/per_day`, required/excluded properties), restore policy, close policy, backup policy (S3 is the only OSS backend, via `Glean.Database.Backup.S3`), sharding (`static_assignment` / `no_shards` / `shard_manager` / `shard_manager_most_recent`), caches, a janitor, `default_max_results/bytes/time_ms`, `query_alloc_limit`, `compact_on_completion`. Local modes: `--db-root DIR`, `--db-tmp`, `--db-memory`. `--db-read-only` and `--db-mock-writes` exist. The Docker demo image is documented as **currently not working**.

Build is Linux-only (x86_64/arm64), GHC 9.x + cabal; `cabal install glean`, `glean-clang`, `glean-lsp`.

## Cross-language and cross-repo

**Cross-language: yes, by construction.** `code.Entity` is a sum over 18 language entity types; `codemarkup` derives a language-neutral API (`EntityKind`, `EntityLocation`, `EntityReferences`, `FileEntityXRefLocations`, `SearchRelatedEntities`, `ExtendsParentEntity`, `ContainsChildEntity`, `EntityComments`, …) on top of it, mostly as *on-demand* derived predicates. `GeneratedEntityToIdlEntity` plus the `gencode` schema map generated code back to its IDL source — genuine cross-language linkage. SCIP and LSIF are first-class ingest formats.

**Cross-repo: no, not at the query layer.** Thrift is `userQuery(1: Repo repo, 2: UserQuery q)` — a query is scoped to exactly one DB, identified by `name/hash`. Angle has no cross-DB join. The only "join across DBs" is a stack, which is one logical DB. Federation happens one layer up in **Glass**, which maps a repo name to *a set of* Glean DB names and "choose[s] one or more Glean DBs" per request, with strategies `ChooseLatest` / `ChooseExactOrLatest Revision` / `ChooseNearest RepoName Revision`; `SymbolSearchRequest.repo_name` is optional, and the OSS `RepoMapping` sets `allGleanRepos = Nothing`, meaning "all existing Glean DBs can be used."

**Infrastructure entities: no.** Nothing in the OSS schema models services, deployments, teams, owners, incidents, environments, or runtime topology. `buck`/`dataswarm`/`chef`/`yaml` schemas model build targets, data pipelines, config-management recipes and YAML — the closest it gets, and all are still artefacts in the repo, not running infrastructure. Glean is a *source-code* fact store with an open schema, not a service catalog.

## Write capability for an external client

Everything below is a Thrift RPC on `GleanService`; the OSS client library is **Haskell only** ("There is currently only a Haskell API; APIs in other languages are coming soon"), plus a C++ writing API in `glean/cpp`. Internally Hack/Python/Rust bindings exist.

Writes: `kickOff` (create DB, with `properties`, `dependencies` = Stacked|Pruned, `repo_hash_time`, `update_schema_for_stacked`, `acl_config`) → `sendJsonBatch` (JSON facts) or `sendBatch`/`sendBatchV2` (binary `Batch` with `owned` unit ranges and derived-fact `dependencies`) or `enqueueBatch` → `finishBatch` → `completePredicates` → `deriveStored` → `waitForWrites` → `finish` → `finalize`. Also `updateProperties`, `deleteDatabase`, `restore`.

**Writing facts at query time: yes, one mechanism.** `UserQueryOptions.store_derived_facts: bool = false` — comment in `glean.thrift`: *"derive facts of 'stored' type, and store them in the database."* The shell exposes it (`*` prefix on a query, wired to `userQueryOptions_store_derived_facts`). It is not general-purpose fact insertion: it only materialises facts of predicates already declared `stored` in the schema, computed from facts already in the DB. On-demand derived predicates also produce facts at query time but never persist them.

**What you cannot do:** update or delete an individual fact. Facts are immutable and append-only, fact IDs are monotonic, and a DB moves Incomplete → Complete and then is effectively read-only (`glean unfinish` exists but is documented as "for testing and development and not for routine use"). Corrections are made by writing a new stacked DB that hides the stale units. `ParallelDerivation` (partition over an outer predicate) exists for scaling derivation.

## Provenance, staleness, contradiction, temporality

**There is no provenance model, no confidence, no source attribution, and no per-fact timestamp.** Say this plainly — it is the largest gap for anything that wants to be a "living knowledge" system.

What exists instead:
- **Units** attribute facts to a file/module for *invalidation*, not for attribution. There is no "who asserted this" or "why".
- **DB identity** carries time: `name/hash` (hash is usually the SCM revision), arbitrary `DatabaseProperties` key/value metadata, and an optional `repo_hash_time` epoch. Temporality is at whole-DB granularity; many revisions coexist as separate DBs/stacks, and retention policies govern how many survive. There is no as-of query *within* a DB.
- **Staleness** is handled outside the fact store: `src.FileDigest` / `digest.FileDigest` content hashes, and Glass's source-control layer comparing revisions/generations and file hashes to decide whether a DB is close enough to the working revision. The LSP server is explicitly read-only and "doesn't currently support updating the data if the source code is edited."
- **Indexing failure is modelled**: `src.IndexFailure { file, reason: CompileError|BuildSystemError|Unclassified|DiscoveryError, details }` — "it is a good practice to add all errors directly into db." `indexer.Config : string -> string` records indexer configuration per DB. That is the only pipeline-provenance in the schema.
- **Contradiction** is not modelled at all. Two facts asserting different things coexist silently. The single exception is key-value predicates, where two facts with the same key and different values is an *error*, not a recorded conflict. `dyn.Usage` (`Unused | Enumerated | Used`) is the only certainty-like enum anywhere, and it is domain-specific to dynamic dispatch.

## Indexers shipped (OSS `glean index <lang>`)

`angle`, `cpp-cmake` (clang, via `compile_commands.json`), `erlang`, `flow`, `hack`, `haskell-hie` (reads `.hie` files; new in 0.2.0.0, indexes local variables and hover types), `go`, `java-lsif`, `lsif`, `scip`, `rust-scip`, `swift`, `typescript`, `python-scip`, `dotnet-scip`, and `external` (any program that emits Glean JSON). Buck, fbthrift, python (native), python-pyrefly and yaml indexers are in the tree but compiled only under `#ifdef GLEAN_FACEBOOK`. README lists Python, Java, Kotlin, Erlang, Thrift, Buck/Bazel, C#, Swift as "custom indexers… not in the open source release yet."

## Published performance figures (primary, Marlow 2025-05-22, Stackage ~2,900 packages)

Indexing 470s vs hiedb 1,021s; DB 0.8GB vs 5.2GB; find-references 0.03s raw Angle / 0.39s via Glass vs 2.3s hiedb; find-definition 0.01s vs 0.18s. Meta's engineering post claims "approximately 1 millisecond for simple queries" and incremental diff processing at "O(fanout) rather than O(repository)".
