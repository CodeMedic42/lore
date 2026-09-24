# Living AI Knowledge

A cross-repository knowledge graph that AI coding agents write to and query.

Knowledge about a software system currently dies at three boundaries: the context
window, the session, and the repository. This stores it outside all three — as a
graph that *references* repos rather than a file that rides inside one.

The question it exists to answer:

> "Where does the list of notifications in Client A come from?"

...answered by traversal across four repositories and into infrastructure, followed
by "and how do I connect to that database?"

## Status: walking skeleton

The skeleton is complete and the motivating query works end-to-end over a
hand-seeded graph. That was deliberate — seeding a *perfect* graph, with no
extraction or resolution errors to blame, is the honest test of whether traversal
beats grep. Everything downstream (extractors, the verification agent, MCP) is
worth building only if this step convinces.

```bash
docker start lak-pg          # or: docker run -d --name lak-pg -e POSTGRES_PASSWORD=lak \
                             #       -e POSTGRES_USER=lak -e POSTGRES_DB=lak -p 55432:5432 postgres:18-alpine
npm install
npx tsx src/cli/migrate.ts   # apply migrations
npm run seed                 # hand-seed the notifications scenario
npm run ask -- "where does the list of notifications in Client A come from"
npm run ask -- "how do I connect to the notifications-db"
npm run serve                # HTTP API on :4310
npm test                     # 15 invariant tests, run on in-process PGlite
```

## The model

Two tables carry the whole design.

**`proposition`** is the edge — deduplicated and content-addressed by a fingerprint
over (subject, predicate, object, *identifying* qualifiers). Ten agents asserting
the same thing produce one row.

**`assertion`** is *someone saying it* — many per proposition, each carrying
`polarity` (false = refutation), `method`, `confidence`, `evidence[]`, bi-temporal
validity, and the raw strings as written.

Collapsing these into one table — the obvious first design — makes corroboration a
fuzzy row-match and makes refutation inexpressible. With them split, corroboration
is a `count`, dispute is `polarity = false`, and status is derived rather than stored.

A proposition's subject may be *another proposition*. That single affordance carries
claims-about-claims, descriptive qualifiers (`ttl_seconds` on a cache read), and
n-ary facts like "reads Redis, falling back to Postgres".

### What actually removes a stale edge

Trust decay does **not**. When a service migrates Redis → Memcached the old edge
still exists, traversal still returns it, and the answer is still wrong — just with
a lower score attached. Two mechanisms close edges for real:

1. **Predicate cardinality** — `functional` predicates auto-expire the prior value.
2. **Scope sweeps** — a static scan is a closed-world snapshot; anything tagged with
   that `scope_key` and not re-asserted in the new run gets `valid_to = run_start`.

### Evidence that can be re-checked

When an agent makes a claim it points at lines of code as proof. Storing the file
path and line numbers is not enough — line numbers shift the moment anyone edits
above them, and a path says nothing about whether the relevant code changed.

So an agent also sends `span_text`: the code it actually read (which it already has
in context, so this is nearly free). The server hashes it after stripping cosmetic
differences — indentation, quote style, trailing semicolons — and stores that hash.
Later, when the file changes, every claim citing it is re-checked:

| Outcome | Meaning | Result |
|---|---|---|
| `ok` | identical, ignoring formatting | stays trusted |
| `shifted` | same code, new line numbers | **line numbers heal themselves**, stays trusted |
| `changed` | the code itself is different | queued for re-verification |
| `gone` | no trace, file deleted | queued for re-verification |

`shifted` matters as much as `changed`: if adding an import invalidated every claim
below it, the queue would be pure noise within a day.

A claim sent without `span_text` is still accepted, but the response warns that it
can never be automatically re-verified.

### Anchor state is a state, not a score

