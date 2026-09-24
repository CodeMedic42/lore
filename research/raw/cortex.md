# Cortex (cortex.io) — Research Dossier

**Researched:** 2026-09-24. Docs read from `docs.cortex.io` (GitBook-hosted, every page available as `.md`, full index at `https://docs.cortex.io/llms.txt` — 398 lines, ~380 pages). Source code read from `github.com/cortexapps/cortex-mcp` (last commit to bundled OpenAPI spec: 2026-01-08) and `github.com/cortexapps/terraform-provider-cortex` (v0.5.0).

---

## 1. What it is

Cortex is a commercial, closed-source **Internal Developer Portal (IDP)** delivered as SaaS (`app.getcortexapp.com`, API at `api.getcortexapp.com`) with a self-managed Helm/Kubernetes option. It is the direct Backstage competitor in the "software catalog + scorecards" category. Its product surface has five pillars, matching the docs IA: **Ingest** (entities, catalogs, integrations), **Configure** (GitOps, settings), **Standardize** (Scorecards, CQL), **Streamline** (Workflows, Plugins, Scaffolder, homepage), **Improve** (Eng Intelligence, Initiatives, Reports, OpEx Review).

Docs tagline (readme.md): *"Code is no longer the bottleneck. Everything else is."* Marketing has pivoted hard to AI governance/AI readiness/AI maturity in 2026 (a whole `solutions/` tree plus a "DRIVE framework" — Delivery, Reliability, Initiatives, Vigilance, Efficiency).

---

## 2. Data model (precise)

### 2.1 The entity descriptor

> "Each descriptor is a fully compliant OpenAPI 3 spec file, extended with Cortex-specific fields." — `entities/yaml.md`

Every entity — service, domain, team, cloud resource, custom type — is **one OpenAPI 3 document** whose `info` block carries `x-cortex-*` extensions. Cortex stores descriptors as JSON internally (hence "YAML comments aren't supported in entity descriptors").

**Required:** `title`, `info.x-cortex-tag` (the unique human slug), `info.x-cortex-type`.
**Strongly recommended:** `description`, `x-cortex-groups`, `x-cortex-owners`.

**Structural blocks:**
- `x-cortex-groups` — free-form string tags; alphanumeric, no whitespace. Used as inclusion/exclusion criteria in Scorecards, catalogs, CQL.
- `x-cortex-owners` — list of `{type: group|email, ...}`. Group owners require `name` + `provider`, where provider ∈ `CORTEX, ACTIVE_DIRECTORY, AZURE_DEVOPS, BAMBOO_HR, GITHUB, GITLAB, GOOGLE, OKTA, OPSGENIE, SERVICE_NOW, WORKDAY`. Optional `inheritance: APPEND | FALLBACK | NONE`.
- `x-cortex-custom-metadata` — arbitrary key/value custom data; values may be scalars, objects, or lists; optional `value`+`description` form.
- `x-cortex-dependency` — list of `{tag, method?, path?, description?, metadata?}`. `metadata` is arbitrary JSON.
- `x-cortex-parents` / `x-cortex-children` — hierarchical edges (teams, domains).
- `x-cortex-relationships` — `[{type: <relationshipTypeTag>, destinations: [{tag}]}]`.
- `x-cortex-definition` — the JSON payload validated against a custom entity type's JSON Schema.
- `x-cortex-team` — `groups` + `members` (`name`, `email`, `notificationsEnabled`, `roles`).
- `x-cortex-link` — `{name, type, url, description}`; `type: OPENAPI | ASYNC_API` renders in an API Explorer tab.

**Integration blocks (~30):** `x-cortex-alerts, -apiiro, -apm, -azure, -azure-devops, -bugsnag, -ci-cd, -checkmarx, -circle-ci, -coralogix, -dashboards, -firehydrant, -git, -incident-io, -infra, -issues, -k8s, -launch-darkly, -microsoft-teams, -oncall, -rollbar, -rootly, -sentry, -semgrep, -servicenow, -slack, -slos, -snyk, -static-analysis, -wiz`. These are **identity-mapping declarations** — they tell Cortex which Datadog service / K8s deployment / AWS ARN / Snyk project *is* this entity. This is the core of Cortex's federation model: the entity is a join key, not a copy of the data.

### 2.2 Entity types

Built-ins: **Services** (default), **Domains** (hierarchical grouping), **Teams** (people), **Cloud resources** (AWS / Azure / GCP types, selected per-workspace in integration settings).

