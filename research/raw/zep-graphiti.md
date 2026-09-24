# Zep & Graphiti — Research Dossier

**Researched:** 2026-09-24
**Primary artifacts read:** `getzep/graphiti` @ commit `47f6482` (2026-09-24), `graphiti-core` **v0.30.2**, MCP server v1.1.0; arXiv:2501.13956 (v1, 20 Jan 2025); help.getzep.com docs tree (Zep cloud) as of 2026-09-24.
**Repo stats (GitHub API, 2026-09-24):** 31,127 stars, 3,178 forks, 514 open issues, created 2024-08-08, license Apache-2.0.

---

## 1. What it is

Two things under one vendor (Zep Software, Inc.):

- **Graphiti** — Apache-2.0 Python framework (`pip install graphiti-core`) for building and querying **temporal knowledge graphs** ("context graphs") over a bring-your-own graph database. README: *"a framework for building and querying temporal context graphs for AI agents… track how facts change over time, maintain provenance to source data, and support both prescribed and learned ontology."*
- **Zep** — the commercial managed platform ("Context Lake") built on the same ideas but **not** on Graphiti's OSS drivers. README states Zep runs on a proprietary **Context Graph Engine**; the Context Lake doc names the underlying graph database service **Konig**. Zep adds users/threads, governance, dashboards, SDKs (Python/TypeScript/Go), and a hosted MCP server.

The 2025 paper is the design document: Zep is described as a memory layer whose core component is Graphiti, *"a temporally-aware knowledge graph engine that dynamically synthesizes both unstructured conversational data and structured business data while maintaining historical relationships."* Reported: DMR 94.8% vs MemGPT 93.4%; LongMemEval "accuracy improvements of up to 18.5%" with "90%" latency reduction vs baseline. Note these are the authors' own numbers on their own system.

---

## 2. Data model (verified against source)

### Node types (`graphiti_core/nodes.py`)

Abstract `Node`: `uuid`, `name`, `group_id`, `labels[]`, `created_at`.

| Type | Label | Added fields |
|---|---|---|
| `EpisodicNode` | `:Episodic` | `source` (enum: `message`/`json`/`text`/`fact_triple`), `source_description`, `content` (raw, non-lossy), **`valid_at`** = *"datetime of when the original document was created"*, `entity_edges[]`, `episode_metadata` (*"customer-defined metadata key-value pairs for filtering"*) |
| `EntityNode` | `:Entity` + custom labels | `name_embedding`, `summary` (*"regional summary of surrounding edges"*), `attributes` (dict, *"Dependent on node labels"*) |
| `CommunityNode` | `:Community` | `name_embedding`, `summary` (*"region summary of member nodes"*) |
| `SagaNode` | `:Saga` | `summary`, `first_episode_uuid`, `last_episode_uuid`, `last_summarized_at`, `last_summarized_episode_valid_at` |

**Sagas are new and undocumented in the paper** — an ordered episode grouping with an incrementally-refreshed running narrative summary. Note the deliberate split in the comment: `last_summarized_at` is *"wall-clock … watermark for the next incremental summarize run"* while `last_summarized_episode_valid_at` *"carries the episode-time semantics for public/temporal consumers."* That is bi-temporality applied to the summarization process itself.

### Edge types (`graphiti_core/edges.py`)

Abstract `Edge`: `uuid`, `group_id`, `source_node_uuid`, `target_node_uuid`, `created_at`.

- `EpisodicEdge` → `:MENTIONS` (Episodic → Entity). This is the provenance edge.
- `EntityEdge` → `:RELATES_TO` (Entity → Entity). The fact.
- `CommunityEdge` → `:HAS_MEMBER`
- `HasEpisodeEdge` → `:HAS_EPISODE` (Saga → Episodic)
- `NextEpisodeEdge` → `:NEXT_EPISODE` (episode ordering within a saga)

### `EntityEdge` — the provenance/temporal payload

