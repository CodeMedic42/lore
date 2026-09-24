# Glean (Meta, glean.software) vs. Living AI Knowledge

**Comparison date:** 2026-09-24
**Subject:** `facebookincubator/Glean` — Meta's open-source code indexing system. BSD-3, Haskell/C++, RocksDB/LMDB, Angle query language, Thrift server. Latest Hackage release `glean-0.2.0.1` (2026-02-13).
**Not to be confused with:** glean.com (Glean Technologies, enterprise search). Different company, different product, and it is the one that actually ships an MCP server. Everything below is about Meta's.

---

## 0. Verification notes on the incoming dossier

The dossier is accurate on essentially everything load-bearing. Five corrections and sharpenings, all verified against primary sources:

1. **CONFIRMED, and the dossier under-weights it.** `glean/website/docs/introduction.md` says verbatim: *"If you're familiar with Datalog, it's worth noting that currently Angle is limited to non-recursive queries only."* The dossier records this as a footnote. It is the single most important fact in this comparison. Glean's query language **cannot express transitive closure**, which means it cannot express the motivating query at unknown depth. Everything in §2 flows from this.

2. **Trap:** `UserQueryOptions.recursive` (field 3 in `glean.thrift`) is *not* query recursion. Its comment reads *"If true, then the query will fetch all nested facts recursively."* That is **result expansion** — hydrating nested fact references in the response payload — not graph traversal. Anyone skimming the Thrift file will misread this. It does not help.

3. **The dossier's "cross-repo: no" is slightly too strong.** `docs/databases.md` line 13 states a DB name *"is often (but not always) the name of the source code repository from which the facts in the database were collected."* A DB is just a set of facts; nothing prevents writing facts from four repos into one DB, and `Stacked { name, hash }` accepts an arbitrary base DB, so a cross-repo stack is constructible. What is genuinely absent is (a) any **cross-DB join in the query engine** — `userQuery(1: Repo repo, 2: UserQuery q)` is scoped to one DB, confirmed — (b) any shipped multi-repo indexing convention, and (c) path namespacing: `src.File` keys are bare path strings, so `src/index.ts` from repo 1 and repo 3 collide and the shipped indexers will not disambiguate them for you.

4. **Write API, public surface, corrected.** `docs/write.md` lists only **the Haskell writing API** in its OSS-visible section; the C++ API and the Hack `genKickOff` path are both inside `<FbInternalOnly>` blocks. Public fallback is raw Thrift: `kickOff → sendJsonBatch → finishBatch → finish`. There is no HTTP/REST write endpoint of any kind.

5. **No per-fact timestamp — confirmed by exhaustion.** Every `PosixEpochTime` in `glean.thrift` (`created_since_epoch`, `expire_time`, `completed`, `repo_hash_time`) hangs off `Database`, never off a fact. There is no fact-level time field anywhere in the IDL.

Also confirmed: landing-page copy ("*ideal for IDEs, code review bots, refactoring tools, LLM coding agents*"; "*Code search agents & LLMs: ground answers in real symbol relationships instead of grep heuristics*"; "*billions of facts*") with **no MCP mention and nothing in the repo behind it**; and CHANGELOG 0.2.0.0 = `glean-lsp` + `.hie` Haskell indexer + experimental LMDB, i.e. zero agent-facing work in the most recent release.

---

## 1. Point-by-point