The original design multiplied trust by an "anchor integrity" factor. The problem:
a pure reformat would score 0.3 (looks broken, isn't) while a one-line change that
inverts the logic scores 1.0 (looks fine, isn't). The number would be uncalibrated
and nobody could tell whether it meant anything.

So a broken anchor does **not** quietly lower a score. It produces a concrete task —
"go look at this file and decide whether this still holds" — which the verification
agent answers by writing a supporting or refuting assertion. Trust stays three
honest factors (method, freshness, corroboration minus refutation); anchor state is
reported alongside the answer:

```
Service C ──reads_from──▶ Redis cache E  {role=cache key_pattern=notif:*}
     · ttl_seconds: 60
     ⤷ gitlab:1003 src/notifications/cache.ts:40-44
     ⟳ evidence changed (1 changed) — queued for re-verification
```

### Entity resolution

Opaque UUID identity; strong identifiers are a uniqueness *constraint*, while name
aliases are weak and never decide anything. Authorities are a reviewed list
(`gitlab_project`, `git_remote`, `arn`, `tf_address`, `otel_service`, `k8s`, `url`,
`scip_symbol`) and are spelling-normalised on the way in — `GitLab-Project` and
`gitlab_project` must not become separate namespaces, or the uniqueness guarantee
silently evaporates.

`scip_symbol` earns its place: a SCIP symbol is a compiler-accurate, version-aware
name for a code symbol, so two different tools indexing the same function emit
byte-identical strings. Two names resolve to one entity with no similarity guess
at all — and because the package version is part of the identity, `@acme/lib 1.0.0`
and `@acme/lib 2.0.0` stay correctly distinct.
Canonicalisation is a **read-time** indirection through `entity.canonical_id`, so a
merge is a pure insert and `unmerge` is one UPDATE — no assertion is ever rewritten.

`env` is a first-class discriminator: `prod-redis` and `staging-redis` cannot merge,
because a bridged environment makes "how do I connect" confidently dangerous.

Name similarity **proposes, never decides** — a near-miss files a row in
`merge_candidate` and still mints its own entity. `service-b` and `service-c` score
0.88 on trigram similarity and are different services. Under-merge leaves a visible
island; over-merge corrupts answers silently and permanently.

### Write path

`POST /v1/observations` — strings in, no IDs required, 202 out. An unknown predicate
is **never rejected**: it is stored raw and queued in `predicate_alias` for review.
An agent that gets a 400 stops writing forever. Nothing in this path blocks on an
LLM or a git host.

Literals are scanned for credentials on ingest and refused. Record *where* a secret
lives, never its value.

### Retrieval

Embeddings never drive traversal — they would return plausible, disconnected facts,
and the entire value here is the connected path. Anchor selection is the one fuzzy
step; every hop after it is structural.

Three path templates cover most questions: `data_provenance`, `blast_radius`,
`access`. Templates declare *directed* hops — without a reverse hop on
`exposes_endpoint`, a walk that reaches an endpoint dead-ends and can never reach
the service behind it.

## Layout

| Path | Role |
|---|---|
| `migrations/*.sql` | Schema, trust functions, edge projection |
| `src/db/` | Storage adapter — real Postgres, or PGlite in-process for tests |
| `src/domain/` | Fingerprinting, the identifying/descriptive qualifier split, predicate vocabulary, secret scanning |
| `src/resolver/` | The resolution ladder, merge/unmerge/distinct |
| `src/store/` | Ingest and scope sweeps |
| `src/query/` | Traversal, path templates, anchor finding, rendering |
| `src/api/` | HTTP surface |

## Deliberately not built yet

pgvector, the verification worker, MCP, merge automation, auth, `anchor_integrity`,
and any static extractor. See the plan for the milestone order.

## Bugs the skeleton caught

Worth recording, because both were invisible on paper:

1. **Annotation edges lost their context.** `falls_back_to` was projected as a bare
   `Redis → Postgres` edge, so *every* service touching that Redis appeared to fall
   back to the notifications database. Fixed by carrying `via_proposition`: a derived
   edge is traversable only if the walk arrived along the parent it annotates.
2. **`as_of` ignored system time.** Assertions were filtered on world-time validity
   only, so "what did we believe last week" returned facts written today.
3. **Fuzzy name matching auto-merged two services.** `service-b` and `service-c`
   score 0.88 on similarity. Name similarity now proposes a `merge_candidate` and
   still mints a separate entity — it never decides.
4. **Anchor checking conflated "moved" with "changed".** Code that shifted 20 lines
   down is intact evidence; treating it as suspect would have buried the
   re-verification queue in noise.
