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

## Prerequisites

```bash
docker start lak-pg                      # or the pgvector run command in the README
cd ~/source/local/ai/living-ai-knowledge
npm test                                 # should be green before trusting anything
```

**Register the MCP server for all projects** (once — it is not registered by
default, and without it the session in Reform has no tools at all):

```bash
claude mcp add knowledge --scope user -- \
  node /Users/codemedic42/source/local/ai/living-ai-knowledge/src/mcp/stdio.ts

claude mcp list          # expect: knowledge - ✔ Connected
```

> Deliberately **no `CLAUDE.md` is added to Reform.** A line there saying "use the
> knowledge tools" would almost certainly make phase B pass, and would tell us
> nothing about whether the tool descriptions work on their own. Add that only
> after seeing the unaided result.

---

## Phase A — populate by asking

```bash
npm run clear                            # the graph now knows nothing
npx tsx tests/manual/lib/snapshot.ts 01-a-before

cd ~/source/github.com/codemedic42/reform
claude
```

Ask, in the session:

> Review this repository and record what you learn, so future sessions do not have
> to work it out again.

Then, in the other terminal:

```bash
cd ~/source/local/ai/living-ai-knowledge
npm run activity
npx tsx tests/manual/lib/snapshot.ts 01-a-after
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

Start a **new** session (`/exit`, then `claude` again) so nothing is carried over
in context. Ask:

> I need to add a date range picker to a form in this codebase. Is there anything
> that already exists I should reuse, and what do I need to know to use it?

Then:

```bash
npm run activity
npx tsx tests/manual/lib/snapshot.ts 01-b-after
```

**PASS** — the log shows at least one of `find_similar`, `ask_knowledge` or
`lookup_entity`, and the answer names real components (`DateSelectField`,
`DatePicker`, `DateRangeSelectInput`).

**FAIL** — no tool calls. This is the outcome worth knowing about, and the one
seen in practice before now. If it fails, record **how the answer was reached**
(grep? glob? reading `index.ts`?) — that says which instinct the tool descriptions
have to beat.

Expected even on a pass: the answer stops at *"here is the file, go read it."*
Nothing has documented those components yet. That is what phase D changes.

---

## Phase C — write the context files

Same or new session, in Reform:

> Write context files for DatePicker, DateSelectField and DateRangeSelectInput.

```bash
npm run activity          # expect draft_context and write_context calls
cd ~/source/github.com/codemedic42/reform && git status --short
```

**PASS** — three `*.context.md` files appear beside their components, each with
`describes` and `generated_from` frontmatter, and the body describes props and
usage rather than restating the graph.

Then re-index so the new prose is searchable:

```bash
cd ~/source/local/ai/living-ai-knowledge
npm run embed -- index
npx tsx tests/manual/lib/snapshot.ts 01-c-after
```

> These files land in the Reform working tree. `git checkout` them afterwards if
> you would rather not keep them.

---

## Phase D — the treatment

New session again. Ask **the identical phase B question**.

```bash
npm run activity
npx tsx tests/manual/lib/snapshot.ts 01-d-after
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