```python
name: str            # relation name, SCREAMING_SNAKE_CASE
fact: str            # natural-language statement
fact_embedding: list[float] | None
episodes: list[str]  # "list of episode ids that reference these entity edges"
expired_at:  datetime | None  # "datetime of when the node was invalidated"
valid_at:    datetime | None  # "datetime of when the fact became true"
invalid_at:  datetime | None  # "datetime of when the fact stopped being true"
reference_time: datetime | None  # "reference timestamp from the episode that produced this edge"
attributes: dict[str, Any]
```

**Schema extensibility:** prescribed ontology via Pydantic models. `entity_types: dict[str, type[BaseModel]]` and `edge_types: dict[str, type[BaseModel]]` are passed per-`add_episode` call, not fixed globally — the ontology is a **call-time argument**, so different episodes can be ingested under different schemas into the same graph. Custom fields land in the `attributes` dict; `validate_entity_types()` rejects any custom field colliding with a reserved `EntityNode` field (`uuid`, `name`, `group_id`, `labels`, `created_at`, `summary`, `attributes`, `name_embedding`).

`edge_type_map: dict[tuple[str,str], list[str]]` constrains which edge types may hold between which entity-type pairs — e.g. `("Person","Company"): ["Employment"]`. `("Entity","Entity")` is the wildcard fallback; the default when `edge_types` is given but no map is `{('Entity','Entity'): list(edge_types.keys())}`. If no custom edge type matches a node-pair signature, attributes are **cleared**, not merged: *"No matching edge schema → no structured attributes apply; clear any stale attributes left from a prior schema."*

---

## 3. The bi-temporal model — exact mechanics

The paper defines two timelines: **T** (*"when events actually occurred"*) and **T′** (*"when facts are created or invalidated in the system"*), with four timestamps per edge: `t'_created`, `t'_expired`, `t_valid`, `t_invalid`.

In current code that maps to, on `EntityEdge`:

| Field | Timeline | Set by |
|---|---|---|
| `created_at` | T′ (transaction) | `utc_now()` at ingestion |
| `expired_at` | T′ (transaction) | `utc_now()` when the system learns the fact is false |
| `valid_at` | T (event) | LLM extraction from episode content, resolved against `reference_time` |
| `invalid_at` | T (event) | LLM extraction, or set to the invalidating edge's `valid_at` |

v0.30.2 adds a **fifth**: `reference_time`, the originating episode's `valid_at`, denormalized onto the edge. This makes the edge self-describing about *which* event-time anchor its relative-date resolution used — provenance for the temporal inference itself, not just for the fact.

On `EpisodicNode` the split is explicit at ingestion (`graphiti.py`): `created_at=now` (T′), `valid_at=reference_time` (T).

**Timestamp extraction** (`prompts/extract_edges.py`) is rule-governed and deliberately conservative:
> *"If the fact is ongoing (present tense), set `valid_at` to the timestamp of the episode the fact originates from. If no per-episode timestamp is available, use REFERENCE_TIME. If a change/termination is expressed, set `invalid_at` to the relevant timestamp. Leave both fields `null` if no explicit or resolvable time is stated. If only a date is mentioned (no time), assume 00:00:00. If only a year is mentioned, use January 1st at 00:00:00."*

System prompt for the dedicated pass: *"You extract temporal bounds from facts. NEVER hallucinate dates."* Plus: *"Do not hallucinate or infer temporal bounds from unrelated events."* Only set when absent — `_extract_edge_timestamps` short-circuits if `valid_at or invalid_at` is already populated, and deduplicated edges retain their original timestamps rather than re-deriving them.

---

## 4. Contradiction detection & edge invalidation

Two-stage: LLM judgment, then deterministic interval arithmetic.

