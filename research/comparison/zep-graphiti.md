# Zep / Graphiti vs. Living AI Knowledge

**Compared:** 2026-09-24
**Verified against:** `getzep/graphiti` @ `47f6482`, `graphiti-core` v0.30.2, MCP server v1.1.0 (read from source, not docs); `help.getzep.com` for the hosted product.

---

## 0. Corrections to the incoming dossier

I re-read the source. Four things need fixing before anything downstream is trusted:

1. **`build_indices_and_constraints` builds no constraints.** Despite the name, `Neo4jGraphOperations.build_indices_and_constraints` executes `range_indices + fulltext_indices` and nothing else. A repo-wide grep for `CONSTRAINT`/`IS UNIQUE` across `graphiti_core/` returns **zero hits**. There is no uniqueness enforcement anywhere in Graphiti. This matters a lot below — it means the "strong identifier as a database constraint" idea has no analogue at all, not even a weak one.
2. **The out-of-order expiry is not in `resolve_edge_contradictions`.** The dossier attributes it there; it actually lives in `resolve_extracted_edge` (`edge_operations.py` ~L823-840), which sorts `invalidation_candidates` by `valid_at` and expires the *incoming* edge. The substance of the dossier's claim is right, the location is wrong. `resolve_edge_contradictions` itself only handles the forward case.
3. **The 13-tool MCP list is confirmed exactly** from `mcp_server/src/graphiti_mcp_server.py` — I enumerated the `@mcp.tool()` decorators. Good.
4. **The dossier under-reports the most important thing about BFS retrieval.** See §2. This is the finding that decides the whole comparison, and it is not in the dossier.

---

## 1. Point-by-point

| Concept element | Zep/Graphiti | Verdict |
|---|---|---|
| Proposition / assertion split | **Nothing.** `EntityEdge` is one row that *is* both the claim and the claiming. `episodes[]` is a list of source UUIDs on that row. | Ours is better for this problem |
| Polarity / refutation | **Nothing.** No `polarity`, no negative assertion. Contradiction resolves to a *winner* via timestamps; the loser is expired, not held as dissent. | Ours |
| Corroboration as a count | **Partial.** `episode_mentions_reranker` sorts by `COUNT((:Episodic)-[:MENTIONS]->(n))` — but it is a *retrieval ranking signal on entities*, not a queryable per-fact support count, and it is not derivable into a status. | Ours |
| Confidence | **Nothing.** Grep for `confidence` across `graphiti_core/` hits only `gliner2_client.py`'s extraction-time `include_confidence` flag, which is never persisted to a node or edge. | Ours |
| Trust score | **Nothing.** No method weighting, no source reliability, no freshness decay, no anchor integrity. | Ours (but unproven — see §4) |
| Bi-temporal validity | **Strong, and better than ours in one respect.** Four timestamps (`created_at`/`expired_at` = system, `valid_at`/`invalid_at` = world) plus a fifth, `reference_time`. | **Theirs** |
| Scope sweeps (closed-world) | **Nothing.** No run identity, no snapshot semantics, no bulk expiry of un-reasserted facts. Every fact dies individually by contradiction or not at all. | Ours |
| Predicate cardinality | **Nothing declarative.** No functional-predicate concept. Supersession is decided per-fact by an LLM similarity judgment (cosine ≥ 0.6) plus interval arithmetic. | Ours |
| Entity resolution | **Has one, architecturally opposite.** See below. | **Ours, clearly** |
| Strong vs. weak identifiers | **Nothing.** Resolution is name-string-based only. No identifier table, no constraint. | Ours |
| Read-time canonicalization | **Nothing — the opposite.** Merges are destructive rewrites at write time. | Ours |
| `env` discriminator | **Nothing.** No first-class discriminator concept. | Ours |
| Call-site grain → derived service edges | **Nothing.** No grain concept, no derivation layer. | Ours |
| Accept-then-normalize write path | **Partial.** `add_memory` is queued and async — but the *normalization is the ingestion*, and it is LLM-blocking. | Mixed, see below |
| Path-template retrieval | **Nothing. This is the big one.** | **Ours, decisively** |
| Four fact sources | **One and a half.** Agent-asserted and human-authored, both through the same text/JSON episode funnel. No static analysis, no telemetry/cloud import. | Ours |
| Verification agent / refutation loop | **Nothing.** No external checker, no re-validation, no way to express "I checked and this is false." | Ours |

### Entity resolution — the sharpest disagreement

