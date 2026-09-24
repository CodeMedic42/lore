# Datadog vs. Living AI Knowledge

**Comparison date:** 2026-09-24
**Primary sources re-verified for this document:** Datadog v2 OpenAPI spec (`https://docs.datadoghq.com/resources/json/full_spec_v2.json`, `info.version: "1.0"`, fetched and parsed locally 2026-09-24), `DataDog/schema` repo (`service-catalog/v3/*.schema.json`, raw.githubusercontent main), `docs.datadoghq.com/api/latest/software-catalog/`, `docs.datadoghq.com/bits_ai/mcp_server/tools/`.

**Overlap: ~25%. Threat: medium.**

---

## 0. Corrections to the incoming dossier

The dossier is substantially accurate. Five corrections, three of them load-bearing.

1. **The relation type enum values are not what the dossier printed.** The dossier lists `RelationTypeOwns, OwnedBy, DependsOn, …`. The actual `RelationType` enum in the spec prefixes *every* value: `RelationTypeOwns, RelationTypeOwnedBy, RelationTypeDependsOn, RelationTypeDependencyOf, RelationTypePartsOf, RelationTypeHasPart, RelationTypeOtherOwns, RelationTypeOtherOwnedBy, RelationTypeImplementedBy, RelationTypeImplements`. Cosmetic in prose, load-bearing if you ever code against `filter[type]`.

2. **The typed write API is strictly behind the Git schema, and this matters.** `UpsertCatalogEntityRequest` is a `oneOf` over exactly **five** typed kinds — `service, datastore, queue, system, api` — plus the `EntityRaw` string. There is **no typed `repository` and no typed `custom`** in the OpenAPI request. Worse, the typed `datastore` and `queue` variants expose only `componentOf/lifecycle/tier/type` — **`dependsOn` and `dependencyOf` are absent from the typed API request**, even though `datastore.schema.json` in the Git repo does define both (verified directly). Practical consequence: to write a datastore→datastore dependency, a `repository` entity, or any custom kind through the REST API, you *must* use the `EntityRaw` branch — i.e. hand Datadog a YAML/JSON blob as an opaque string and hope the server-side validator is newer than the published typed schema. The dossier's "datastore/queue/repository/custom have componentOf/dependsOn/dependencyOf" is true of the Git schema and false of the typed API contract.

3. **MAJOR OMISSION — Datadog has already built an assertion model with confidence, evidence, explanation, source, status lifecycle, human refutation, revision history and a trust cut-off. It is the CSM Ownership Inference API, and it covers exactly one predicate.** The dossier does not mention it at all. Detail in §2 below, because it changes the threat assessment.

4. `GET /api/v2/catalog/entity` accepts `filter[exclude_snapshot]` ("Filter entities by excluding snapshotted entities"), but the string `exclude_snapshot` appears nowhere in the component schemas and "snapshot" is never defined for the catalog. There is an undocumented notion of a snapshotted entity in the catalog. Worth a support ticket if you ever evaluate them seriously — it is the only hint of catalog versioning in the public surface.

5. `POST /api/v2/catalog/entity/preview` — the documented "dry run" — returns **202**, not 200. A dry run that answers asynchronously is not a validation call you can block a write path on. `POST /kind` is also 202.

One dossier uncertainty I can partially close: **`execute_code`**. Verbatim from the tools page: *"Executes AI agent-authored JavaScript in a Datadog-managed sandbox. The code receives a `dd.*` namespace with helpers for **querying** logs, metrics, traces, services, change events, incidents, monitors, dashboards, and other Datadog APIs, and returns a structured value back to the agent."* Every verb is a read verb and the stated purpose is "multi-signal investigations and ad-hoc data exploration." Not proof it cannot POST, but the documented surface is read-shaped. And the question is lower-stakes than the dossier implies: even if it *could* reach `POST /catalog/entity`, an agent would still be writing into a 10-verb, zero-provenance, last-write-wins model. The write channel is not the constraint; the data model is.

