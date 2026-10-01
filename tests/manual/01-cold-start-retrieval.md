# Manual test 01 — cold-start retrieval

**The question:** when an agent is asked something the knowledge graph can answer,
does it *use* the graph — or ignore the tools and read the repository, the way it
would have before any of this existed?

This is the risk the original plan named and could not test. Every automated test
proves the machinery works; none of them prove a model reaches for it.

A control and a treatment:

| Phase | Where | What it establishes |
|---|---|---|
| A — populate | `library-ui` | The graph can be filled by asking, not by running a CLI |
| B — cold ask | `app-client` | **Control.** Does a fresh session use the tools at all? |
| C — document | `library-ui` | Context files get written for three components |
| D — cold ask again | `app-client` | **Treatment.** Does the same question get a better answer? |

B and D ask the **identical question** from a repository that has no copy of the
library's source. That is the point: grep cannot answer it, so anything the agent
produces must have come from the graph.

---

## The two repositories

Two standalone repositories, listed in [`repos.json`](./repos.json):

| | |
|---|---|
| **`lore-testing-library-ui`** | `@acme/ui-kit` — `Button` `Card` `Calendar` `CalendarDay` `DateRangeSelector` `DateSelector` `FieldLabel` `HelperText` `TextField`, in a four-level chain: `DateRangeSelector → DateSelector → TextField → FieldLabel` |
| **`lore-testing-app-client`** | `@acme/contact-form` — a form using `Card`, `TextField` and `Button`, with a TODO implying a need for date selection without naming a component. No `node_modules`, no copy of the library's source. |

Each is its own source of truth.

**This test runs on the `01-cold-start-retrieval` branch of both repositories** —
one branch per test, named after it. The branch is what fixes the starting state:
`main` drifts as the fixtures gain components, while a test's branch stays at the
state its pass criteria were written against. Right now the branch is identical to
`main`; it diverges the first time a fixture changes for some other test's benefit.

```bash
npm run test:reset -- --branch=01-cold-start-retrieval
```

That discards any changes, removes untracked files, and reports which graph each
repository would use — plus a warning if a branch has no upstream, since one that
exists only locally would silently fall back to `main` on another machine.

Adjust the paths in `repos.json` if you clone them somewhere other than
`~/source/github.com/codemedic42/`.

The library is deliberately small. A real repository is a better test of whether
the extractor survives reality, and a worse test of everything else — too many
components to hold in your head, and no way to tell a wrong answer from an
unfamiliar one.

---

## The throwaway graph

Manual tests must never touch a real graph. Scanning fixtures into one pollutes it
permanently, and the hand-written observations it already holds are not something a
re-scan restores.

Three things make that hard to get wrong by accident:

- each test repository commits its own `.lore.json`, so any session inside it uses
  the throwaway graph wherever it is cloned — `test:reset` reports which graph each
  repository would use, so a missing one is visible rather than silent
- `npm run clear` defaults to the throwaway graph; emptying a real one needs
  `--real --yes` and says what it would destroy first
- the `test:*` scripts carry the profile, so there is no environment variable to
  remember

Every command states its target before acting:

```
$ npm run clear
clearing: lore_test (via LORE_PROFILE)
(the throwaway graph — pass --real --yes to empty a real one)
```

---

## What has to be running

Worth being precise, because "start the MCP server" is a reasonable assumption and
is not what happens.

**There is no MCP server to start.** The client launches one per session as a
subprocess over stdin/stdout, and it exits when the session does. Two Claude
windows means two of them, which is fine.

**The database does have to be running.** It is the only long-lived process.

```
  Claude Code ──spawns──▶ node src/mcp/stdio.ts ──▶ PostgreSQL  ← the only service
  (session 1)             (lives and dies with the session)      ↑
  Claude Code ──spawns──▶ node src/mcp/stdio.ts ─────────────────┘
  (session 2)
```

### One-time setup

