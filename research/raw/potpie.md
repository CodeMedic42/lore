# Potpie (potpie-ai/potpie) — Research Dossier

**Researched:** 2026-09-24. **Primary sources:** repo `potpie-ai/potpie` @ `db33c46` (main, cloned 2026-09-24), `docs.potpie.ai` (llms.txt index), PyPI `potpie` 2.0.1 (uploaded 2026-08-31), potpie.ai marketing/blog pages.

> **Critical framing:** "Potpie" today is **two different products sharing one name and one docs site.**
> 1. **Potpie v1 (legacy, ~2024–2025):** a self-hostable FastAPI + Celery + Postgres server that parsed repos into a Neo4j code graph and ran CrewAI/pydantic-ai custom agents over it. Its docs pages still live at `docs.potpie.ai/agents/*`, `/custom-agents/*`, `/self-hosting/*`, `/pre-built-agents/*`.
> 2. **Potpie v2 (shipped, PyPI 2.0.0 on 2026-07-03, 2.0.1 on 2026-08-31):** a **local-first CLI + background daemon** that maintains a *project-memory context graph* — not a code graph. The repo on `main` is entirely v2. The v1 server code is gone from `main`.
> Most third-party writeups describe v1. The repo describes v2. This dossier covers both, weighted to v2 since that is what ships.

---

## 1. One-line

Potpie v2 is an Apache-2.0, local-first CLI + daemon that maintains a bitemporal, provenance-stamped **claim graph of project memory** (decisions, preferences, prior bugs/fixes, infra topology, ownership, activity timeline) which coding harnesses (Claude Code, Codex, Cursor, OpenCode) read before acting and write to after — with Potpie deliberately owning validation/storage/ranking and *not* owning the LLM intelligence.

---

## 2. What the repo actually contains (v2)

`pyproject.toml` name `potpie`, version `2.0.1`, license `Apache-2.0`, Python `>=3.12,<3.15`. Entry points: `potpie = potpie.cli.main:main`, `potpie-daemon = potpie.daemon.__main__:main`.

uv workspace members:
- `potpie/context-engine/` — `potpie-context-engine` 0.2.0, the graph engine (ports-and-adapters/hexagonal). **This is the product.**
- `potpie/parsing/` — Rust (`parsing_rs`, maturin) + Python tree-sitter code-graph extractor. **Excluded from the wheel.**
- `potpie/integrations/` — GitHub/Linear/Jira/Confluence adapters. **Excluded from the wheel.**
- `potpie/sandbox/` — Docker/Daytona agent sandbox + parser runner. **Excluded from the wheel.**
- root `potpie/` — CLI, daemon, pots, skills, auth, setup, runtime.

Also: `spec/` (12 ADRs, 12 SPEC-CHANGEs, conformance contracts, glossary, product/system contracts) and `docs/context-graph/` — ~3,900 lines of unusually candid internal architecture docs that explicitly annotate "Roadmap (not yet wired)" and correct their own prior drift. These docs are the single best primary source on this product.

---

## 3. The data model (v2) — this is the substantive part

### 3.1 Storage shape ("Position B")

Everything is one physical relationship type. From `adapters/outbound/graph/cypher.py` (per `architecture.md`):

```
(:Entity {group_id, entity_key})-[:RELATES_TO {group_id, name, subject_key, object_key,
    source_ref, valid_at, invalid_at, created_at, …}]->(:Entity)
```

- The **predicate name lives in the edge's `name` property**, not in the relationship type.
- **The MERGE key includes `source_ref`**, so corroborating writes from different sources do not collide — two sources asserting the same fact produce two claims, not one overwrite.
- **Bitemporal by construction:** `valid_at`/`invalid_at` = *event time*; `created_at` = *system time*.
- `group_id` **is** the `pot_id` — the tenancy discriminator stamped on every node and edge.
- This same Cypher runs unchanged on Neo4j and FalkorDB (a documented Phase-0 spike).

### 3.2 Entity catalog — 24 labels (`core/ontology.py`, `ENTITY_TYPES`)

