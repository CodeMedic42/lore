# Potpie (potpie-ai/potpie) vs. Living AI Knowledge

**Verified against primary sources on 2026-09-24.** Repo read at `db33c46` (main, pushed 2026-09-23);
`potpie` 2.0.1 on PyPI depending on `potpie-context-engine[all]==0.2.0`; in-tree `docs/context-graph/`
and `spec/`; GitHub API (5,734 stars / 679 forks / 111 open issues, Apache-2.0, not archived);
potpie.ai/pricing.

Potpie is the closest analog in the whole competitive set. It is the same *category* — a persistent,
agent-written, provenance-stamped, bitemporal claim graph about a software project, deliberately
leaving the LLM to the harness. It is shipping, Apache-2.0, and has more graph-hygiene machinery in
code than anything else surveyed. Read this as "the strongest competitor", then read the corrections
below, because most of the places our concept differs are places Potpie made a *different* call, not
places it simply hasn't got to yet — and two of its documented guarantees turn out not to be wired.

---

## 0. Corrections to the incoming dossier

The dossier is largely accurate. Ten things are wrong or misleading, and several are load-bearing:

1. **Entity ids are semantic, not opaque.** `core/identity.py:mint_entity_key` slugifies a name:
   `mint_entity_key(svc_spec, name="Auth Service") -> "service:auth-service"`. The canonical id *is*
   the normalised name. This is the direct opposite of our "canonical id is an opaque UUID, never
   semantic" decision, and it is the single biggest architectural divergence between the two systems.
   A rename mints a new entity; there is no indirection layer to absorb it.
2. **The alias layer does not exist.** `identity.py` documents cross-source convergence via `ALIAS_OF`
   claims. `ALIAS_OF` appears in exactly three places in the repo: two docstring lines and one line of
   `docs/context-graph/ontology.md`. It is **not in `EDGE_TYPES`**, so it cannot be written through the
   canonical door. The docstring is honest about it — "P0/P1 only defines the contract" — but the
   ontology doc reads as though it ships.
3. **Entity merge has no read-time effect.** `merge_duplicate_entities` stamps `merged_into`,
   `merge_status`, `merge_reason` on the losing entity and writes a `RELATED_TO` marker edge.
   `grep -rn "merged_into"` across the entire repo returns the one write site and two unit-test
   assertions. Nothing reads it. Existing edges are **not** rewritten to the winner, and no reader
   redirects. Merge is advisory bookkeeping, not resolution.
4. **`environment` is not in the physical edge identity.** `edge_identity_key(...)` computes
   `(subject, predicate, object, environment)` and stamps it as an `identity_key` property — and
   nothing consumes that property either. The actual Cypher MERGE key is
   `(group_id, name, subject_key, object_key, source_ref)`; `environment` rides in `extras` as an
   ordinary property. The singleton-supersession query matches on `(group_id, name, subject_key)` and
   objects that differ, with **no environment predicate in the WHERE clause**. The documented promise
   "an env-qualified edge never supersedes its counterpart in another environment" holds in practice
   only because `OWNED_BY` is the sole singleton and is never env-qualified, and because differing
   `source_ref`s usually keep rows apart. It is not enforced where it claims to be.
5. **Soft-fail defaults ON, and does not cover the agent door.** `ontology_soft_fail_enabled()` is
   `_truthy(getenv(...), True)` — default on — while `docs/context-graph/architecture.md` says "off".
   More importantly it governs the *reconciliation/ingest* path. The agent-facing
   `semantic_mutation_validator` rejects unconditionally: `err("unknown_predicate", ...)`. So
   `potpie graph propose` **hard-rejects an unknown predicate**, full stop.
6. The auto-supersede flag is `CONTEXT_ENGINE_AUTO_SUPERSEDE` (default on), not
   `CONTEXT_ENGINE_RECONCILIATION_AUTO_SUPERSEDE`.
7. The reader/spec drift is in the other direction: `infra_topology.service_neighborhood` advertises
   `EXPOSES` in `inline_relations`, but the reader's `_INFRA_PREDICATES` contains neither `EXPOSES`
   nor `IMPLEMENTED_IN`. It advertises an edge it never traverses.