```bash
docker start lore-pg

claude mcp add knowledge --scope user -- \
  node /Users/codemedic42/source/github.com/codemedic42/lore/src/mcp/stdio.ts

LORE_PROFILE=test npx tsx src/cli/migrate.ts        # create the throwaway schema
```

User scope, not project scope: the whole point is asking about repositories you are
*not* in, so a per-project registration would defeat it.

### Permissions

The six read-only tools declare `readOnlyHint`, so a client can tell them from the
writes and need not prompt for them. Allowing them once in `~/.claude/settings.json`
removes the remaining friction:

```json
"permissions": {
  "allow": [
    "mcp__knowledge__ask_knowledge",
    "mcp__knowledge__lookup_entity",
    "mcp__knowledge__find_similar",
    "mcp__knowledge__load_context",
    "mcp__knowledge__draft_context",
    "mcp__knowledge__pending_questions"
  ]
}
```

Writes — `record_observations`, `record_statement`, `answer_question`,
`scan_repository`, `write_context` — still prompt, which is correct: they change
shared state or write files.

> This changes whether you are *asked*, never whether Claude *chooses* a tool,
> which is the thing under test.

### Preflight

```bash
npm test                 # green before trusting anything
npm run test:doctor      # exits non-zero on anything fatal
```

```
  graph:  lore_test (via LORE_PROFILE)
  ok    database reachable (pg) — PostgreSQL 17.11
  ok    migrations applied (21/21)
  ok    pgvector present
  ok    MCP registered — knowledge - ✔ Connected
  warn  graph is empty — nothing to retrieve yet
```

A `FAIL` means stop. The empty-graph warnings are correct at this point.

> Deliberately **no `CLAUDE.md` is added to either test repository.** A line saying
> "use the knowledge tools" would almost certainly make phase B pass and tell us
> nothing about whether the tool descriptions work unaided. Add that only after
> seeing the unaided result.

### Contamination

Every phase here measures whether a session reaches for the tools *unprompted*, so
a session that has read this file has answered the question for free. Phase A's
criterion is "`scan_repository` appears in the log"; a session that read that
sentence will produce it. The phase is then void, not merely weakened.

This has already happened once. The fixture READMEs named this repository, a review
session followed the pointer to a sibling checkout, and read Phase A's pass
criteria. The READMEs no longer mention it — see the note on fixture isolation in
`tests/manual/README.md` — but the fixtures sit one directory from this file and a
shell command can still reach it, so check rather than assume.

After each phase, grep that fixture's session transcript:

```bash
slug=-Users-codemedic42-source-github-com-codemedic42-lore-testing-library-ui   # or -app-client
latest=$(ls -t ~/.claude/projects/$slug/*.jsonl | head -1)
grep -c 'tests/manual\|01-cold-start-retrieval\.md' "$latest"
```

Zero is the only passing number. Two details matter in that command. It reads only
the newest transcript, because a contaminated one stays on disk and would otherwise
fail every later run. And it matches `01-cold-start-retrieval.md` with the
extension, because the scenario *branch* carries the same name and a session running
`git branch` is harmless.

A non-zero count voids that phase. Record it in `results/` and rerun the phase in a
fresh session rather than scoring it — a contaminated pass is indistinguishable from
a real one, which makes it worse than a failure.

---

## Phase A — populate by asking

```bash
npm run test:reset -- --branch=01-cold-start-retrieval   # known starting state
npm run clear                                            # the graph knows nothing
npm run test:snapshot -- 01-a-before

cd ~/source/github.com/codemedic42/lore-testing-library-ui
claude
```

Ask it as you naturally would. Do not name the tools — whether the descriptions
alone are enough is the whole point:

> Review this repository and record what you learn, so future sessions do not have
> to work it out again.

Watch which tools it calls while it runs; the activity log is the durable record.

```bash
cd ~/source/github.com/codemedic42/lore
npm run test:activity
npm run test:snapshot -- 01-a-after
```

