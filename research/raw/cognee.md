# Cognee — research dossier

**Sources of record:** `github.com/topoteretes/cognee` cloned at commit `663a2dc1` ("docs: lead README with the v1.6.0 local memory quickstart (#5141)", 2026-09-19), `pyproject.toml` `version = "1.6.0"`, Apache-2.0, copyright Topoteretes UG (Berlin). Docs at `docs.cognee.ai`. Companion repos: `topoteretes/cognee-integrations` (plugins), `topoteretes/cognee-community` (third-party adapters), `topoteretes/cognee-rs` (Rust SDK). Research paper: *Optimizing the Interface Between Knowledge Graphs and LLMs for Complex Reasoning*, Markovic, Obradovic, Hajdu, Pavlovic, arXiv:2505.24478 (2025) — cited in the README's BibTeX block.

Notation below: **[SRC]** = read from source in the cloned repo (highest confidence). **[DOC]** = documentation site. **[MKT]** = marketing/pricing page.

---

## 1. What it is

An open-source, self-hostable **AI memory platform**: a Python library plus FastAPI server, CLI, MCP server, TS/Rust SDKs and agent plugins, that ingests documents / code / conversation sessions into a **knowledge graph + vector index** and serves retrieval back to agents. The repo's own words [SRC `CLAUDE.md`]: "It replaces traditional RAG … with an ECL (Extract, Cognify, Load) pipeline combining vector search, graph databases, and LLM-powered entity extraction."

The v1.x surface is a four-verb memory API — `remember`, `recall`, `improve`, `forget` — layered over the older `add` / `cognify` / `search` / `memify` primitives, which still ship [SRC `cognee/__init__.py`].

## 2. The ECL / cognify pipeline (exact task list)

[SRC `cognee/tasks/README.md`, `get_default_tasks`] `cognify()` is seven ordered tasks:

1. `documents.classify_documents` — `Data` rows → typed `Document`s
2. `documents.extract_chunks_from_documents` → `DocumentChunk`s
3. `graph.extract_graph_from_data` — LLM (or GLiNER) extracts `Entity`/`EntityType` + edges
4. `summarization.summarize_text` → `TextSummary` nodes
5. `storage.add_data_points` — writes graph + vector + edge-evidence rows
6. `provenance.record_provenance` — only when `PROVENANCE_TRACKING=true`
7. `graph.detect_contradictions` — only when `CONTRADICTION_DETECTION=true`

`temporal_cognify=True` swaps 3–4 for `extract_events_and_timestamps` → `extract_knowledge_graph_from_events`. Pipelines are composable `Task` objects with `batch_size`, `enriches`, `ctx` injection and a `Drop` sentinel; users can register their own via `run_custom_pipeline`.

**Incremental update** [SRC `api/v1/update/incremental.py`]: `update(data_id, data, dataset_id)` does a paragraph-anchored multi-region diff against stored text, re-chunks only changed spans against the `max_chunk_tokens` recorded on the chunks being replaced, deletes replaced chunks + their summaries + chunk-orphaned entities + triplet embeddings, and re-runs LLM extraction only on new chunks. Chunk id is `uuid5(doc : sha256(text) : occurrence)` so unchanged content keeps identity. Verified on Kuzu/Ladybug, Neo4j and the Postgres demo adapter; Neptune falls back to full re-cognify.

## 3. Data model

`DataPoint` (pydantic `BaseModel`) is the base class of every graph node [SRC `infrastructure/engine/models/DataPoint.py`]. Base fields: `id: UUID`, `created_at`/`updated_at` (ms epoch), `ontology_valid: bool`, `ontology_uri: str|None`, `version: int`, `topological_rank`, `valid_to: int|None` (bi-temporal supersession), `metadata: MetaData`, `type` (auto-set to class name), `belongs_to_set`, `source_pipeline`, `source_task`, `source_node_set`, `source_user`, `source_content_hash`, `feedback_weight: float = 0.5`, `importance_weight: float|None = 0.5`.

