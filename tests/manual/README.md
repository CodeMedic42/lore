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
`~/source/local/ai/ai-knowledge-testing/` carries a `.lak.json`, and the MCP server
walks up from the session's working directory to find it — so every session inside
that tree reads and writes `lak_test`, and sessions anywhere else use the personal
database. Clear it with `LAK_PROFILE=test npm run clear`.

Every command prints which graph it is touching before acting on it.

## Layout

| Path | What it is |
|---|---|
| `01-*.md` | The test itself — steps, pass criteria, a results template |
| `lib/snapshot.ts` | Records graph counts and tool history per phase |
| `lib/reset.ts` | Returns the test repositories to a clean state between runs |
| `results/` | Per-run evidence — gitignored |

## The test repositories

They live in the workspace, not here:

```
~/source/local/ai/ai-knowledge-testing/
  .lak.json        points every session inside at the throwaway database
  library-test/    @acme/ui-kit — nine components, a four-level composition chain
  client-test/     @acme/contact-form — consumes the library, has no copy of its source
```

Each is a real git repository and **is its own source of truth**. There is no
template to keep in sync: git is the reset mechanism, and branches are how
scenarios vary.

```bash
npx tsx tests/manual/lib/reset.ts                  # discard changes, clean untracked
npx tsx tests/manual/lib/reset.ts --branch=main    # and switch branch first
```

A test that dirties a repository — phase C writes context files into
`library-test` — is undone by resetting, as long as the changes are not committed.
A fix the repositories genuinely need is committed to the relevant branch.

They must live outside this repository for two reasons. A Claude session started
inside this one resolves its project to this one, so a test that depends on the
session knowing nothing would quietly have the whole knowledge tool in context. And
`load_context` checks freshness with `git log` against the repository holding the
file, which needs each fixture to have a real git identity of its own.

`results/` is gitignored. Snapshots are evidence for one run, not project history.
