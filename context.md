# Lore — project context

Read this before working on Lore, and especially before touching anything in the
test fixtures.

---

## What Lore is

A cross-repository, cross-session knowledge graph that AI coding agents write to and
query, over an HTTP API and MCP.

The motivating question is one no single repository can answer:

> *"Where does the list of notifications in Client A come from?"*

Answering it means traversing a client, into a service, into another service, into a
queue, into a cache, into the Terraform that provisions it — four repositories and
some infrastructure. Followed immediately by the second question, *"how do I connect
to that database?"*

**Why it is not a file in a repo.** The idea came from watching a tool that stored
indexed repository knowledge *inside* each repository. That conflicts on every merge
and is invisible from outside the repo that holds it. Knowledge has to be a
first-class store that *references* repositories, never a file riding inside one.

### The design decisions that matter

- **Proposition / assertion split.** A proposition is the deduplicated,
  content-addressed edge. An assertion is *someone saying it* — with polarity,
  method, confidence, evidence and bi-temporal validity. Collapsing them makes
  corroboration a fuzzy row-match and refutation inexpressible.
- **Two tiers.** The graph holds **structure**: typed relations between identified
  entities, traversable. Context files (`*.context.md`, committed beside the code)
  hold **prose** a reader needs to read. Note that "crosses a boundary" is *why* the
  graph matters, not what defines its contents — intra-package composition edges
  live in the graph too.
- **Pointers, not content.** The database never stores fast-changing detail; content
  is fetched at query time.
- **Scope sweeps and predicate cardinality** close stale edges. Trust decay does
  not.
- **Embeddings pick the anchor, never a hop.**
- **Write freely, but facts decay.** Anyone may assert; time and corroboration sort
  it out.

Audience is personal now, team later — but the data model assumes multiple writers
from the start. Team deployment is designed in `docs/architecture/` and deliberately
not built.

---

## How Lore is tested

**`npm test`** — the unit and integration suite. Fast, deterministic, run it before
trusting anything.

**`tests/manual/`** — the part automated tests cannot answer:

> Does an agent actually *reach for* these tools, or ignore them and read the
> repository?

No assertion can measure that. It needs a real agent, in a real repository, with no
instruction to use the tools. That is what the manual tests are, and
`tests/manual/README.md` is their guide.

One command prepares a run:

```bash
npm run test:setup -- --testId 01
```

It is idempotent. It starts `lore-pg`, applies migrations, registers the MCP server,
writes the guard, clones any missing fixture, resets each to `origin/<branch>`,
clears the graph and takes the `before` snapshot. It **refuses** to clear anything
if a fixture would resolve to a real graph or if the leak sweep finds something in
its history, so a failed setup never destroys what you were about to look at.

Everything runs against a **separate throwaway database** (`lore_dev`), selected by
a `.lore.json` at the fixture root — outside both repositories, so nothing inside a
fixture refers to Lore. `npm run clear` defaults to the throwaway and requires
`--real --yes` to touch anything else. `tests/manual/results/` is gitignored.

---

## The fixtures

Two real repositories, outside this one:

| Repository | Is | Stands for |
|---|---|---|
| `mythos-ui-library` | `@mythos/ui-library` — nine components in a four-level composition chain | A component library you consume but do not own |
| `mythos-client` | `@mythos/client` — a small app consuming it, with no copy of its source | A client that cannot answer questions about its dependency by reading itself |

Both live under `~/mythos/`, on branch `baseline`, with the `.lore.json` guard in
`~/mythos/` itself rather than in either repository. Clone URLs and the root are in
`tests/manual/repos.json`; what each test needs is in `tests/manual/tests.json`.

They are separate repositories for two reasons. A session started inside *this*
repository resolves its project to this one, so it would have the whole knowledge
tool in context. And `load_context` checks freshness with `git log` against the
repository holding the file, which needs each fixture to have a real git identity.

---

## Modifying a fixture

> **A fixture must contain nothing that reveals it is a fixture.**

This is the rule the rest of this section exists to serve. It has been broken five
times, by five different routes, each of which looked closed after the previous fix.

### Why it is this strict

Every phase of every manual test measures whether an agent reaches for the tools
*unprompted*. A session that knows it is inside an evaluation has answered the
question for free — and a contaminated pass is indistinguishable from a genuine one,
which makes it **worse than a failure**. One run was voided after a session read the
test spec; another after it read the pass criteria out of a commit message.

### Where "it is a fixture" must never appear

Not in the README. Not in code. Not in comments. Not in identifiers. Not in commit
messages, branch names, tags, config file notes, CI configuration, or issue and PR
text. Not in `git` history, including trees that are no longer checked out.