**Custom entity types** are first-class and unlimited: *"You can create unlimited custom entity types through the Cortex UI or API."* A type is `{type (identifier), name, description, iconTag, schema}` where `schema` is a raw **JSON Schema** document (`JsonNode` in the OpenAPI spec — no constraint beyond valid JSON). `required` properties are enforced at entity creation, and the properties surface on the entity page and are queryable in Scorecards, CQL and Data Explorer table columns.

API: `POST/PUT/DELETE /api/v1/catalog/definitions[/{type}]`. Response carries `source: CORTEX | CUSTOM`.

**Two-step**: you cannot create an entity *type* via GitOps — only via UI or API. Once the type exists, entities of that type can be created via UI, API, or GitOps.

### 2.3 Relationships — three distinct mechanisms

Cortex deliberately separates three graph mechanisms (`defining-relationship-types.md`):

1. **Dependencies** — cyclical, non-team entities, `caller → callee`, optionally pinned to a specific `method` + `path` endpoint of the callee's OpenAPI `paths`. Carries `description` and arbitrary JSON `metadata`. *Incoming dependencies are inferred automatically from outgoing definitions.*
2. **Team hierarchies / Domain hierarchies** — built-in parent/child with ownership inheritance.
3. **Entity relationships (typed)** — user-defined relationship *types*, the extensible graph layer. Marked `[Beta]` in the bundled swagger; the tag lost the `[Beta]` suffix in the current published docs.

A **relationship type** (`EntityRelationshipTypeRequest`) is genuinely a schema object, not a label:
```
tag, name, description
sourcesFilter / destinationsFilter : { include: bool, types: [entityType], providers: [AWS|GCP|AZURE] }
allowCycles: bool
isSingleSource / isSingleDestination : bool      # cardinality constraints
definitionLocation: SOURCE | DESTINATION | BOTH   # where in a descriptor it may be declared
createCatalog: bool                               # auto-generate a catalog page for the type
sourceLabelSingular/Plural, destinationLabelSingular/Plural
inheritances: [{ parameterTag, inheritanceType: NONE|FALLBACK|APPEND|CONFIGURE_AT_SOURCE }]
isCortexManaged (read-only)
```
So: typed, directed, cardinality-constrained, type-filtered edges with **parameter inheritance along the edge** (currently only `x-cortex-owners` propagates; the `inheritances` array is generalized for future parameters). Edges themselves carry **no properties** — `EntityRelationship` is exactly `{sourceEntityTag, destinationEntityTag, relationshipTypeTag, providerType?}`, where `providerType` is an enum with a single value: `WORKDAY`. Only *dependency* edges carry `description`/`metadata`.

CQL exposes recursive traversal: `entity.sources(relationshipType="x")` and `entity.destinations(relationshipType="x")`, with an optional depth parameter.

### 2.4 Other model objects

- **Catalogs** — UI-defined saved views/filters over entities. *"Entities are defined by YAML files, but catalogs aren't."* An entity can be in many catalogs.
- **Groups** — flat string tags on entities (separate from catalogs and domains).
- **Custom data** — key → arbitrary JSON value, optional description. Three write paths (descriptor, API, webhook) that merge with documented key precedence.
- **Custom events** — timestamped events per entity with UUID identity, type, and time filtering.
- **Custom metrics** — named time series per entity (Eng Intelligence).
- **Deploys** — first-class deployment records per entity, with environments, UUID identity, and a tenant-wide search.
- **Packages** — dependency manifests ingested per entity for Java/Maven, Node (npm/yarn/pnpm), Python (requirements/pipfile), Go (go.sum), .NET (csproj/packages.lock).
- **Verifications / verification periods** — attestation records (see §5).
- **Scorecards, Initiatives, Workflows, Scaffolders, Plugins, Secrets, API keys, Teams, Team hierarchies, User labels, IP allowlist, Audit logs, GitOps logs, Notification logs.**

Identifiers: every entity has a human `tag` (`x-cortex-tag`, immutable — changing it creates a new entity) and an **18-character auto-generated immutable CID** (hashid). Tags containing `/` are supported via API (URL-encoded) but not in the UI.

---

## 3. Write capability (what an external agent can actually do)