**Stage 1 — LLM (`prompts/dedupe_edges.py`).** A single call receives the NEW FACT, a list of `EXISTING FACTS` (duplicate candidates: same endpoints), and a list of `FACT INVALIDATION CANDIDATES` (semantically similar edges on either endpoint, retrieved by `get_edge_invalidation_candidates` via cosine similarity ≥ 0.6). Indices are continuous across both lists. Returns `EdgeDuplicate{duplicate_facts: list[int], contradicted_facts: list[int]}`. System prompt: *"You are a fact deduplication assistant. NEVER mark facts with key differences as duplicates."* Key modeling choice, from the prompt's own examples:

> `"Alice works at Acme Corp as a software engineer"` vs `"Alice works at Acme Corp as a senior engineer"` → `duplicate_facts=[], contradicted_facts=[1]` (*"same relationship but updated title — contradiction, NOT a duplicate"*)
> `"Bob ran 5 miles on Tuesday"` vs `"Bob ran 3 miles on Wednesday"` → both empty (*"different events on different days"*)

A fact can be **both** duplicate and contradicted. LLM-returned indices are range-validated and out-of-range values logged and discarded.

**Stage 2 — deterministic (`resolve_edge_contradictions`).** For each candidate the LLM flagged:
- Skip if the intervals don't overlap: `edge.invalid_at <= new.valid_at` OR `new.invalid_at <= edge.valid_at`. No overlap, no contradiction.
- If `edge.valid_at < new.valid_at`: the new edge wins — set `edge.invalid_at = new.valid_at` and `edge.expired_at = utc_now()` (only if not already expired).

And the symmetric case — **out-of-order ingestion**. If the resolved edge isn't already expired, candidates are sorted by `valid_at` and if any candidate has `valid_at > new.valid_at`, the *new* edge is born expired: *"Expire new edge since we have information about more recent events."* Backfilling old data does not clobber newer state.

**Nothing is deleted.** Invalidation writes timestamps. Historical state remains queryable — `SearchFilters` exposes AND/OR filter trees over all four of `valid_at`, `invalid_at`, `created_at`, `expired_at` with operators `= <> > < >= <= IS NULL IS NOT NULL`, and all four are indexed in Neo4j.

**Entity dedup** (`dedup_helpers.py`) is a cheaper deterministic path before any LLM call: exact normalized-name match, then MinHash/LSH over 3-gram shingles (32 permutations, band size 4, Jaccard ≥ 0.9), gated by a name-entropy check (`_NAME_ENTROPY_THRESHOLD = 1.5`, min length 6, min 2 tokens) so short/low-entropy names don't fuzzy-match. Edges have an analogous fast path: exact normalized `fact` text + identical endpoints → reuse, appending the episode UUID.

---

## 5. Search & reranking

Paper formalism: `f(α) → β = χ(ρ(φ(α)))` — search φ, rerank ρ, construct χ.

