# Backstage (CNCF) — Research Dossier

**Researched:** 2026-09-24. **Version basis:** Backstage `v1.55.1` (latest stable; `v1.55.0` was the feature release). `@backstage/catalog-model@1.10.1` published 2026-09-15 (npm registry). Most recent catalog DB migration on `master`: `20260912000000_refresh_state_maintenance.js`.
**License:** Apache-2.0. **Governance:** CNCF — accepted 2020-09-08, Incubating since 2022-03-15. Created at Spotify.

---

## 1. One-line

Backstage is an open-source **framework for building an internal developer portal**, whose core is a YAML-sourced, continuously-reconciled **Software Catalog** of typed entities and typed relations, plus a plugin system (TechDocs, Scaffolder, Search, Kubernetes, Permissions) and — as of 2025–2026 — a first-party **MCP server** and **AI entity kinds**.

Critically: Backstage is a *framework*, not a product. You fork/scaffold an app, write TypeScript, and deploy it yourself. There is no hosted Backstage from the CNCF project.

---

## 2. The Software Catalog data model

### 2.1 Envelope

Every entity is `{ apiVersion, kind, metadata, spec?, relations?, status? }`. `Entity.schema.json` sets `additionalProperties: false` at the envelope level; `apiVersion`, `kind`, `metadata` are required.

