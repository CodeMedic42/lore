# Sourcegraph — Research Dossier

**Research date:** 2026-09-24. Latest release observed: **Sourcegraph 8.0.0 (2026-09-17)**. Docs read at sourcegraph.com/docs (current); GraphQL schema read from the *archived* `sourcegraph-public-snapshot` repo (last public state, ~2024) — noted where that matters.

---

## 1. What Sourcegraph is

Sourcegraph is an **enterprise code search, code navigation and code-change platform** over an organization's entire set of repositories, now repositioned as a **context provider for AI agents**. It indexes all repos from connected code hosts, serves regex/keyword/structural search over them, layers compiler-accurate cross-repository symbol navigation on top via SCIP indexes, and exposes all of that through a search API, a GraphQL API, a new versioned REST API, and an MCP server.

Two strategic facts shape everything below:

- **The product is closed source.** `sourcegraph/sourcegraph-public-snapshot` and `sourcegraph/cody-public-snapshot` are both **archived** on GitHub. Only satellite pieces remain open: SCIP (Apache-2.0), Zoekt, src-cli, the SCIP indexers, deploy repos, and the docs site.
- **Amp split off.** Sourcegraph discontinued Cody Free/Pro in July 2025 and pointed individuals at Amp; Amp was then spun out as a separate company (reported December 2025). Cody survives only as **Cody Enterprise** — an in-IDE assistant whose differentiator is Sourcegraph-backed context. Sourcegraph's own AI surface is now **Deep Search**, **Code Finder**, and **Agentic Batch Changes**, not Cody.

---

## 2. Code search (the base layer)

Backed by Zoekt (trigram index) plus unindexed search for arbitrary revisions. Documented query language is large and is the honest "query surface" of the product:

- **Pattern types:** `keyword` (default), `standard`, `regexp` (RE2), literal via quotes, `/regex/` literals, structural search.
- **Core filters:** `repo:` / `-repo:`, `rev:`, `file:` / `-file:`, `content:`, `language:`, `select:`, `type:` (`file|path|repo|symbol|diff|commit`), `case:`, `fork:`, `archived:`, `visibility:`, `count:` (incl. `count:all`), `timeout:`, `patterntype:`, `context:`.
- **Predicates — the interesting part:** `repo:has.meta(key:value)`, `repo:has.path(regex)`, `repo:has.topic(name)`, `repo:has.commit.after(...)`, `file:has.content(regex)`, `file:has.owner(email)`, `file:has.contributor(regex)`, `rev:at.time(...)`.
- **Boolean:** `AND` / `OR` / `NOT` with parentheses; documented precedence (AND binds tighter).
- **Revision syntax:** `@branch`, `@sha`, `@tag`, `@a:b:c`, glob `@*refs/heads/*`, negated globs, and `^rev` set-difference.

Surrounding features: **search contexts** (named repo-sets, repo-list JSON or query-based, user/org/global scope, combinable with `OR`), **saved searches**, **code monitoring** (notify on query match), **Notebooks**, **Search Jobs** (exhaustive background search, Enterprise-only, results downloaded as JSON Lines matching the Stream API event shape; documented exclusions: file predicates, catch-all `.*`, multiple `rev:` filters, `index:` filter), **Code Insights** (time-series/pie charts over search queries with automatic historical backfill from version control; Enterprise), and **Code Ownership** (CODEOWNERS parsing, assigned owners/teams, `select:file.owners` — docs admit it "has not been fully validated to work well on large repositories or large CODEOWNERS rulesets").

`rev:at.time()`, `type:diff`, `type:commit`, and Code Insights backfill are the whole of Sourcegraph's temporal story. They are all **git-derived**, not a modelled history.

---

## 3. Code navigation and the SCIP schema

Two tiers, documented plainly: **search-based** navigation (text + syntax heuristics, ~40 languages, zero setup) and **precise** navigation (compiler-derived, Enterprise tier). "Sourcegraph automatically uses Precise Code Navigation whenever available, and Search-based Code Navigation is used as a fallback."

Precise indexers at GA: scip-go, scip-typescript, scip-clang (C/C++/CUDA), scip-java (Java/Kotlin/Scala), rust-analyzer, scip-python, scip-ruby, scip-dotnet. Ingestion paths: manual, CI, or **auto-indexing** via executors driven by policies, with job inference from `go.mod` / `package.json` and override via `sourcegraph.yaml`. Auto-indexing languages documented: Go, TypeScript/JavaScript, Python, Ruby, JVM. Job states `QUEUED_FOR_INDEXING → INDEXING → INDEXING_COMPLETED` / `INDEXING_ERRORED`.