| Our concept | Glean | Verdict |
|---|---|---|
| **Proposition = deduplicated, content-addressed edge** | **Partial, and genuinely good.** A fact is immutable, uniquely keyed, and auto-deduplicated by the storage backend. The key *is* the content address. | Glean's is better-engineered; ours is more expressive (their key cannot be cyclic, ours can nest arbitrarily) |
| **Identifying vs. descriptive qualifiers** | **Direct equivalent.** `predicate P : Key -> Value`. Key determines identity; value is the mutable part. Validated over ~21k lines of schema. | **Theirs validates ours.** Steal the framing (§4) |
| **Assertion table — someone *saying* a proposition** | **Nothing.** No asserter, no session, no method, no confidence, no evidence. | Ours, uncontested |
| **Polarity / refutation** | **Nothing.** Contradictions coexist silently. The one exception is key-value predicates, where a second value for the same key is a **write error**, not a recorded conflict. | Ours, uncontested |
| **Corroboration as a count** | **Nothing** — and structurally impossible: dedup means a second identical fact *disappears*. Glean cannot count how many times something was observed, because observing it twice is the same fact. | Ours. Worth noting: dedup and corroboration are in direct tension. Our assertion/proposition split is exactly the fix |
| **Bi-temporal validity** | **Nothing at fact level.** Time lives on the DB (`name/hash`, `repo_hash_time`, `created_since_epoch`). Many revisions coexist as separate DBs. No as-of query *within* a DB. | Ours, uncontested |
| **Scope sweeps** | **Partial, and better-engineered than ours.** Units (arbitrary strings, ~one per file) + `Pruned { base, units, exclude }` + interned ownership sets (Elias-Fano, interval maps, ~7% size overhead). | Theirs is the more rigorous mechanism; ours is the only one that records *when* something stopped being true (§1 notes) |
| **Predicate cardinality / functional predicates** | **Direct equivalent, opposite policy.** Key-value predicates enforce one value per key — and *reject* the conflicting write. | Ours is better for a multi-writer world; theirs is only viable because writers are deterministic indexers |
| **Trust score** | **Nothing.** `dyn.Usage = Unused \| Enumerated \| Used` is the only certainty-like enum in ~95 schema files, and it is domain-specific to dynamic dispatch. | Ours — but see §6 for why Glean's *absence* of trust is an argument against ours |
| **Entity resolution, strong/weak ids, merge/distinct** | **Nothing.** No aliasing, no merge, no canonical indirection. Identity is the fact key, full stop. Their equivalent of "the same symbol in two languages" is hand-authored (`gencode`, `GeneratedEntityToIdlEntity`). | Ours, uncontested. Also: they got away without it because code symbols have canonical names. Infra entities do not |
| **`env` as a first-class discriminator** | **Nothing** (no environments modelled at all) | Ours |
| **Call-site grain → derived service edges** | **Direct equivalent, and the better-specified one.** `stored` derived predicates = materialised views, computed by `deriveStored`; on-demand derived predicates = virtual views. `codemarkup` is a whole language-neutral abstraction layer built this way. Derived facts inherit the **conjunction** of their sources' ownership. | **Theirs is better.** Steal it (§4) |
| **Accept-then-normalise write path, 202 in <150ms, never 400** | **Opposite by design.** Strongly typed, type-checked server-side, rejects unknown predicates, rejects incompatible schema changes. No streaming append: you `kickOff` a DB, batch facts in, `finish`, and it is then read-only. | Ours, decisively — and this is the deepest incompatibility (§5) |
| **Path-template retrieval over recursive CTE** | **Structurally impossible.** *"currently Angle is limited to non-recursive queries only."* Fixed-shape multi-hop conjunctions work; unknown-depth traversal does not. | Ours. Their limitation validates our choice of Postgres recursive CTE, and warns us about its cost (§6) |
| **Embeddings for anchor resolution only** | **Nothing** — no vectors, no embeddings, no semantic search. Deliberately no substring or regex matching either: *only* prefix match, "because prefix matching can be supported efficiently by Glean's prefix-tree representation." | Ours. Note their discipline: they refused fuzzy matching entirely rather than ship a slow version |
| **Four fact sources (agent / static / runtime / human)** | **One and a half.** Static analysis, superbly. `dyn.7` is a runtime-observed dynamic-dispatch schema, so runtime import is precedented. Agent-asserted: nothing. Human-authored: nothing. | Ours on breadth; theirs on depth in the one lane it occupies |
| **Verification agent that can refute** | **Nothing that refutes** — but `src.IndexFailure` models *indexing* failure as a first-class fact, with the doc note "it is a good practice to add all errors directly into db." | Ours — but steal `IndexFailure` immediately (§4, and it fixes a bug we will otherwise ship) |
| **Schema evolution** | **Far ahead of us.** `SchemaId` = hash of the whole schema; clients send it with every query; server translates data into the client's schema both directions. Documented compatible/incompatible change rules, enforced. | **Theirs, decisively.** We have nothing here and we will need it |
| **Cross-language entity model** | **Far ahead of us.** `code.Entity` sums 18 languages; `codemarkup.31` derives 36 language-neutral predicates over it; SCIP and LSIF are first-class ingest formats. | Theirs |
| **Infrastructure entities** | **Nothing.** No services, deployments, environments, owners, on-call, incidents, runtime topology. `buck`/`dataswarm`/`chef`/`yaml` model *artefacts in the repo*, not running systems. | Ours, uncontested |
| **Agent-facing API** | **Nothing.** Thrift binary only, OSS client Haskell only, Linux-only build (GHC 9 + cabal), Docker demo image documented as not working. Zero hits for `mcp` in the repo. | Ours |