The REST API is large. Counting operations extracted from the inline OpenAPI fragments embedded in all 81 `docs.cortex.io/api/readme/*` pages: **520 documented operations** — 162 GET, 173 POST, 83 PUT, 100 DELETE, 2 PATCH. (The `swagger.json` bundled in `cortex-mcp` is an older subset: 190 paths / 316 operations.) Roughly half the POST/PUT/DELETE volume is per-integration configuration CRUD (`/api/v1/{datadog|github|aws|...}/configuration[s]`), which is admin plumbing, not knowledge writes.

Auth: `Authorization: Bearer <token>`, JWT format. Two token kinds — workspace **API keys** (Settings) and **personal access tokens** (required for remote MCP). Rate limit **1000 req/min per client**, max body **2 MB**, `429` + `Retry-After`.

**Knowledge-bearing writes available to an agent:**

| Object | Write operations |
|---|---|
| Entities | `POST /api/v1/open-api` (`createOrUpdateEntity`, upsert or CREATE mode) and `PATCH /api/v1/open-api` (`createOrPatchEntity`, merge). **Body content-type is `application/openapi;charset=UTF-8` — you send the raw descriptor YAML, not JSON.** Plus `deleteEntity`, `deleteEntitiesByType`, `archiveEntity`, `unarchiveEntity`. |
| Entity types | `createDefinition`, `updateDefinition`, `deleteDefinition` (JSON Schema payload) |
| Relationship types | `createRelationshipType`, `updateRelationshipType`, `deleteRelationshipType` |
| Entity relationships | `addEntityRelationships` / `updateEntityRelationships` (bulk, per type), `addEntitySources`/`addEntityDestinations`, `updateEntitySources`/`updateEntityDestinations` |
| Dependencies | `createDependency`, `updateDependency`, `deleteDependency`, `createOrUpdateDependenciesInBulk` (map of callerTag → [{tag, method, path, description, metadata}]), `deleteDependenciesInBulk` |
| Custom data | `addCustomDataForEntity`, `createOrUpdateCustomDataInBulk`, `addCustomDataViaWebhook` (unauthenticated UUID endpoint), delete variants |
| Custom events | create / replace-by-UUID / delete |
| Custom metrics | `createCustomMetricData`, `createBulkCustomMetricData`, `deleteByTimeRange` |
| Deploys | `addDeployForEntity`, `updateDeployByUuid`, deletes |
| Packages | 12 upload endpoints (manifest files) + 5 deletes |
| Docs | `updateOpenApiDocForEntity` (attach an OpenAPI doc to an entity) |
| Groups | `addGroupsToEntity`, `deleteGroupsFromEntity` |
| Scorecards | `createOrUpdateScorecard` (body = **Scorecard descriptor YAML**, `application/yaml`), `deleteScorecard`, `refreshScorecardScoreForEntity`, exemption request/approve/deny/revoke |
| Initiatives | create / update / delete |
| Workflows | `createOrUpdateWorkflow`, `validateWorkflowDescriptor`, **`runWorkflow` (`POST /api/v1/workflows/{tagOrId}/runs`)**, `workflowsAsyncHttpCallback`, delete |
| Scaffolders | create / update / delete |
| Plugins | create / update / patch / delete |
| Teams | create, update metadata, update members, archive/unarchive, delete; `replaceAllTeamHierarchyRelationships` (full-graph replace) |
| Verifications | `createVerificationPeriod`, `updateVerificationPeriod`, `verifyEntityForPeriod`, `bulkVerifyEntities` |
| Eng Intel | `updateUserLabelAssignments` |
| Users | SCIM 2.0 `/scim/v2/Users` full CRUD + PATCH |
| Secrets / API keys / IP allowlist | full CRUD |
| Queries | `POST /api/v1/queries` runs a CQL query as an async job; `GET /api/v1/queries/{jobId}` retrieves results |

**Important asymmetry:** the primary entity write path is *descriptor-shaped* (send YAML), not field-shaped. There is no `PATCH /catalog/{tag}` that sets one field. Granular writes exist only for the side-tables (custom data, dependencies, groups, relationships, deploys, metrics, events). The `createOrPatchEntity` PATCH merges a partial descriptor, which is the closest thing to a field-level update.

**GitOps conflict rule:** *"YAML is the source of truth. If a dependency has already been set through the `cortex.yaml`, the API returns an error."* An agent writing via API into a GitOps-managed workspace will be rejected for fields the descriptor owns. This is the single most important constraint for a write-capable agent.

