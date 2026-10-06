# Manual tests

Things that cannot be asserted in CI because they depend on how a language model
actually behaves in a live session. Each test has explicit pass criteria and leaves
evidence in `results/`, so a re-run is comparable rather than a fresh impression.

| Test | Question it answers | Branch |
|---|---|---|
| [01 — cold-start retrieval](./01-cold-start-retrieval.md) | Does an agent *use* these tools, or just read the repo? | `baseline` |

**Everything in this file applies to every test.** A test document covers only its
own question, phases and pass criteria.

## Why these exist

The original plan named a risk it could not test: agents might never write to the
graph, or never read from it, no matter how good the schema is. Everything in
`test/` verifies the machinery works. Nothing there verifies that a model reaches
for it — and a model that ignores the tools makes all of it worthless.

---

## Preparing a run

One command, idempotent, run it as often as you like:

```bash
npm run test:setup -- --testId 01
```

In order, it:

1. starts `lore-pg`, creating the container if it does not exist, and waits for
   Postgres to *accept connections* rather than merely be up;
2. creates `lore_test` if missing and applies migrations;
3. registers the `knowledge` MCP server at user scope, or re-points it if it refers
   to an older checkout;
4. writes the `~/mythos/.lore.json` guard;
5. clones any missing fixture, then resets each to `origin/<branch>` with
   `git clean -fdx` — `-x` matters, because a stray `node_modules` in the client
   would let a session answer questions about the library by reading it;
6. **refuses to continue** if a fixture resolves to anything but the throwaway
   graph, or if the leak sweep finds anything in its history;
7. clears the graph and takes the `before` snapshot — but only if every check
   passed, so a failed setup never destroys the graph you were about to inspect.

Exit status is non-zero on any failure, and the output names the offending commit,
file, line and text.

What each test needs is declared in [`tests.json`](./tests.json); the repositories
and their root are in [`repos.json`](./repos.json).

For the smaller job of putting a repository back mid-test, `test:reset` touches git
and nothing else:

```bash
npm run test:reset -- --branch=baseline
npm run test:reset                  # reset whatever is checked out
```

### Preflight

`test:setup` checks the environment it controls. These check what it does not — the
code itself, and a broader read of the graph's health:

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

A `FAIL` means stop. Empty-graph warnings are correct before a run.

---

## What has to be running

Worth being precise, because "start the MCP server" is a reasonable assumption and
is not what happens.

**There is no MCP server to start.** The client launches one per session as a
subprocess over stdin/stdout, and it exits when the session does. Two Claude windows
means two of them, which is fine.

**The database does have to be running.** It is the only long-lived process.

```
  Claude Code ──spawns──▶ node src/mcp/stdio.ts ──▶ PostgreSQL  ← the only service
  (session 1)             (lives and dies with the session)      ↑
  Claude Code ──spawns──▶ node src/mcp/stdio.ts ─────────────────┘
  (session 2)
```

`test:setup` does the equivalent of this on every run. It is spelled out because
knowing what it does is what lets you fix it when it fails:

```bash
docker start lore-pg                 # setup creates the container if it is absent

claude mcp add knowledge --scope user -- \
  node /Users/codemedic42/source/github.com/codemedic42/lore/src/mcp/stdio.ts

LORE_PROFILE=test npx tsx src/cli/migrate.ts        # the throwaway schema
```

User scope, not project scope: the whole point is asking about repositories you are
*not* in, so a per-project registration would defeat it.

### Permissions

The six read-only tools declare `readOnlyHint`, so a client can tell them from the
writes and need not prompt. Allowing them once in `~/.claude/settings.json` removes
the remaining friction:

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

> This changes whether you are *asked*, never whether Claude *chooses* a tool, which
> is the thing under test.

Expect prompts anyway for shell loops. A command whose paths the parser cannot prove
in-tree — anything with a variable, like `cat "$f"` — is escalated to you by
`blockReadsOutsideWorkingDirectories`. Read the file list before approving; approving
a run of them in a row is how the first leak got through.