This is worth being precise about, because Graphiti does something the concept explicitly forbids.

`_resolve_with_similarity` (`dedup_helpers.py` L220) resolves in two deterministic steps before any LLM is consulted:

- exact normalized-name match → **auto-merge**;
- if the name clears an entropy gate (`_NAME_ENTROPY_THRESHOLD = 1.5`, min length 6, ≥2 tokens), MinHash/LSH over 3-gram shingles, and **any candidate with Jaccard ≥ `_FUZZY_JACCARD_THRESHOLD = 0.9` is auto-merged with no LLM check at all.**

That is auto-merge on name similarity alone — the exact failure the concept's `merge_candidate` table exists to prevent. Worse, the merge is **destructive and write-time**: `_promote_resolved_node` rewrites the node, and `state.uuid_map[node.uuid] = match.uuid` remaps every downstream reference. There is no `entity_merge` table, no `entity_distinct`, no `merge_candidate` queue, and — verified by grep — **no unmerge of any kind**. Once `prod-redis` and `staging-redis` collide, there is no recovery path short of deleting and re-ingesting.

Graphiti mitigates this for its own domain: names like "Alice Chen" are high-entropy and rarely 0.9-similar to a different person. But the concept's domain is exactly the adversarial case. `notifications-service-prod` vs `notifications-service-staging` — normalize, shingle, and those are far above 0.9 Jaccard. `notif-cache-v1` vs `notif-cache-v2` likewise. **Graphiti's entity resolution would actively destroy the distinctions this concept is built on**, and its one protective mechanism (the entropy gate) is inverted here: infrastructure names are *long and high-entropy*, so they sail straight into the fuzzy path rather than being deferred to the LLM.

The concept's read-time indirection through `entity.canonical_id` is strictly better for this domain and it is not a close call.

### Bi-temporality — where they genuinely beat us

Credit where due. `reference_time` (new in 0.30.2) denormalizes the originating episode's `valid_at` onto the edge, so the edge records *which anchor its relative-date resolution used*. That is provenance for the temporal inference itself, and the concept has no equivalent. If an agent writes "we switched to Memcached last Tuesday," you need to know which "now" resolved "last Tuesday" — otherwise the timestamp is uninterpretable on replay.

The out-of-order handling is also more careful than most: sort candidates by `valid_at`, and if one is *newer* than the incoming edge, the **incoming edge is born expired** ("Expire new edge since we have information about more recent events"). Backfill cannot clobber newer state. The concept should check it has an answer here, because a scope sweep replaying an old commit is structurally the same hazard.

### Write path — the 202 is not what it looks like

Both return fast. But `POST /v1/observations` is fast because nothing blocks on an LLM *ever*; `add_memory` is fast because the LLM work is queued behind it. The concept's guarantee is "an unknown predicate is stored raw and never rejected." Graphiti's is "your text will be processed eventually, and what comes out is whatever the extractor decided."

That difference is load-bearing. In Graphiti there is no way for an agent to say "this specific edge, these specific endpoints, this predicate" and have it survive verbatim. `add_triplet` looks like the escape hatch — and it is the closest thing — but I read it: it unconditionally routes both endpoints through `resolve_extracted_nodes` unless you supply a UUID that already exists. So even the direct-write path is subject to the fuzzy auto-merge above. **There is no way to write a fact with guaranteed-stable entity identity.**

---

## 2. The motivating query — where it actually breaks

> "Where does the list of notifications in Client A come from?"

**It cannot answer this, and the reason is architectural rather than a missing feature.**

Set aside the schema gap for a moment — assume you did all the work: defined `Repository`, `Service`, `Cache`, `Database`, `TerraformResource` Pydantic entity types, wrote a `edge_type_map` constraining `("Service","Cache"): ["ReadsFrom"]`, and hand-fed four repos' worth of call sites plus Terraform state through `graph.add` in 10,000-character chunks (verified limit, from Zep's own docs) with a shared `document_id`. Expensive, but possible.

You still hit three walls.

**Wall 1: BFS returns a bag of edges, not a path.** This is the finding that settles it. From `graphiti_core/driver/neo4j/operations/search_ops.py` L372:

```cypher
MATCH path = (origin {uuid: origin_uuid})-[:RELATES_TO|MENTIONS*1..{max_depth}]->(:Entity)
UNWIND relationships(path) AS rel
MATCH (n:Entity)-[e:RELATES_TO {uuid: rel.uuid}]-(m:Entity)
RETURN DISTINCT <edge fields> LIMIT $limit
```

