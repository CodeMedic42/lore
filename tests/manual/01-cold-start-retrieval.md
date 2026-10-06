# Manual test 01 — cold-start retrieval

**The question:** when an agent is asked something the knowledge graph can answer,
does it *use* the graph — or ignore the tools and read the repository, the way it
would have before any of this existed?

> Read [`README.md`](./README.md) first. Setup, permissions, the throwaway graph,
> the fixtures and the contamination check are shared by every test and are not
> repeated here.

A control and a treatment:

| Phase | Where | What it establishes |
|---|---|---|
| A — populate | `ui-library` | The graph can be filled by asking, not by running a CLI |
| B — cold ask | `client` | **Control.** Does a fresh session use the tools at all? |
| C — document | `ui-library` | Context files get written for three components |
| D — cold ask again | `client` | **Treatment.** Does the same question get a better answer? |

B and D ask the **identical question** from a repository that has no copy of the
library's source. That is the point: grep cannot answer it, so anything the agent
produces must have come from the graph.

## What this test assumes

Branch `baseline` in both fixtures — undocumented, nothing recorded, no context
files. Phase B is only meaningful against that starting state.

| Repository | What matters here |
|---|---|
| `mythos-ui-library` | `Button` `Card` `Calendar` `CalendarDay` `DateRangeSelector` `DateSelector` `FieldLabel` `HelperText` `TextField`, in a four-level chain: `DateRangeSelector → DateSelector → TextField → FieldLabel` |
| `mythos-client` | A form using `Card`, `TextField` and `Button`, with a TODO implying a need for date selection without naming a component. No `node_modules`, no copy of the library's source |

```bash
npm run test:setup -- --testId 01
```

---

## Phase A — populate by asking

```bash
cd ~/mythos/mythos-ui-library
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
> that loads itself for free. It may also ask what to do about code that
> contradicts its own doc comments: **report, do not fix**, since changing `src/`
> would move the ground under B and D.

---

## Phase B — the control

A different repository, with no copy of the library's source. Grep **cannot**
answer this, so whatever comes back came from the graph.

```bash
cd ~/mythos/mythos-client
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
cd ~/mythos/mythos-ui-library
claude
```

> Write context files for DateRangeSelector, DateSelector and TextField.

```bash
npm run test:activity                   # expect draft_context and write_context
cd ~/mythos/mythos-ui-library && git status --short
```

**PASS** — three `*.context.md` files beside their components, each with `describes`
and `generated_from` frontmatter, and bodies describing props, defaults and gotchas
rather than restating what the graph already holds.

Re-index so the new prose is searchable:

```bash
cd ~/source/github.com/codemedic42/lore
npm run test:embed -- index
npm run test:snapshot -- 01-c-after
```

> These land on `baseline`, which must stay undocumented for phase B to mean
> anything. Undo with `npm run test:reset -- --branch=baseline`. For a scenario that
> *starts* documented, commit them to a branch of their own — `documented`, say.

---

## Phase D — the treatment

A new session in the consuming repository, asking **the identical phase B
question**.

```bash
cd ~/mythos/mythos-client
claude
```

```bash
npm run test:activity
npm run test:snapshot -- 01-d-after
```

**PASS** — `find_similar` (or `ask_knowledge`) *followed by* `load_context`, and an
answer containing real API detail: prop names, which are required, what the gotchas
are. Not a file path.

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
Contamination grep, per phase:     (zero, or the phase is void)
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