| Category | Labels |
|---|---|
| Topology scope endpoints (`scope=True`) | `Repository`, `Service`, `Environment`, `DataStore`, `Cluster`, `DeploymentTarget` |
| Code-anchored topology | `Dependency`, `APIContract`, `Adapter`, `ConfigVariable`, `CodeAsset` |
| Product | `Feature` |
| People | `Team`, `Person` |
| Timeline | `Activity` (`is_activity=True`), `Period` |
| Memory tier | `Preference`, `Policy`, `BugPattern`, `Fix`, `Decision` |
| Fail-open fallbacks (`public=False`) | `Document`, `Observation`, `QualityIssue` |

Each `EntityTypeSpec` row carries: `identity_class` (`SLUG_ALIAS` / `EXTERNAL_ID` / `CONTENT_HASH`), `key_prefix`, `identity_policy`, `authoritative_source`, `required_properties`, `lifecycle_states` + `lifecycle_transitions` (a real state machine, e.g. `Decision`: proposed→accepted→superseded→deprecated, rejected), `patchable_properties` (a patch allow-list), `scope`, `is_activity`, `project_map_family`, `debugging_family`, `fact_family`, `source_of_truth`, **`freshness_ttl_hours`**, and classifier cues `text_patterns` (regexes) + `property_signatures`.

Notable design decisions stated in code:
- **"An entity exists only if an edge needs it as an endpoint."** No aspirational nodes.
- **Identity-only required fields** — a node needs only `entity_key` + label.
- **`Activity` is the single timeline collapse point.** PRs, commits, issues, incidents and deploys all mint as `Activity` (`activity:<source>:<id>`). There is deliberately no `PullRequest`/`Commit`/`Issue`/`Incident`/`Deployment` label.
- Per-entity freshness TTLs: topology/code/ownership = 1 week; `Activity`/`Period` = 2 weeks; memory tier (`Preference`/`Policy`/`BugPattern`/`Fix`) = 12 weeks; `Decision` = 24 weeks; default 30 days.

### 3.3 Predicate catalog — 25 public + `RELATED_TO` (`EDGE_TYPES`)

| Category | Predicates |
|---|---|
| topology (11) | `DEFINED_IN`, `DEPLOYED_TO`, `DEPENDS_ON`, `USES`, `USES_ADAPTER`, `CONFIGURES`, `DEPLOYED_WITH`, `EXPOSES`, `HOSTED_ON`, `PROVIDES`, `IMPLEMENTED_IN` |
| ownership (1) | `OWNED_BY` — the **only** `singleton=True` edge |
| people (1) | `MEMBER_OF` |
| timeline (5) | `TOUCHED`, `PERFORMED`, `AUTHORED`, `IN_PERIOD`, `MENTIONS` |
| memory (7) | `POLICY_APPLIES_TO`, `REPRODUCES`, `RESOLVED`, `ATTEMPTED_FIX_FAILED`, `VERIFIED`, `DECIDED`, `AFFECTS` |
| generic (1) | `RELATED_TO` (`public=False`, universal downgrade target) |

Plus one **system** edge kept out of the agent vocabulary: `SUPERSEDES`.

`EdgeTypeSpec` declares `allowed_pairs` (typed endpoint constraints, with sentinels `*`, `@Scope` = any `scope=True` label, `@Activity`), `required_properties`, `category`, `lifecycle_carrier`, `predicate_family` and `exclusive_family` (used for conflict detection and auto-supersession), `singleton`, and `source/target_inferred_labels`.

**Explicitly absent and called out as fictional in older docs:** `FIXES`, `CAUSED`, `IMPLEMENTS`, `CALLS`, `TRIGGERED_BY`, `PRECEDED_BY`, `HOTSPOT`, `HAS_ROOT_CAUSE`. "The timeline is read-time, not stored" — ordering/windowing/correlation are queries over `valid_at`, never stored temporal edges.

### 3.4 Schema extensibility

Documented rule (module docstring of `ontology.py`): **"Adding an entity: one row in `ENTITY_TYPES`. Adding a predicate: one row in `EDGE_TYPES`. Adding a record type: one row in `RECORD_TYPES`."** Identity registry, singleton registry, classifier tables, fact-family policy, ranker inputs and the agent-facing surface are all *derived views* recomputed at import. `core/coherence.py` runs **import-time invariants that fail startup loud** if any view drifts from a catalog (`OntologyCoherenceError`; rule stated as *"align the declaration, don't relax the check"*).