Also worth flagging: the dossier omits the **data-observability toolset**, which exposes `search_data_entities`, `get_data_entity_details`, `get_data_entity_hierarchy` and `get_data_entity_lineage` ("fetches the live reachable lineage subgraph from entities, upstream, downstream, or both"). That is a genuine second graph with genuine traversal semantics — and it has **no public REST endpoint in the v2 spec at all**. It is MCP-only. Datadog's most traversal-shaped API is reachable only by an LLM.

---

## 1. Point-by-point

| Our concept | Datadog | Verdict |
|---|---|---|
| **Proposition / assertion split** | None. One row per entity; relations are derived from `spec` fields. Two writers = one overwrites the other ("may result in unintended overwriting"). | **Nothing.** Structural gap. |
| **Corroboration as a count** | None. Second writer of the same edge is a no-op or a clobber. | **Nothing.** |
| **Polarity / refutation** | None in the catalog. `includeDiscovered` off/on separates declared from observed; UI ranks manual above detected. Divergence renders both. | **Nothing** in catalog. See §2 for the CSM exception. |
| **Bi-temporal validity** | `createdAt`/`modifiedAt` only. No valid-time, no `as_of`, no revision list. `as_of` *does* exist on `/api/v2/security_monitoring/entity_context` (verified: `as_of`, mutually exclusive with `from`/`to`, plus `revisions[]` with `first_seen_at`/`last_seen_at`). | **Nothing** in catalog; **proven capability** one product over. |
| **Scope sweeps (closed-world snapshot)** | Nothing declarative. Telemetry has an implicit analogue: Service Map nodes age out at 30d without traces. But that is TTL on *observations*, not a sweep over *assertions* — it cannot retract a YAML `dependsOn`. | **Partial, wrong shape.** |
| **Predicate cardinality** | None. `dependsOn` is an unordered set; nothing is functional; nothing auto-expires a prior value. | **Nothing.** |
| **Trust score** | None in catalog. No confidence anywhere on an entity or relation. `OwnershipInference.confidence` exists in CSM. | **Nothing** in catalog. |
| **Entity resolution: strong ids** | Effectively `kind:name` refs (`service:myapp`) plus `metadata.id` (read-only Datadog UUID, "User supplied values are ignored"). Uniqueness is on the *name*, which is semantic — exactly what you ruled out. | **Weaker.** Name-as-key. |
| **Entity resolution: weak aliases** | Tags and *renaming rules* for peer-tag-derived names. Rules are operator-authored find/replace, not candidate-generating. | **Partial, manual.** |
| **Read-time canonicalisation / merge & unmerge** | None. No merge table, no unmerge, no `entity_distinct`. Renaming rules rewrite at ingest — destructive, not an indirection. | **Nothing, and architecturally opposite.** |
| **`env` as a first-class discriminator** | **Genuinely strong.** `env` is a reserved primary tag; Service Map is *scoped by env*; the second primary tag is configurable. Cross-env bleed is a solved problem here. | **Equal or better.** Steal the framing. |
| **Call-site grain, derive service edges** | **Partial and sophisticated.** Endpoint Observability discovers HTTP endpoints from APM; span-kind stats + peer-tag aggregation materialise uninstrumented peers. But grain is *span/endpoint*, never *call site in a file at a commit*. | **Partial.** Finer than a service, coarser than a line. |
| **Accept-then-normalise write path (never 400 on unknown predicate)** | Opposite. `kind` must be pre-registered via `POST /kind` or the write is rejected. Relation vocabulary is a **closed 10-value enum** with no extension mechanism. `extensions` is free-form but explicitly inert: "No Datadog features are affected by this field." | **Nothing. Philosophically opposed.** |
| **Path-template retrieval, recursive CTE, trust cut, as_of** | `GET /relation` is a **one-hop filter**, not a traversal — `filter[from_ref]`/`filter[to_ref]`, page offset/limit. Multi-hop means N round trips client-side. `get_data_entity_lineage` does real traversal, but only over *data* entities and only via MCP. | **Partial, in the wrong graph.** |
| **Fact source: agent-asserted** | REST/Terraform/Git only. **No MCP tool writes a catalog entity, relation or kind** — `search_datadog_entities` (Service Catalog Read) is the only catalog tool. | **Blocked at the ergonomic layer.** |
| **Fact source: static analysis of code** | **Nothing.** Datadog indexes telemetry and *reads declaration files*. `codeLocations[]` is a glob pointer, not an index. No call graph, no symbol resolution. | **Nothing.** This is your moat. |
| **Fact source: running systems** | **Overwhelming.** APM, USM/eBPF, RUM, cloud crawlers, Resource Catalog, Cloudcraft, DSM pathways, CNM/NDM, Kubernetes. | **Far better than you will ever be.** |
| **Fact source: human-authored** | YAML in-repo + UI + Terraform. Solid. | **Equal.** |
| **Verification agent that can REFUTE** | Bits AI proposes Systems (accept/edit/reject, tagged `created_by:ai`) and Bits Code opens PRs. But: *"AI-generated Systems only suggest new Systems; they do not propose updates to existing ones."* It cannot contradict an existing claim. | **Partial — additive only, never contradictory.** |
| **Secrets: record location, never value** | Not modelled. `links[]` and `contacts[]` are where a connection string would land, with no scanner and no policy. | **Nothing.** |