### The two places Glean's design is a live argument against ours

**Dedup vs. corroboration.** Glean deduplicates facts at the storage layer — asserting the same fact twice is a no-op. We deduplicate propositions but count assertions. That is the correct call, and the contrast is worth internalising: *content-addressing is how you make a fact store cheap, and it is exactly what destroys the signal we want to keep.* Our split is the only way to have both. Good.

**Immutability vs. validity intervals.** Glean's facts are append-only with monotonic IDs and a key that "can only refer to earlier facts." Corrections are made by building a **new stacked DB** that hides stale units. This is elegant and it scales, and it throws away history: when Service C migrates Redis→Memcached, Glean cannot record *"`reads_from redis-e` was true until 2026-03-01."* It can only make the fact invisible in a newer DB. For a system whose selling point is *living* knowledge, that history is the product. This is the clearest place where our design is not just different but better for our purpose.

---

## 2. The motivating query, walked concretely

**Question:** "Where does the list of notifications in Client A come from?" across four repos and into Terraform-provisioned AWS, followed by "How do I connect to that database?"

**Answer: only if you hand-build almost all of it, and even then only if you already know the hop count.**

**Step 1 — Author the schema (2–5 days, genuinely fine).** Nothing infra ships. You write `infra.angle`:

```
predicate Service : string
predicate Endpoint { service : Service, method : string, path : string }
predicate CallSite { caller : code.Entity, endpoint : Endpoint }
predicate Store { name : string, kind : enum { redis | memcached | postgres }, env : enum { prod | staging } }
predicate ReadsFrom { service : Service, store : Store }
predicate FallsBackTo { from : Store, to : Store }
predicate TerraformResource : string
predicate ProvisionedBy { store : Store, resource : TerraformResource }
```

Angle's type language (records, sums, enums, predicate references) is more than expressive enough. This step is not the problem. Note that `env` as an enum field on `Store` gives us exactly our env discriminator — Glean's schema language would support our design fine.

**Step 2 — Build four ingesters (weeks, and this is where the work is).** Glean ships `external` — any program that emits Glean JSON — so the plumbing is free. The extraction is not:
- **HTTP call-graph (Client A → Service C).** No shipped indexer resolves an HTTP client call to a server route. You write it, per framework, in both repos' languages.
- **Terraform.** No HCL indexer exists anywhere in the tree. You write it.
- **Redis / AWS runtime topology.** No runtime importer of any kind. You write it, against cloud APIs.
- **Fallback semantics (Redis → Postgres).** Needs either a code-reading heuristic or a human assertion. Glean has no human-authoring path at all: a human "fact" is a JSON batch you hand-write and `glean write`.

