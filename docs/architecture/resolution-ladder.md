# Following a pointer

**Status: design, not built.** Settled in discussion; `load_context` currently
stops at "the repo is not checked out here, have a URL".

## The principle

**The database stores pointers and relationships. It never stores content.**

Content is fetched at query time from wherever it actually lives. This is the same
rule that put context files beside the code, applied one step further out: the
moment the graph starts caching what a component's props are, it owns a copy that
rots, and the rot is invisible to whoever reads it.

An earlier draft of this document proposed caching context files in the graph at
scan time. That was wrong for a reason worth recording: **it assumes the person
scanning owns the repo.** For third-party dependencies that is never true. You will
never be a Material UI contributor, and its maintainers will never see your
database. A cache-on-scan design quietly works only for code you control, which is
the minority of what you depend on.

## The ladder

Given an entity the graph knows about, detail is resolved in this order, stopping
at the first that succeeds:

| | Source | Freshness |
|---|---|---|
| 1 | **Local checkout** — read the file from disk | Verifiable: `git log` against the `generated_from` commit |
| 2 | **Remote context file** — fetch `*.context.md` from the recorded URL | Stamped only: "as written at commit X", nothing to compare against |
| 3 | **Remote source** — fetch the source file itself and read it | Current, but unsummarised |
| 4 | **Documentation** — return `homepage` / `documented_at` | Whatever the publisher maintains |
| 5 | **Say so** — name the library and version, state that detail needs research | — |

Rungs 4 and 5 are **answers, not failures**. "Your client uses `@mui/material`
6.1.2, documented at mui.com, I will look up the DatePicker API there" is a good
outcome. The graph's job was to know *which* library, *which* version and *where to
look* — not to document Material UI. Material UI documents Material UI.

The difference between an internal library and a third-party one is only *how far
down the ladder you get*. Reform commits context files, so it stops at rung 1 or 2
with real prop detail. MUI has never heard of the convention, so it stops at 4.
Same mechanism, different richness, and **nobody has to opt in for the system to be
useful.**

## Where third-party pointers come from

Nobody has to tell the graph where Material UI lives. Every installed package
declares it:

```json
{ "name": "react", "version": "18.3.1",
  "repository": "https://github.com/facebook/react.git",
  "homepage": "https://reactjs.org/" }
```

The extractor already reads `package.json`. It should also read each notable
dependency's *installed* manifest and record `repository` and `homepage` as `url`
and `documented_at` on the technology entity. That is the whole mechanism — the
address arrives automatically, from the dependency itself.

## Inaccessible is the same as absent

A private repository you cannot authenticate to is, for practical purposes, a URL
that does not exist: resolution moves to the next rung.

But it must **say which happened.** "No context file at that path" and "the
repository exists and refused me" are different facts, and a user who sees the
second knows there is something there worth getting access to. Silence makes a
permissions problem look like an absence of information.

## Credentials: delegate, never store

This system should never hold a password, a token, or a private key.

Git already solves this. On this machine `credential.helper` is `osxkeychain`, and
credentials for the hosts you clone from are already there. `git credential fill`
asks the keychain; we get a token for one request and never persist it. The same
path works for a company SSO flow, because it is the one `git clone` already uses.

Order of preference, all delegating:

1. `gh auth token` / `glab auth token` where those CLIs are installed
2. `git credential fill` via the configured helper (osxkeychain here)
3. A host-specific environment variable, for CI
4. Unauthenticated — fine for most public dependencies

### The constraint that is easy to get wrong

**`git credential fill` BLOCKS on an interactive prompt when nothing is cached.**
Discovered the hard way: a probe against a host with no stored credential hung for
two minutes and had to be killed. A tool call that does that simply freezes the
agent, and the user sees a hang with no explanation.

So every credential lookup must fail fast and never prompt:

- `GIT_TERMINAL_PROMPT=0` in the environment
- `core.askPass` pointed at `/bin/false`
- a hard timeout of a couple of seconds regardless

A missing credential must return "cannot authenticate" in milliseconds, which then
degrades to the next rung like any other inaccessible URL.

## Storing *how* to authenticate, not the secret

Worth having later, not now. The graph could record per host what the mechanism is
— SSO, OIDC, a personal access token, plain credentials — and which CLI or helper
serves it. No secret, only the method, so the fetcher knows what to try and the
user gets a useful message instead of a generic failure.

This matters for a real setup rather than a tidy one. A company may run **both**
GitHub and GitLab, with a separate SSO account on each and different usernames —
so "the credential" is not one thing, and a single global token is the wrong shape.
Per-host is the minimum viable model.

Whether a token can be kept at all without re-authenticating constantly is an open
question. The OS keychain is the only reasonable place, and the honest answer may
be that the user re-authenticates on the schedule their SSO dictates. Delegating to
git means we inherit whatever answer their organisation already chose, which is
better than inventing a second one.
