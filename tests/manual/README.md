# Manual tests

Things that cannot be asserted in CI because they depend on how a language model
actually behaves in a live session. Each one has explicit pass criteria and leaves
evidence in `results/`, so a re-run is comparable rather than a fresh impression.

| Test | Question it answers |
|---|---|
| [01 — cold-start retrieval](./01-cold-start-retrieval.md) | Does an agent *use* these tools, or just read the repo? |

## Why these exist

The original plan named a risk it could not test: agents might never write to the
graph, or never read from it, no matter how good the schema is. Everything in
`test/` verifies the machinery works. Nothing there verifies that a model reaches
for it — and a model that ignores the tools makes all of it worthless.

## The throwaway graph

Nothing here touches a real graph. The testing workspace at
`~/source/local/ai/ai-knowledge-testing/` carries a `.lore.json`, and the MCP server
walks up from the session's working directory to find it — so every session inside
that tree reads and writes `lore_test`, and sessions anywhere else use the personal
database. Clear it with `LORE_PROFILE=test npm run clear`.

Every command prints which graph it is touching before acting on it.

## Layout

| Path | What it is |
|---|---|
| `01-*.md` | The test itself — steps, pass criteria, a results template |
| `lib/snapshot.ts` | Records graph counts and tool history per phase |
| `lib/reset.ts` | Returns the test repositories to a clean state between runs |
| `results/` | Per-run evidence — gitignored |

## The test repositories

Separate repositories, listed in [`repos.json`](./repos.json):

| | |
|---|---|
| [`lore-testing-library-ui`](https://github.com/CodeMedic42/lore-testing-library-ui) | A component library you consume but do not own |
| [`lore-testing-app-client`](https://github.com/CodeMedic42/lore-testing-app-client) | A client consuming it, with no copy of its source |

Each is **its own source of truth**. There is no template to keep in sync: git is
the reset mechanism, and branches are how scenarios vary.

### Branches are named for the code's state

A branch fixes the starting state a test's pass criteria were written against;
`main` drifts as the fixtures gain components for later tests.

| Branch | State of the fixture | Used by |
|---|---|---|
| `baseline` | Undocumented. No context files, nothing recorded. | [01 — cold-start retrieval](./01-cold-start-retrieval.md) |

**Name a branch for the state of the code, never for the test that uses it.**
`git branch -a` lists every branch to every session in the repository, so one
descriptively-named branch leaks to all tests, not just its own — a session running
test 01 could read test 02's hypothesis straight off the branch list. `baseline`,
`documented` and `stale-context` are honest descriptions of code states that give
nothing away. `01-cold-start-retrieval` named the hypothesis, which is why it was
renamed.

Several tests may share one branch; the table above is the mapping, not the branch
name.

```bash
npm run test:reset -- --branch=baseline
npm run test:reset -- --clone       # fetch any repository that is missing
npm run test:reset                  # reset whatever is checked out
```

Reset discards changes, removes untracked files, and reports two things worth
knowing before a run: which graph each repository would use, and whether its branch
has an upstream. A branch that exists only locally would silently fall back to
`main` on another machine, and the test would then be measuring a different
starting state than the one it documents.

**Push a scenario branch.** It is part of the test.

Each commits its own `.lore.json`, so a session inside it uses the throwaway graph
wherever it is cloned. `test:reset` reports which graph each would use, so a
repository missing that file is visible rather than silently writing to a real
graph.

A test that dirties a repository — phase C writes context files into
`library-test` — is undone by resetting, as long as the changes are not committed.
A fix the repositories genuinely need is committed to the relevant branch.

They must live outside this repository for two reasons. A Claude session started
inside this one resolves its project to this one, so a test that depends on the
session knowing nothing would quietly have the whole knowledge tool in context. And
`load_context` checks freshness with `git log` against the repository holding the
file, which needs each fixture to have a real git identity of its own.

**Separate repositories are not isolation.** Living outside this one stops a
fixture from inheriting this project's context. It does nothing to stop a session
from going and finding it. The first attempt at test 01 leaked exactly that way:
the fixture READMEs named this repository, a review session followed the pointer to
a sibling checkout, and read Phase A's pass criteria. It reported the contamination
itself, which is the only reason that run was not scored as a pass.

Isolation here is therefore a property of what the fixtures *say*, not of where
they sit.

**Correction to an earlier claim in this file.** It used to say
`blockReadsOutsideWorkingDirectories` gates the file tools but not `cat` under
Bash. That is wrong. The setting does cover Bash: a command whose paths the shell
parser cannot prove in-tree — anything with a variable, like `cat "$f"` — is
escalated to the person running the test rather than allowed. So the guard is real,
and its strength is however those prompts get answered. The original leak most
likely went through an approved prompt during a run where several were approved in a
row, not through an ungated tool.

That makes the human the weak link, which is an argument for the fixtures carrying
nothing worth reading rather than for tighter settings. What holds is that nothing
inside a fixture gives a session a reason to look: no pointer to this repository, no
account of what a phase measures, and no mention of the graph beyond the
`.lore.json` the safety guard needs.

**So write a fixture as if the test did not exist.** A fixture describes its own
code and nothing else. Anything that would help a session guess what is being
measured belongs in this directory instead.

### Leak surface: audit all of it, not just the files

Three separate runs leaked by three different routes, each of which looked closed
after the previous fix. The fixtures carry text in more places than a scrub of the
working tree reaches:

| Surface | How it leaked | Status |
|---|---|---|
| `README.md` | Named this repository and described the test's design | scrubbed |
| `.lore.json` `note` | Narrated "test fixture… throwaway graph" | neutralised |
| Branch names | `01-cold-start-retrieval` stated the hypothesis, and `git branch -a` shows every branch | renamed to `baseline` |
| **Commit messages** | The commit that removed the README pointer explained in full what it removed, and the original fixture commits called themselves fixtures and described what the test measures | history rewritten |
| Reflog, remote-tracking refs | Kept the old messages reachable after the rewrite, via `git log --all` | expired and pruned |

`git log` is among the first things a reviewing session runs — it found the commit
messages unprompted. **Before a run, check every surface in that table, not just the
files.** Tags, CI config, issue templates and PR descriptions belong in it too the
moment a fixture gains any.

Commit messages in the fixtures must therefore be boring: what changed in the code,
nothing about why the repository exists. Explanatory messages belong in *this*
repository, where they do no harm.

`results/` is gitignored. Snapshots are evidence for one run, not project history.