**Step 3 — Cram everything into one DB, and pay for it.** There is no cross-DB join. So all four repos plus Terraform plus cloud imports go into a single `arch/<hash>` DB. Consequences you will hit on day one:
- `src.File` keys are bare path strings. `src/index.ts` exists in repo 1 *and* repo 3 and they will collide. You must namespace every path yourself — which means you cannot reuse `glean index typescript` as-is; you post-process its JSON output first.
- Re-indexing repo 3 alone requires `glean create --incremental <old> --exclude <repo3 units>`. This works *if* you set units at repo-file granularity. But stacks are a chain: rebuilding a lower layer invalidates everything stacked above it. Four repos updating independently means constant stack churn, and the implementation notes still say ownership-aware incremental *derivation* across stacks "isn't implemented yet."

**Step 4 — Write the query. It works, for exactly one shape.**

```
{ Cache, Db, TF } where
  N = <the notification-list entity in Client A>;
  infra.CallSite { caller = N, endpoint = E };
  infra.Endpoint { service = S } = E;
  infra.ReadsFrom { service = S, store = Cache };
  infra.FallsBackTo { from = Cache, to = Db };
  infra.ProvisionedBy { store = Db, resource = TF };
```

That returns the answer in single-digit milliseconds. But observe what it is: **our `data_provenance` path template, hand-written in Angle, with the depth hardcoded.** It works because we knew the chain was five hops of known shape.

Change the question to "Client A → ? → ? → ? at unknown depth" — the general case, the one that makes a knowledge graph worth having — and Angle cannot express it. *"Currently Angle is limited to non-recursive queries only."* Your options are: (a) write one Angle query per possible depth, a combinatorial mess once edge types vary; (b) run a client-side BFS, one round-trip per hop, assembling the frontier in your own code — N network round-trips instead of one query, with the depth cap, edge-type whitelist and trust cut all reimplemented client-side. Option (b) is what Glass effectively does. It is also precisely the architecture our recursive CTE exists to avoid.

**Step 5 — "How do I connect to that database?" Nothing.** No secrets model, no notion of returning the *location* of a credential rather than its value, no environment-aware routing beyond a field you invented in step 1. OSS access control is an opaque `acl_config` string at `kickOff`.

**Step 6 — Staleness, the honest part.** When Service C migrates Redis→Memcached, the `ReadsFrom` fact persists until the unit that produced it is excluded in a new stacked DB. If your units are file-grained, re-indexing repo 3 prunes it correctly and *this is better-engineered than our scope sweep*. But Glean cannot record the migration as a dated refutation. The old edge does not become "false as of March"; it becomes invisible in DB N+1 while remaining true in DB N. Ask "when did Service C stop using Redis?" and Glean's only answer is "diff two databases yourself."

**Step 7 — Operational tax.** Linux-only build, GHC 9 + cabal, fbthrift binary protocol (not Apache Thrift), Haskell-only OSS client. We are TypeScript/Node. Realistic integration is shelling out to the `glean` CLI and parsing JSON.

**Bottom line for §2:** Glean can answer the motivating query if you author the schema, write four ingesters, namespace all paths, put everything in one database, and hardcode the hop count. It cannot answer it at unknown depth, cannot tell you when the answer stopped being true, cannot tell you who claimed it, and cannot tell you how to connect.

---

## 3. Threat assessment: **low**

**Could this team close the gap?** At the storage layer they are among the best in the world. But the gap is not storage. It is provenance semantics, entity resolution, an agent-facing write path, infrastructure ingest, and NL retrieval — none of which is their problem.

Four reasons the gap stays open:

1. **Immutability is architectural, not a setting.** Facts are append-only with monotonic IDs; a DB goes Incomplete → Complete and is then read-only (`glean unfinish` exists and is documented as *"for testing and development and not for routine use"*). Mutable validity intervals on individual assertions is not a feature you bolt onto that — it is a different store. They *could* express assertion-on-proposition in the schema (a predicate whose key references another fact is exactly our proposition-about-a-proposition — the mechanism is there), but with no per-fact time, no arbitrary write-at-query-time, and no in-place update, the expression would be inert.