### Where Datadog's approach is genuinely better than ours

Be honest about three:

- **Derived-not-declared.** Their graph is re-derived from ground truth continuously. It is correct about what actually talks to what at 30-day recency *with no maintenance*. Our graph decays the moment agents stop writing, and our entire staleness apparatus — cardinality, sweeps, anchor integrity — exists to simulate what they get for free from traffic. That apparatus is a tax they do not pay.
- **`env` scoping.** They made `env` a reserved primary tag that *scopes the map itself*, not just a discriminator on a node. Our design has `env` as an entity attribute that blocks merges. Theirs additionally scopes the *query*. Adopt both.
- **Peer-tag materialisation.** They synthesise a `datastore` entity for an uninstrumented Redis from `db.instance`/`net.peer.name` on the client span. That is exactly your "record the finest observable grain and derive upward," implemented at scale with a published allowlist. Your equivalent for static analysis has no such allowlist yet.

### Where ours is better, and why it is not close

- **A count is not a clobber.** Ten agents asserting the same edge gives you corroboration=10. In Datadog it gives you one row and a documented race condition whose remedy is "pick one write path." For a multi-writer agent population this is disqualifying, not inconvenient.
- **Refutation is expressible.** `polarity=false` lets a verifier say "this is not true" without deleting evidence that someone believed it. Datadog's only "no" is a `DELETE`, which destroys the disagreement along with the claim.
- **Never 400 on an unknown predicate.** Their closed 10-verb enum cannot express `reads_from`, `falls_back_to`, `provisioned_by`, `caches`, `exposes_endpoint`, or `resolves_secret_from`. Everything collapses to `DependsOn`. The motivating query is *a distinction between kinds of dependency*, and that distinction does not survive their schema. This is the single biggest gap, larger than provenance.
- **Bi-temporality.** "What did we believe last Tuesday, and what was true last Tuesday" are different questions. Datadog can answer neither for the software graph.

---

## 2. The thing the dossier missed: CSM Ownership Inference

Verified directly in the OpenAPI spec (`/api/v2/csm/ownership/*`). Datadog ships, today, for the single predicate *owns*:

- `GET /csm/ownership/{resource_id}` — inferences, **one per owner type** (`user|team|service|unknown`).
- Each inference carries: **`confidence`** (numeric string, 4 dp, required), **`explanation`** (human-readable, "how the inference was produced", required), **`sources[]`** (e.g. `{"kind": "code_owners"}`), **`evidence_versions[]`** (e.g. `{"pipeline_id": "p1", "version": "v3"}`), **`status`** ∈ `suggested|persisted|overridden|failed|unknown`, `failure_reason`, `retry_schedule`, and a **`checksum`** identifying the exact inference state.
- `GET …/{owner_type}/evidence` — evidence as its own addressable resource, weak-ETag cached.
- `GET …/history` — **cursor-paginated revision history**, newest first, each entry carrying its own confidence, explanation, evidence and checksum.
- `POST …/{owner_type}/feedback` — actions **`confirm | reject | correct | persist`**, requiring `inference_checksum` (mismatch ⇒ conflict), with optional free-text `reason` and `corrected_owner_handle`/`corrected_owner_type`. Response returns `previous_status` → `new_status`.
- `GET/POST /csm/ownership/settings` — org-wide **`confidence_level` ∈ `high|medium|low`** gating **`auto_tag`**, plus `GET …/untagged` counting findings *grouped by ownership confidence*.

That is: provenance, evidence, explanation, confidence, a status lifecycle, human corroboration *and refutation* with optimistic concurrency, full history, and an org-level trust cut-off that decides whether a claim is applied automatically. It is a well-designed miniature of your assertion table.

Three conclusions follow, and they point in different directions:

1. **Your design is not exotic.** A large engineering org converged independently on nearly the same primitives. That is validation, not threat.
2. **Datadog is capable of building this.** The design skill exists in-house, shipped.
3. **They built it in CSM, not the Catalog, and they built it for one predicate.** The Catalog — the thing an agent would actually write architecture facts into — still has `createdAt/modifiedAt` and a 10-verb enum. That is a *product priority* statement, not a capability limit. Read it as: the knowledge layer is not where Datadog invests.

---

## 3. The motivating query

*"Where does the list of notifications in Client A come from?"* — target path: Client A → calls → Service C → reads_from → Redis E → falls_back_to → Postgres → provisioned_by → Terraform.

**What Datadog gets for free, assuming APM is deployed everywhere:**
- Client A → Service C, if Client A is a RUM app or an instrumented service and the call is traced. Real, automatic, accurate.
- Service C → Redis E, from peer-tag aggregation (`db.instance`, `net.peer.name`) — materialised as a `datastore` entity even with Redis uninstrumented. Real, automatic.
- Service C → Postgres, likewise — *if the fallback path actually executed during the retention window*.
- Redis E and the Postgres instance appear in Resource Catalog with provider JSON, tags and a Relationships map. Real.

**Where it breaks, in order of severity:**

1. **"the list of notifications" has no referent.** There is no entity for a feature, a screen, a response field, or a symbol. Your anchor-resolution step has nothing to resolve against. The best available handle is an *endpoint* from Endpoint Observability (`GET /api/v1/notifications`), which requires the asker to already know the endpoint — i.e. to already have half the answer. Nothing in Datadog maps "the notifications list in the UI" to that endpoint. **This alone defeats the query.**

2. **`reads_from` and `falls_back_to` are both `DependsOn`.** Even with every node present, the returned subgraph is `service:client-a --DependsOn--> service:service-c --DependsOn--> datastore:redis-e` and `--DependsOn--> datastore:notif-pg`. The answer "Redis, falling back to Postgres" is *unrepresentable*. You get "C depends on two datastores." The semantic content of the motivating query lives entirely in the edge types Datadog does not have. You could shove `falls_back_to` into `extensions` — where, by Datadog's own documentation, nothing reads it.

3. **The fallback edge may not exist at all.** It is observed only if the fallback fired within 30 days. A correct, load-bearing, once-a-quarter disaster path is invisible. This is the precise inverse of your failure mode: you risk asserting stale edges, they risk never observing live ones.