Schema extensibility is **structural**: subclass `DataPoint` with plain pydantic fields; a field holding another DataPoint (or list) becomes an edge named after the field; scalars become node properties. `metadata` is the storage contract:
- `index_fields` — fields to embed; each gets its own vector collection `<TypeName>_<field>`. Declarable as `Annotated[str, Embeddable()]`.
- `identity_fields` — fields from which the node id is derived by `uuid5(NAMESPACE_OID, f"{cls.__name__}:{joined}")`, so the same real-world thing merges across ingestions. Declarable as `Annotated[str, Dedup()]`. Without it a node gets a random uuid4 and can never merge.
- `transparent` — node is unwrapped; its edges attach to its children.

Two advanced declaration forms [SRC `shared/llm_graph_model.py`]: **typed edge fields** `list[Edge[Source, Target, RelType]]` (the LLM answers flat relationship rows resolved against extracted nodes; third generic controls naming — field name / `Literal[...]` / free-form `str`), and **identity references** `Annotated[Role, FromIdentity()]` (the LLM answers an identity string instead of a nested object). Unresolvable rows are dropped with a warning, never failing the chunk. `Edge` carries `relationship_type`, `weight`, `weights: dict[str,float]`, `properties`, `edge_text`.

Built-in node types [SRC `modules/engine/models/`]: `Entity` (name, is_a→`EntityType`, description, relations, plus optional `truth_alignment`/`truth_subspace_signature`/`truth_epoch`), `EntityType`, `NodeSet`, `Event`, `Interval`, `Timestamp`, `Triplet`, `Skill`, `SkillRun`, `SkillImprovementProposal`, `Tool`, `TableRow`/`TableType`/`ColumnValue`/`DltColumn` (relational-schema ingestion), `DocumentChunk`, `TextSummary`, plus the code-graph family (§5) and `Rule`/`RuleSet` for coding rules.

**Ontologies** [SRC `modules/ontology/`]: an RDF/OWL file (`ONTOLOGY_FILE_PATH`) is parsed by `RDFLibOntologyResolver`; extracted entity names/types are matched to ontology classes/individuals with a pluggable `MatchingStrategy` (default `FuzzyMatchingStrategy`, difflib cutoff 0.8). `ONTOLOGY_MODE=annotate` (default) enriches; `strict` drops entities with no ontology grounding (graph only — chunk text stays embedded). Matched nodes keep the external `ontology_uri`, which is what lets the graph be exported as RDF. Ontologies can be uploaded via `POST /api/v1/ontologies` and selected per write by `ontology_key`.

## 4. Storage backends

- **Graph** [SRC `get_graph_engine.py` branches]: `ladybug` (default, embedded — a pinned fork/successor of Kuzu; `kuzu` is an accepted alias), `neo4j`, `neptune`, `neptune_analytics`, `ladybug-remote`/`kuzu-remote`, `turso`, `postgres_demo` (explicitly labelled a **demo, not production-ready**; the production Postgres-graph is a licensed product).
- **Vector**: `lancedb` (default), `pgvector`, `neptune_analytics`, `turso`. ChromaDB/Qdrant/Weaviate/Milvus/FalkorDB/Memgraph/Pinecone/Turbopuffer exist only as *community adapters* registered at runtime via `use_vector_adapter()` / `use_graph_adapter()`.
- **Relational**: SQLite (default) or Postgres, via SQLAlchemy + Alembic migrations.
- **Session cache**: `sqlite` (default), `postgres`, `redis`, `fs`, `tapes`.
- **Embeddings**: LiteLLM, Ollama, OpenAI-compatible, **fastembed** (local, `BAAI/bge-small-en-v1.5` default in keyless mode).
- **LLM**: OpenAI, Azure, Gemini, Anthropic, Bedrock, Ollama, LM Studio, custom OpenAI-compatible, via LiteLLM. Structured output via `litellm_native` (default), `instructor`, or `baml`.

The graph adapter interface is broad — ~45 methods including `get_neighborhood(depth)`, `get_nodeset_subgraph`, `get_top_degree_node_ids`, `get_graph_metrics`, source-ref attach/remove for nodes *and* edges, `get/set_node_feedback_weights`, `get/set_edge_feedback_weights`, `get/set_node_truth_state`, `update_node` (partial), `get_triplets_batch`.