**Other write surfaces:** official Terraform provider (`cortexapps/terraform-provider-cortex`, v0.5.0, MPL-style repo) with resources `cortex_catalog_entity`, `cortex_catalog_entity_custom_data`, `cortex_catalog_entity_openapi`, `cortex_scorecard`, `cortex_resource_definition`, `cortex_department`; an open-source Python CLI (`cortexapps-cli` on PyPI, `github.com/cortexapps/cli`); **Cortex Axon** (Go, open source) for jobs running inside your network that push data out, plus **Axon Relay** (Snyk Broker over WebSocket) for Cortex to reach internally-hosted GitHub/GitLab/Bitbucket/Jira/Prometheus/SonarQube/Harness without inbound firewall holes.

---

## 4. MCP server — exact tools, and it is read-only

Two deployments:
- **Local**: `ghcr.io/cortexapps/cortex-mcp:latest`, stdio over Docker. Source: `github.com/cortexapps/cortex-mcp`, MIT, Python, built on **FastMCP** (`FastMCP.from_openapi`). README carries a **"Research Preview"** banner.
- **Remote**: `https://mcp.cortex.io/mcp`, streamable HTTP, `Authorization: Bearer <personal access token>`. Documented as having **more tools** than local, including `query_docs` and "the ability to add private tools and integrations on top of the public functionality."

**Mechanism:** the server loads a bundled `swagger.json` (918 KB) and maps routes to tools purely by an OpenAPI vendor extension. `src/routes/mappers.py`:
```python
if route.extensions.get("x-cortex-mcp-enabled") == "false":  return MCPType.EXCLUDE
elif route.extensions.get("x-cortex-mcp-enabled") == "true": return MCPType.TOOL
return MCPType.EXCLUDE  # TODO UNDO THIS.
```
Of 316 operations in the bundled spec, **28 are MCP-enabled: 26 GET and 2 POST**, and both POSTs are read-shaped queries (`queryPointInTimeMetrics`, `getMyWorkspace`). Verified enabled set:

`listAllEntities, listEntityDescriptors, getEntityDetails, getEntityDescriptor, listDependenciesForEntity, getDependency, getCustomDataForEntity, getCustomDataForEntityByKey, listCustomEventsForEntity, getCustomEventForEntityByUuid, getDeploysForEntity, getCurrentOncallForEntity, listEntitySourcesForRelationshipType, listEntityDestinationsForRelationshipType, listRelationshipTypes, getRelationshipTypeDetails, listEntityRelationships, listScorecards, getScorecard, listScorecardScores, getScorecardNextStepsForEntity, listInitiatives, getInitiative, getCustomMetricData, listMetricDefinitions, getTeamDetails, queryPointInTimeMetrics (POST), getMyWorkspace (POST)`

The published docs enumerate a **larger** tool set for the remote server, grouped: Catalog/Entities (adds `searchCatalog`, `listGroupsForEntity`, `listDefinitions`, `getDefinition`, `getOpenApiDocForEntity`, `KubernetesGetK8sResourcesForEntity`, `AWSGetAwsResources`, `getMyWorkspace`); Custom data & events; Dependencies & relationships; Scorecards; Initiatives; **Verifications** (`listVerifications`, `listVerificationPeriods`, `retrieveVerificationPeriod`, `listVerificationsForEntity`); Metrics (`getCustomMetricData`, `queryTraceEvents`, `listMetricDefinitions`, `queryPointInTimeMetrics`); Teams & on-call (`getTeamDetails`, `getTeamHierarchyRelationships`, `listTeamMemberRoles`, `getCurrentOncallForEntity`); Deploys (`getDeploysForEntity`, `searchDeploys`, `listDeployEnvironments`); Workflows (`listWorkflows`, `getWorkflow`, `listWorkflowRuns`, `getWorkflowRun`); Docs & meta (`query_docs`, `get_more_tools` — a dynamic tool-discovery tool).

**Read-only is stated explicitly** in `using-cortex-mcp.md` FAQ:
> **"Can I make changes via the Cortex MCP?"** — *"No, you cannot make changes or write data via the Cortex MCP. The MCP is strictly read-only—it only handles `GET` requests and cannot modify or write data."*

(The literal claim "only handles GET requests" is slightly inaccurate — two read-shaped POSTs are enabled — but the semantic claim holds: no tool mutates state. Notably `runWorkflow` is *not* exposed, so the MCP cannot trigger Cortex automation either.)

---

## 5. Provenance, staleness, contradiction, temporality