4. **Terraform: no edge, only a pointer.** `integrations.terraform.workspaceIds[]` matches `^ws-[a-zA-Z0-9]+$` — an **HCP Terraform workspace ID on the entity**. Not a resource address, not `aws_db_instance.notifications`, not a module path, and not on the *datastore* (the typed request exposes no such field for datastore anyway). `provisioned_by` as a traversable hop does not exist. Best case you hand the user a workspace link and they go read HCL themselves. Note also that CSM Ownership *does* resolve resource→IaC provenance internally (`sources: [{kind: "code_owners"}]`-style pipelines) — again, in the security product, not the catalog.

5. **"How do I connect to that database?"** Nothing. No modelled location-of-credential. The honest answer is a `links[]` entry someone hand-wrote, which is a wiki link with extra steps.

6. **Assembling the path costs N round trips.** `GET /relation?filter[from_ref]=…` per hop, then `GET /entity` per node. No depth parameter, no edge-type whitelist, no ranking, no `as_of`. You are writing the traversal engine on the client, against a one-hop filter API, over a graph whose edges are all the same colour.

**What it would take to make Datadog answer it:** instrument all four services with APM *and* ensure the fallback path executes inside 30 days; hand-author `entity.datadog.yaml` for every repo; register custom kinds for anything not in the five typed ones; encode `reads_from`/`falls_back_to`/`provisioned_by` in `extensions` and then **write your own query layer that reads `extensions` and does the traversal** — because Datadog will not. At that point Datadog is your storage backend and you have built our product anyway, on a store with no corroboration, no refutation, no valid-time and a documented concurrent-write race.

---

## 4. Threat assessment: medium

**Could they close the gap?** Technically, yes, and faster than anyone else on your competitor list. They have: the ownership-inference provenance machinery (§2); `as_of` + `revisions[]` proven on security entities; `EntityRaw` as an already-permissive ingest door; a 304-tool MCP server one tool away from agent writes; and ground-truth telemetry that solves your worst problem (fact density) for free.

**Will they?** The incentive is poor and the evidence says no.

- Datadog monetises **telemetry volume** — hosts, spans, ingested GB. A knowledge graph of asserted facts has no volume meter. There is no public price for IDP, Catalog, Resource Catalog or Cloudcraft; they are retention devices for APM, not a product line.
- They have owned this surface for years and the Catalog data model has moved from "flat YAML" to "flat YAML with references." The 2026-09-14 `ai_agent` kind was added and reverted the same day. The typed API request still lags the Git schema (§0.2). This is a maintained annotation layer, not an investment area.
- Their whole epistemology is "the traces are the truth." A provenance-and-contradiction model presumes claims can disagree with observation. That is philosophically foreign to an observability vendor, and it is why refutation landed in *security* — where the ground truth genuinely is ambiguous — and not in APM.

**The realistic bad day:** they ship a catalog-write MCP tool and wire ownership-style `confidence`/`sources`/`explanation` onto relations. That would be maybe two quarters of work and would capture the "agent annotates the observed topology" use case. It still would not give them a code-derived call graph, an open predicate vocabulary, or bi-temporal traversal. **It would compress your differentiation to: open predicates, static-analysis facts, bi-temporality, and cross-repo source-level grain.** Those are defensible, but they are a narrower story than the one you are telling now.

**The unfalsifiable risk:** for a customer already paying Datadog, "80% right, zero maintenance, already deployed" beats "100% right if agents keep writing." Your pitch has to survive that comparison, and today it survives it only on the edge-semantics argument in §3.2 — which is strong, specific, and demonstrable. Lead with it.

---

## 5. What to steal

1. **`includeDiscovered` as a first-class query parameter.** One boolean cleanly separating *asserted* from *observed* in the response. Your model already distinguishes `method`, but you have no single ergonomic switch. Ship `?include_inferred=false` on traversal and default it **on** with derived edges ranked below asserted ones — exactly their UI ordering.