**But it is a compile-time/source-level schema, not a runtime-extensible one.** There is no API, CLI command or config file to add an entity type or predicate — you edit Python and redeploy. Unknown labels/predicates arriving at write time are either rejected, or (with `CONTEXT_ENGINE_ONTOLOGY_SOFT_FAIL=1`) *downgraded*: unknown labels dropped, ADR→`Document`/`Observation`, unknown edge types rewritten to `RELATED_TO` at confidence 0.3, endpoint-mismatched edges dropped — each downgrade recorded and optionally attached as a `QualityIssue` node. The docs list a staged ontology-evolution lifecycle (draft/experimental/active/deprecated/retired, per-view version units, change-class policy) as **explicitly not encoded today**.

### 3.5 Record types — the agent-facing memory vocabulary (`RECORD_TYPES`)

Structured (have a payload schema + backing reader): `preference`, `policy`, `bug_pattern`, `fix`, `verification`, `decision`.
Free-form (accepted, anchor to `Document`/`Observation`, **no reader**, surfaced as `unsupported_include`): `investigation`, `diagnostic_signal`, `workflow`, `feature_note`, `service_note`, `runbook_note`, `integration_note`, `incident_summary`, `doc_reference`.

---

## 4. Provenance, truth, staleness, contradiction, temporality

This is where Potpie is most differentiated, and it is all in code, not marketing.

### 4.1 Provenance (`core/graph_mutations.py ProvenanceRef`)
Every mutation stamps `prov_*` properties: `prov_pot_id`, `prov_source_event_id`, `prov_mutation_id`, `prov_source_system`, `prov_source_kind`, `prov_source_ref`, `prov_event_occurred_at`, `prov_event_received_at`, `prov_graph_updated_at`, `prov_valid_from`, `prov_valid_to`, `prov_confidence`, `prov_created_by_agent`, `prov_reconciliation_run_id`, plus actor identity (`actor_user_id`, `actor_surface`, `actor_client_name`, `actor_auth_method`). Docstring: *"Every important fact carries these fields so consumers can answer where did this come from, when was it observed, when was it last written, how confident is it, and who produced it."*

### 4.2 Truth classes — 7, per claim (`core/graph_contract.py TruthClass`)
`authoritative_fact`, `source_observation`, `agent_claim` (default), `user_decision`, `preference`, `timeline_event`, `quality_finding`.

Distinct from the per-*entity* `source_of_truth` policy (`authoritative_external_truth` / `authoritative_code_truth` / `canonicalized_memory` / `soft_inference`).

`TRUTH_TO_EVIDENCE_STRENGTH` maps truth class → ranker strength: authoritative_fact & source_observation → `deterministic`; user_decision, preference, timeline_event → `attested`; agent_claim → `stated`; quality_finding → `inferred`.

### 4.3 Evidence gating
`SourceAuthority` (6): `repository_metadata`, `authoritative_code`, `external_system`, `ci_run`, `user_statement`, `agent_observation`. `STRONG_AUTHORITIES` = all but `agent_observation`.
Rule: **`EVIDENCE_REQUIRED_TRUTH_CLASSES = {authoritative_fact, source_observation}`** must cite evidence; **`LOW_AUTHORITY_TRUTH_CLASSES = {agent_claim, quality_finding}`** are explicitly soft and need none. A missing agent-authored `description` is a **warning, never a reject**.

### 4.4 Temporality
Bitemporal: event time (`valid_at`/`valid_until`/`invalid_at`, and `occurred_at` on activities) vs system time (`created_at`, `observed_at`). Reads accept `as_of`, validity windows, `include_invalidated`. **Nothing is hard-deleted:** `end_relation_validity` stamps `valid_until`; `retract_claim` invalidates with a required `reason`; `supersede_claim` writes the replacement *and* an invalidation stamped `superseded_by_key`, creating a `SUPERSEDES` edge; `merge_duplicate_entities` writes a merge-record `RELATED_TO` edge.

### 4.5 Contradiction
- **Automatic supersession** is narrow: `_supersede_singleton_predecessors` stamps `invalid_at` on prior disagreeing live singleton claims — and `OWNED_BY` is the **only** singleton predicate. Everything else accumulates.
- **Environment is part of edge identity:** `edge_identity_key(subject, predicate, object[, environment])`, so a prod-qualified edge never supersedes its staging counterpart.
- **Detection without resolution:** `detect_family_conflicts` finds contradicting live `RELATES_TO` edges per (predicate-family, subject) and classifies them as *contradiction / supersession_pending / overlap*. `graph quality conflicting-claims` surfaces these. **Quality never writes** — it recommends a propose/commit correction or an inbox item.

