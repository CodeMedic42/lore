# Team deployment

**Status: design, not built.** Everything here describes what a company deployment
needs. The code today runs one mode — direct database — which is right for one
person and wrong for an organisation.

## Why not just share the database

Pointing every developer's `DATABASE_URL` at a shared Postgres works on the first
afternoon and is wrong by the second week:

- **Credential sprawl.** Every laptop holds database credentials. Rotating them
  means chasing everyone.
- **No identity.** Every assertion is `asserted_by: 'mcp-agent'`. The trust model
  rests on knowing who said a thing, and that information never existed.
- **No authorisation.** The Postgres role is the only boundary, and it is all or
  nothing.
- **Client-side migrations.** A developer on an old checkout starts a session and
  runs migrations against the shared schema. That is a production incident waiting
  for a Tuesday.
- **Wire protocol exposed.** Postgres has to be reachable from every laptop — a VPN
  requirement, or worse.
- **The schema becomes the API.** It cannot evolve without breaking every client
  that has not updated.

A service fixes all six, and adds something the personal setup cannot have:
**identity on every fact**.

## Shape

The load-bearing constraint: **four tools cannot move off the developer's
machine.** `load_context`, `draft_context`, `write_context` and `scan_repository`
read and write the working tree. A purely remote server cannot see it, and moving
them would discard the entire second tier — the context files beside the code.

So the MCP server stays local and becomes a client.

```
Developer machine                          Company
┌──────────────────────────────────────┐   ┌────────────────────────────────┐
│ Claude Code                          │   │  Knowledge Service             │
│   └─spawns─▶ MCP subprocess          │   │    authn / authz / audit       │
│                ├─ filesystem tools   │   │    migrations                  │
│                │    load_context     │   │    verification worker         │
│                │    draft_context    │   │         │                      │
│                │    write_context    │   │         ▼                      │
│                │    scan_repository  │   │    PostgreSQL ── reachable     │
│                │      (reads disk,   │   │                   only here    │
│                │       posts facts)  │   │                                │
│                └─ graph tools ───────┼───┼──▶ HTTPS /v1/…                 │
│                     ask_knowledge    │   │                                │
│                     find_similar     │   └────────────────────────────────┘
│                     record_*         │
│                     …                │
└──────────────────────────────────────┘
```

Note that the filesystem tools are **hybrid**, not local-only: `load_context` asks
the service where a component lives, then opens the file itself. `scan_repository`
reads hundreds of local files and posts the resulting facts. Neither is purely one
side, which is why a clean "remote server" split does not work.

## The client abstraction

Today every operation takes a `Db`. It would instead take a `KnowledgeClient`,
with two implementations — the same shape as the existing storage adapter, where
one interface already serves both real Postgres and in-process PGlite.

```ts
export interface KnowledgeClient {
  ask(question: string, opts): Promise<AskResult>
  findSimilar(description: string, opts): Promise<SimilarHit[]>
  lookup(name: string, opts): Promise<Neighbourhood>
  record(envelope: IngestEnvelope): Promise<IngestResult>
  tell(text: string, opts): Promise<TellResult>
  gaps(opts): Promise<Gap[]>
  answer(gap, answer: string): Promise<AnswerResult>
  sourceFor(entity: string): Promise<SourceRef[]>   // load_context asks this
  identity(): Promise<{ user: string; org: string }>
}
```

- `LocalClient` — wraps the existing functions against a local `Db`. Personal setup
  keeps working with nothing running but Postgres.
- `HttpClient` — the same calls over `/v1/…`, with a bearer token.

Selected by config: `LORE_API_URL` set means remote. One env var.

The HTTP API those calls map onto **already exists and is tested**. What is missing
is the client that uses it, and everything below.

## Authentication

Recommended: **OIDC device-code flow**, the pattern `gh` and `gcloud` use.

```
$ lore login
  Open https://sso.company.com/device and enter: FKQR-XZTP
  ✓ Signed in as cam@company.com
```

