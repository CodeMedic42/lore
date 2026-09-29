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
npm run ask -- "where does the list of notifications come from"
npm run ask -- "how does authentication work for this client"
npm run ask -- "what alerts are set up in AWS"
npm run gaps                 # what the assistant should ask you next
npm run gaps -- --all        # every detected hole, ranked
npm run tell -- "svc-a reads from billing-db"   # just say it in English
npm run answer               # list its questions; answer by number
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

## Knowing what it doesn't know

The graph detects its own holes, so an assistant can ask a *useful* question rather
than an annoying one. Every gap below is mechanically derived from the shape of the
graph — nothing is guessed:

| Gap | Question it produces |
|---|---|
| `dangling_endpoint` | Something calls this route; nothing on record serves it. **Answering joins two repos.** |
| `name_collision` | Two similar names, unresolved. The Angular-rewrite-beside-the-React-one case. |
| `homeless_project` | A project with no repository |
| `no_access_info` | A database nobody recorded how to reach |
| `unknown_technology` | A project whose language and framework are unknown |
| `unprovisioned_infra` | Infrastructure with no owning IaC module |
| `undescribed_concept` | A capability with no description, so it can never be matched to a question |
| `unidentified_entity` | Well connected, but identified only by name |
| `orphan_entity` | Mentioned once, linked to nothing |

Gaps are ranked by what answering them unlocks — the same unknown counts for more
on a well-connected entity — and `askableQuestions()` returns only the top one or
two. An assistant that interrupts five times a session gets muted, and then nothing
is learned at all.

Two rules keep question quality up:

- **Never ask what the graph can settle itself.** `GET /v1/notifications` and
  `POST /v1/notifications` differ by four characters, so name similarity flags them
  — but they carry different method qualifiers and are definitively different
  routes. `maintain()` marks such pairs distinct without asking.
- **Never ask the same thing twice.** When a join proposal already covers a pair,
  the generic "are these the same?" is suppressed in favour of the better-phrased
  "is this the same route as X, served by Y?"

## Connections get proposed, not invented

One repo records *"I call `GET /v1/notifications`"*. Another, weeks later and by
someone else, records *"I serve `GET /v1/notifications`"*. Those are two separate
endpoint entities until something notices they are the same route.

`endpoint_join_candidates()` matches them on path and method and **proposes** the
link. It never asserts it — a path collision between two unrelated systems is
entirely possible. This is the moment the graph becomes worth more than the sum of
its parts, and it happens without anyone holding both repos in their head.

## Two tiers: the graph, and context files

Some knowledge is global and rare-changing. Some is local and changes every sprint.
Putting both in one place is what breaks systems like this — either the central
index rots, or a dense in-repo file becomes a merge battleground.

So they are split along the line that matters:

| | **The graph** | **A context file** |
|---|---|---|
| Holds | Facts that cross a boundary | Everything inside one boundary |
| Example | `library-a exports TextField`, `SearchField composes TextField` | TextField's props, variants, gotchas |
| Churn | Rare | Every sprint |
| Lives | Central store | `src/components/TextField.context.md`, beside the code |
| Merge conflicts | None — in no repository | The same ones you already had on the component |

The graph stores a **pointer**. Detail is loaded on demand.

That last row is the point. A dense index committed to a repo fights every branch,
because it is a global thing stored locally. A per-component context file is edited
by the same person editing the component, in the same commit — so it merges exactly
as well as the code does.

```markdown
---
describes: ./TextField.tsx
generated_from: 4a91c2e
---

# TextField
`onChange` hands you the string, not the `ChangeEvent`.
```

`generated_from` makes staleness a `git log 4a91c2e..HEAD -- TextField.tsx` away —
instant, local, exact, no hashing:

```
$ npm run context -- TextField
status: loaded
Context for TextField, from src/components/TextField.context.md.
WARNING: 2 commit(s) have touched the described files since this was written.
Changed since: src/components/TextField.tsx.
Treat details as possibly out of date, and offer to refresh it.
```

Every failure mode still answers something useful:

| Status | Meaning |
|---|---|
| `loaded` | Here is the detail, and how far behind it is |
| `no_context_file` | Here is the source path, and where to write one |
| `repo_not_local` | Not checked out here — here is the URL |
| `path_missing` | The recorded location is stale; it moved |
| `no_source` | Nothing records where this lives, and here is what would fix that |

### Writing them

The agent writes the prose — it is the language model, so nothing here calls out to
one. `draft_context` gathers the material; `write_context` persists it correctly.

```bash
$ npm run context -- draft "TextField"
Refreshing src/components/TextField.context.md. Update what changed; keep everything still accurate.
source: src/components/TextField.tsx
HEAD: 18fe8e8

already in the graph:
  TextField part_of library-a
  SearchField composes TextField

commits since written:
  c59caec Tweak TextField
  c49e462 Add startAdornment and onBlur to TextField

existing context (895 chars) — refresh, do not replace
```

Three things that draft deliberately does:

- **Hands back the existing body**, because a refresh should update what changed and
  leave hand-written gotchas alone. Regenerating from scratch quietly discards what
  someone learned the hard way.
- **Shows the diff since `generated_from`**, not just the current source — the
  question is what changed, not what exists.
- **Lists what the graph already holds**, so it does not get duplicated into the file
  and drift.

`write_context` handles the mechanics: where the file goes, `describes` relative to
it, stamping `generated_from` with HEAD, and preserving frontmatter a human added.
Losing someone's `owner:` line on every refresh is the kind of small betrayal that
stops people maintaining these at all. It refuses to write anything not ending in
`.context.md`, and refuses to write outside the repository.

### Committing code and context together does not read as stale