### 4.6 Staleness
Per-entity `freshness_ttl_hours` rolls up into `FACT_FAMILY_FRESHNESS_TTL_HOURS`. At read time, `assess_graph_quality` derives a source-ref TTL from the fact family and produces a `GraphQualityReport` (`good/watch/degraded/unknown`) from freshness, verification gaps, source-access gaps and coverage. `graph quality stale-facts` is the explicit report. Recency also enters the ranker as exponential decay with a **30-day half-life**.

### 4.7 Ranking (`domain/ranking.py`)
Weighted **arithmetic** mean (deliberately replacing a geometric mean whose floor let one zero factor veto a candidate) of six clamped factors, missing → neutral 0.5:
`semantic_similarity` 1.3 · `strength` 1.2 · `scope_overlap` 1.1 · `recency` 1.0 · `corroboration` 0.8 · `coverage_quality` 0.5. Strength scale: deterministic 1.0 / attested 0.8 / stated 0.6 / inferred 0.45 / speculative 0.2. Every ranked item keeps a per-factor `breakdown` for explainability.

**Reads never synthesize an answer.** The single result shape is an `AgentEnvelope` of ranked `EvidenceItem`s with per-include `CoverageReport` (`complete/partial/sparse/empty`), `unsupported_includes`, `overall_confidence` (a *coverage rollup*, explicitly "not a trust score"), `as_of`.

### 4.8 Retrieval cards
`build_retrieval_card` is the single builder for the text a claim is embedded and searched as — shared by write-path and read-path so they cannot drift. It concatenates `description` • `fact` • humanized subject key • predicate • object key • object value • key-sorted scope values • extra terms. Skills insist the `description` be written *for search, not display* (symptoms, synonyms, scope). The bundled **local embedder ships by default** (no API key); `match_mode` is `vector` with an embedder, `lexical` (token-overlap) without, and is surfaced on every read so empty results are debuggable.

---

## 5. Write capability — what an external agent can actually write

**Yes — an external agent can write arbitrary facts into the graph, within the ontology, and the design assumes it will.** This is the whole product thesis.

### 5.1 The semantic DSL — 10 operations, all applicable
`upsert_entity`, `link_entities`, `assert_claim`, `append_event`, `end_relation_validity`, `retract_claim`, `supersede_claim`, `merge_duplicate_entities`, `patch_entity`, `transition_state`.
`APPLICABLE_MUTATION_OPS` = all ten; `REVIEW_REQUIRED_OPS = ()` and `DEFERRED_OPS = ()` are both empty. Review is a **runtime `MutationRisk` (low/medium/high) decision**, not an op partition. Medium/high-risk ops auto-apply only with `--allow-review-required` **and** `--approved-by`; otherwise the batch returns `review_required`.

Payload is flat, batch-shaped, versioned:
```json
{"graph_contract_version":"v1.5","pot_id":"…","idempotency_key":"…",
 "created_by":{"surface":"cli","harness":"claude"},
 "operations":[{"op":"assert_claim","subgraph":"debugging",
   "subject":{"key":"bug_pattern:…","type":"BugPattern","properties":{…}},
   "predicate":"REPRODUCES","object":{"key":"service:…","type":"Service"},
   "truth":"agent_claim","confidence":0.9,"description":"<retrieval card>",
   "evidence":[{"source_ref":"github:pr:412","authority":"external_system"}]}]}
```
Flat field set: `op, subject, predicate, object, value, truth, confidence, evidence[], description, environment, valid_from, valid_until, observed_at, reason, superseded_by, patch, expected_entity_version, from_state, to_state, external_ids`; `append_event` adds `verb, occurred_at, actor, targets[], mentions[]`.

**Agents never author Cypher or structural DTOs.** A `value` literal mints a synthetic `Observation` — *"never an authoritative fact from raw text."*

### 5.2 Two-phase canonical write door
`potpie graph propose --file m.json [--ttl 1h]` → validates, lowers, persists a server-held `GraphMutationPlanRecord` (no graph write) → `potpie graph commit <plan_id> --verify [--approved-by]` → re-checks the conflict guard, enforces approval, applies **the server-persisted plan** (the agent does not resend), then `--verify` reads the committed `claim_keys` back and takes before/after quality snapshots, downgrading the result to `degraded`/`partial`/`watch` on missing readback or quality regression.