It computes a path — and then `UNWIND`s it and returns `DISTINCT` edges. The function signature is `-> list[EntityEdge]`. **The connectivity is discarded at the API boundary.** You get an unordered neighborhood set and a default `LIMIT 10`. You cannot get back "Client A → Service C → Redis E → Postgres → Terraform" as an ordered chain, because no Graphiti API returns an ordered chain. Reassembling one client-side from a deduplicated edge bag is a graph search you'd be writing yourself — at which point you are not using Graphiti's retrieval, you are using it as a triple store.

The concept's entire premise is "the whole value is the connected path." Graphiti's retrieval layer structurally does not produce one.

**Wall 2: every predicate is the same relationship type.** Verified in `edge_db_queries.py`: every entity-entity fact is `MERGE (source)-[e:RELATES_TO {uuid: ...}]->(target)`. The predicate (`calls`, `reads_from`, `falls_back_to`) is a *property* called `name`, not a relationship type. So a typed path template — "follow `calls`, then `reads_from`, then `falls_back_to`" — is not expressible as a graph pattern. `SearchFilters.edge_types` is a flat post-hoc filter over result edges, not a per-hop constraint. You cannot whitelist edge types *per hop*, which is precisely what the concept's templates do.

**Wall 3: depth 3.** `MAX_SEARCH_DEPTH = 3` (`search_utils.py` L67) is the default `bfs_max_depth`. The motivating chain is four hops before it reaches Terraform. It is a parameter and you can raise it — but raising an undirected-ish property-filtered variable-length match on a graph with no per-hop typing is how you get a query that either times out or returns the entire graph. And note the pattern is **directed outbound only** (`-->`), so the concept's "reverse hop on `exposes_endpoint`" problem — the one the README says the skeleton already caught — would bite here with no way to declare the exception.

Then "how do I connect to that database?" has no answer shape at all: no secret-location modelling, and Zep's own guidance warns against treating ingested metadata as a trusted security label.

**Verdict: no, and the fix is a retrieval rewrite, not a configuration.**

---

## 3. Threat assessment — **low**

To ship this concept, Zep would need to:

- add an assertion layer with polarity, method, confidence and evidence (a new table/edge class and a rewrite of every read path that currently assumes one edge = one fact);
- replace destructive write-time entity merge with non-destructive read-time canonicalization, plus strong-identifier constraints — on a proprietary engine, with existing customer graphs to migrate;
- add closed-world scope sweeps and declarative predicate cardinality;
- **rewrite retrieval to preserve paths** and support per-hop typed templates, which means either reifying predicates as relationship types or building a path-template compiler;
- build code/IaC/cloud importers from nothing — no AST, no git reader, no Terraform parser, no OTel ingest exists today.

That is not an adjacent feature set; it is most of the concept, and two items are rewrites of load-bearing internals.

**Incentive is the stronger argument.** Zep's stated markets are agent memory, customer/account context, and business-domain context — the docs name sales, customer service, health and finance. Developer tooling and code intelligence appear nowhere. Their retrieval bet is embedding-first hybrid search with rerankers; the concept's bet is that embeddings must *never* drive traversal. These are opposed architectural commitments, and Zep's is validated by their own benchmark story (DMR, LongMemEval — both conversational-memory benchmarks). Moving to path-first traversal would make their existing benchmarks worse.

**But** they ship near-daily, have 31k stars and a real distribution channel, and "context graph for engineering teams" is a legible adjacent market. If someone proves the category, a `Repository`/`Service` ontology pack plus a code importer is a plausible quarter of work — it would be shallow (no paths, no refutation) but it would be *marketed* as the same thing. The risk is narrative, not technical.

---

## 4. What to steal — concretely