---

## The throwaway graph

Manual tests must never touch a real graph. Scanning fixtures into one pollutes it
permanently, and the hand-written observations it already holds are not something a
re-scan restores.

Three things make that hard to get wrong by accident:

- the fixture root `~/mythos/` carries a `.lore.json`, and the resolver walks up from
  the session's working directory to find it, so every session under that tree uses
  the throwaway graph. It sits **outside** both repositories on purpose: a committed
  guard is a file an agent reads and asks about, and "why does this repository pin a
  database?" is one inference from "I am inside a test". `test:setup` refuses to
  proceed if a fixture resolves anywhere else;
- `npm run clear` defaults to the throwaway graph; emptying a real one needs
  `--real --yes` and says what it would destroy first;
- the `test:*` scripts carry the profile, so there is no environment variable to
  remember.

Every command states its target before acting:

```
$ npm run clear
clearing: lore_test (via LORE_PROFILE)
(the throwaway graph — pass --real --yes to empty a real one)
```

---

## The fixtures

Separate repositories, cloned under `~/mythos/` by `test:setup`:

| | |
|---|---|
| [`mythos-ui-library`](https://github.com/CodeMedic42/mythos-ui-library) | `@mythos/ui-library` — a component library you consume but do not own |
| [`mythos-client`](https://github.com/CodeMedic42/mythos-client) | `@mythos/client` — a client consuming it, with no copy of its source |

Each is **its own source of truth**. There is no template to keep in sync: git is
the reset mechanism, and branches are how scenarios vary. Adjust `root` in
`repos.json` if you keep them somewhere else.

They are deliberately small. A real repository is a better test of whether
extraction survives reality, and a worse test of everything else — too many
components to hold in your head, and no way to tell a wrong answer from an
unfamiliar one.

They live outside this repository for two reasons. A Claude session started inside
this one resolves its project to this one, so a test that depends on the session
knowing nothing would quietly have the whole knowledge tool in context. And
`load_context` checks freshness with `git log` against the repository holding the
file, which needs each fixture to have a real git identity.

### Branches are named for the code's state

A branch fixes the starting state a test's pass criteria were written against;
`main` drifts as the fixtures gain components for later tests.

| Branch | State of the fixture | Used by |
|---|---|---|
| `baseline` | Undocumented. No context files, nothing recorded. | [01](./01-cold-start-retrieval.md) |

**Name a branch for the state of the code, never for the test that uses it.**
`git branch -a` lists every branch to every session, so one descriptively-named
branch leaks to all tests, not just its own — a session running test 01 could read
test 02's hypothesis straight off the branch list. `baseline`, `documented` and
`stale-context` are honest descriptions of code states that give nothing away.
`01-cold-start-retrieval` named the hypothesis, which is why it was renamed.

Several tests may share one branch; the table is the mapping, not the branch name.

**Push a scenario branch.** It is part of the test: a branch that exists only
locally would silently fall back to `main` on another machine, and the test would
then be measuring a different starting state than the one it documents.

A test that dirties a repository — writing context files, say — is undone by
resetting, as long as the changes are not committed. A fix the repositories
genuinely need is committed to the relevant branch.

---

## Contamination

Every phase of every test measures whether a session reaches for the tools
*unprompted*. **A session that has read the test document has answered the question
for free**, and a contaminated pass is indistinguishable from a real one — which
makes it worse than a failure.

After each phase, grep that fixture's session transcript:

```bash
slug=-Users-codemedic42-mythos-mythos-ui-library   # or -mythos-client
latest=$(ls -t ~/.claude/projects/$slug/*.jsonl | head -1)
grep -c 'tests/manual\|cold-start-retrieval' "$latest"
```

Zero is the only passing number. It reads only the newest transcript, because a
contaminated one stays on disk and would otherwise fail every later run.

A non-zero count **voids that phase**. Record it in `results/` and rerun in a fresh
session rather than scoring it.

> Deliberately **no `CLAUDE.md` is added to either fixture.** A line saying "use the
> knowledge tools" would make the retrieval phases pass and tell us nothing about
> whether the tool descriptions work unaided. Add that only after seeing an unaided
> result.

### Separate repositories are not isolation

Living outside this repository stops a fixture inheriting this project's context. It
does nothing to stop a session going and finding it. Isolation is a property of what
the fixtures *say*, not of where they sit — and the fixtures sit one directory from
a document that explains every pass criterion.

`blockReadsOutsideWorkingDirectories` does cover Bash, escalating any command it
cannot prove in-tree, so the guard is real. But its strength is however those
prompts get answered, which makes the human the weak link. That is an argument for
the fixtures carrying nothing worth reading rather than for tighter settings.

**So write a fixture as if the test did not exist.** It describes its own code and
nothing else. Anything that would help a session guess what is being measured
belongs in this directory instead. The operative rules are in
[`context.md`](../../context.md).

### Leak surface: audit all of it, not just the files

Three runs leaked by three different routes, each of which looked closed after the
previous fix:

| Surface | How it leaked | Status |
|---|---|---|
| `README.md` | Named this repository and described the test's design | scrubbed |
| `.lore.json` `note` | Narrated "test fixture… throwaway graph" | moved out of the repos |
| Branch names | `01-cold-start-retrieval` stated the hypothesis, and `git branch -a` shows every branch | renamed to `baseline` |
| **Commit messages** | The commit that removed the README pointer explained in full what it removed, and the original commits called themselves fixtures | history rewritten |
| **Historical file content** | Rewriting *messages* preserved every tree, so `git show <old>:README.md` still returned the original README verbatim — the client's included "must have come from the knowledge graph" | history collapsed |
| Reflog, remote-tracking refs | Kept old objects reachable via `git log --all` until the force push landed | expired and pruned |
| Scaffold commit, stale `main` | GitHub's initial commit still held a README naming the old `lore-testing-*` repository, and `commit --amend` moves only the checked-out branch, so `main` kept the pre-amend commit — and the push propagated it | both rewritten |

Two lessons worth stating outright, because each cost a run:

**`git log` is among the first things a reviewing session runs.** It found the commit
messages unprompted. So commit messages in a fixture must be boring: what changed in
the code, nothing about why the repository exists. Explanatory messages belong in
*this* repository, where they do no harm.

**Scrubbing a file does not scrub its history.** Rewriting messages while preserving
trees leaves every earlier version of every file one `git log -p` away. Each fixture
is therefore collapsed to two commits — the scaffold, and one holding the current
clean tree — so no intermediate state exists to read. A fixture's history is not a
record worth keeping; the only thing it can do is leak.

`test:setup` runs the sweep on every run and refuses to proceed on a hit, so this is
a gate rather than a habit. The pattern lives in `lib/fixtures.ts` as `LEAK_PATTERN`.
To check by hand:

```bash
git grep -I -i -E 'fixture|manual test|knowledge graph|throwaway|lore[-_]|@acme' $(git rev-list --all)
git log --all --format='%B' | grep -icE 'fixture|manual test|knowledge graph'
```

Searching every commit matters more than searching the tip: a scrub of the working
tree leaves everything behind.

---

## Layout

| Path | What it is |
|---|---|
| `NN-*.md` | A test — its question, phases, pass criteria and results template |
| `tests.json` | What each test needs: branch, repositories, graph state, snapshot |
| `repos.json` | The fixtures, their clone URLs, and the root they live under |
| `lib/setup.ts` | `test:setup` — prepares everything, gates on safety and leaks |
| `lib/reset.ts` | `test:reset` — git-only reset between phases |
| `lib/fixtures.ts` | Shared helpers, including the leak sweep |
| `lib/snapshot.ts` | Records graph counts and tool history per phase |
| `results/` | Per-run evidence — gitignored |

`results/` is gitignored. Snapshots are evidence for one run, not project history.