### Code and comments specifically

The code must read as though it were written for its own sake.

- **No comment may mention** a test, a fixture, an evaluation, an extractor, Lore,
  or this repository. That includes softer tells: *"deliberately"*, *"on purpose"*,
  *"so that the scanner…"*, *"this is here to exercise…"*.
- **A component exists because the library needs it**, not because a test needs a
  four-level chain. Write the comment a library author would write: what the thing
  does and how to use it.
- **Do not name things after what they exercise.** No `HocWrappedDefault`, no
  `KebabCaseComponent`, no `fixture` or `test` in a filename that is not a real test
  file.
- **Deliberate quirks must look like house style.** The `.js` extensions on
  TypeScript imports, the HOC-wrapped default export and the kebab-case filenames
  are there because they have broken extraction before — but the README presents
  them as *conventions*, which is exactly how a real library would present them.
  Keep that framing.
- **No `TODO` or `FIXME` referring to Lore or a test.** A TODO that implies a
  missing capability is fine and useful; one that explains why the test needs it is
  not.
- **A property a test depends on is never explained.** `client` has no copy of
  the library's source, and that absence is the whole mechanism of Phase B. Saying
  so anywhere destroys it. State nothing; let the absence do its work.

### Checklist before a fixture change is pushed

1. **Commit message** — what changed in the code, nothing about why the repository
   exists. Explanatory messages belong in *this* repository, where they do no harm.
2. **Branch name** — name it for the state of the code (`baseline`, `documented`,
   `stale-context`), never for the test that uses it. `git branch -a` shows every
   branch to every session, so one bad name leaks to all tests.
3. **README** — describes the package and its stack. Nothing else.
4. **Comments and identifiers** — no awareness of being tested.
5. **`.lore.json` stays out of the repository.** The guard lives at `~/mythos/` and
   the resolver walks up to it. Never commit one into a fixture: it is a file an
   agent reads and asks about, and "why does this repository pin a database?" is one
   inference from "I am inside a test". `test:setup` fails if a fixture resolves to
   anything but the throwaway graph.
6. **History** — if leaking content ever lands in a fixture, rewriting commit
   *messages* is not enough. Trees persist, and `git show <old>:README.md` returns
   the content verbatim. Collapse the history instead. A fixture's history is not a
   record worth keeping; the only thing it can do is leak.
7. **Sweep every blob**, not just the tips:

   ```bash
   git rev-list --objects --all | awk '{print $1}' | while read o; do
     [ "$(git cat-file -t $o)" = blob ] && git cat-file -p $o
   done | grep -icE 'fixture|manual test|pass criteri|knowledge graph|throwaway|contaminat|absence is the test|extraction'
   ```

   Zero is the only passing number. Do not add a bare `lore` to that pattern —
   `.lore.json` legitimately contains its own connection string, so the check would
   never pass and you would learn to ignore it.

### If a leak is found mid-run

Void the phase — do not score it. Record what leaked in
`tests/manual/results/`, close the route, and rerun in a fresh session. Detection
should not depend on the agent volunteering it, so the spec carries a transcript
grep; run it after every phase.

---

## Current state

The walking skeleton works and the kill criterion passed early: an agent can
populate the graph by being asked, and traversal answers the motivating query on
real code.

Two confirmed defects, both found by a fixture session rather than by the suite:

1. **Duplicate entities across kind families.** `KIND_FAMILY` puts `component` in
   `unit` and `capability` in `concept`, and resolution never merges across
   families — so an agent that calls `TextField` a capability mints a twin, with
   only a warning. This is the cost of the fix that stopped `App` over-merging into
   `app`: over-merging traded for under-merging.
2. **Written but unreadable.** No traversal template walks `built_with`,
   `written_in`, `tests_with` or `lints_with`, *and* `entityFacts` filters on
   `object_literal is not null`, which drops every entity-valued object. Together
   the write succeeds, reports `0 rejected`, and the fact is unreachable by any tool
   shape. Writes that silently vanish on read are the worst failure a knowledge
   store can have.

One open design problem: **three stores claim the same job.** The graph, context
files, and Claude Code's own session memory all advertise "durable, survives
sessions," and nothing adjudicates between them — so agents stop and ask where a
fact belongs. The likely fix is a single `record` entry point that routes on the
*shape* of what it is handed (a relation → the graph; prose about one entity → a
context file draft; anything about the user → neither) and reports where each item
landed, so the agent learns the taxonomy from feedback rather than from a
description.