**PASS** — `scan_repository` in the log, and the graph holds nine components with
the composition chain intact.

**PARTIAL** — the graph is populated, but through many `record_observations` calls
after reading files by hand. It worked, expensively; `scan_repository`'s description
is not doing its job.

**FAIL** — no tool calls. It read files and told you about them without recording
anything.

> It may ask where knowledge should go — Claude Code keeps its own per-project
> memory, and the server instructions do not yet state the boundary. Answer
> **knowledge graph only**, so phase B measures the graph rather than a memory file
> that loads itself for free.

---

## Phase B — the control

A different repository, with no copy of the library's source. Grep **cannot**
answer this, so whatever comes back came from the graph.

```bash
cd ~/source/github.com/codemedic42/lore-testing-app-client
claude
```

> Customers need to tell us when they are free for a callback, so this form needs a
> date range. Is there anything in the libraries we already use that I should reuse,
> and what do I need to know to use it?

```bash
npm run test:activity
npm run test:snapshot -- 01-b-after
```

**PASS** — the log shows `find_similar`, `ask_knowledge` or `lookup_entity`, and
the answer names `DateRangeSelector`, which appears nowhere in this repository.

**FAIL** — no tool calls. If so, record **how it answered instead** — grep? glob?
reading `package.json`? That says which instinct the descriptions have to beat.

Two things to watch even on a pass:

- **Does it chain?** Finding the name is half of it; `find_similar` → `load_context`
  is the behaviour the two-tier design depends on.
- **Expect it to stop at "here is the file."** Nothing is documented yet, so
  `load_context` returns `no_context_file` with an absolute path. That gap is what
  phase D measures.

---

## Phase C — write the context files

Back in the library, because that is where the files belong — beside the code they
describe.

```bash
cd ~/source/github.com/codemedic42/lore-testing-library-ui
claude
```

> Write context files for DateRangeSelector, DateSelector and TextField.

```bash
npm run test:activity                   # expect draft_context and write_context
cd ~/source/github.com/codemedic42/lore-testing-library-ui && git status --short
```

**PASS** — three `*.context.md` files beside their components, each with
`describes` and `generated_from` frontmatter, and bodies describing props, defaults
and gotchas rather than restating what the graph already holds.

Re-index so the new prose is searchable:

```bash
cd ~/source/github.com/codemedic42/lore
npm run test:embed -- index
npm run test:snapshot -- 01-c-after
```

> These land in `lore-testing-library-ui` on the test's branch. Undo with
> `npm run test:reset -- --branch=01-cold-start-retrieval`. If you want a scenario
> that *starts* documented, commit them to a branch of their own — `02-…` or
> similar — rather than to this test's branch, which must stay undocumented for
> phase B to mean anything.

---

## Phase D — the treatment

A new session in the consuming repository, asking **the identical phase B
question**.

```bash
cd ~/source/github.com/codemedic42/lore-testing-app-client
claude
```

```bash
npm run test:activity
npm run test:snapshot -- 01-d-after
```

**PASS** — `find_similar` (or `ask_knowledge`) *followed by* `load_context`, and an
answer containing real API detail: prop names, which are required, what the
gotchas are. Not a file path.

**The comparison that matters:** B said *"this exists, here is where."* D should say
*"this exists, here is how to use it."* If the two answers are the same, the
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

Snapshots for the run: `results/01-{a,b,c,d}-*.json`.

## What each outcome would mean

- **B fails** — the descriptions lose to the instinct to read files. Fix the
  descriptions first. A `CLAUDE.md` line is the fallback, but it masks the problem
  rather than solving it.
- **B passes, D no better** — retrieval works and the second tier does not. Either
  `load_context` is not being chained after a hit, or the context files are too thin
  to add anything.
- **Both pass** — the design holds, and the next question is cost: how many tool
  calls and how many tokens did a good answer take, against reading the files?