Upload is `src code-intel upload -file=index.scip` (repo/commit inferred from the local git clone; `-repo`, `-commit`, `-github-token` flags available).

### The SCIP schema, read directly (962 lines of `scip.proto`)

SCIP now lives at **github.com/scip-code/scip**, Apache-2.0, `go_package = "github.com/scip-code/scip/..."`, `java_package = "org.scip_code.scip"` — i.e. it has been moved out of the Sourcegraph org into a neutral-looking org, though the README still points at Sourcegraph's announcement post.

Top-level: `Index { Metadata metadata; repeated Document documents; repeated SymbolInformation external_symbols }`.

- `Metadata { ProtocolVersion version; ToolInfo tool_info; string project_root; TextEncoding text_document_encoding }`.
- `Document { language, relative_path, occurrences, symbols, text, PositionEncoding position_encoding }`.
- **Symbol strings** are a real grammar: `<scheme> <manager> <package-name> <version> (<descriptor>)+`, or `local <id>`. Descriptor suffixes: Namespace, Type, Term, Method (with disambiguator), TypeParameter, Parameter, Meta, Local, Macro.
- `SymbolInformation { symbol, documentation[], relationships[], Kind kind, display_name, signature_documentation, enclosing_symbol }` — **86 `Kind` values** (AbstractMethod, Accessor, Concept, Contract (Solidity), DataFamily (Haskell), Axiom (Lean), Fact (Alloy), …).
- `Relationship { symbol, is_reference, is_implementation, is_type_definition, is_definition }` — **exactly four relation predicates, all booleans.**
- `Occurrence { typed_range (SingleLineRange|MultiLineRange), symbol, symbol_roles bitset, override_documentation, SyntaxKind syntax_kind (37 values), diagnostics[], typed_enclosing_range }`.
- `SymbolRole` bitset: Definition 0x1, Import 0x2, WriteAccess 0x4, ReadAccess 0x8, Generated 0x10, Test 0x20, ForwardDefinition 0x40.
- `Diagnostic { Severity, code, message, source, tags }`; `Language` enum with 111 values.

**What SCIP can express:** a symbol graph within and across packages, keyed by a package-versioned symbol name, with definition/reference/implementation/type-definition edges, roles, docs, signatures, enclosing AST ranges (explicitly intended for call hierarchies and outlines), syntax highlighting and diagnostics.

**What SCIP cannot express — verified by reading the schema, not inferred:**
- **No time.** There is no timestamp, no commit SHA, no branch, no author anywhere in the file. Commit association happens *out of band* at upload. An index is a snapshot with no internal notion of when it was true.
- **No provenance beyond `ToolInfo{name, version, arguments}`.** No confidence, no source attribution per fact, no "who asserted this."
- **No contradiction model.** Indexes from different tools are merged by the server; the format has no way to mark two claims as conflicting or to prefer one.
- **No user-extensible entity or relation types.** `Kind` and `Relationship` are closed enums/booleans in the proto. You cannot add "owned-by team X", "deployed to service Y", "calls this HTTP endpoint". The only extension hatch is the `Meta` descriptor suffix ("Can be used for any purpose") and free-text `documentation`.
- **No infrastructure, service, or runtime entities at all.** SCIP's universe is files, symbols, and packages.

---

## 4. The AI surface

**Deep Search** — "an agentic code search tool that understands natural language questions about your codebase." Runs an agentic loop using Code Search and Code Navigation as tools, plus sandboxed **Lua scripts** for aggregation (network, filesystem and code execution restricted). Returns Markdown with a source list of every search performed and file read. Enterprise Starter or Enterprise only; **not supported for BYOK**; consumes subscription credits; self-hosted requests may run up to 5 minutes. All processing is in-instance; only LLM calls leave. Context filters (July 2026) restrict which repos/files it may touch. Topic analytics (July 2026) report what teams ask about.

**Code Finder** — GA 2026-08-20. "An agent optimized specifically for code search"; returns "a concise summary with links and line ranges."

**Agentic Batch Changes** — Beta 2026-06-29, headline feature of 8.0. "Turns a description of a change into changesets across your codebase." Research/plan via Deep Search → canary on one repo → staged rollout with checkpoints → watches opened PRs and iterates on CI failures and merge conflicts. Requires per-code-host Batch Changes credentials and CI tokens in Secrets. **Documented limitation: it cannot merge changesets.**

**Smart hover summaries** (GA 2026-06-18) — LLM summaries built on precise code-intel data. **Repository Overview** (2026-08-03, v7.6) — repo activity at a glance, framed around code being written "partially by humans, partially automated."

**Cody Enterprise** — chat, auto-edit, prompts, context filters, `@`-mentions of files/symbols/URLs/remote files, multi-repo. Context fetching is documented as keyword search + the Sourcegraph Search API + "Code Graph"; **no embeddings pipeline is described in current docs**.