Plan states: `validated, invalid, conflict, review_required, approved, committed, expired, abandoned, error`. Plans persist at `~/.potpie/graph_plans.json`.

**Optimistic concurrency is coarse:** `subgraph_versions` is only `{"_global": <total pot claim count>}` — no per-subgraph counters, so unrelated concurrent writes to one pot can spuriously conflict (documented as roadmap).

**Idempotency:** `idempotency_key` on the batch; deterministic `make_claim_key(pot, subgraph, subject, predicate, object-or-hash, src-or-idem-hash)`; and for event-less batches a **stable blake2b content fingerprint of the whole batch** is used as the provenance source id "never the per-apply uuid, so retries stay idempotent."

### 5.3 The second write path
`potpie record --type <preference|policy|bug_pattern|fix|verification|decision|…> --summary "…" [--scope k:v]` goes through `record_to_semantic`, which maps each record type to fixed semantic ops and sets `allow_review_required=True, approved_by="context_record"` so deliberate record writes auto-apply. This is the "Spine B" immediate-apply path (no plan, no TTL, no conflict guard). It never generates supersede/merge.

`potpie graph mutate` still exists but is a **legacy wrapper** over propose+commit that emits a steering warning.

### 5.4 Pre-apply gate and caps
`validate_reconciliation_plan`: canonicalization, duplicate-key detection, ISO temporal checks, and hard caps of **5,000 entities / 10,000 edges / 2,000 invalidations** per batch. Then the single write door `apply_mutation_batch` runs four verbs in order: `upsert_entities → upsert_edges → delete_edges → invalidate`.

### 5.5 The inbox — uncertainty as a first-class state
`graph inbox add|list|show|claim|mark-applied|mark-rejected|close`. States `pending → claimed → applied/rejected/closed`. **Inbox items are explicitly never facts** and never appear in ordinary reads. `mark-applied` requires a linked `plan_id` or `mutation_id`. Persisted at `~/.potpie/graph_inbox.json`. This is the designed escape hatch for "I have evidence but can't safely pick the canonical update."

### 5.6 Audit
`graph history [--entity|--claim|--plan|--mutation|--subgraph]` is the committed-write audit trail; commits emit a `history_pointer` + `audit_ref`.

---

## 6. Read surface

### 6.1 Three composable axes
- **Retrieve** — `graph read --subgraph <s> --view <v>` through the read trunk.
- **Filter** — `graph search-entities` straight to `claim_query.find_claims` (identity resolution before a write).
- **Traverse** — `graph neighborhood --entity <key> [--predicate --depth --direction]` over `backend.inspection.neighborhood`.

**Explicitly out of scope on the agent surface:** arbitrary cross-predicate shortest path, centrality/PageRank, cycle detection, unbounded recursive aggregation. *"This is a project-memory graph for retrieval-into-context, not a graph analytics engine."*

### 6.2 8 subgraphs × 9 named views
`debugging.prior_occurrences`, `recent_changes.timeline`, `infra_topology.service_neighborhood`, `decisions.preferences_for_scope`, `decisions.active_decisions`, `features.feature_context`, `code_topology.ownership_by_path`, `knowledge.document_context`, `admin.inspection_slice`. Views declare `required_any_scope`, `supported_filters`, `inline_relations`, `result_shape` (`flat_claims`/`entity_relations`/`events`/`raw_graph`); a malformed read returns `missing_required_scope`/`unsupported_filter` rather than running.

### 6.3 9 readers, one trunk
`coding_preferences`, `features`, `infra_topology`, `timeline`, `prior_bugs`, `decisions`, `owners`, `docs`, `raw_graph`. 11 intents (`feature, debugging, review, operations, planning, docs, onboarding, refactor, test, security, unknown`) map to default include sets.

**Anti-phantom-vocabulary rule:** an advertised include with no reader returns `UnsupportedInclude(reason="not_implemented")`; an unknown include returns `unknown_include`. A coherence guard requires the advertised set to equal the runtime registry or startup fails. "I asked for X and got nothing" is always distinguishable from "X isn't real."