1. **`reference_time` on the assertion.** Steal this outright. Store the "now" that the writer's relative-date resolution was anchored to, separate from `valid_from`. Without it, "we switched last Tuesday" is uninterpretable on replay. Cheap column, real value.
2. **Born-expired on out-of-order write.** When an incoming assertion on a functional predicate is *older* than an existing live one, expire the incoming one rather than the existing one. The concept's scope sweeps will replay historical state eventually and this is the guard.
3. **Non-overlap short-circuit before any expensive check.** Graphiti skips contradiction work entirely when intervals don't overlap (`edge.invalid_at <= new.valid_at OR new.invalid_at <= edge.valid_at`). Pure arithmetic, no model call. Put this in front of the cardinality machinery.
4. **The entropy gate, inverted.** Graphiti gates *fuzzy* matching on name entropy and lets exact matching through unconditionally. Adopt the gate, invert the tuning: in this domain high entropy means "long infrastructure name likely differing by one discriminating token" — the highest-risk case, not the safest. Consider gating on *edit distance concentrated in a discriminator position* (`-prod` vs `-staging`, `-v1` vs `-v2`) and hard-blocking merges that differ only there.
5. **`excluded_entity_types` per-call.** Per-ingest suppression of extraction types is a genuinely good ergonomic. Worth an analogue: a scan run that declares "I am authoritative for `reads_from` only" scopes its sweep correctly and can't nuke edges it never looks for. **This is probably the missing safety rail on scope sweeps** — a sweep should be scoped by `(scope_key, predicate set)`, not `scope_key` alone.
6. **`get_episode_entities` as an API shape.** "Given a source, return everything derived from it" is the reverse-provenance call. The concept has evidence pointing one way; expose the inverse: `GET /v1/evidence/{commit}/derived`. Essential for "this commit was reverted, what did it claim."
7. **Attributes cleared, not merged, on schema mismatch.** Graphiti explicitly clears stale attributes when no edge schema matches rather than leaving them. Take the discipline: a re-assertion under a changed predicate vocabulary should not silently retain qualifiers from the old one.
8. **Naming.** "Episode" is a better word than "observation" for *a raw unit of input retained losslessly*, and the concept should keep the raw episode content addressable rather than only retaining extracted assertions. `add_memory` / `search_memory_facts` are also better agent-facing tool names than CRUD-ish ones.

**Do not steal:** `group_id` as the multi-tenancy story (Zep's own docs concede it is a query filter, not enforcement); embedding-first hybrid retrieval; write-time destructive merge.

---

## 5. Build on it, or take it as a data source?

**Build on it: no.** The three things you would be building on are the three things that are wrong for this domain. You would inherit destructive fuzzy entity merge with no unmerge (fatal — silent, permanent, and hits `prod`/`staging` first), a retrieval layer that discards path structure (fatal — it is the product), and a single `:RELATES_TO` relationship type that makes typed path templates inexpressible. You would keep Graphiti's bi-temporal logic and its episode store, and rewrite everything else — while paying Python, a graph DB dependency, and an upstream that has no reason to care about your use case. The Postgres + proposition/assertion decision already made is the right one, and nothing here should change it.

**As a data source: also mostly no, and this is worth saying plainly.** The tempting story is "Zep holds conversational context, we import facts from it." It doesn't survive contact:

- Graphiti facts carry **no confidence and no method**, so every imported assertion arrives as `method=llm_inferred, confidence=<invented>`. You'd be manufacturing the provenance the concept exists to keep honest.
- Its entities have already been merged by the fuzzy path. Importing them imports the over-merges, and you cannot detect them after the fact — they arrive as single entities.
- Its evidence granularity is **episode-level**, not `{repo, commit, path, line}`. Anchor integrity is uncomputable on anything imported, so `trust` degrades to `base × freshness` for the whole imported subgraph.

The one narrow case that *does* work: if a team already runs Zep over their engineering Slack/incident channels, that is a genuine source of cross-repo knowledge no static scan can see ("Service C's Redis fallback was added after the March incident") — exactly the fact-density gap listed as risk #1. But import it as **`method=human`, low confidence, evidence = the episode UUID and URL**, treated as a *lead for the verification agent to confirm against code*, never as a fact. That is a v3 connector, not a strategy.

**The honest framing: Zep/Graphiti is prior art to learn temporal mechanics from, not a competitor and not a substrate.** They have solved "remember what a user told you, and notice when it stops being true" well. The concept is solving "traverse a typed path from a call site into a Terraform resource, and know who claimed each hop and whether anyone checked." The overlap is the word "graph" and the bi-temporal columns.

---

## Risk register — what this comparison did *not* let you off the hook for

- **Fact density (risk #1) is untouched by this analysis.** Zep's existence proves agents will write to a store; it proves nothing about whether they write *cross-repo* facts. Graphiti's users feed it conversations, where the valuable facts are stated outright. Nobody states "Service C falls back to Postgres" in a repo that contains neither.
- **Trust scoring (risk #3) gets no support here.** The most mature product in this space shipped *no* confidence field at all, after two years and 31k stars. Read that either as a gap to exploit or as evidence that per-fact confidence didn't earn its keep. The AUC measurement the concept already plans is the only way to tell, and it should happen before `trust` gets four multiplicands.