2. **No commercial incentive.** BSD-3, no company, no pricing, no hosted service. The internal customer is IDE navigation and code review inside Meta's monorepo. Cross-repo infra knowledge is, for Meta, not a problem — they have one repo.

3. **Six years of revealed preference.** Created 2020-08. Still no MCP server, no HTTP API, no non-Haskell OSS client. The landing page acquired agent-flavoured copy; the repo did not acquire agent-flavoured code. The most recent release added an LSP server, a `.hie` indexer and an LMDB backend. If they wanted agent write-back, a REST endpoint would have shipped first.

4. **OSS lags internal by years.** Python, Java, Kotlin, Erlang, Thrift, Buck/Bazel, C# and Swift indexers are listed as "not in the open source release yet." Whatever Meta builds internally may never reach us.

**What they do have that is adjacent and should make you slightly uncomfortable:** the 18-language `code.Entity` model, `codemarkup`'s neutral derived layer, SCIP/LSIF ingest, and world-class incrementality. If our `code_derived` fact source matters a lot, we are building a thin, worse version of their indexer fleet.

**Realistic worst case:** someone wraps Glean/Glass in an MCP server for code navigation. That competes with our read path *for intra-repo code facts only*. It touches neither infrastructure, nor provenance, nor cross-session memory. Threat: low, not none.

---

## 4. What to steal — concrete

1. **`src.IndexFailure` — steal this first; it fixes a bug we will otherwise ship.** Glean models indexing failure as a first-class fact: `src.IndexFailure { file, reason: CompileError | BuildSystemError | Unclassified | DiscoveryError, details }`, with the doc note *"it is a good practice to add all errors directly into db."* Our scope sweep expires anything tagged with a `scope_key` and not re-asserted in the current run. **If a file fails to parse during a scan, the sweep will silently expire every valid edge derived from it.** Fix: record scan failures as rows in the same store, keyed by `scope_key` + path, and have the sweep exclude the coverage of any path with a failure in this run. Adopt their four-way reason enum verbatim — it is a good taxonomy.

2. **Key/value = identifying/descriptive.** `predicate P : Key -> Value` is our identifying-vs-descriptive qualifier split, validated across ~21k lines of schema. Adopt the framing explicitly in our docs and column naming: *the key determines identity; the value is what can change without changing identity.* Keep our divergence (they make a value conflict an error; we make it a proposition-about-a-proposition that can be refuted) — ours is right for multi-writer.

3. **Unit granularity discipline.** Their units are arbitrary undeclared strings, *one per file or module*. Our `scope_key` should be file-grained, not repo-scan-grained. A repo-level scope sweep expires everything a partial run missed; a file-level scope key only expires what that file's rescan actually covered. This is a one-line design change with large blast-radius consequences.

4. **Derived-fact ownership is the *conjunction* of its sources' ownership.** When we derive a service-level edge from call-site edges, that derived edge must inherit the union of constituent `scope_key`s and the *minimum* trust of its constituents — so that expiring any one call site correctly invalidates the derived edge. Our spec does not say this and it is the obvious hole in "record the finest grain and derive upward."

5. **`stored` vs. on-demand derived predicates.** Two explicit modes — materialised-into-the-store vs. computed-per-query — with a CLI verb (`glean derive`) and an API verb (`deriveStored`) to materialise. Steal the vocabulary and the two-mode design for our service-level edge derivation. Also steal `ParallelDerivation` (partition derivation over an outer predicate) as the scaling story when derivation gets slow.

6. **`digest.FileDigest` content hashes → fix our `anchor_integrity`.** Today `anchor_integrity` checks whether the evidence path still exists at HEAD. That is weak, and risk #3 ("trust scoring may be theatre") is justified. Steal the digest idea but tighten it: store a **normalised content hash of the anchored line span**, not of the file. Unchanged span → 1.0; changed span → decayed; file gone → 0.0. Normalise whitespace before hashing and the reformat-vs-semantic false positive largely disappears. This turns a hand-wave into something measurable, which is what our own AUC-vs-hand-labels plan needs.