This is where Cortex is more serious than most catalogs, though the mechanisms are operational rather than epistemic — there is **no per-fact provenance graph and no confidence scoring**.

**Provenance (partial, per-source-system).** Every integration block on an entity records *which* external system a fact came from; custom data is tagged by origin (descriptor / API / webhook) and Data Explorer says *"Cortex surfaces keys from all sources: the entity descriptor (`x-cortex-custom-metadata`), the custom data API, and custom webhook integrations."* Team members carry `sources: [{type: ENTITY_DEFINED | IDP_GROUP, provider, externalId, externalGroupId}]` — so you can tell an Okta-sourced member from a YAML-declared one. Relationship types carry `isCortexManaged`; entity types carry `source: CORTEX | CUSTOM`; relationships carry an optional `providerType`. **GitOps logs**, **audit logs**, and **notification logs** are separate first-class, API-readable log surfaces.

**Contradiction handling — merge, not adjudicate.** For dependencies: *"When leveraging multiple dependency sources (such as Datadog and a catalog entity's YAML), all the sources are merged together and de-duplicated… if an entity YAML indicates `X->Y` and Datadog indicates `X->Y` and `X->Z`, two edges are presented."* Union semantics, no conflict surfaced. For custom data there is documented key precedence and *"new values overwrite previous ones for the same key."* For descriptor-vs-API there is a hard rule rather than a merge: YAML wins and the API errors.

**Staleness — three real mechanisms:**
1. **Data verification periods.** An admin defines a window (start/end, name, instructions, optional "require reason"), scoped by entity type / group / CQL, and restricted to specific **team member roles**. Only a **direct** member of the owning team can verify — inherited ownership and parent-team membership explicitly do not qualify. Owners get notified at period start and weekly Monday reminders; pending verifications appear on the engineering homepage. Verifications are queryable via API and CQL; there are prebuilt Scorecard and CQL-report templates to flag unverified / verified-as-incorrect entities. This is an **attestation** system — a human periodically re-asserts the data is true, with a timestamp and an identity.
2. **Auto-archive.** Daily at 07:00 UTC, entities that disappeared from an integration are archived (integration-based), and entities whose descriptor file was deleted are archived (GitOps-based); monorepo entities archive/unarchive as a group. Skips if errors detected.
3. **Discovered entities** (formerly "Discovery audit"). Cortex continuously diffs the catalog against Git / APM / K8s / cloud integrations and lists what's new or vanished, with event type + event date, import/ignore/delete actions, manual sync, and CSV export. New entities can be imported with a pre-seeded descriptor.

Plus **explicit refresh cadences**, which is really the staleness contract: Scorecards re-evaluate **every 4 hours** by default; Data Explorer metrics sync every 4 hours; AWS dependencies sync daily 08:00 UTC, all other dependencies 00:00 UTC; Eng Intelligence backfills 6 months and takes up to 24 hours on first setup.

**Temporality.** Split. Entities and custom data are **current-state only** — *"new values overwrite previous ones for the same key, so it's not suited for time-sensitive tracking."* Time series live in a parallel system: **custom metrics** (per-entity time series, aggregations avg/max/median/min/p95/sum) and **Eng Intelligence** (`queryTraceEvents` over raw event records with filters, ordering, cursor pagination, day-of-week restriction; `queryPointInTimeMetrics` with previous-period comparison and grouping by team/entity/user). Scorecard results are a notable gap: *"Scorecard columns show current results rather than a time series… **Historical Scorecard data isn't supported yet**."* Entities do carry `lastUpdated` and CQL has `entity.created()`.

**AI-generated facts are marked as such.** Ownership Recommendations (Research Preview) *"leverages machine learning to infer and recommend the most likely owners of a service using signals from Git activity"*; the recommendation must be accepted (individually or in bulk), and Cortex's own guide (`verify-auto-mappings.md`) prescribes chasing a bulk AI accept with a data verification period. That is a deliberate confidence-laundering workflow: machine inference → human attestation.

---

## 6. Cross-repo scope and infrastructure modelling