**Multi-tenancy**: `ENABLE_BACKEND_ACCESS_CONTROL=True` (default) gives each `(user, dataset)` its own graph + vector database. Supported for Ladybug/Kuzu, Neo4j (needs multi-DB edition), Postgres, Turso, LanceDB, PGVector; **not** for Neptune, ladybug-remote, Neptune Analytics or community adapters — with the flag on, an unsupported backend is a hard `EnvironmentError`, not a silent fallback.

## 5. Code graph ingestion

Deterministic and **LLM-free**. Cognee shells out to **enola** (`github.com/enola-labs/enola`, a Go CLI, shipped as the pinned `enola-cli` wheel) which writes a snapshot contract of `facts.jsonl` + `insights.json` + `receipt.json`, `format_version: 1` [SRC `tasks/code_graph/enola.py`]. Cognee maps fact kinds to node types [SRC `tasks/code_graph/extract_code_graph.py` `KIND_TO_MODEL`]:

`module`→`CodeModule`, `symbol`→`CodeSymbol` (symbol_kind ∈ function, method, getter, struct, interface, type, class, variable, constant, enum…), `route`→`ApiEndpoint`, `storage`→`StorageResource`, `dependency`→`ExternalDependency`, `service`→`CodeService`, `test_ref`→`CodeTestReference`, `file_ref`→`CodeFileReference`, `insight`→`CodeInsight` (architecture findings from enola explainers: cycles, layers, hotspots, god-class, dependency-depth, exported-surface, complexity-outliers, dead-methods, unused-routes — linked to cited facts by `evidences` edges), `intent`→`CodeIntent` (declared architecture from `enola-intent.yaml`), `extraction`→`CodeExtractionAccount` (per-extractor coverage counters, so a thin graph can be told from a thin extraction), `association`→`CodeAssociation` (Rails `has_many`/STI), `lint`→`CodeLintFinding`. Edge types include `calls`, `imports`, `has_method`, `part_of`, `evidences`.

Node identity is `uuid5` over `(repo, kind, name)`; `fact_hash` fingerprints derived fields so re-ingestion writes only changed facts (delta writes) and sweeps stale nodes. `CodeRepository` stores `last_snapshot_id`, `last_delta` and a projection of the receipt (`format_version`, `enola_version`, git provenance, counts, extraction-quality block).

Search is **only** via `SearchType.CODE` with a `code_query` dict [SRC `code_retriever.py` `_OPERATIONS`]: `query_facts`, `explore`, `traverse`, `find_path`, `impact_analysis`, `insights`, `architecture`, `delta`. No LLM, no embeddings, no vector search — graph adapter only, with a bounded LRU/TTL parsed-index cache keyed by dataset + graph identity. Any query can add `"diagram": "mermaid"|"dot"` for deterministic diagram source. Whole repos (local dir or git URL) go through a CODE_REPO route with cross-file edges; remote URLs are shallow-cloned to `~/.cognee/repos`.

## 6. Contradiction detection, supersession, provenance, temporality

**Contradiction detection** [SRC `tasks/graph/detect_contradictions.py`] — opt-in (`CONTRADICTION_DETECTION=true`, default **off**), runs as the last cognify task after `add_data_points`. Mechanism: collect ids of entity/event nodes this ingestion touched → `graph_engine.get_neighborhood(ids, depth=1)` → render each edge as `[F#] <source> <rel> <target>`, skipping `STRUCTURAL_RELATIONSHIPS = {contains, is_part_of, made_from, exists_in, contradicts}` and edges with an unnamed endpoint, capped at `CONTRADICTION_MAX_FACTS` (500) → one LLM call returning a `ContradictionList` of `(first_fact_id, second_fact_id, reason, confidence)` → drop anything below `CONTRADICTION_CONFIDENCE_THRESHOLD` (0.5) → write a `contradicts` edge between the differing subjects (or the differing objects when subjects match) carrying `first_fact`, `second_fact`, `reason`, `confidence`. It logs a warning per conflict. **It only adds edges — never rewrites or deletes — and swallows its own errors.** Cross-ingestion contradictions work because `Entity` ids are deterministic. Not covered: the temporal cognify path, the code-graph route.