7. **`indexer.Config : string -> string`.** Record the exact configuration and version of each producer, per run, as data. Cheap, and it makes "everything scanner v3 emitted last Tuesday was garbage" a single retractable scope rather than a forensic exercise.

8. **`SchemaId` negotiation.** A content hash over the entire schema, sent by the client with every query, with server-side bidirectional translation between schema versions. We have committed to never rejecting an unknown predicate, which guarantees our predicate vocabulary churns. At minimum: version the predicate vocabulary, stamp the vocabulary version onto every assertion, and expose it on reads. Their compatible/incompatible change taxonomy (add/remove defaultable field ✓, add/remove sum alternative ✓, add/remove predicate ✓, change a field's type ✗) is a ready-made rulebook.

9. **`gencode` / `GeneratedEntityToIdlEntity`.** A shipped model for "this artefact was produced by that source" — the exact shape of our `provisioned_by` Terraform edge. Read it before designing ours.

10. **`code.Entity` + `codemarkup` layering.** Raw, typed, per-source facts at the bottom; one narrow language-neutral API derived above. Our path templates should query *only* the neutral layer, never raw importer output. This is the architectural lesson, and it is free.

11. **`dyn.Usage = Unused | Enumerated | Used`.** A coarse three-valued ordinal instead of a float confidence. Consider exposing trust to the LLM narrator as a 3-band ordinal (`verified` / `plausible` / `weak`) rather than `0.83`. An LLM does nothing useful with two decimal places, and bands are far easier to hand-label for our AUC measurement.

12. **API shape: `kickOff → sendJsonBatch → finishBatch(handle) → finish`.** Our `POST /v1/observations` returns 202 in <150ms; steal the **handle + `finishBatch(handle)`** pattern so an agent can *later* learn what happened to its batch — which raw predicates got mapped, which entities were minted provisionally, what resolved to what — without anything blocking on the write path. We have specified the 202; we have not specified the reconciliation endpoint, and agents will need it.

13. **`store_derived_facts` as an explicit per-query opt-in.** A boolean on the read request saying "this read may write." Worth having on our traversal endpoint so derived service-level edges can be materialised lazily on first traversal.

14. **Honest escape-hatch documentation.** `glean unfinish` is documented as *"for testing and development and not for routine use."* Label our escape hatches (force-merge, manual expire) the same way, in the API docs, not the wiki.

---

## 5. Build on it, or compete? And is it a data source?

### Build on it: no.

Five blockers, ranked:

1. **The write model is incompatible at the root.** Glean writes are batch-oriented *database creation*: `kickOff` → batches → `finish` → read-only. You cannot append to a Complete DB. Our write path is continuous single-observation append with a 202 in 150ms. Implementing that on Glean means creating a stacked database per observation. That is not a workaround, it is a refutation.
2. **No per-fact time and no fact mutation** → bi-temporal validity is unrepresentable. You could encode `valid_to` as a new fact, but with no fact-level time and no negation in stored derived predicates, as-of filtering becomes a manual nat comparison bolted onto every single query.
3. **No recursion** → our entire retrieval story becomes client-side BFS (§2, step 4).
4. **Single-DB query scope** → every cross-repo answer requires either one giant DB with hand-namespaced paths, or application-level fan-out.
5. **Linux-only Haskell/C++/fbthrift vs. TypeScript/Node.** Not fatal alone; fatal in combination with the above.

### As a data source: yes — but narrowly, and not the way you would first assume.

The obvious plan is: run Glean per repo with the shipped indexers, query `codemarkup` (`EntityLocation`, `EntityReferences`, `ContainsChildEntity`, `ExtendsParentEntity`), and bulk-emit observations with `method=code_derived`, `evidence={repo, commit, path, line_range}`, and `scope_key` = the Glean DB `name/hash`. Pleasingly, **the DB hash *is* the commit**, which is exactly our evidence anchor, and the shipped SCIP/LSIF ingest covers a dozen languages we would otherwise hand-roll.

**Do not do this as bulk ingest.** It produces enormous volumes of precise *intra-repo* symbol facts — which is the **low-value** kind. Our risk #1 is that importers out-produce agents and the cross-repo edges (the whole point) drown in noise. Bulk-importing Glean makes risk #1 strictly worse: millions of `EntityReferences` rows, zero new cross-repo edges, and a trust score whose distribution is now dominated by deterministic facts that never needed one.

**Do it as verification instead.** Our verification agent needs to answer "does this asserted claim actually hold in the code?" Glean answers that in ~1ms, with a typed query, across 18 languages, with the revision pinned by the DB hash. That is a much better fit: low volume, high value, directly feeds `anchor_integrity` and the refutation path. Ask Glean *point questions* ("does symbol X still exist at path Y at commit Z?", "who still references it?"); never ask it for its contents.

**Even that is probably premature.** Linux box, GHC 9 + cabal build, one indexer per language, a Thrift client we do not have or CLI shell-out with JSON parsing, plus ongoing DB retention/backup/re-index ops. Against that: `tree-sitter` gets 80% of the same anchor facts in a few hundred lines with no Haskell in the stack. For a single-user local product, Glean is over-engineered by roughly two orders of magnitude. Revisit it only if and when the verification agent becomes the bottleneck and the language count exceeds what tree-sitter queries can comfortably cover.

---

## 6. The uncomfortable part

Three things Glean's existence argues *against* our design. Take them seriously.

**Six years, twenty-one thousand lines of schema, billions of facts, and they never needed provenance.** For deterministically derived code facts, provenance is genuinely unnecessary: the derivation is reproducible, so "who said it" is answered by "re-run the indexer." Our trust score only earns its keep for `llm_inferred` and `human` assertions. If risk #1 lands — if importers out-produce agents — we will have built an elaborate trust, refutation and bi-temporal apparatus for the 5% of rows that need it, wrapped around a fact store that Glean already does better. **The honest test: what fraction of rows at month six are `llm_inferred` or `human`? If it is under 20%, the concept has collapsed into an importer with annotations, and Glean's shape is the correct shape.**

**Their non-recursion is not laziness, it is a considered trade.** Meta has a dedicated query-engine team, a bytecode VM, and a ~1ms latency target, and they still shipped without transitive closure — because non-recursive queries are what make prefix-tree indexing and that latency tractable. They also refused substring and regex matching outright for the same reason. Our depth-capped recursive CTE over Postgres, with an edge-type whitelist and a trust cut in the recursive term, will be the performance problem in this product. Plan for it now: their `stored` derived predicate is the answer — materialise hot path segments rather than traversing live.

**Their invalidation machinery is what doing this properly costs.** Interned ownership sets, Elias-Fano coding, fact→uset interval maps, ~7% storage overhead, and *still* "incremental derivation across stacked ownership isn't implemented yet." Our scope sweep is a `UPDATE ... SET valid_to` over a row set, and it will work — because our scale is four orders of magnitude smaller, not because we found something they missed. Say that out loud in the design doc, so nobody later mistakes simplicity for insight.

---

## Verdict

Glean is the best-engineered typed fact store for source code in existence, and it solves almost none of the problem we are solving. It has no assertions, no provenance, no confidence, no refutation, no fact-level time, no entity resolution, no infrastructure model, no agent write path, no recursion, and no HTTP API. What it has — content-addressed dedup, key/value identity split, derived views, unit-based invalidation, schema-id negotiation, a language-neutral entity layer — is a catalogue of design decisions we should copy wholesale at the layer where we overlap.

Threat: **low**. Value as prior art: **high**. Value as a data source: **narrow and deferrable** — a verifier, not an importer.