**Cross-repo: yes, but it is not a code-search product.** Cortex does not index or read source across repos for retrieval. It maps repos to entities: `listAllEntities` filters by `gitRepositories` with provider prefixes (`github:org/repo`, `gitlab:namespace/project`, `bitbucket:workspace/repo`, `azure-devops:project/repo`), monorepos are handled via `basepath` and a Repository/Monorepo relationship-type pattern (Service→Repository, or Repository→Service for monorepos), and CQL offers provider-agnostic predicates like `git.fileExists()` that *"search across all of your Git repositories without needing to specify the Git provider."* Cross-repo questions ("which services are still on the old secrets manager?") are answered by evaluating a predicate per entity against its repo, not by a code index. Package manifests (Java/Node/Python/Go/.NET) are ingested per entity, giving a cross-repo dependency inventory.

**Infrastructure: yes, natively and deeply.** Cloud resources are built-in entity types, not custom ones. AWS import uses **Cloud Control types** (`x-cortex-infra.aws.cloudControl: [{type: AWS::RDS::DBInstance, region, accountId, identifier}]`) plus ECS cluster/service ARNs, with `AWSGetAwsCloudControlTypes` / `AWSSetConfiguredAwsCloudControlTypes` to choose which types hydrate. Azure Resources by full resource ID; GCP by `{projectId, resourceName, resourceType}`. Kubernetes maps `DEPLOYMENT | STATEFUL_SET | ARGO_ROLLOUT | CRON_JOB` per namespace/cluster, cached (`"This endpoint serves cached data only and does not make live Kubernetes API calls"`). Terraform-managed infra is a documented first-class workflow (`entities/terraform.md`, plus Workflow guides that provision/update/destroy EC2). Relationship-type filters carry an explicit `providers: [AWS|GCP|AZURE]` dimension. Automated dependency discovery (beta) infers edges from AWS, Azure Resources, Datadog, Dynatrace, GCP, New Relic.

**Integrations (~54 documented):** anthropic, apiiro, argocd, aws, axon-relay, azuredevops, azureresources, bamboohr, bitbucket, bugsnag, buildkite, checkmarx, circleci, clickup, codecov, coralogix, datadog, dynatrace, entraid, firehydrant, github, gitlab, google, grafana, harness, humanitec, incidentio, instana, jenkins, jira, kubernetes, launchdarkly, lightstep, mend, microsoftteams, newrelic, okta, opsgenie, pagerduty, prometheus, rollbar, rootly, semgrep, sentry, servicenow, slack, snyk, sonarqube, splunk-observability, splunk-oncall, sumologic, syntasso, veracode, webhook, wiz, workday, xmatters. (Anthropic integration ingests Claude Code usage via Console admin key or Enterprise analytics key — AI-adoption measurement, not agent integration.)

---

## 7. Scorecards, CQL, Eng Intelligence (feature detail)

**Scorecards.** Four parts: entity scope (type + groups + CQL), rules, levels-or-points, and an evaluation window (default 4h). Rules are boolean; each can carry a failure message (with `context.entity.id` templating to deep-link), a scheduled start date (announce before it counts), a group filter, and per-entity exemptions (request → approve/deny/revoke, all API-driven). Levels are ordered and gated (must pass all rules at and below a level); points are weighted and independent; both can be combined. Authoring via form builder (pre-configured rules per integration), CQL editor, or **Scorecards as code** in `.cortex/scorecards`. Shields.io badge endpoint per entity. `getScorecardNextStepsForEntity` returns what an entity needs to reach its next level. Filter schema in the Terraform provider v0.5.0 is `{types: {include, exclude}, groups: {include, exclude}, query}` — the old `category` field was removed.

**CQL** is the query layer and the most distinctive piece. A proprietary DSL over four source classes — entity metadata, integrations, custom data, custom metrics — with `AND/OR/!`, arithmetic, `map()`/aggregations, **embedded JQ** (*"arbitrary JSON manipulations… Cortex can transition seamlessly between CQL and JQ data types"*), and **captures** (bind sub-expressions to variables so a failure message can explain *why* it failed). Uses: Scorecard rules, CQL reports, plugin visibility, catalog/verification/Scorecard scoping. Tooling: Query builder, CQL explorer, per-entity test runner (up to 10 entities). Permission-gated: integration-touching queries require Scorecard-edit permission. Exposed via `POST /api/v1/queries` as an async job.