The obvious implementation gets this wrong. If you commit `TextField.tsx` and
`TextField.context.md` in one commit — the correct workflow — a naive
`git log <sha>..HEAD` counts that commit and reports the file one behind
immediately. Every well-maintained file would cry wolf on every commit, and within
a week nobody reads the warning.

So commits that also touched the context file are excluded. Verified:

| | Result |
|---|---|
| Context committed on its own | up to date |
| Code **and** context in one commit | up to date |
| Code changed, context untouched | `WARNING: 1 commit(s) have touched the described files` |

Register a checkout so files can be read:

```bash
npm run context -- register library-a ~/src/library-a https://gitlab.com/acme/library-a
```

## Using it from Claude Code (MCP)

`.mcp.json` in this repo registers the server, so Claude Code offers to connect it
when you open the project. Or add it yourself:

```bash
claude mcp add knowledge -- node /absolute/path/to/src/mcp/stdio.ts
```

It runs on plain `node` — Node 24 strips the types, so there is no build step and
no `tsx` in the hot path. It talks to the same core the HTTP API wraps, so there is
one implementation of the rules. Point `DATABASE_URL` at a shared Postgres and a
whole team's agents write into one graph; leave it at the default and it is yours.

Six tools:

| Tool | For |
|---|---|
| `ask_knowledge` | A question in plain English, answered across repo boundaries with evidence |
| `load_context` | Follow the pointer and load the dense detail beside the code |
| `draft_context` | Gather source, existing context, and the diff since it was written |
| `write_context` | Persist a context file with correct frontmatter and stamp |
| `lookup_entity` | Everything known about one thing, and what it connects to |
| `record_observations` | Record durable facts the agent learned |
| `record_statement` | Record what the user said, in their words |
| `pending_questions` | What the graph is missing and should ask about |
| `answer_question` | Apply the user's answer |

The tool descriptions do real work here — they are where the model learns *what is
worth recording*: things that cross a repository boundary, how data actually flows,
what things are built from, what they are for. And what is not: the body of a
function, anything a refactor invalidates next week, a dump of a lockfile.

The write path teaches as it goes. Record something under a name the graph has not
seen and the response says so, and suggests supplying a `git_remote` or `arn` next
time so it resolves instead of duplicating — which is the single biggest threat to
a graph like this being useful.

## Telling it things, and answering its questions

```bash
npm run tell -- "the new-notification-client is written in TypeScript and uses \
                 Angular, it replaces notification-client and is built with Vite"

Recorded:
  new-notification-client ──written_in──▶ TypeScript
  new-notification-client ──uses_framework──▶ Angular
  new-notification-client ──supersedes──▶ notification-client
  new-notification-client ──built_with──▶ Vite
```

The parser is deterministic and deliberately modest. It reads the statements people
actually make about systems, carries a subject forward across "it", splits a chained
sentence into separate claims, and **declines anything it cannot parse confidently**
rather than inventing structure — unrecognised text comes back verbatim.

Two behaviours are worth calling out.

**Negation refutes, it does not delete.**

```bash
npm run tell -- "notification-client no longer uses Webpack"
  notification-client ──built_with──▶ Webpack  [REFUTES]
```

The original claim stays on record with its provenance; trust drops from 0.95 to
0.19 because one source now contradicts another. Note also that "uses" is
ambiguous, so it deferred to the relation the graph already held — `built_with`,
not `uses_framework` — which is what makes the contradiction land on the right
claim instead of inventing a parallel one to argue with.

**Answering is easier than parsing.** Because the system knows what it asked, the
subject and usually the predicate are already settled and only the value has to be
understood. So a one-word reply works:

```bash
npm run answer
  1. Are "new-notification-client" and "notification-client" the same thing?
  2. Is GET {notifications-service-url}/v1/notifications (called by
     notification-client) the same route as GET /v1/notifications, served by
     notifications-service?

npm run answer -- 1 "no, they are different clients"   → recorded as permanently distinct
npm run answer -- 1 "yes"                              → joined
```

That second answer is the whole point. Before it, the client's call site and the
service's route definition were unrelated records in two repositories. After one
word, the traversal runs end to end across three repos:

```
notification-client ──calls──▶ GET /v1/notifications
GET /v1/notifications ──exposes_endpoint⁻¹──▶ notifications-service
notifications-service ──reads_from──▶ notifications-db
notifications-db ──provisioned_by──▶ notifications-infra
notifications-infra ──lives_in_repo──▶ platform-terraform
```

## Three ways knowledge arrives

| Mode | `method` | Example |
|---|---|---|
| Inferred | `llm_inferred` | The agent reads the code and sees the fetch call |
| Elicited | `human` | The agent asks which service defines a route; you answer |
| Told | `human` | You say "the new client is Angular, replacing the React one" |
| Derived | `code_derived` / `telemetry` | An extractor parses Terraform, or traces are imported |

Trust weights these differently, and every claim records who asserted it.

## Three ways questions are answered

Not every question is a path:

- **Traversal** — "where does the notification list come from" → a chain across repos
- **Concept walk** — "how does authentication work" starts at a *capability*, not a
  named system, hops backwards to whatever implements it, then follows the data
- **Listing** — "what alerts are set up in AWS" is a filtered list; answering that
  with a graph walk would be perverse

## Layout

| Path | Role |
|---|---|
| `migrations/*.sql` | Schema, trust functions, edge projection |
| `src/db/` | Storage adapter — real Postgres, or PGlite in-process for tests |
| `src/domain/` | Fingerprinting, the identifying/descriptive qualifier split, predicate vocabulary, secret scanning |
| `src/resolver/` | The resolution ladder, merge/unmerge/distinct |
| `src/store/` | Ingest and scope sweeps |
| `src/query/` | Traversal, path templates, anchor finding, gap detection, rendering |
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