2. **The entire ownership-feedback API shape, generalised to any predicate.** `POST /v1/propositions/{fingerprint}/feedback` with `action ∈ confirm | reject | correct | persist`, requiring `assertion_checksum`, returning `previous_status → new_status`. Four things to take:
   - `confirm` and `reject` are *distinct verbs*, not a boolean — the API reads correctly to an LLM.
   - `correct` carries the replacement inline, so "wrong, and here is the right value" is one call, not refute-then-assert.
   - **`checksum` as optimistic-concurrency on the refutation**: an agent cannot reject a claim that changed under it. You have no equivalent and you will need one.
   - **`persist`** — promoting a derived claim to a sticky one. Your `method` axis has no "a human blessed this" state that survives a scope sweep. Add it.

3. **`explanation` as a required field separate from `evidence`.** Human-readable "how this was produced," distinct from machine-checkable pointers. Required, not optional. Cheap to add, and it is the field that makes trust scores auditable rather than theatrical — directly addressing your risk #3.

4. **`evidence_versions: [{pipeline_id, version}]`.** They version the *extractor*, not just the evidence. When your static analyser v3 is wrong, this is how you bulk-invalidate everything v3 produced without touching v2's output. This is a materially better idea than anchor_integrity and it is not in your design.

5. **Org-level `confidence_level ∈ high|medium|low` gating `auto_tag`.** A named trust cut-off stored as *settings*, not hard-coded, with `GET /untagged` counting what falls below it. Your trust cut is a query parameter; make it a configurable policy with an observability endpoint that tells you how much knowledge the threshold is suppressing. That is also your AUC measurement harness, for free.

6. **`status ∈ suggested | persisted | overridden | failed | unknown`, with `failure_reason` and `retry_schedule`.** Your derived status is verified/disputed. Theirs includes the *operational* states — an extraction that failed and when it will retry. You need that the moment you have an async verification agent, and modelling it as inference status rather than job status keeps it queryable alongside the claim.

7. **The peer-tag allowlist pattern.** A published, closed list of tags that identify a peer (`db.instance`, `db.system`, `messaging.destination.name`, `net.peer.name`, `peer.service`, `server.address`, `topicname`, `queuename`, `tablename`, `streamname`). This is literally your *identifying qualifiers* set for telemetry-sourced propositions. Adopt it verbatim for the OTel importer — it is battle-tested entity resolution input and it will not be a coincidence that it reads like your fingerprint key.

8. **`env` scopes the map, not just the node.** Their Service Map is scoped by `env` plus one configurable second primary tag. Make `env` a required traversal parameter with no default, so a query cannot silently span prod and staging. Your merge-blocking rule stops over-merge; this stops the *query* from bridging.

9. **`scope_query: "kind:service"` on scorecard rules.** A stored query defining what a rule applies to. Nearly your `scope_key`, and a good precedent for expressing sweep scope as a query string rather than an opaque token — which makes a sweep's blast radius inspectable before you run it.

10. **`EntityRaw` — accept the blob.** `oneOf [typed, raw string]` on the write endpoint, with a documented example. It is the same instinct as your accept-then-normalise: never let schema drift block a writer. Their mistake is that the *typed* branch is the one that rots (§0.2). Make raw the primary path, not the escape hatch.

11. **Naming.** `componentOf` / `dependencyOf` as explicit inverse-direction fields reads better in YAML than a direction flag. `codeLocations: [{repositoryURL, paths[]}]` is a clean evidence-anchor shape. `inheritFrom: "<kind>:<name>"` is a tidy one-line way to express metadata inheritance.

**What to explicitly NOT steal:** the closed relation enum; name-as-primary-key; `extensions` that nothing reads (a schema escape hatch that features ignore is worse than no escape hatch — it invites writers to record facts into a void); and implicit metadata inheritance triggered by "exactly one system is defined in this file," which is a rule nobody will remember and which makes a file's meaning depend on its other contents.

---