**Eng Intelligence.** DORA dashboard, Velocity dashboard, AI Impact (GitHub Copilot) dashboard, custom dashboards, Data Explorer (chart + table views), custom metrics, legacy All Metrics table. Metric families: AI tools (adoption rate, active AI users, auto-labels users `AI User`/`Non-AI User`), deployment (change failure rate, deployment frequency, rollback frequency), incidents (frequency, time to resolution — from PagerDuty), project management (story points completed, work item lead time, items created/completed — from Jira), version control (cycle time, opened/closed/merged PRs, PR size, comments per PR, unique authors, PR reviews count, success rate, time to open / first review / approve / merge — from GitHub, GitLab, Azure DevOps, Bitbucket, with PR size and cycle time unsupported on ADO/Bitbucket). Data Explorer **table view** can put custom data keys, custom entity-type schema fields, entity metadata, and **Scorecard score %/level** side by side with metrics. `getTraceEvents`/`listMetricDefinitions`/`queryPointInTimeMetrics` make all of this API-addressable — `listMetricDefinitions` is explicitly a discovery endpoint ("Use this before querying metrics to understand what data is available").

**Workflows** — visual multi-step automation. Core blocks (async HTTP + callback, branch, JQ data transformation, HTTP, JavaScript, manual approval, run workflow, scaffolder, set variables, user input), Cortex blocks (create/update entity, add custom data, list deploys, get Scorecard scores — running as the initiating user's permissions), integration blocks. Run state = `{context, actions}`. Workflows-as-code in `.cortex/workflows`. Request signing supported. `runWorkflow` is API-triggerable.

**Plugins** — a single HTML file rendered in a sandboxed iframe, with a **plugin proxy** that handles CORS and injects secrets server-side, plus context about the current entity/page. CQL controls which entities a plugin appears on. There is a Plugin Marketplace and a documented **Backstage plugin migration** path (`cortexapps/backstage-plugin`, 40 stars).

**Scaffolder** — Cookiecutter-based templating, registerable and runnable from Workflows, with a GitHub-repo→Cookiecutter converter.

---

## 8. Deployment, security, licensing

Cloud (`app.getcortexapp.com`) or **self-managed** Helm chart into your own Kubernetes (EKS/AKS/GKE/self-hosted), PostgreSQL 15+, minimum 2× backend (8 GB each), 1× worker (8 GB), 1× frontend; requires a GitHub PAT and a **JWT license key** from the Cortex account team. Support window: *"we only offer dedicated support for releases up to two months prior to the current release version."* Some features are cloud-only (AI tool metrics, several betas).

Access control: SSO (Okta, Entra ID, Google, generic OIDC), SCIM provisioning (Okta, Entra ID), roles + **custom roles**, identity mapping, IP allowlist, audit logs, secrets store, personal tokens. Permission names are granular and documented (`Edit Entities`, `Edit Entity Types`, `Enable Entity Dependency Discovery`, `Configure verification periods`, `Enable AI Chat`, `View Eng Intelligence`, `Configure Integrations`, `Configure Plugin Appearance`, `View GitOps Logs`…).

**Pricing:** not published. `cortex.io/pricing` states only *"Cortex uses a per-seat model with pricing that scales based on org size. Pricing is customized"* / *"Custom pricing — Reach out and we'll build a quote that fits."* No tiers, no list prices, no free tier or trial disclosed on that page.

**Open source footprint:** `cortex-mcp` (MIT), `cli` (Python), `axon` + `axon-go` (Go), `terraform-provider-cortex` (Go), `backstage-plugin`, ~10 sample plugins, `scorecard-library`. The product itself is closed source. Separately, the `cortexapps` GitHub org hosts **`engrams`** (AGPL-3.0, Rust, `engramsfactory.com`, created 2026-04-27, actively pushed) — a self-hosted Firecracker-microVM orchestrator for AI coding agents with snapshot/restore, a dashboard, CLI, 24 connectors, and trigger-driven automations. It is not part of the Cortex IDP product and is not referenced in Cortex docs, but it indicates where the company's agent-infrastructure attention is going.

---

## 9. AI features (current state, 2026-09)

- **Cortex AI Chat** — Research Preview, invite-gated. In-sidebar (⌘J) and full-page. Page-aware grounding ("who owns this?"). Reaches catalog, Scorecards, Initiatives, Workflows, Eng Intelligence metrics, and Cortex's own public docs. Conversations are private to the user. **Cannot take action**: *"It won't create or edit Scorecards, Initiatives, Dashboards, or Workflows."* Critical permission caveat: *"Cortex AI is not limited to the entities you can see… anyone with the `Enable AI Chat` permission can ask about any metric or scorecard score for any entity in your workspace, including ones hidden from them elsewhere."*
- **Slack AI Assistant** — `@Cortex` in channel or DM.
- **Cortex MCP** — read-only (§4).
- **OpEx Review Agent** — Public Beta. Scheduled agent that analyses Cortex data organised by the DRIVE pillars, produces a narrated executive briefing per period, AI insights per metric explaining movement, embedded dashboards, drill-in chat, shareable point-in-time reports.
- **Ownership Recommendations** — Research Preview, ML over Git activity, bulk-acceptable.
- **AI governance / AI readiness / AI maturity solution tracks** — Scorecard rule libraries and dashboards for governing *other people's* AI adoption (Copilot metrics, Anthropic/Claude Code usage ingestion, AI security control Scorecards).

Net: Cortex's AI is **read, summarise, recommend** — it does not write to the catalog. Every documented AI output either stays in chat, or is a recommendation that a human accepts and (per Cortex's own guidance) then attests to via a verification period.