**Supersession** is a *separate*, also opt-in mechanism [SRC `tasks/graph/resolve_temporal_contradictions.py` + `modules/graph/utils/temporal_conflict_resolver.py`]. It is a no-op unless the caller declares `functional_relationships` (single-valued relations, e.g. `{"ceo_of"}`) — reachable only from `cognify()`, not `remember()`. It groups touched-subject edges by `(source, relationship)`, and where a group holds >1 distinct target, the most recent assertion wins; losers get `superseded=True`, `superseded_by=<winning edge_object_id>`, `supersession_reason`. Nothing is deleted. There is **no cardinality inference** — cognee says outright that which relations are functional "cannot be inferred — only declared."

**Fact validity** is bi-temporal: `close_node(node_id, at_ms)` stamps `valid_to`; `is_valid(node, at_ms)` reads it. Last-write-wins, not idempotent. Distinct from `Event`/`Interval` occurrence time.

**Five provenance mechanisms** [SRC CLAUDE.md, verified against `modules/provenance/`]: (1) source stamping on node fields (`COGNEE_PROVENANCE_MODE`, default `lightweight`); (2) graph source-refs keyed `make_source_ref_key(dataset_id, data_id)`, always on, drives `forget()` rollback; (3) a **hash-chained tamper-evident audit ledger** in `provenance_entries` (`PROVENANCE_TRACKING`, default **false**); (4) a memory-provenance projection (tenant→user→dataset→data + ACL) computed on demand at `GET /v1/schema/provenance`; (5) **edge evidence** — which document chunk supports which graph edge, in `provenance_edge_evidence` (`EDGE_EVIDENCE_ENABLED`, default **true**), returned as structured `EvidenceReference` objects when searching with `include_references=True`. Scope limit stated plainly: edge evidence covers only edges extracted from document chunks — *not* contradiction edges, improve-stage enrichment, session bridging, or the code graph.

**Staleness**: rows are ignored at read time when their pipeline run didn't complete or their document is gone, and swept on delete / `forget(memory_only=True)`.

## 7. `improve()` and memify

`improve()` is an explicit orchestrator over nine ordered stages [SRC `modules/improve/registry.py`]: `feedback_weights`, `persist_session_qa`, `persist_agent_traces`, `extract_agent_context`, `distill_sessions`, `update_user_preferences`, `build_truth_subspace`, `triplet_enrichment`, `global_context_index`. First seven need `session_ids`; last two work on the graph alone. Each stage has a `gate()` (returns skip reasons like `no_session_ids`, `backend_unsupported`, `no_llm_configured`, `opt_in_disabled`) that runs before any LLM cost, and returns a `StageResult` with status `completed | already_completed | errored | skipped`. Only `persist_session_qa` is fatal. Runs claim a lock keyed on sessions + `dataset:<id>`; watermarks prevent redundant work; `IMPROVE_MAX_RERUN_PASSES=3`.

`memify()` is the lower-level enrichment API taking `extraction_tasks` + `enrichment_tasks`. Named tasks resolvable as strings [SRC `memify_task_registry.py`]: `extract_subgraph`, `extract_subgraph_chunks`, `get_triplet_datapoints`, `extract_user_sessions`, `cognify_session`, `extract_agent_trace_feedbacks`, `cognify_agent_trace_feedback`, `apply_feedback_weights`, `detect_entity_duplicates`, `merge_entity_duplicates`, `index_data_points`. Pre-assembled memify pipelines in `cognee/memify_pipelines/` add `consolidate_entities`, `consolidate_entity_descriptions`, `create_triplet_embeddings`, `cross_connect_entities`, `global_context_index`, `persist_sessions_in_knowledge_graph`, `persist_agent_trace_feedbacks_in_knowledge_graph`.

**Truth subspace** [SRC `modules/truth_subspace/build.py`]: replays the `session_learnings` node set into up to `DEFAULT_K` deterministic centroid slots, projects `DocumentChunk`s onto them, stores coordinates with an epoch. The hybrid reranker trusts a chunk's coordinates only when its `truth_epoch` matches the live centroid epoch — a failed build degrades reranking rather than corrupting it.