### 6.4 Contract discovery
`potpie graph catalog [--profile read|full]` returns versions, commands, truth classes, mutation ops, source authorities, `match_mode`, views, public entity types and predicates — derived entirely from the ontology. The skill says: *"Start graph-aware work here instead of reading docs."* `graph describe <subgraph> [--view] [--examples]` is a context-free typed metadata call. `graph mutation-template --kind <repo-baseline|feature|preference|preference-policy|infra-snapshot|bug-fix|decision|timeline-event|timeline-change>` prints a schema-only skeleton.

---

## 7. Storage backends

`build_backend(profile, …)`; `KNOWN_PROFILES = (in_memory, embedded, neo4j, falkordb, falkordb_lite, postgres, chroma, hosted)`. `GraphBackend` is a Protocol bundling six capability ports in two tiers — **canonical** (`mutation`, `claim_query`) and **rebuildable projections** (`semantic`, `inspection`, `analytics`, `snapshot`) — plus `profile`, `capabilities()`, `provision(SetupPlan)`.

| Profile | Real caps | Notes |
|---|---:|---|
| `in_memory` | 6/6 | conformance/reference |
| `embedded` | 6/6 (delegated) | JSON-persisted wrapper over in_memory |
| **`falkordb_lite`** | **5/6** | **the OSS/CLI default** — embedded FalkorDB via `redislite` on a local file; no server, no Docker |
| `falkordb` | 5/6 | full FalkorDB server |
| `neo4j` | 4/6 | "shape-first production target"; native relationship vector index; **no inspection, no snapshot** |
| `postgres` / `chroma` / `hosted` | **0/6** | `StubGraphBackend` — every method raises `CapabilityNotImplemented` |

Documented gaps: claim-key `mutation.invalidate` raises on **both** Neo4j and FalkorDB; snapshot export/import only on in_memory/embedded. Net: **FalkorDB is more complete than Neo4j.** Unbuilt capabilities fail closed with a dotted `graph.<profile>.<cap>.<method>` slot, never a bare `NotImplementedError`.

Default paths: `falkordb_lite` at `.potpie/context_graph/falkordb.db`, graph name `context_graph`. `reset_pot` is `MATCH (n {group_id:$gid}) DETACH DELETE n`.

---

## 8. Multi-repo / cross-repo

- A **Pot** is the tenancy unit; `pot_id` **is** `group_id`. First setup creates an active `default` pot.
- **A pot can hold many sources** — `potpie source add <kind> <location>` with kinds `repo | github | linear | jira | confluence | document | …`. So **multiple repositories in one pot is supported and is the intended way to span repos**; `Repository` is a first-class `scope=True` entity and `DEFINED_IN` links a `Service` to a `Repository` with a `path` property for monorepo subtrees.
- Repo→pot routing: `pot default show|set|clear --repo .`, `pot linked`, `pot create/use --also-default-for-current-repo`; `doctor` reports `effective_current_repo_pot` vs `repo_default_pot`.
- **Cross-pot federation is an explicit stated anti-goal.** There is no query that spans pots.
- `source add` is **registration metadata only — no scan, no ingest**. `setup --scan` is opt-in, default off.

---

## 9. Infrastructure modeling

Yes, first-class and environment-qualified. Entities: `Service`, `Environment`, `DataStore`, `Cluster`, `DeploymentTarget`, `Adapter`, `ConfigVariable`, `Dependency`, `APIContract`. Predicates: `DEPLOYED_TO`, `HOSTED_ON`, `USES`, `USES_ADAPTER`, `CONFIGURES`, `DEPLOYED_WITH`, `DEPENDS_ON`, `EXPOSES`, `DEFINED_IN`. The `infra_topology.service_neighborhood` view does bounded BFS (depth capped at 4, direction out/in/both) with `environment_filter` defaulting to `qualified_only`. `graph mutation-template --kind infra-snapshot` writes env-qualified service/adapter/config/deployment facts.

**But nothing discovers this automatically.** Scanners (codeowners / openapi / kubernetes / dependency-manifest) were **deleted** from the codebase (commit `5af8ea5f`, "mega-removal of dead CE surface"). Infra topology is populated only by a harness reading Terraform/k8s/compose/CI files and authoring semantic mutations — the `potpie-source-ingestion` skill's Phase-3 lane. There is no live cloud-account connection, no Datadog/OTel ingestion, no drift detection against running infrastructure.

---

## 10. Agent integration surface