8. **The HTTP API has no graph surface.** Routes are `/api/v1/context/{ingest,record,reset,status}`,
   `/events/*`, `/pots/{id}/{events,timeline,ingestion-config,ingest/*}`, `/webhooks/github`. There is
   **no** `propose`, `commit`, `read`, `neighborhood` or `search-entities` over HTTP. The full graph
   surface is CLI-only, over a UDS daemon protocol. This matters enormously for "can we consume it".
9. Extensibility is stronger than "edit a row": `core/definition.py` has a versioned, additive
   `GraphExtension` (entity_types, edge_types, views, record_types, readers) with collision rejection
   and `GraphDefinition.extend()`, resolved via a `ContextVar`. But reader `factory` is `None` in OSS
   and "the engine supplies their concrete factories at composition time" — strong evidence the
   commercial product is closed extensions over this OSS core.
10. `potpie/context-engine` is excluded from the `potpie` wheel too; it ships as a separate
    distribution. And potpie.ai/pricing still markets the v1 products (Specialists, Forge, Recipes,
    Trace) that no longer exist in the repo — the site and the OSS product have drifted apart.

---

## 1. Feature-by-feature

| Our concept | Potpie today | Verdict |
|---|---|---|
| Proposition / assertion split (dedup'd, content-addressed edge + N assertions) | Partial. One `:RELATES_TO` row per (s,p,o,**source_ref**). A `claim_key` is deterministic over `(pot, subgraph, s, p, o[@env], discriminator)`. Corroboration is "two rows exist", counted at read time. There is **no** deduplicated proposition row — no single object to hang claims-about-claims on. | **Ours better** for reification and count semantics; theirs is simpler and already working. |
| Proposition-as-subject (claims about claims) | None. `allowed_pairs` are entity→entity; `AFFECTS` has a wildcard target but still entity-typed. Qualifiers are edge properties. | **Ours better** — this is a genuine capability gap. |
| Polarity / refutation | **Nothing.** `truth` is a *class* (`agent_claim`, `authoritative_fact`, …), not a sign. There is no "false" assertion. Dissent is expressed by `retract_claim`, which stamps `invalid_at` on the **edge triple** — it silences everyone's claim, including the one you disagree with. Contradiction is *detected* (`detect_family_conflicts`, `graph quality conflicting-claims`) but "quality never writes"; resolution is a human proposing a correction. | **Ours better and materially different.** Potpie cannot represent "source B says this is false while source A still says it's true." |
| Bi-temporal validity | **Genuine, and shipped.** Event time `valid_at`/`invalid_at`; system time `created_at`/`expired_at`/`observed_at`/`graph_updated_at`. Reads take `as_of`, windows, `include_invalidated`. Nothing is hard-deleted. | **Parity.** They are ahead of us on having it working. Steal the property names. |
| Scope sweeps (closed-world snapshot expiry) | **Nothing.** `source add` registers metadata only; `setup --scan` is opt-in and there is no scanner left to run. No run-scoped `scope_key`, no "not re-asserted this run → `valid_to = run_start`". The only staleness signal is a per-entity `freshness_ttl_hours` (topology 1 week) surfaced as a *report*, not an expiry. | **Ours better.** TTL flags a fact as old; it does not remove a migrated edge from traversal. Potpie has precisely the failure mode our design memo calls out. |
| Predicate cardinality / functional predicates | Present but almost unused: `singleton=True` on `EdgeTypeSpec`, registry auto-synced at import, supersession Cypher stamps `invalid_at` on disagreeing live claims. **`OWNED_BY` is the only singleton in the live registry**, and supersession only fires when `evidence_strength == "deterministic"`. | **Parity in design, ours better in ambition.** Their mechanism is exactly ours; they declined to apply it to topology (`USES`, `DEPLOYED_TO` all accumulate). |
| Trust score | Different shape. `RankingService` = weighted **arithmetic** mean of `semantic_similarity` 1.3, `strength` 1.2, `scope_overlap` 1.1, `recency` 1.0 (exp decay, 30-day half-life), `corroboration` 0.8 (diminishing), `coverage_quality` 0.5, with a per-factor `breakdown` on every item. `strength` comes from truth class (deterministic 1.0 … speculative 0.2). | **Split.** Their combination rule is better than ours — they *migrated off* a geometric mean because one zero factor could veto a strong candidate, which is exactly what our multiplicative `base × freshness × anchor × corroboration` will do. But they have **no `anchor_integrity` equivalent**: nothing in the repo checks a cited `source_ref` against git HEAD. `last_verified_at` exists as a field that nothing populates from a real check. Our anchor idea is a real differentiator *if* it works. |
| Entity resolution — strong ids | Weak. `IdentityClass.EXTERNAL_ID` + `authoritative_source` exist per entity type, but only `Dependency`, `APIContract`, `Activity` use it. No uniqueness constraint table, no ARN / terraform-address / OTel-service identifier registry. | **Ours better.** |
| Entity resolution — weak aliases | **Unbuilt** (see correction 2). | **Ours better.** |
| Resolution ladder on write | **Nothing at write time.** `canonicalize_reconciliation_plan` does within-batch string normalisation (trim, lowercase, collapse whitespace) plus a `SYNONYMS` table that is **literally empty**. No trigram, no embedding candidates, no provisional minting. The burden is pushed onto the agent: `graph search-entities` is documented as "identity resolution before a write". | **Ours better**, and this is their weakest layer. |
| Read-time canonicalisation through `canonical_id` | **Nothing** (correction 3). | **Ours better.** This is the single most valuable thing in our design that Potpie cannot retrofit cheaply — semantic keys mean the merge target *is* the key. |
| `env` as first-class discriminator | Partial: `Environment` is an entity, `environment` is an edge property, the infra reader filters on it with `qualified_only` default. But it is not in the physical identity (correction 4), and it discriminates *edges*, not *entities* — there is no `prod-redis` vs `staging-redis` entity separation; you get one `datastore:redis` with env-tagged edges. | **Ours better** for the over-merge risk; theirs is lighter-weight and fine for "which env runs X". |
| Call-site grain, derive service edges | **Nothing.** No `CALLS` predicate, no `Endpoint`/`CallSite` entity. `DEPENDS_ON` is `Service→Service` only. `CodeAsset` exists but the only edges into it are `TOUCHED`, `IMPLEMENTED_IN`, `POLICY_APPLIES_TO`, `REPRODUCES`, `AFFECTS` — none of them a call. The legacy tree-sitter code graph (`FILE/CLASS/FUNCTION`, `CONTAINS`/`REFERENCES`) is excluded from the wheel and survives in v2 only as `CODE_GRAPH_LABELS` coerced to `CodeAsset`. | **Ours better.** Potpie explicitly stopped being a code graph. |
| Accept-then-normalise write path (202 <150ms, never 400 on unknown predicate) | **Opposite by design.** Two-phase `propose` → `commit`, synchronous validation, atomic batch: one bad op and the whole batch returns `invalid`/`review_required` and *nothing* writes. Unknown predicate = hard error (correction 5). Caps 5k entities / 10k edges / 2k invalidations. | **Genuinely contested.** Their argument: an unvalidated graph is worthless, and `review_required` plus the `inbox` is a real "not sure yet" state. Ours: agents will silently stop writing if the door 400s. Their `record` path (fixed ops, auto-apply, no plan) is the concession — and it is the path the bundled skills actually tell agents to use. Take the warning seriously: our "never 400" promise means we will accumulate unmappable raw predicates and need an async mapper that actually works. |
| Path-template retrieval | **Nothing.** `infra_topology` does depth-bounded BFS and returns a **deduped, ranked flat bag of claim rows** — `dedupe_claim_rows(...)` into `Candidate` objects, no path reconstruction, no ordered chain, no path ranking. Depth cap 4, default 2, per-hop limit `max(max_items*4, 16)` (silent frontier truncation on a fan-out). Explicit non-goals: shortest path, centrality, cycle detection, unbounded recursion — "a project-memory graph for retrieval-into-context, not a graph analytics engine." | **Ours better, and this is the sharpest differentiator.** Our whole thesis is that the *connected path* is the answer. |
| Four fact sources | Two and a half. Agent-asserted: yes, central. Human-authored: yes (`record`, `user_statement` authority). Static analysis: **zero** — the codeowners/openapi/kubernetes/dependency scanners were deleted; a harness must read the files and author mutations. Running systems: **zero** — no cloud inventory, no k8s watch, no OTel/Datadog ingest, no deploy webhook beyond GitHub merged-PR, no drift detection. | **Ours better on paper** — but note they *had* scanners and removed them. That is a datapoint about maintenance cost, not about value. |
| Verification agent that can refute | **Nothing.** `--verify` on commit is *read-back* verification (did the claim keys land?) plus a before/after quality snapshot. The `VERIFIED` predicate and `Fix.verification_status` are human/agent-asserted labels, not checks. Nothing independently re-reads the repo to confirm or refute a claim. | **Ours better.** |
| Cross-repo | Yes **within a pot** — many `source add repo` per pot, `Repository` is a scope entity, `DEFINED_IN` carries a `path` for monorepo subtrees, repo→pot routing via `pot default`/`pot linked`. **"Cross-pot federation is an explicit anti-goal"** (verbatim, four places). | **Parity on the stated need.** Their answer is "put the repos in one pot", which is operationally fine and materially simpler than our multi-writer story. |
| Storage | Neo4j / FalkorDB Cypher, single `:RELATES_TO` type, predicate in `name`. `falkordb_lite` (redislite, no server, no Docker) is the OSS default. **The `postgres` backend is a stub, 0/6 ports.** | Their embedded default is a better onboarding story than ours. Their Postgres stub is a small piece of irony. |

---

## 2. Could Potpie answer the motivating query today?

*"Where does the list of notifications in Client A come from?"* — Client A → Service C → Redis cache E
→ falls back to → Postgres → provisioned by Terraform (repo 4).

**Setup that would work.** One pot; `potpie source add repo .` four times; run the `potpie-repo-baseline`
and `potpie-infra-architecture` skills in a harness with all four checkouts visible, so the agent reads
Dockerfiles, compose files, k8s manifests, Terraform and env templates and authors semantic mutations
through `propose` → `commit`.

**What is expressible.** `service:client-a -DEPENDS_ON-> service:service-c` (allowed).
`service:service-c -USES-> datastore:notif-redis` and `-USES-> datastore:notif-pg` (allowed).
`service:client-a -DEFINED_IN-> repo:github/acme/client-a` (allowed, with `path`).
`service:service-c -DEPLOYED_TO-> environment:prod -HOSTED_ON-> cluster:aws-prod` (allowed).

**Where it breaks, concretely:**

1. **"Redis falls back to Postgres" cannot be typed.** `USES` allows only `Service→DataStore` and
   `Service→Dependency`. There is no `DataStore→DataStore` pair on any predicate, and no
   `FALLS_BACK_TO`. The only legal encoding is `RELATED_TO` — which is `public=False`, is the
   soft-fail downgrade target, and **is not in `_INFRA_PREDICATES`**, so `service_neighborhood` will
   never traverse it. The fact can be written and will then be invisible to the one view that would
   have surfaced it.
2. **"Provisioned by Terraform" cannot be typed either.** `DEFINED_IN` is `Service→Repository` only.
   There is no `DataStore→Repository`, no `PROVISIONED_BY`, no Terraform-address identity class, no
   `TerraformResource`/`InfraResource` entity. Same `RELATED_TO` dead end.
3. **"The list of notifications" has no anchor.** There is no `Endpoint`, no `APIContract` on the
   client side, no call site. The finest grain available is `Service` (or a free-form `CodeAsset`
   the agent invents). You can ask about `service:client-a`; you cannot ask about
   `GET /api/notifications`.
4. **The answer arrives as a bag, not a path.** Even with everything above hand-authored legally,
   `graph read --subgraph infra_topology --view service_neighborhood --scope service:client-a
   --depth 4` returns a ranked list of individual claim rows. Nothing asserts that the Redis edge and
   the Postgres edge are *steps in one chain from Client A*. The harness LLM must re-derive the path
   from the bag — which is precisely the reasoning step our path templates exist to make deterministic.
   And `--depth 4` is the hard ceiling (`_MAX_TRAVERSAL_DEPTH = 4`), with a per-hop row cap that can
   truncate the frontier silently in a wide graph.
5. **Entity resolution will bite.** Repo 1 calls it "Service C", repo 3's Helm chart calls it
   "service-c-api", Terraform calls it `svc_c`. Three agents on three days mint
   `service:service-c`, `service:service-c-api`, `service:svc-c`. Nothing reconciles them: no alias
   layer, an empty `SYNONYMS` table, and `duplicate-candidates` only fires on **exact normalised
   display-name equality within a label** — which these three do not satisfy. Even after a human runs
   `merge_duplicate_entities`, the losing entity's edges stay put and no reader redirects. The query
   returns a third of the graph and looks like it worked.
6. **"How do I connect to that database?"** There is no `access` concept, no secret-location model,
   no `ConfigVariable→secret-reference` semantics beyond a free-form property bag. The design has no
   opinion on the credential-leak risk; a `ConfigVariable`'s `properties` will happily hold a value.

**Bottom line:** Potpie could answer a degraded version — "Client A depends on Service C, which uses
Redis and Postgres in prod, owned by team X, defined in these repos" — after substantial hand-feeding
by a harness with all four checkouts open. It cannot express the fallback relationship, cannot reach
Terraform, cannot anchor on the endpoint, and cannot return a path.

---

## 3. Threat assessment

**High, but bounded by their own stated anti-goals.**

They have most of the hard, boring parts already: bitemporality, provenance stamping, idempotency,
plan/commit with server-held plans, audit history, an inbox state machine, coverage-honest read
envelopes, explainable ranking, import-time coherence guards, a versioned extension mechanism, an
embedded zero-dependency default backend, a Claude Code plugin with deterministic hooks, 5.7k stars
and daily commits. They ship an alpha that is more disciplined than most GA products.

What they would have to build to become us:

- Path-template retrieval and path ranking (weeks — their BFS is already there, they need to keep
  parent pointers and add templates; the explicit "not a graph analytics engine" stance is a
  *decision*, not a limitation).
- Polarity and a dispute model (weeks — invasive but mechanical; requires giving up "retract kills
  the triple").
- Real entity resolution: strong-id constraints, an alias table, a resolution ladder, and read-time
  canonicalisation (**months, and it is a rewrite**). Semantic `entity_key`s are baked into the MERGE
  key, the claim key, the key-prefix label inference, the CLI UX and every skill prompt. Adding an
  opaque canonical id under that is not additive.
- Infra discovery and live-system import (months, and they *deleted* this once already).
- Scope sweeps (days — easy, and the most likely thing they add next given their TTL machinery).
- Call-site grain (months — a deliberate retreat from v1 they are unlikely to reverse).
- Cross-pot federation (explicit anti-goal, stated four times).

**Incentive:** their commercial pitch is "AI-native SDLC context", and "where does this data come
from, across our repos and into infra" is squarely on that roadmap. The `GraphExtension` mechanism
with `factory=None` readers suggests the closed product is already adding entity types and views the
OSS tree does not show — so the competitive surface may be larger than the repo.

**The realistic threat is not that they ship our design.** It is that they ship *good enough* memory
plus a frictionless install (`uv tool install potpie`, no Docker, embedded FalkorDB, skills that
auto-install into four harnesses) and own the write habit before we have a product. Distribution,
not architecture, is where they beat us.

---

## 4. What to steal

Concrete, in rough order of value:

1. **The coverage-not-confidence read contract.** `AgentEnvelope` carries a per-include
   `CoverageReport` (`complete/partial/sparse/empty`), `candidate_pool`, the serving `graph_view`,
   and an `overall_confidence` computed off the **worst** per-include tier, documented verbatim as
   "how much of what you asked for was found, NOT a model trust or per-claim probability." Adopt this
   distinction wholesale. Our trust score and our coverage are different numbers and must never be
   the same field.
2. **Arithmetic, not geometric, combination — with a per-factor breakdown.** They migrated *off* a
   weighted geometric mean because its floor let one zero factor veto a strong candidate. Our
   `base × freshness × anchor_integrity × corroboration` has exactly that bug: a deleted evidence file
   (`anchor_integrity = 0.0`) zeroes a fact that five other sources corroborate. Keep multiplicative
   only if you deliberately want veto semantics; otherwise switch, and emit the per-factor breakdown
   on every ranked item so the AUC experiment has data to work with.
3. **`not_implemented` vs `unknown_include`, enforced by a startup coherence guard.** An advertised
   capability with no implementation returns `not_implemented`; an unrecognised one returns
   `unknown_include`; the process refuses to boot if advertised ≠ runtime. This is the cheapest
   anti-phantom-vocabulary mechanism available and we should copy it verbatim, including the rule
   "align the declaration, don't relax the check."
4. **The inbox as a first-class "not sure yet" state.** `graph inbox add|list|show|claim|
   mark-applied|mark-rejected|close`, states `pending→claimed→applied/rejected/closed`, and the hard
   rule that **inbox items are never facts and never appear in graph reads**. This is the correct home
   for our under-merge/over-merge candidates, low-confidence LLM extractions, and unmapped raw
   predicates — better than a `pending` flag on the assertion row.
5. **`graph catalog` — one endpoint returning the entire machine-readable contract**, documented as
   "start graph-aware work here instead of reading docs." Vocabulary, ops, views, includes, examples.
   Agents will not read our docs. Ship `GET /v1/catalog` on day one.
6. **The three-catalog structure with derived registries.** `ENTITY_TYPES` / `EDGE_TYPES` /
   `RECORD_TYPES` as the only sources of truth, with identity, singleton, classifier and freshness
   registries rebuilt at import as *views*, plus import-time invariants that fail loud on drift. And
   `RECORD_TYPES` specifically — `record_type → anchor_label → emits_predicate → payload_schema →
   reader_include` — is exactly the join table we need between an agent-friendly verb vocabulary and
   the graph schema. It is why `potpie record --type decision --summary "..."` can be one line.
7. **The batch content fingerprint for idempotency.** A stable blake2b over the whole batch used as
   the provenance source id — "never the per-apply uuid, so retries stay idempotent and do not mint
   duplicate edges." We need this the moment an agent retries a `POST /v1/observations`.
8. **`SourceAuthority` + evidence gating by truth class.** Six authorities
   (`repository_metadata`, `authoritative_code`, `external_system`, `ci_run`, `user_statement`,
   `agent_observation`) with `EVIDENCE_REQUIRED_TRUTH_CLASSES = {authoritative_fact,
   source_observation}` and `LOW_AUTHORITY = {agent_claim, quality_finding}`. Requiring evidence
   *selectively* — by the kind of claim, not universally — is better than our flat `evidence[]`
   field, which will be empty half the time and we will have no policy about it.
9. **The property names.** `valid_at`/`invalid_at`/`created_at`/`expired_at`/`observed_at`/
   `graph_updated_at`; `prov_*` prefixing for the whole provenance block; `superseded_by_key`;
   `supersession_reason`. Free, and it makes any future interop cheaper.
10. **`GraphExtension`** — a versioned, additive bundle of `{entity_types, edge_types, views,
    record_types, readers}` with collision rejection and `definition.extend()`. Better than our
    implied "the schema is whatever is in the migrations."
11. **The zero-token nudge model.** SessionStart / PreToolUse(edit) / PreToolUse(Bash) /
    PostToolUse(Bash) / Stop hooks calling `potpie --json graph nudge`; four *data* events read named
    views, rank, dedupe against a per-session injection ledger and inject a compact block; two
    *instruction* events return a fixed directive and **never** auto-write; the whole trigger brain is
    deterministic with no model on the path; the hook fails open (exits 0 silently). This is the
    answer to our Risk #1 (fact density): you do not get writes by asking nicely, you get them by
    wiring the harness. Copy the architecture, including the fail-open discipline.
12. **Their negative result on scanners.** They built codeowners/openapi/kubernetes/dependency
    scanners and deleted them, replacing them with skills that tell the harness to read the files
    itself. Before we build importers, understand why. The likely reason — scanners rot, and an LLM
    reading a Dockerfile generalises better than a parser — is directly relevant to whether our
    "static analysis" fact source is worth the maintenance.

---

## 5. Build on it, or compete?

**Building on it: no, and the reason is structural, not political.**

Potpie's canonical id is a slugified name. Our entire entity-resolution design — opaque UUID, strong
identifier tables with uniqueness constraints, weak aliases that never auto-merge, `entity_merge` /
`entity_distinct`, and read-time canonicalisation through `entity.canonical_id` so merges are pure
inserts and unmerge is trivial — is a layer *underneath* the id. You cannot add it above a system
whose id is the name, whose MERGE key contains that name, whose claim key contains it, whose entity
label is inferred from its prefix, and whose CLI and skill prompts all speak in
`service:payments-api`. You would be forking, not extending.

Secondary blockers, any one of which would be a months-long fight upstream: no polarity (we would
need `retract` to stop meaning "kill the triple"); no proposition row to attach claims-about-claims
to; a bag-not-path read layer; a hard-rejecting write door that contradicts our accept-then-normalise
ergonomics; the `postgres` backend being a 0/6 stub while Postgres is our storage decision; and
cross-pot federation being an *explicit, repeatedly stated anti-goal* while cross-boundary is our
product.

Forking is likelier than extending, and a fork of a 783-file Python codebase to change its identity
model is not cheaper than building the TypeScript service we scoped.

**As a data source: yes, but the plumbing is worse than it looks, and the value is thin.**

Conceptually a Potpie pot is a decent importer for our graph: `Preference`, `Policy`, `Decision`,
`BugPattern`/`Fix` are project memory we have no plan to produce, and the timeline of `Activity`
nodes from GitHub is real corroboration data. Its claims already carry evidence refs, truth classes,
confidence, bitemporal stamps and actor identity — a near-clean map onto our assertion table
(`method`: their `agent_claim`→`llm_inferred`, `authoritative_code`→`code_derived`,
`user_statement`→`human`; their `valid_at`/`invalid_at`→our `valid_from`/`valid_to`; their
`source_ref`→our `evidence[]`).

But: **there is no HTTP read API.** No `/graph/read`, no `/neighborhood`, no `/search-entities`. You
would shell out to `potpie --json graph read ...` / `graph export` (real only on `in_memory` and
`embedded` backends) or read the FalkorDB/redislite file directly. And you would import entities
whose ids are names, which lands you straight in our Risk #2 — their unresolved
`service:service-c` / `service:svc-c` duplicates become our unresolved duplicates, and their empty
alias layer gives us nothing to resolve them with.

**The honest framing: Potpie is a competitor in the same category whose best output is a research
input, not a data feed.** Take the design (section 4) — that is worth weeks of our time. Do not take
the data.

---

## 6. What this comparison says about *our* risks

- **Risk 1 (fact density) is validated and they have a better answer than we do.** Potpie's response
  to "agents won't write" is not an ergonomic API, it is deterministic harness hooks plus `record`
  types that make a write one line. Our 202-in-150ms API is necessary and not sufficient.
- **Risk 3 (trust may be theater) is sharpened.** Potpie *has* ranking, *has* corroboration, *has*
  recency decay, and deliberately has **no** anchor-integrity signal. Either they didn't think of it,
  or they judged it not worth the git access — and their reader-level honesty elsewhere suggests the
  latter. Measure `anchor_integrity` against hand labels early; if its AUC contribution is flat,
  delete it rather than shipping it.
- **A risk we had not listed: the vocabulary door.** Their agent-facing validator hard-rejects unknown
  predicates and their ingest path soft-downgrades them to `RELATED_TO` at confidence 0.3 — and
  `RELATED_TO` is then excluded from every topology traversal. Our "never 400, store the raw predicate,
  map it asynchronously" has the same failure in a politer costume: unmapped predicates that exist in
  the store and are invisible to every path template. Decide now what a path template does with an
  unmapped edge, and make unmapped-predicate volume a first-class metric.