**Session distillation** [SRC `modules/session_distillation/distill.py`]: load QA turns + distillable context entries → batch → one curator LLM call per batch proposing lessons → per-lesson novelty search + writer/rejecter LLM → accepted lessons rendered as documents and cognified. A failed call raises rather than advancing the watermark, so lessons are never silently lost.

## 8. Retrieval

23 `SearchType`s including `HYBRID_COMPLETION` (default), `GRAPH_COMPLETION`, `GRAPH_COMPLETION_COT`, `GRAPH_COMPLETION_CONTEXT_EXTENSION`, `GRAPH_COMPLETION_DECOMPOSITION`, `GRAPH_SUMMARY_COMPLETION`, `TRIPLET_COMPLETION`, `RAG_COMPLETION`, `CHUNKS`, `CHUNKS_LEXICAL`, `SUMMARIES`, `CYPHER` (gated on `ALLOW_CYPHER_QUERY`), `NATURAL_LANGUAGE`, `TEMPORAL`, `FEELING_LUCKY`, `CODING_RULES`, `SKILLS`, `AGENTIC_COMPLETION`, `CODE`, `GRAPH_REPORT`. `recall()` auto-routes with a **rule-based, LLM-free first-match table** (`api/v1/recall/query_router.py`) that only ever picks `CHUNKS_LEXICAL` for a quoted phrase, `CODING_RULES` for an explicit phrase, or the `HYBRID_COMPLETION` default — never `CYPHER`. `only_context=True` returns the exact user+system prompts the LLM would have received.

## 9. MCP server

[SRC `cognee-mcp/src/server.py` + README] Exactly **four** tools; `tools/list` advertises three by default, the rest are found via FastMCP `search_tools` and remain callable by name (`COGNEE_MCP_TOOL_MODE` ∈ `default|minimal|all`).

| Tool | R/W | Args |
|---|---|---|
| `remember` | **write** | `data`, `filename`+`content_base64` (≤10 MB), `dataset_name`, `session_id`, `custom_prompt`, `background`, `ontology_key`, `self_improvement` |
| `recall` | read | `query`, `search_type`, `datasets`, `session_id`, `system_prompt`, `top_k=15` |
| `forget` | **write (destructive)** | `dataset`, `everything`, `data_id`, `dataset_id` |
| `cognify_status` | read | `dataset_name`, `pipelines` (unadvertised by default) |

`improve` is defined in the server module but **deliberately not registered as a tool** — reachable only through `remember(self_improvement=True)`. Responses carry `content[0]._meta["cognee/memory"]` with `count` and a `state` of `found | indexing | build_failed | none`. Per-client **agent scoping** gives each MCP client its own dataset (`cursor_vscode_memory`, `claude_code_memory`, …) unless `COGNEE_MCP_AGENT_SCOPED=false`. Transports: stdio, SSE (legacy), HTTP.

## 10. Coding-agent plugin (Claude Code / Codex / OpenClaw)

[SRC `cognee-integrations/integrations/claude-code/`] Installed via `claude plugin marketplace add topoteretes/cognee-integrations` + `claude plugin install cognee-memory@cognee`. The hooks are **stdlib-only HTTP clients** that never import cognee in-process. Hook wiring (`hooks/hooks.json`):

- `SessionStart` — mode select, identity provisioning, dataset readiness, watcher bootstrap, and an `additionalContext` steer telling Claude to treat Cognee as authoritative over `MEMORY.md` (`COGNEE_PREFER_MEMORY`)
- `UserPromptSubmit` — dataset-scoped context lookup (sync) + async prompt staging
- `PreToolUse(Read)` — `file-context.py` injects code-graph facts about the file about to be read (symbols with line numbers, calls-out-to, imports)
- `PostToolUse(Bash|Agent|Read|Write|Edit|Grep|Glob)` — async trace write
- `Stop` — assistant answer write, credits refresh, optional transcript clear
- `PreCompact` — memory anchor build; `SessionEnd` — detached final sync worker (with an exit watcher fallback)