## 6. Build on it, or compete?

**Build on it: no, and the reason is specific.** The blocker is not the missing provenance — you could layer an assertion table over their entities. The blocker is that **the edge vocabulary is a closed 10-value enum with no extension mechanism**, and your product's value is the distinction between kinds of edge. You cannot store `falls_back_to` anywhere Datadog will traverse. Your only option is `extensions` plus your own traversal engine — at which point Datadog is a slow, paid, rate-limited, eventually-consistent (202) key-value store for YAML blobs, with a documented concurrent-write race and no valid-time. You would inherit every constraint and gain only their entity ids.

Secondary blockers, any one of which is disqualifying on its own: no relation write endpoint at all (relations only exist as a side effect of entity `spec` fields, so you cannot assert an edge without owning both endpoints' full documents — which guarantees the overwrite race for multi-writer agents); no multi-hop query; no `as_of`; MCP is read-only for the catalog; and the whole thing is unavailable on GovCloud. And it costs money per host to hold data that is yours.

**Data source: yes, emphatically, and this is the most valuable finding in this document.**

Datadog is the single best available answer to your **risk #1 (fact density)**. Your worry is that agents only restate what is in the repo in front of them and never produce the cross-repo edges that matter. Datadog's APM already knows, with observed evidence, which service calls which, which datastore each one touches, and which cloud resource backs it — precisely the edges no single checkout contains. Ingesting it does not make you "an importer with agent annotations" *if* the imported facts land as assertions with `method='telemetry'` alongside code-derived and agent-asserted ones and are subject to the same trust, corroboration and refutation machinery. That is the whole point of separating proposition from assertion: an edge corroborated by a static scan *and* by 40,000 observed spans *and* by an agent's reading of the code is a materially stronger claim than any one of them, and your schema can express that while Datadog's cannot express it at all.

Concretely:

- `GET /api/v2/catalog/relation?includeDiscovered=true` → assertions with `method='telemetry'`, `asserted_by='datadog'`, `evidence=[{source:'datadog_relation', from_ref, to_ref, meta.source, meta.definedBy}]`, `predicate` mapped from `RelationTypeDependsOn` to your `calls`/`depends_on` — and mapped *conservatively*, since you cannot recover `reads_from` from their enum. Record the coarse predicate honestly rather than inventing precision.
- `GET /api/v2/catalog/entity?include=schema` → strong identifiers. `metadata.id` (their UUID) is a **strong identifier** in your resolution ladder — a real uniqueness constraint from an external authority, exactly what `gitlab_project` and `arn` are. `datadog.codeLocations[].repositoryURL` is the **join key** between their telemetry graph and your code graph, and it is the highest-value single field in their entire schema for you.
- Their `env` primary tag → your `env` discriminator, directly. This is high-quality environment attribution you would otherwise have to infer.
- **A Datadog relation disappearing is a refutation signal, not a deletion.** Poll `includeDiscovered=true`; an edge present last week and absent now (with the service still reporting traces) is a `polarity=false`, `method='telemetry'` assertion. Their 30-day TTL becomes your evidence of change — which is a *better* use of it than they make, because you keep the history and they do not.
- Their `datastore`/`queue` entities materialised from peer tags are free infrastructure nodes with real identifiers, covering the exact layer (Redis, Postgres, Kafka) where your motivating query lives and where static analysis is weakest.

The integration is one-directional by necessity: read from Datadog, never write back — there is nothing on their side that can hold what you know, and writing back would enter the overwrite race for no gain.

**Bottom line.** Datadog is an outstanding *observed topology* and a deliberately thin *asserted knowledge base*. The two are complements, not substitutes. The risk is not that Datadog builds your product; it is that a prospect with Datadog already deployed decides 80%-right-and-free-of-maintenance is enough. Your answer to that person is §3.2 — that the difference between `reads_from` and `falls_back_to` is the entire question they asked, and Datadog's schema has no place to put it.