A refresh token is cached in `~/.config/lore/`; the MCP subprocess reads it at
startup and exchanges it for short-lived access tokens. No database credentials
anywhere, works with any SSO the company already runs, and revocation is central.

Simpler fallbacks, in descending order of preference: a personal access token in
the keychain; a service account token per machine; mTLS where that is already the
house style. The client should treat the token as opaque so the mechanism can
change without touching tool code.

**Whatever the mechanism, the outcome that matters is the same:** the service knows
who is calling, so `asserted_by` becomes `cam@company.com` instead of `mcp-agent`.

## Authorisation — the genuinely hard part

An answer here is a **path**, and paths cross boundaries. If Cam may see repo A but
not repo B, and the real answer runs A → B → C, what comes back?

- Return the path anyway → leaks that B exists and what it does.
- Cut the path at B → returns a confident, complete-looking, **wrong** answer. This
  is the dangerous option, because nothing in the response says it was truncated.
- Return the path with B redacted → honest, but tells the user something exists
  that they cannot see, which some environments also consider a leak.

**Recommendation: org-wide read, identity-attributed write.** Everyone in the
organisation can read the whole graph; every write records who made it; write
restrictions per repo if a team wants them.

The reasoning: architecture knowledge is rarely the secret — the code is, and the
code already has its own access control. A partial graph produces confidently wrong
answers, which is worse than no graph. And per-repo read authorisation is the kind
of complexity that quietly kills adoption.

Regulated environments will need more than this. The design should not *prevent*
that — the entity/edge model can carry a `visibility` attribute and traversal can
filter on it — but it should not be in the first version, and truncation must be
**stated in the answer** if it is ever added.

## What the service gains beyond proxying

1. **Identity on every fact.** Trust scoring already weights `human` above
   `llm_inferred`; with identity it can surface *who*, and a stale claim becomes
   answerable by asking the person who made it.
2. **Migrations run once**, server-side, decoupled from client versions.
3. **Audit.** The activity log becomes organisational rather than per-laptop.
4. **The verification worker gets a home.** It needs GitLab credentials and runs
   out of band — it belongs on a server, not on a laptop that closes at 6pm.
5. **Rate limiting and quota**, which matter once embedding or scanning is remote.

## Version skew

Clients will run whatever version each developer last pulled. The service must
handle old clients and old clients must degrade rather than break:

- `/v1/` is already the path prefix; break compatibility only by adding `/v2/`.
- A capability handshake on connect: the server states which operations and
  predicates it supports, and the client hides tools the server cannot serve.
- Unknown predicates are already accepted and queued rather than rejected, which
  means a newer client writing a newer predicate to an older server degrades
  correctly by construction.

## When the service is unreachable

Fail clearly, in the same style as the database-down message: say what is wrong and
what to do. **Do not** silently fall back to an empty graph — an agent that gets
"nothing known" when the service is down will confidently tell the user something
does not exist.

A local read-through cache is attractive and should wait. It reintroduces staleness
into the one tier that was supposed to be authoritative, and the failure mode —
answering from a cache that is three weeks behind — is exactly what this project
exists to avoid.

## What does not change

The personal setup stays exactly as it is: `LORE_API_URL` unset, `LocalClient`,
Postgres or PGlite, nothing else running. That is not a compatibility concession —
it is the mode most single developers should use, and it must not get worse in
order to serve the company case.

## Open decisions

| Decision | Options | Leaning |
|---|---|---|
| Auth mechanism | OIDC device flow · PAT · service account · mTLS | OIDC, falling back to PAT |
| Read authorisation | Org-wide · per-repo | Org-wide first |
| Where scanning runs | Developer machine · CI job · server clone | CI, for coverage without depending on who opened what |
| Embedding | Local model per machine · service-side | Service-side once shared, for one consistent vector space |
| Tenancy | One deployment per org · multi-tenant | One per org |

That fourth row matters more than it looks: embeddings from different model
versions are not comparable, so a shared graph needs one place deciding what the
vectors mean.