Session→graph sync posts to `/api/v1/improve` (session-aware) rather than re-posting transcript text; there is **no fallback** — a server without it logs `improve_unsupported`. Triggers: idle watcher (`COGNEE_IDLE_THRESHOLD=60`s), every `COGNEE_AUTO_IMPROVE_EVERY=150` stored calls, with a persisted per-session cooldown `COGNEE_IMPROVE_COOLDOWN=1800`s that failures also arm as backoff. Repos auto-index at session start when the server is local and re-index after turns that change the working tree; each repo gets a dataset `codebase-<repo-name>-<digest>`. The README is explicit about a freshness asymmetry: a local server sees the working tree including uncommitted changes; a cloud server sees only the last pushed commit of a cloned URL. Skills: `cognee-remember`, `cognee-search`, `cognee-sync`, `cognee-code`, `cognee-forget`, `cognee-switch-datasets`. Other integrations in the repo: aider, antigravity, claude-agent-sdk, codex, crewai, dify, google-adk, langgraph, mastra, n8n, obsidian, opencode, openclaw, slack, strands, telegram, vellum, vscode, web-widget.

## 11. Other notable features

- **COGX** — "the Cognee eXchange format for portable memory" [SRC `modules/migration/cogx.py`], version `0.1`: a directory with `manifest.json` + one JSONL per record kind (`COGXDocument`, conversation/turn, etc.), pydantic-discriminated by `kind`. Importers exist for **Mem0, Zep/Graphiti, Letta, LangMem**; `cognee.export(format="cogx"|"json"|"graphml"|"cypher"|"pydantic")` dumps out; `cognee.push()` ships a COGX tarball to Cognee Cloud preserving the graph instead of re-deriving it.
- **Skills (procedural memory)** — dataset-scoped `SKILL.md` playbooks, discovered by `SearchType.SKILLS` (metadata-only, progressive disclosure), loaded by the `load_skill` tool (12k cap), improved via `SkillRun` → LLM-drafted `SkillImprovementProposal` → apply by id.
- **Authorized SQL tool connections** [SRC `api/v1/tools/tools.py`] — register an external SQL DB (connection string AES-encrypted at rest, never returned), query it read-only via `recall(scope=["tools"])` under `TOOL_CALLS_ENABLED`. Write-back is approval-gated: `propose_sql_write` / `propose_corrections` (drafts UPDATEs **from detected `contradicts` edges**) → `list_write_proposals` → `apply_write_proposal` (the only path that commits; rolls back if affected rows exceed the cap or differ from the dry run) → `reject_write_proposal`.
- **GLiNER demo extractor** — LLM-free graph extraction with `fastino/gliner2.5-base-v1` (~800 MB), closed schema resolved per document from caller labels → OWL classes → a frozen LABEL_BANK/RELATION_BANK, capped at 20 per kind. Explicitly a *demo* of an enterprise GLiNER product.
- **Presort** (`remember(dry_run="presort")`) — classify, hash, dedup, version and PII-detect a folder before ingestion.
- **Web scraping / crawling** (Tavily, BeautifulSoup, Playwright), OCR/docling, audio/video loaders, relational-DB schema ingestion (`ingest_database_schema`), dlt sources, Slack/GitHub/Linear webhook integrations with OAuth credential storage.
- **Visualization**: `visualize_graph`, `start_visualization_server`, `get_schema_inventory`, `get_memory_provenance_graph`, Next.js UI at port 3000.
- **Benchmarks** [SRC README]: BEAM 0.79 at 100K-token context, 0.67 at 10M (the latter labelled "exploratory"), with the README itself cautioning that the two settings use different conversations, models and retrieval-selection procedures.

## 12. Pricing / licensing [MKT]

Core repo is **Apache-2.0**. Cognee Cloud pricing page: **Free** $0/mo (1M tokens, 1 workspace, unlimited users/API calls, agentic integrations); **Standard** $1.00 per 1M tokens processed + $5 per additional workspace (adds Slack/Notion/Linear/Google Drive connectors, code indexing, in-app support); **Enterprise** custom / BYOC, listing bi-temporal memory with conflict resolution, provenance tracking, per-user and per-agent personalization, named support. Several in-repo features are explicitly demos of licensed products: Postgres-as-graph, GLiNER extraction.