`metadata` (from the catalog's own OpenAPI spec, `plugins/catalog-backend/src/schema/openapi.yaml`) has **only `name` required**, plus optional `namespace`, `title`, `description`, `labels`, `annotations`, `tags`, `links`, and two server-populated fields: `uid` and **`etag`** — *"An opaque string that changes for each update operation to any part of the entity… can (optionally) be specified when performing update or delete operations, and the server will then reject the operation if it does not match the current stored value."* `EntityMeta` is `additionalProperties: {}` — open.

**There are no timestamp fields on the entity.** No `createdAt`, no `updatedAt`, no `observedAt`, no validity interval. (A `last_updated_at` column exists in the internal `final_entities` table since migration `20221201085245`, but it is not part of the public entity shape.)

Name rules: 1–63 chars, `[a-z0-9A-Z]` with `[-_.]` separators. Namespace defaults to `default`. Entity refs are `kind:namespace/name`.

### 2.2 Entity kinds

**Core kinds** (validated by `BuiltinKindsEntityProcessor`, `apiVersion: backstage.io/v1alpha1`) — exactly eight validators are registered in source: `API`, `Component`, `Resource`, `Group`, `Location`, `User`, `System`, `Domain`.

- **Component** — *"A piece of software… a mobile feature, web site, backend service or data pipeline."* Required `spec`: `type`, `lifecycle`, `owner`. Optional: `system`, `subcomponentOf`, `providesApis[]`, `consumesApis[]`, `dependsOn[]`, `dependencyOf[]`.
- **API** — required `type`, `lifecycle`, `owner`, `definition`; optional `system`. `type` examples: `openapi`, `asyncapi`, `graphql`, `grpc`.
- **Resource** — *"The infrastructure a component needs to operate at runtime, like BigTable databases, Pub/Sub topics, S3 buckets or CDNs."* Required `type`, `lifecycle`(per docs)/`owner`; optional `system`, `dependsOn`, `dependencyOf`.
- **System** — required `owner`; optional `domain`, `type`.
- **Domain** — required `owner`; optional `subdomainOf`, `type`.
- **Group** — required `type`, `children[]`; optional `profile{displayName,email,picture}`, `parent`, `members[]`.
- **User** — required `memberOf[]`; optional `profile`.
- **Location** — *"A marker that references other places to look for catalog data."* `spec.type`, `spec.target` / `spec.targets[]`, `spec.presence: required|optional`.
- **Template** — lives in the Scaffolder (`backstage.io/v1beta3` current; docs page still shows `v1beta2` examples). `spec.type`, `spec.parameters`, `spec.steps`, `spec.output`, `spec.owner`.

**AI kinds (new, 2026)** — shipped in `@backstage/plugin-catalog-backend-module-ai-model`, with JSON schemas in `packages/catalog-model/src/schema/kinds/`:

- **`AiResource`** (`backstage.io/v1alpha1`) — *"An AI resource represents contextual information consumed by AI coding tools, such as skills and rules."* Base spec: `type`, `lifecycle`, `owner` required; `system` optional. It is a **discriminated union on `spec.type`**, with four typed variants shipped as separate schemas:
  - `skill` — *"reusable contextual knowledge consumed by AI coding tools."* Adds `disciplines[]`, `categories[]`, `agents[]` (e.g. `claude-code`), `dependsOn[]`, and three fields explicitly borrowed from the **agentskills.io specification**: `allowedTools` (space-separated, e.g. `"Bash(git:*) Bash(jq:*) Read"`), `license` (SPDX), `compatibility` (max 500 chars).
  - `rule` — adds `disciplines[]`, **`category` (required)**, **`rationale` (required)** — *"Explanation of why this rule exists."*
  - `plugin` — requires `skills[]` (refs to skill entities); optional `version`.
  - `marketplace` — requires `plugins[]`; optional `version`.
  - Any other `type` is accepted with base fields only.
  - **Content is not in the entity.** README: *"The actual content of skills and rules is not stored in the entity spec. Instead, the source file is referenced via the standard `backstage.io/source-location` annotation."* The catalog holds the *card*, not the *knowledge*.
- **`API` with `spec.type: mcp-server`** (`API.v1alpha1.mcp-server.schema.json`, apiVersion enum now includes `backstage.io/v1beta1`) — requires `type`, `lifecycle`, `owner`, **`remotes[]`** (`{type: streamable-http|stdio|sse, url}`). Per RFC backstage/backstage#32062 (opened 2025-12-08, closed): rather than a new `McpServer` kind, *"By replacing the current `spec.definition: string` with a tagged union, each API subtype can supply its own structured data."*

### 2.3 Relations — exactly seven pairs, fixed

`packages/catalog-model/src/kinds/relations.ts` exports exactly 14 constants = **7 pairs**, and there is no eighth:

| Forward | Reverse | fromKind | toKind |
|---|---|---|---|
| `ownedBy` | `ownerOf` | API, Component, Domain, Group, Location, Resource, System, User | Group, User |
| `providesApi` | `apiProvidedBy` | Component | API |
| `consumesApi` | `apiConsumedBy` | Component | API |
| `dependsOn` | `dependencyOf` | Component, Resource | Component, Resource |
| `parentOf` | `childOf` | Group | Group |
| `memberOf` | `hasMember` | User | Group |
| `partOf` | `hasPart` | Component/API/Resource→Component/System; System→Domain; Domain→Domain |

A relation on the wire is `{ type: string, targetRef: string }` — `additionalProperties: false`. **A relation carries no properties, no weight, no confidence, no timestamp, no source attribution.** Relations are *derived*, not stored: `BuiltinKindsEntityProcessor.postProcessEntity` reads fixed `spec.*` fields and emits pairs. Notably `AiResource` is **not** in the builtin validator list and its `dependsOn` is a plain string array — the AI kinds ride on the generic mechanism.

### 2.4 Schema extensibility — the new model-layer registry (alpha, 2026)

This is the most significant recent architectural change and is easy to miss. `packages/catalog-model/src/model/` introduces a declarative, *composable* model registry. `createCatalogModelLayer({ layerId, builder })` — *"Plugins can create such catalog model layers to declare various contributions to the overall catalog model, and registering them with the catalog which then forms a complete picture out of them."* `layerId` is namespaced (`example.com/MyCustomKind`; `backstage.io` reserved).

`CatalogModelLayerBuilder` exposes a full CRUD surface over the meta-model: `addKind`, `addKindVersion`, `updateKind`, `removeKind`, `addRelationPair`, `updateRelationPair`, `addAnnotation`/`update`/`remove`, `addLabel`/`update`/`remove`, `addTag`/`update`/`remove`, and `import(layer)`.

A `CatalogModelKindDefinition` carries `group` (apiVersion group), `names {kind, singular, plural}`, `description`, and `versions[]`. Each version has `name` (e.g. `v1alpha1`), an optional **`specType`** discriminator (*"This can be used to make kinds whose spec effectively are discriminated unions"*), a `schema.jsonSchema`, and **`relationFields[]`** — `{ selector: {path}, relation, defaultKind?, defaultNamespace? }`, i.e. *relation derivation is now declarative*, not hardcoded in a processor. The well-known relations themselves are now expressed as a layer (`wellKnownRelationsModel`, layerId `catalog.backstage.io/well-known-relations`) with human `title`s (`"owned by"`, `"API provided by"`). Source still contains open `TODO`s — this is genuinely alpha.

The older, still-documented extension route: pick your own `apiVersion` prefix (*"the `backstage.io` `apiVersion` space is reserved for use by the Backstage maintainers"*), add a processor with `validateEntityKind`, and note that *"A kind's schema validation typically doesn't forbid 'unknown' fields in an entity `spec`."* Field-format rules can be relaxed via `catalogModelExtensionPoint.setFieldValidators()`.

---

## 3. Ingestion: processors and entity providers

Two extension points, at different depths (`@backstage/plugin-catalog-node`).

**`EntityProvider`** — the edge. `getProviderName(): string` and `connect(connection)`. The connection offers `applyMutation(mutation)` and `refresh({keys})`. The mutation is a tagged union:
```ts
type EntityProviderMutation =
  | { type: 'full'; entities: DeferredEntity[] }
  | { type: 'delta'; added: DeferredEntity[];
      removed: (DeferredEntity | { entityRef: string; locationKey?: string })[] }
```
`full` = authoritative replacement of that provider's entity set; `delta` = incremental. There is **no `updated` arm** — an update is expressed as an `added` entry. Provider names must be *"unique… and stable over time since emitted entities are related to the provider by this name."* A third variant, **Incremental Entity Providers**, exists for paginated sources too large to hold in memory.

**`CatalogProcessor`** — the processing loop. Optional hooks: `readLocation(location, optional, emit, parser, cache)`, `preProcessEntity(entity, location, emit, originLocation, cache)`, `validateEntityKind(entity)`, `postProcessEntity(entity, location, emit, cache)`, `getPriority()`. `emit` accepts a `CatalogProcessorResult` union: `location`, `entity`, `relation`, `error`, and `refresh` (refresh-key registration). Processors get a per-entity `CatalogProcessorCache` (`get`/`set`).

**Lifecycle**: ingest → process → **stitch**. The stitcher merges the processed entity, emitted errors, and all emitted relations into the `final_entities` row. *"What it exposes are final entities — i.e. the output of all processing and the stitching process, not the raw originally ingested entity data."* Orphaning: an entity that loses all parents gets `backstage.io/orphan: 'true'` and is deleted by default (`catalog.orphanStrategy: keep` to retain; `orphanProviderStrategy` likewise).

**Built-in integrations** (18 listed): AWS S3, Azure Blob Storage, Azure DevOps, Bitbucket Cloud, Bitbucket Server, Gerrit, GitHub, GitLab, Gitea, Microsoft Entra ID, Keycloak, LDAP, Okta, Datadog, Harness, Google GCS. GitHub discovery (`GithubEntityProvider`) takes `organization`, `catalogPath` (glob-capable), `filters` (`branch`, `repository` regex, `topic` include/exclude, `visibility`, `allowArchived`), and `schedule.frequency`/`timeout`; webhook-driven ingestion via `@backstage/plugin-events-backend-module-github` on topics `github.push`/`github.repository` avoids rate limits.

---

## 4. The API — and what you cannot do with it

The catalog OpenAPI spec defines **21 operations**. Reads: `GetEntities` (deprecated), `GetEntityByUid`, `GetEntityByName`, `GetEntityAncestryByName`, `GetEntitiesByRefs`, `GetEntitiesByQuery`, `QueryEntitiesByPredicate` (POST), `GetEntityFacets`, `QueryEntityFacetsByPredicate` (POST), `GetLocations`, `GetLocationsByQuery`, `GetLocation`, `getLocationByEntity`. Writes: `RefreshEntity`, `DeleteEntityByUid`, `CreateLocation` (with `?dryRun`), `UpdateLocation` (PUT), `DeleteLocation`, `AnalyzeLocation`, `ValidateEntity`.

**There is no create-entity or update-entity endpoint.** Not deprecated, not gated — absent. The only way to add an entity is to put YAML somewhere a Location or provider can read, or to write a custom `EntityProvider` in TypeScript and deploy it. `DELETE /entities/by-uid/{uid}` is *"appropriate for orphaned entities, but not for removal of 'live' entities"* — a live entity reappears on the next processing loop. `catalog.readonly: true` disables even location registration.

Query language (`by-query` POST) is a JSON predicate dialect: `$all`, `$any`, `$not`, `$exists`, `$in`, `$hasPrefix`, `$contains`, plus `fullTextFilter {term, fields}`, `orderFields`, `limit`/`offset`/`cursor`. Cursor pagination is supported.

**GraphQL**: there is **no first-party catalog GraphQL API**. `@backstage/plugin-catalog-graphql` is deprecated. The live option is community/Frontside: `@frontside/backstage-plugin-graphql-backend` + `-module-catalog`, serving `/api/graphql` with a `@relation` directive. RFC #17175 ("GraphQL Plugin 2.0") exists but GraphQL is not core.

---

## 5. MCP and the AI surface

`@backstage/plugin-mcp-actions-backend` exposes the **Actions Registry** as MCP tools over **Streamable HTTP** at `/api/mcp-actions/v1`. Default: *"always available and always exposes every registered action."* Named sub-servers get their own endpoints (`/api/mcp-actions/v1/catalog`) with `filter.include`/`filter.exclude` rules matching glob-on-action-ID or attributes; **exclude wins**. Config: `mcpActions.name/description/instructions`, `mcpActions.namespacedToolNames`, `backend.actions.pluginSources`. All requests authenticated: static external-access tokens, or OAuth via **Client ID Metadata Documents** (`auth.clientIdMetadataDocuments.enabled`). OTel instrumentation: `mcp.server.operation.duration`, `mcp.server.session.duration`, spans named `tools/call <toolname>`.

Actions register with zod `schema.input`/`output`/`secrets` and `attributes: {readOnly, idempotent, destructive}` — *"an action is assumed to be non-idempotent and not read-only"* when unset; `destructive` defaults true unless `readOnly`. Also served over plain HTTP at `/.backstage/actions/v1/...` with permission filtering.

**Well-known actions** (documented as explicitly non-exhaustive):

| Action | R/W (verified in source where noted) |
|---|---|
| `auth.who-am-i` | read |
| `catalog.get-catalog-entity` | read |
| `catalog.query-catalog-entities` | **read** — source: `readOnly:true, idempotent:true, destructive:false` |
| `catalog.register-entity` | **write** — `destructive:false, readOnly:false, idempotent:false`; input `locationUrl`, output `locationId`; calls `catalog.addLocation({type:'url'})` |
| `catalog.unregister-entity` | **write/destructive** — `destructive:true, readOnly:false, idempotent:true`; removes a Location and every entity it owns |
| `catalog.validate-entity` | read |
| `catalog.get-catalog-model-description` | read — returns markdown of *"all registered entity kinds, annotations, labels, tags, and relations"* (the model-layer registry, exposed to agents) |
| `notifications.get-notifications` | read |
| `kubernetes.get-kubernetes-clusters`, `kubernetes.get-kubernetes-resources-for-entity` | read (live cluster data) |
| `scaffolder.dry-run-template`, `.list-scaffolder-actions`, `.list-scaffolder-tasks`, `.get-scaffolder-task-logs` | read |
| `scaffolder.execute-template` | **write** — runs a template (creates repos, PRs) |
| `search.query` | read |

So the **maximum agent write surface is: register a Location URL, unregister one, and execute a scaffolder template.** An agent cannot write an entity's fields, cannot assert a relation, cannot annotate an existing entity.

**Published skills**: `docs/.well-known/skills/`, served at `https://backstage.io/.well-known/skills/index.json`, installed with `npx skills add https://backstage.io` into `.github/skills/`. Each skill is a directory with a required `SKILL.md` (YAML front-matter `name`, `description`). Shipped skills: `app-frontend-system-migration`, `plugin-new-frontend-system-support`, `plugin-full-frontend-system-migration`, `mui-to-bui-migration`, `plugin-analytics-instrumentation`, `onboard-to-openapi-server`. These are about *maintaining Backstage itself*, not about the user's codebase.

---

## 6. Other plugins (brief)

**TechDocs** — *"Spotify's homegrown docs-like-code solution."* MkDocs-generated static sites, keyed by `backstage.io/techdocs-ref`; also `techdocs-entity` / `techdocs-entity-path` for docs owned by a different entity. Publishers: local FS, GCS, S3, Azure Blob, OpenStack Swift (community). Addon framework since 1.2. v1.55 added an MkDocs plugin allowlist and `--skip-if-unchanged` SHA256 hashing in the CLI. Spotify reports ~5,000 doc sites / ~10,000 daily hits.

**Scaffolder** — Template entities with `parameters` (JSON-Schema-driven wizard) and `steps` (actions). Every run is a task with an ID, logs, dry-run, "Start Over", and (v1.55) **task recovery with workspace serialization** across crashes. Action modules per provider: Azure DevOps, Bitbucket, Gerrit, Gitea, GitHub, GitLab, Rails, Yeoman, Sentry, Cookiecutter. Gotcha documented: action IDs must be camelCase (dashes parse as subtraction in template expressions).

**Search** — pluggable engines: Elasticsearch/OpenSearch and Lunr supported, Postgres community-supported. Collators index Catalog, TechDocs, Stack Overflow. v1.55 requires ES 8.19+.

**Permissions** — off by default (*"all endpoints are unprotected"*). Resource permissions plus conditional decisions via rules; catalog rules are `isEntityOwner(claims)`, `isEntityKind(kinds)`, `hasAnnotation(name, value?)`, `hasLabel(name, value?)`, `hasMetadata`, `hasSpec`. The Actions Registry applies permission filtering to the MCP tool list automatically.

**Kubernetes** — *"designed around the needs of service owners, not cluster admins."* Surfaces live cluster objects per entity via `backstage.io/kubernetes-id` / `kubernetes-label-selector`. It **does not create catalog entities** — infrastructure is rendered on demand, not ingested.

---

## 7. Provenance, staleness, contradiction, temporality

- **Provenance — partial, at location granularity.** `backstage.io/managed-by-location` *"points to the source from which the entity was originally fetched"*; `managed-by-origin-location` names the registering location; `backstage.io/source-location` points at source code. Provider name is the stable key for provider-emitted entities. **Field-level provenance does not exist** — you cannot ask which processor or source set `spec.owner`.
- **Contradiction — resolved by overwrite, not recorded.** Processors mutate the entity in sequence; last write wins, ordered by `catalog.processorOptions.<name>.priority`. Two sources disagreeing produces one value and no record of the disagreement. Errors are the one exception: emitted errors land in `entity.status.items` and block replacement.
- **Staleness — refresh, not decay.** Entities are reprocessed on `catalog.processingInterval`; providers push on webhooks; `refresh({keys})` targets refresh-keyed entities; `POST /refresh` forces one. A stale entity looks identical to a fresh one — there is no confidence, no TTL, no last-verified marker in the public model.
- **Temporality — none.** No entity history, no versioning of instances, no time-travel query, no "what did this look like last quarter". `apiVersion` versions the *schema*, not the *instance* (issue #5834). Audit *events* exist (Auditor service, catalog audit events) as an operational log stream — they are not queryable entity history. `etag` gives optimistic concurrency, not a timeline.
- The docs themselves temper the ambition: *"the Backstage Software Catalog should not be considered the ultimate source of truth, instead, it is advisable to use the Backstage Catalog as a caching mechanism."* And: *"intended to capture human mental models using entities and their relationships rather than an exhaustive inventory."*

---

## 8. Cross-repo and infrastructure

**Cross-repo: yes, natively and centrally.** This is Backstage's strongest axis. Discovery providers crawl whole GitHub/GitLab/Bitbucket orgs, and a single query spans every repo in the catalog. `Component.dependsOn`, `providesApis`/`consumesApis`, `System`, and `Domain` are explicitly designed to express relationships *across* repository boundaries. But the unit of knowledge is the **repo-level entity**, not code. Backstage indexes no symbols, no functions, no call graphs, no diffs. It cannot answer "who calls this function across repos" — only "which components declare that they consume this API."

**Infrastructure: modeled, shallowly.** `Resource` is a first-class kind *"the infrastructure a component needs to operate at runtime, like BigTable databases, Pub/Sub topics, S3 buckets or CDNs"*, wired into `dependsOn`/`partOf`/`ownedBy`. But a Resource is a hand-written (or provider-emitted) YAML card with `type`, `lifecycle`, `owner` — not a live cloud inventory, and there is no first-party Terraform/Pulumi/CloudFormation state reader in core. Live infra is *viewed* through the Kubernetes plugin without entering the graph. Infrastructure is named in Backstage; it is not understood.

---

## 9. Pricing and licensing

Backstage itself is **Apache-2.0, free, CNCF-hosted — no pricing page, no license tiers, no SaaS**. Cost is self-hosting and engineering. Commercial distributions exist around it; **Spotify Portal for Backstage** is the first-party one, sold as a per-user annual subscription with **no public list price** (quote-based; also listed on AWS Marketplace), bundling Spotify's premium plugins (including an AI Knowledge Assistant). Red Hat Developer Hub and Roadie are other commercial distributions.
