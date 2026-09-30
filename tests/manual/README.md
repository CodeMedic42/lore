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

## Layout

| Path | What it is |
|---|---|
| `01-*.md` | The test itself — steps, pass criteria, a results template |
| `lib/snapshot.ts` | Records graph counts and tool history per phase |
| `lib/fixture.ts` | Materialises the consuming-repo fixture outside this repo |
| `fixtures/` | Committed templates, copied out by `lib/fixture.ts` before use |
| `results/` | Per-run evidence — gitignored |

A fixture is committed as a template and copied elsewhere before use, because a
Claude session started inside this repository resolves its project to this
repository. A test that depends on the session knowing nothing would quietly have
the entire knowledge tool in context.

`results/` is gitignored. Snapshots are evidence for one run, not project history.
