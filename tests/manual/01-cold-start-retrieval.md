# Manual test 01 — cold-start retrieval

**The question:** when an agent is asked something the knowledge graph can answer,
does it *use* the graph — or does it ignore the tools and read the repository, the
way it would have before any of this existed?

This is the risk the original plan named and could not test. Every automated test
proves the machinery works; none of them prove a model reaches for it.

The test has a control and a treatment:

| Phase | What it establishes |
|---|---|
| A — populate | The graph can be filled by asking, not by running a CLI |
| B — cold ask | **Control.** Does a fresh session use the tools at all? |
| C — document | Context files get written for three date components |
| D — cold ask again | **Treatment.** Does the same question get a better answer? |

---

## The throwaway graph

Manual tests must never touch a real graph — scanning fixtures into it would
pollute it permanently and there would be no safe way to clear it.

The testing workspace carries a `.lak.json`, and the MCP server walks up from the
session's working directory to find it. So every session inside
`~/source/local/ai/ai-knowledge-testing/` reads and writes `lak_test`, while
sessions anywhere else use the personal graph. No second MCP registration, no
scope conflicts.

Every tool says which graph it is touching:

```
$ LAK_PROFILE=test npm run clear
clearing: lak_test (via LAK_PROFILE)
```

Set up the workspace and this test's fixture:

```bash
npx tsx tests/manual/lib/fixture.ts client-test      # --force to replace
LAK_PROFILE=test npx tsx src/cli/migrate.ts          # first time only
```

> Phase A still scans the REAL Reform repository — that is the point. Only the
> graph it writes into is disposable.

## What has to be running

Worth being precise, because "start the MCP server" is a reasonable thing to
assume and is not what happens.

**There is no MCP server to start.** The client launches one per session as a
subprocess, speaking JSON-RPC over stdin/stdout, and it exits when the session
does. Two Claude windows means two of them, which is fine.

**The database does have to be running.** That is the only long-lived process.
Everything the graph knows lives in PostgreSQL; each MCP subprocess connects to
it on startup.

```
  Claude Code ──spawns──▶ node src/mcp/stdio.ts ──▶ PostgreSQL  ← the only service
  (session 1)             (lives and dies with the session)      ↑
  Claude Code ──spawns──▶ node src/mcp/stdio.ts ─────────────────┘
  (session 2)
```

```bash
docker start lak-pg                      # the service
cd ~/source/local/ai/living-ai-knowledge
npm test                                 # green before trusting anything
```

**Register the MCP server for all projects** (once — not registered by default,
and without it the session in Reform has no tools at all):

```bash
claude mcp add knowledge --scope user -- \
  node /Users/codemedic42/source/local/ai/living-ai-knowledge/src/mcp/stdio.ts
```

### Permission prompts

Claude Code asks before each MCP tool, per project. With eleven tools that is a lot
of interruptions, and the prompts are not the evidence anyway — `npm run activity`
is. Allow the whole server up front:

```bash
# in the TARGET repo, not this one
jq '.permissions.allow += ["mcp__knowledge"]' .claude/settings.local.json > /tmp/s \
  && mv /tmp/s .claude/settings.local.json
```

`mcp__knowledge` covers every tool the server exposes. `.claude/settings.local.json`
is conventionally gitignored, so this does not touch the repository.

If prompts continue in a session that was already open, restart it — settings are
read at startup.

> This is a convenience, not a thumb on the scale. It changes whether you are
> *asked*, never whether Claude *chooses* the tool, which is the thing under test.

### Preflight

```bash
npm run doctor
```

Checks every dependency in the order it would break, and exits non-zero if the
test would fail for an uninteresting reason. Expect all `ok` before starting:

```
  ok    database reachable (pg) — PostgreSQL 17.11
  ok    migrations applied (19/19)
  ok    pgvector present
  ok    graph populated — 131 entities, 109 components, 249 live edges
  ok    MCP registered — knowledge - ✔ Connected
```

A `FAIL` means stop and fix. A `warn` is fine — and note that **after** phase A's
`npm run clear` the graph and embedding lines *will* warn, because the graph is
deliberately empty at that point. That is the test working, not a problem.

Run `doctor` before clearing, not after.

> Deliberately **no `CLAUDE.md` is added to Reform.** A line there saying "use the
> knowledge tools" would almost certainly make phase B pass, and would tell us
> nothing about whether the tool descriptions work on their own. Add that only
> after seeing the unaided result.

---

## Phase A — populate by asking

```bash
LAK_PROFILE=test npm run clear           # the throwaway graph now knows nothing
npx tsx tests/manual/lib/snapshot.ts 01-a-before   # records the empty starting point

cd ~/source/github.com/codemedic42/reform
claude
```

Ask, in the session — **and phrase it as you naturally would.** Do not name the
tools; whether the descriptions alone are enough is the whole point:

> Review this repository and record what you learn, so future sessions do not have
> to work it out again.

While it runs, watch which tools it calls. Claude Code shows them live; the
activity log is the durable record.

Then, in the other terminal:

```bash
cd ~/source/local/ai/living-ai-knowledge
LAK_PROFILE=test npm run activity
LAK_PROFILE=test npx tsx tests/manual/lib/snapshot.ts 01-a-after
```

**PASS** — `scan_repository` appears in the activity log, and the graph holds
roughly 100+ components.

**PARTIAL** — the graph is populated, but via many `record_observations` calls
after reading files by hand. It worked, but expensively; `scan_repository`'s
description is not doing its job.

**FAIL** — no tool calls. Claude read files and told you about them without
recording anything.

---

## Phase B — the control

**Ask from a DIFFERENT repository.** Asking about Reform from inside Reform is the
weakest form of this test: reading `projects/reactive/src/components/fields/` is
fast, accurate and current, so an agent might quite reasonably prefer grep and we
would learn nothing. From a consuming repo, Reform's source is not on disk — grep
*cannot* answer, and the graph is the only route.

That is also the real scenario: working on a client, asked to use a library you do
not own.

`client-test` is a small React app whose `package.json` depends on
`@reformjs/reactive`, with a form already using `TextField`, `SelectField` and
`Card`, and a TODO implying a need without naming a component. It has no
`node_modules`, so nothing about Reform is locally greppable.

```bash
cd ~/source/local/ai/ai-knowledge-testing/client-test
claude
```

The template lives in `fixtures/` but cannot be used from there: a session started
inside this repository resolves its project to this repository, and would see the
knowledge tool's own source as context. The script copies it out and gives it its
own git identity, so the session knows only that it consumes Reform.

Ask:

> Customers need to tell us when they are free for a callback, so this form needs a
> date range. Is there anything in the libraries we already use that I should reuse,
> and what do I need to know to use it?

Then:

```bash
LAK_PROFILE=test npm run activity
LAK_PROFILE=test npx tsx tests/manual/lib/snapshot.ts 01-b-after
```

**PASS** — the log shows at least one of `find_similar`, `ask_knowledge` or
`lookup_entity`, and the answer names a real Reform component
(`DateRangeSelectInput`, `DateSelectField`, `DateSingleSelectField`) that appears
nowhere in this repository.

**FAIL** — no tool calls. This is the outcome worth knowing about, and the one
seen in practice before now. If it fails, record **how the answer was reached**
(grep? glob? reading `index.ts`?) — that says which instinct the tool descriptions
have to beat.

Expected even on a pass: the answer stops at *"here is the file, go read it."*
Nothing has documented those components yet. That is what phase D changes.

---

## Phase C — write the context files

**Back in Reform**, since that is where the files belong — they are committed beside
the code they describe.

```bash
cd ~/source/github.com/codemedic42/reform
claude
```

> Write context files for DatePicker, DateSelectField and DateRangeSelectInput.

```bash
LAK_PROFILE=test npm run activity    # expect draft_context and write_context calls
cd ~/source/github.com/codemedic42/reform && git status --short
```

**PASS** — three `*.context.md` files appear beside their components, each with
`describes` and `generated_from` frontmatter, and the body describes props and
usage rather than restating the graph.

Then re-index so the new prose is searchable:

```bash
cd ~/source/local/ai/living-ai-knowledge
LAK_PROFILE=test npm run embed -- index
LAK_PROFILE=test npx tsx tests/manual/lib/snapshot.ts 01-c-after
```

> These files land in the Reform working tree. `git checkout` them afterwards if
> you would rather not keep them.

---

## Phase D — the treatment

New session, **back in the consuming repo**, asking **the identical phase B
question**.

```bash
cd ~/source/local/ai/contact-form-demo
claude
```

```bash
LAK_PROFILE=test npm run activity
LAK_PROFILE=test npx tsx tests/manual/lib/snapshot.ts 01-d-after
```

**PASS** — the log shows `find_similar` (or `ask_knowledge`) *followed by*
`load_context`, and the answer contains actual API detail — prop names, required
versus optional, gotchas — rather than a file path.

**The comparison that matters:** B said *"this exists, here is where."* D should
say *"this exists, here is how to use it."* If both answers are the same, the
two-tier design is not earning its keep.

---

## Recording the result

```
Date:            
Phase A:   PASS / PARTIAL / FAIL   tools used:
Phase B:   PASS / FAIL             tools used:
           if FAIL, how did it answer instead?
Phase C:   PASS / FAIL             files written:
Phase D:   PASS / FAIL             tools used:
           did the answer improve on B?  how?
Surprises:
```

Snapshots for one run: `results/01-{a,b,c,d}-*.json`.

## What each failure would mean

- **B fails, D not reached** — the tool descriptions lose to the model's instinct
  to just read files. Fix the descriptions first; a `CLAUDE.md` line is the
  fallback, but it masks the real problem rather than solving it.
- **B passes, D no better** — retrieval works and the second tier does not. Either
  `load_context` is not being chained after a hit, or the context files are too
  thin to add anything.
- **Both pass** — the design holds, and the next question is cost: how many tool
  calls and how many tokens did a good answer take?