---

## 10. Where the model has hard edges

- Relationship **edges carry no user properties** (only dependencies do, via `metadata`). No edge-level provenance, timestamp, or confidence.
- **No historical Scorecard data** ("isn't supported yet"). Catalog state is current-only; history lives only in metrics/trace and the log surfaces.
- **No per-fact confidence or contradiction surfacing.** Multi-source dependency data is unioned silently; custom-data keys are last-writer-wins by precedence; descriptor-vs-API conflicts hard-error rather than reconcile.
- Custom entity types cannot be created via GitOps.
- Entity write is descriptor-shaped; no field-level PATCH of arbitrary descriptor fields other than the merge-PATCH.
- MCP is read-only and does not expose `runWorkflow`, so an external agent cannot make Cortex *act* through the MCP — only through the REST API with an API key.
- CQL is proprietary and undocumented outside the in-product CQL explorer (grammar and full function list are not in the public docs tree).

---

## Sources consulted

- https://docs.cortex.io/llms.txt (full docs index, 2026-09-24)
- https://docs.cortex.io/readme.md, /get-started/quickstart.md
- https://docs.cortex.io/get-started/cortex-ai-assistant.md, /mcp.md, /mcp/configuring-cortex-mcp.md, /mcp/using-cortex-mcp.md, /cortex-ai-chat.md, /library.md
- https://docs.cortex.io/ingesting-data-into-cortex/entities-overview.md and the full `entities/*` subtree (yaml, adding-entities, entity-types, creating-custom-entities, managing-custom-entity-types, dependencies, ownership, ownership-inheritance, defining-relationship-types, groups, custom-data, discovery-audit, relationship-graph, archiving-entities/auto-archive, external-docs, deploys, terraform, terraform-provider, details)
- https://docs.cortex.io/ingesting-data-into-cortex/catalogs.md, /integrations.md, /integrations/axon-relay.md, /integrations/anthropic.md, /integrations/webhook.md, /integrations/aws/importing-entities-from-aws.md, /integrations/kubernetes/connecting-entities-to-kubernetes.md
- https://docs.cortex.io/standardize/scorecards.md (+ create, evaluate, scorecards-as-code, rule-exemptions), /standardize/cql.md, /cql/using-jq.md
- https://docs.cortex.io/improve/eng-intelligence.md (+ data-explorer, available-metrics-in-data-explorer, custom-metrics, dashboards), /improve/initiatives.md, /improve/opex-review.md
- https://docs.cortex.io/streamline/workflows.md, /streamline/plugins.md
- https://docs.cortex.io/configure/gitops.md, /configure/settings/entity-settings/verification.md, /configure/cortex-command-line-interface.md
- https://docs.cortex.io/api/readme.md and all 81 pages under /api/readme/* (inline OpenAPI fragments extracted programmatically → 520 operations)
- https://docs.cortex.io/resources/beta.md, https://docs.cortex.io/self-managed.md, https://docs.cortex.io/solutions/drive-framework.md
- https://docs.cortex.io/guides/ai-excellence/verify-auto-mappings.md
- https://github.com/cortexapps/cortex-mcp (server.py, src/server.py, src/config.py, src/routes/mappers.py, README.md, swagger.json — 918 KB, 190 paths / 316 ops; git log through 2026-01-08)
- https://github.com/cortexapps/terraform-provider-cortex (provider.go, docs/*, CHANGELOG.md v0.5.0)
- https://api.github.com/orgs/cortexapps/repos (59 public repos), https://github.com/cortexapps/engrams README
- https://www.cortex.io/pricing