**Search methods** (per graph layer): `cosine_similarity`, `bm25` (Neo4j's Lucene fulltext / FalkorDB `db.idx.fulltext` / Kuzu FTS / OpenSearch for Neptune), `bfs` (breadth-first, `MAX_SEARCH_DEPTH = 3`). Episodes support BM25 only; communities support cosine + BM25.

**Rerankers** — edges/nodes: `rrf`, `node_distance`, `episode_mentions`, `mmr`, `cross_encoder`; episodes: `rrf`, `cross_encoder`; communities: `rrf`, `mmr`, `cross_encoder`.

Implementations verified: RRF is `1/(i + rank_const)` summed across result lists, `rank_const=1`. MMR is `λ·sim(q,d) + (λ−1)·max_sim(d, others)` with `DEFAULT_MMR_LAMBDA = 0.5` over L2-normalized vectors. `node_distance_reranker` scores by hop distance from a `center_node_uuid` (1 for direct neighbors, `inf` otherwise; center itself pinned at 0.1) and returns `1/score`. `episode_mentions_reranker` RRF-seeds then re-sorts descending by `COUNT(:Episodic)-[:MENTIONS]->(n)` — i.e. **corroboration count as a ranking signal**. `DEFAULT_MIN_SCORE = 0.6`.

Cross-encoder clients: `OpenAIRerankerClient` and `GeminiRerankerClient` (boolean classification via logprobs; Gemini default `gemini-2.5-flash-lite`), plus local `BGERerankerClient` (`BAAI/bge-reranker-v2-m3`).

16 prebuilt recipes in `search_config_recipes.py` (`COMBINED_HYBRID_SEARCH_RRF/MMR/CROSS_ENCODER`, and `EDGE_/NODE_/COMMUNITY_HYBRID_SEARCH_*`). `search_()` defaults to `COMBINED_HYBRID_SEARCH_CROSS_ENCODER`.

Zep cloud's `graph.search` exposes the same reranker names plus richer filters: `scope` ∈ `auto|edges|nodes|episodes|observations|thread_summaries`, `bfs_origin_node_uuids` (≤5), `node_labels`/`edge_types` **and** `exclude_node_labels`/`exclude_edge_types`, `connected_node_uuids`/`source_node_uuids`/`target_node_uuids`/`episode_uuids`, property filters (incl. `CONTAINS`), nested boolean `episode_metadata_filters`, and datetime filters on all four temporal fields. Query capped at 400 chars; `max_characters` budget default 2500, max 50000.

---

## 6. Backends, multi-tenancy, ops

**Backends** (`GraphProvider` enum): `NEO4J` (5.26+), `FALKORDB` (1.1.2+, also embedded "FalkorDB Lite"), `NEPTUNE` (+ OpenSearch Serverless for fulltext), `KUZU` (**deprecated** — *"the upstream Kuzu project is no longer maintained"*, emits `DeprecationWarning`). Zep cloud uses neither — proprietary Konig/Context Graph Engine.

**Multi-tenancy** is `group_id`: a string property on every node and edge, indexed, used as a query filter. It is **not** database-enforced isolation. The docs are explicit: *"your application must authorize each `group_id`"*, values must derive from authenticated state, and *"A namespace filter does not replace application authorization."* No built-in cross-namespace query — *"perform multiple queries across namespaces and combine results in your application logic"* (though `search_` accepts a `group_ids` list, and there is a `@handle_multiple_group_ids` decorator plus a request-scoped driver fix for concurrent multi-group isolation, landed 2026-09-08).

Zep cloud reframes this as `user_id` (user graphs) vs `graph_id` (shared Context Graphs), with real RBAC (humans) + ABAC policies (API keys, UserGroups) layered on: *"Use RBAC for humans. Use policies when you need least-privilege access to context for agents and Memory MCP users."*

**Ops:** OpenTelemetry tracing (optional, no-op when absent, configurable `trace_span_prefix`). Anonymous PostHog telemetry, opt-out via `GRAPHITI_TELEMETRY_ENABLED=false`. Concurrency via `SEMAPHORE_LIMIT` (default 10). FastAPI REST service in `server/`. LLM providers: OpenAI, Azure OpenAI, Anthropic, Gemini, Groq, GLiNER2, any OpenAI-compatible endpoint. Embedders: OpenAI, Azure, Gemini, Voyage.

---

## 7. Write capability (what an external agent can actually write)

**Graphiti MCP server — 13 tools** (`mcp_server/src/graphiti_mcp_server.py`, v1.1.0):

*Writes (5):* `add_memory` (the primary path — async/queued, sequential per `group_id`; takes `reference_time`, `excluded_entity_types`, `custom_extraction_instructions`, `previous_episode_uuids`, `saga`, `saga_previous_episode_uuid`), `add_triplet` (bypasses extraction, writes source→fact→target directly), `delete_entity_edge`, `delete_episode` (cascading — *"entities and facts that were created solely by this episode are removed… while entities and facts also supported by other episodes are preserved"*), `clear_graph`.
*Compute (2):* `build_communities`, `summarize_saga`.
*Reads (6):* `search_nodes`, `search_memory_facts` (with `valid_at_after/before`, `invalid_at_after/before`), `get_entity_edge`, `get_episodes`, `get_episode_entities` (*"Use this to trace provenance: given one or more episode UUIDs, return the graph elements that those episodes produced"*), `get_status`.

MCP ships 10 built-in entity types (`Requirement`, `Preference`, `Procedure`, `Location`, `Event`, `Object`, `Topic`, `Person`, `Organization`, `Document`) and 7 edge types (`RelatesTo`, `MentionedIn`, `WorksFor`, `LocatedAt`, `ParticipatesIn`, `Owns`, `Requires`).

**Zep hosted Memory MCP server** (`https://api.getzep.com/mcp`, OAuth 2.1 + PKCE, short-lived tokens, per-account seats): 12 tools — reads `search_graph`, `get_user_summary`, `get_subgraph`, `get_node_neighbors`, `list_episodes`, `list_graphs`, and the `*_in` variants for shared graphs; writes only `add_memory` and `add_memory_to_graph`. User-graph tools take no user/graph/project argument — *"The target is fixed by the authenticated identity, so one user's token cannot select another user's memory or another project."*

**Zep REST/SDK:** `graph.add` (`type` ∈ `text|json|message`, **10,000 character limit** per call, optional `created_at` RFC3339, `metadata` ≤10 scalar keys, `document_id` for chunk grouping), `thread.add_messages`, `graph.episode.update` (metadata merge semantics; null removes a key), episode/edge/node deletes, `add_fact_triple`. **Observations are read-only** — *"cannot be created, edited, or deleted directly."*

Net: writes are **episode-append plus limited deletes**. You cannot patch a fact's temporal bounds or assert an invalidation directly — you add an episode and let extraction/contradiction logic decide. `add_triplet` is the only bypass, and even it routes through node resolution and embedding generation.

---

## 8. Cross-repo / infrastructure

**Neither product models software repositories or infrastructure as first-class entities.** There is no repo, service, deployment, commit, or dependency concept anywhere in the schema. The graph is domain-agnostic — entities are whatever the LLM extracts under your ontology. You *could* define `Repository`/`Service` Pydantic types and ingest code or IaC as episodes, but nothing parses code, reads a git history, resolves symbols, or understands a service topology. There is no "span multiple repos in one query" concept because there is no repo concept. Zep's positioning is agent memory, customer/account context, and business-domain context — the docs name sales, customer service, health, and finance as use cases.

The only infrastructure-adjacent surface is Zep's own ops: OTel tracing of Graphiti's internals, Zep's audit/API logs, BYOK/BYOM, SOC 2 Type II and HIPAA BAA at Enterprise.

---

## 9. Pricing (getzep.com/pricing, read 2026-09-24; no date stamp on page)

Credit-based. **Free:** 10k credits/mo, 2 projects, 1 MCP seat, 5 custom types, variable rate limits, lower-priority processing. **Flex $125/mo:** 50k credits (then $25/10k), 600 RPM, 5 projects, 5 MCP seats, 10 custom types, 1-day API logs, 30-day rollover. **Flex Plus $375/mo:** 200k credits (then $75/40k), 1,000 RPM, 10 projects, 15 MCP seats, 20 custom types, **Observations**, custom extraction instructions, webhooks, analytics, 7-day API logs, 60-day rollover. **Enterprise:** negotiated, SLA-backed rate limits, unlimited projects, SOC 2 Type II, HIPAA BAA, 1-year audit/API log retention, dedicated AM. Graphiti itself is Apache-2.0, free, self-hosted (you pay for the graph DB and LLM calls).

---

## 10. Recency signals

Repo is under daily active development (HEAD commit dated the day of research). Zep's changelog shows near-daily entries through Sept 2026: entity nodes now list source episodes in an `episodes` field (*"complete lists when ≤100 mentions"* — 2026-09-23), Context Lake and Source traceability docs added, Ingestion Traces replacing reasoning traces, self-referencing fact extraction, user-summary rebuilds after fact-triple/node/batch writes. The hosted MCP server was recently consolidated *down* from eight tools to three core ones (`search_graph`, `get_user_summary`, `add_memory`) with traversal tools retained for relationship questions.