**There is no MCP server in this repo.** The string `mcp` appears only as (a) an allowed value of `source_channel`/`actor_surface` on the HTTP ingestion API (`cli|mcp|http|webhook`), and (b) prose in a skill telling the agent to use *its own* GitHub MCP tools. The legacy v1 custom-agent docs list an optional "MCP Servers" field on a task and note it is **inactive in the current release**. Integration is instead via **CLI + skills**.

**8 bundled skills** (pure `SKILL.md` instruction text, no executable code, no new tools): `potpie-graph` (235 lines — the read/write discipline), `potpie-source-ingestion` (248 lines), `potpie-repo-baseline`, `potpie-cli`, `potpie-debug-memory`, `potpie-change-timeline`, `potpie-infra-architecture`, `potpie-project-preferences`. The Claude Code plugin ships 7 (all but `potpie-cli`).

Install targets: `claude` → `~/.claude/skills`, `codex` → `~/.agents/skills`, `cursor` → `~/.cursor/skills`, `opencode` → `~/.config/opencode/skills`. `AGENTS.md`/`CLAUDE.md` are **merged** between `<!-- potpie-start -->` / `<!-- potpie-end -->` markers, not overwritten. A JSON manifest tracks installed versions; `skills status` partitions installed/missing/outdated and `nudge()` emits an advisory `potpie skills install --agent <a>`.

### The zero-token nudge model
A Claude Code plugin ships `hooks.json` wiring `SessionStart`, `PreToolUse(Write|Edit|MultiEdit|NotebookEdit)`, `PreToolUse(Bash)`, `PostToolUse(Bash)`, `Stop` to a `potpie_nudge.py` adapter that shells `potpie --json graph nudge`. Six nudge events with one policy each: `session_start`, `pre_edit`, `pre_deploy`, `test_failed` → **data** (read named views, rank, dedupe against a per-session injection ledger at `~/.potpie/nudge_sessions.json`, budget to top-K, inject a compact source-ref-first block); `test_passed`, `stop` → **instruction** (return a fixed directive prompting the agent to record a bug/fix claim or durable learnings — **never an auto-write**). *"The whole trigger brain is deterministic — no model on this path."* The hook is fail-safe: any error exits 0 with no output.

### Other surfaces
- `potpie ui` — read-only local graph explorer served by the daemon at `<base>/ui`.
- Daemon: typed authenticated protocol over UDS with loopback TCP fallback; boot-scoped compatibility ticket from a recursive operation/wire-schema catalog handshake; bearer auth described as "transitional, not the final identity model." Modes `daemon` (default) / `in_process`.
- HTTP ingestion server (second composition root, default backend `neo4j`): `POST /api/v1/context/ingest` (raw_episode), `/events/reconcile`, `/record`, `POST /webhooks/github` (HMAC verified, fail-closed), plus event retry/batch-retry/timeline/SSE-stream/ingestion-config endpoints. The local CLI path does **not** run this server.
- Telemetry: Sentry + usage events; `POTPIE_TELEMETRY_DISABLED=1` disables all outbound telemetry.

---

## 11. Honest limitations (from Potpie's own docs)

Marked "Roadmap (not yet wired)" in-tree:
- **All `potpie cloud …` commands, `pot list --managed`, `use --managed` raise `CapabilityNotImplemented`.** The managed backend does not exist.
- External Event Ledger clients (`managed_client.py`, `self_hosted_client.py`) are **TODO stubs** — `ledger pull/query/status` are non-functional against any real provider.
- Service-side LLM reconciliation is **off by default** and described as "parked / non-canonical."
- `postgres`/`chroma`/`hosted` backends are stubs; `snapshot` on falkordb/neo4j, `inspection` on neo4j, and claim-key `invalidate` on neo4j/falkordb are all unbuilt.
- Per-subgraph version tracking is unbuilt (concurrency is one global counter).
- `graph catalog --task` is "accepted and ignored in V1.5"; `--mode`/`--source_policy` "ride only in metadata — they do not change the read path."
- `ContextGraphStrategy` (AUTO/SEMANTIC/EXACT/HYBRID/TRAVERSAL/TEMPORAL) "is consumed by nothing in the active read trunk — it is vestigial."
- `skills add <source>` is a TODO stub.
- Two evidence-strength vocabularies coexist in code and are acknowledged as such.
- A known reader/spec drift is documented (`service_neighborhood` advertises `EXPOSES` but traverses `IMPLEMENTED_IN`).

PyPI classifier is `Development Status :: 3 - Alpha`.

---