---

## 5. APIs — read and write

**MCP server** (GA 2026-02-25, v7.0). `https://<instance>/.api/mcp` (curated), `/.api/mcp/all` (full), `/.api/mcp/deepsearch`. Auth: OAuth 2.0 with **Dynamic Client Registration on by default**, a dedicated `mcp` scope, or access tokens. Gated by an `MCP#ACCESS` permission. Tools: `read_file`, `list_files`, `list_repos`, `list_refs`, `keyword_search`, `nls_search`, `evaluator` (sandboxed Lua), `go_to_definition`, `find_references`, `commit_search`, `diff_search`, `compare_revisions`, `get_contributor_repos`, `code_finder`, `deepsearch`, `deepsearch_read`. Default set since 2026-03-30: `read_file`, `list_files`, `keyword_search`, `nls_search`, `list_repos`, `commit_search`, `diff_search`, `deepsearch_read`. **Every tool is read-only. There is no MCP write tool.**

**REST API** — new in 7.0, at `/api-reference` per instance, publishes its own OpenAPI schema, backwards-compatible within a major version, "work in progress" with capabilities "gradually being ported over." No public OpenAPI document is reachable on sourcegraph.com without an instance.

**GraphQL** — `/.api/graphql`. Docs now describe it as "a debug API… It does not have backwards-compatibility guarantees, and may not remain stable across Sourcegraph releases," and steer integrators to REST. Cost limits: depth 30, 500k fields, 500 aliases. **It is nonetheless the real write surface.** ~76 mutations in the core schema plus extensions: repo metadata (`addRepoMetadata`, `updateRepoMetadata`, `deleteRepoMetadata`, and the older `*RepoKeyValuePair`), ownership (`addCodeownersFile`, `assignOwner`, `assignTeam`, `updateOwnSignalConfigurations`), insights (~15 mutations), notebooks (5), and ~32 Batch Changes mutations (`createBatchChange`, `createBatchSpecFromRaw`, `executeBatchSpec`, `applyBatchChange`, `publishChangesets`, `mergeChangesets`, `closeChangesets`, `createChangesetComments`, `createBatchChangesCredential`, …).

**Stream API** — `/.api/search/stream`, SSE, params `q`, `v`, `t`, `cm`, `cl`, `display`, `max-line-len`; events `matches`, `progress`, `filters`, `alert`, `done`.

**src CLI** — `src code-intel upload`, `src repos add-metadata|update-metadata|delete-metadata`, batch change commands.

---

## 6. Repository metadata — the only extensible store

`repo:has.meta(key:value)` is backed by arbitrary user-supplied **key-value pairs per repository** (tags are KVPs with `null` value). Docs: "No scale limits in terms of number of pairs per repo, or globally." Gated by a `Repository metadata / Write` RBAC permission. Caveat: avoid `:`, `(`, `)` because search escaping is limited.

This is genuinely important for comparison: it is **flat, untyped, string-keyed, repo-scoped, and has no provenance, no timestamp, no relationships, and no schema.** It is the entirety of Sourcegraph's ability to hold a fact that is not derivable from code.

---

## 7. Cross-repo and infrastructure

Cross-repo is a first-class strength *for code*: Zoekt indexes all repos; precise navigation resolves across repository and package-dependency boundaries because SCIP symbols carry `Package{manager, name, version}`; `repo:`/`context:` scope any query across the fleet; Batch Changes fan out across repos and code hosts. Tier-1 code hosts: GitHub (.com + Enterprise), GitLab (.com + self-hosted), Bitbucket Cloud/Server, Gerrit, Azure DevOps — documented to scale to 500k repos / 10k users. Tier 2: AWS CodeCommit, Perforce, Plastic SCM, each with documented gaps.

**Infrastructure modelling: none.** There is no service catalog, no ownership-of-a-service entity, no deployment, environment, dependency-of-a-running-system, incident, or telemetry entity anywhere in the documented model. The closest approximations are repo KVPs, CODEOWNERS-derived owners, and the fact that Kubernetes YAML is searchable *as text*.

---

## 8. Pricing and licensing

Public pricing page shows only **Enterprise: from $16K minimum annual contract**, bundling search, navigation, Deep Search, Batch Changes, Insights, Monitoring, "Full MCP Server, API, and CLI access", single-tenant cloud, 24×5 support, with org-wide credit pooling and credits that "don't expire monthly" and roll over on renewal. **Enterprise Starter** is referenced repeatedly in docs as a tier but its price is not on the page. Cody Free/Pro no longer exist. Open-source components are Apache-2.0 (SCIP); the platform itself is proprietary.