## 12. Legacy Potpie v1 (for completeness)

Still documented at docs.potpie.ai. A self-hostable FastAPI + Celery + Postgres + Redis server (Docker; `./scripts/start.sh`) that parsed a repo into a code knowledge graph and ran agents over it.

- **API v2:** `POST /api/v2/parse` (`repo_name`/`repo_path`, `branch_name`, `commit_id`) → `project_id`; `GET /api/v2/parsing-status/<project_id>` with states `submitted → cloned → parsed → processing → inferring → ready`; `POST /api/v2/conversations/` (`project_ids[]`, `agent_ids[]`); `POST /api/v2/conversations/<id>/message/?stream=`; `POST /api/v2/project/<id>/message/` one-shot. Auth: `x-api-key` header.
- **Pre-built agents:** `codebase_qna_agent`, `code_generation_agent`, `spec_generation_agent`, `debugging_agent`.
- **Custom agent framework:** `role`, `goal`, `backstory`, `system_prompt`, plus 1–5 tasks each with `description`, `tools[]`, `expected_output` (JSON schema), optional MCP servers (inactive). Visibility: personal / team-by-email / organization.
- **~80 documented tools** across 9 categories: knowledge-graph (`ask_knowledge_graph_queries` — "natural language queries against the context graph using vector similarity search", `get_code_from_probable_node_name`, `get_code_from_node_id`, `get_code_graph_from_node_id`, `get_node_neighbours_from_node_id`, `get_nodes_from_tags`, `intelligent_code_graph`, …), code access, **code-changes management (~19 write tools with 24-hour session expiry, `export_changes` to a patch)**, external (`web_search_tool`, `webpage_extractor`, `bash_command` read-only), project management (todos/requirements), GitHub (incl. `code_provider_create_branch`, `code_provider_update_file`, `code_provider_create_pr`, `code_provider_add_pr_comment`), Linear, Jira (10 tools), Confluence (7 tools incl. create/update page), and `change_detection`.
- **Code-graph shape (Rust/tree-sitter extractor, still in the repo at `potpie/parsing/`):** node types `FILE`, `CLASS`, `INTERFACE`, `FUNCTION`; relationship types `CONTAINS` (FILE → CLASS/FUNCTION) and `REFERENCES` (FUNCTION → FUNCTION/CLASS). Python side returns a NetworkX `MultiDiGraph`. Languages: Python, Rust, JavaScript, TypeScript, Go, Java, C, C++, Ruby, PHP, C#, Elixir, OCaml, Elisp, Elm, QL. A Rust "FFF" lexical in-memory workspace index also exists (`build_workspace_index`, `search_files`) — explicitly "lexical, in-memory search only… intentionally does not do semantic matching."
- These legacy `FILE`/`FUNCTION`/`CLASS`/`NODE` labels survive in v2 only as `CODE_GRAPH_LABELS`, treated as `CodeAsset` endpoints by the validator.
- A 2025-10-15 Potpie blog post describes the v1 stack as Neo4j for the call graph + **Weaviate** for vectors + Embedchain for RAG, with LLM-generated per-entry-point explanations.

---

## 13. Pricing & license

- **Code: Apache 2.0** (LICENSE in repo; `license = "Apache-2.0"` in pyproject; PyPI confirms).
- **Hosted/commercial:** potpie.ai/pricing publishes **no tiers or amounts**. Verbatim: *"Potpie's pricing model depends on a few factors specific to your team. Licenses are priced per user. There is a platform fee based on the number of users supported."* An `enterprise-pricing` page exists and is a contact form.
- The OSS local path is stated to need **no cloud auth and no mandatory Docker/Neo4j/Postgres**; `whoami` reports a `none` identity locally.

---

## 14. Versions read

| Thing | Value |
|---|---|
| Repo HEAD | `db33c46`, main, 2026-09-24 |
| PyPI `potpie` | 2.0.1 (2026-08-31); 2.0.0 (2026-07-03); betas 2026-06-24 |
| `potpie-context-engine` | 0.2.0 (workspace) |
| `GRAPH_CONTRACT_VERSION` | `v1.5` |
| `ONTOLOGY_VERSION` | `2026-06-graph` |
| workbench envelope `graph_contract_version` | `v2` (envelope string only) |
| `potpie-graph` skill | version 5 |
| Docs "last reviewed" stamps | 2026-06-29 and 2026-08-24 |
