# Port (getport.io / port.io) — Research Dossier

**Research date:** 2026-09-24. Docs read at `docs.port.io` (Docusaurus, sitemap 916 URLs). OpenAPI spec pulled live from `https://api.port.io/swagger/json` (OpenAPI 3.1.0, `info.title: "Port API"`, `version: "1.0"`, 75 paths / ~130 operations). Terraform provider `v2.28.2` released 2026-09-24. MCP `server.json` version `1.0.2`, MCP spec schema `2025-12-11`. Latest changelog entry on `roadmap.getport.io/changelog`: **2026-09-09**, "What we built in August 2026".

---

## 1. What it actually is

Port is a commercial SaaS **Internal Developer Portal**, now positioned (marketing language, Sept 2026) as an "**Agentic SDLC platform**" built on three pillars: a **Context Lake** (the software catalog), **Workflows & tools** (the execution layer), and **Agent management**.

Important structural fact: **the documentation tree was reorganized**. What used to be `build-your-software-catalog` is now `/context-lake/`. "Self-service Actions & Automations" is explicitly labelled **legacy** — replaced by **Workflows** (GA per the September 2026 changelog). Both remain supported; the legacy API routes still exist.

Not open source. The core platform is closed SaaS. What *is* open source (Apache-2.0): the **Ocean** integration framework (`port-labs/ocean`, 193★, 50 integrations in-tree), the Terraform provider, the Pulumi provider, the k8s exporter, the CLI. The **remote MCP server is closed source** — `port-labs/remote-mcp-server` contains only a README and a `server.json` pointing at hosted endpoints. The old self-hostable Python MCP server (`port-labs/port-mcp-server`) is explicitly **deprecated**: *"This repository has been deprecated and is no longer actively maintained or supported."*

---

## 2. Data model — precise mechanics

Verified against the live OpenAPI `POST /v1/blueprints` request schema.

**Blueprint** = entity *type*. Required: `identifier`, `title`, `schema`. Identifier pattern `^(?!\.{1,2}$)[\p{L}0-9@_.+:\\/-]+$`, max 100 chars. Top-level keys:

- `schema.properties` / `schema.required` — JSON-Schema-ish. `type` ∈ `string | number | boolean | object | array`. `format` ∈ `date-time, url, email, idn-email, ipv4, ipv6, markdown, yaml, user, blueprints, team, timer, proto, labeled-url`. `spec` ∈ `open-api, embedded-url, async-api` (renders Swagger/AsyncAPI UI in the entity page). Property identifiers must match `^[A-Za-z0-9@_=\-]+$`.
- `relations` — `{ target, required, many, title, description, union }`. **A relation cannot be both `many: true` and `required: true`.** There is no relation *type system* beyond target + cardinality: an edge is named, typed only by its target blueprint, and carries a title/description. Self-relations are allowed.
- `mirrorProperties` — `{ path, title }` where `path` is a dot-separated chain of relation identifiers terminating in a property or meta-property (`"system.domain.domain_members"`, `"deployment-to-microservice.$title"`). This is **materialized graph traversal exposed as a flat field**.
- `calculationProperties` — `{ calculation, type, format, colorized, colors, items }`. A **JQ expression** evaluated over the entity itself.
- `aggregationProperties` — `{ target, calculationSpec, query, pathFilter }`. Functions: `count`, `sum`, `min`, `max`, `median`, `average`. `averageOf` ∈ `hour|day|week|month|total`. `pathFilter` (maxItems 1) scopes the aggregation to entities reachable along a specific relation path.
- `ownership` — either `{type: "Direct"}` (hidden relation to `_team`) or `{type: "Inherited", path: "<relation.chain>"}`.
- `changelogDestination` — `WEBHOOK` (with optional agent proxying) or `KAFKA`.
- `includeInGlobalSearch` — per-blueprint override of an org-level default.

**Entity** = instance. Fields: `identifier` (≤1000 chars), `title`, `icon`, `team`, `blueprint`, `properties`, `relations`. Meta-properties available in queries: `$identifier, $title, $team, $icon, $createdAt, $updatedAt, $createdBy, $updatedBy, $blueprint`.

**Schema extensibility:** fully user-defined and runtime-mutable. There is no fixed ontology. Port ships **default blueprints** (`service`, `environment`, `workload`, `deployment`, `organization`) that are editable, and **protected system blueprints** prefixed `_`: `_user`, `_team`, `_scorecard`, `_rule`, `_rule_result`, `_ai_agent`, `_ai_invocations`, `_ai_conversation`, `_mcp_server`, `_workflow`. System blueprints cannot be deleted; only `_user` and `_team` can be extended, and **only with relations**.

**Scale limits:** 5 million `_rule_result` entities max. Plan entity caps: 10k (Free) / 50k (Basic) / 250k (Standard) / 1M+ (Enterprise). Scorecard rule-result sync "can take up to 24 hours" on large blueprints.

---

## 3. Graph / dependency query capability

This is genuinely one of Port's stronger areas. Query DSL is a JSON `{combinator, rules}` tree, **nestable** (a rule may itself be `{combinator, rules}`), with **no short-circuit evaluation** (documented explicitly).

Comparison operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `isEmpty`, `isNotEmpty`, `propertySchema`, `between`, `notBetween`, `contains`, `doesNotContains`, `containsAny`, `beginsWith`, `doesNotBeginsWith`, `endsWith`, `doesNotEndsWith`, `in`, `notIn`. Date rules accept presets (`lastWeek`, `last3Months`, `last3Years`, `nextMonth`, …).

Relation operators:
- `relatedTo` with `blueprint` + `value` (single or array), plus modifiers `required: true|false` and **`direction: "upstream" | "downstream"`** — this is the dependency-graph traversal primitive.
- `matchAny` — identifier matching.
- **Path queries**: `{"property": {"path": ["rel1","rel2","rel3"], "fromBlueprint": "..."}, "operator": "matchAny", "value": ...}`. `fromBlueprint` inverts the traversal direction.
- **`maxHops`** for self-relations: variable-depth traversal, **1–15 hops**, usable **once per path**, mixable with fixed hops.

Also available: `POST /v1/entities/search` (cross-blueprint), `POST /v1/blueprints/{bp}/entities/search` (+ `/count`), filters by `relation`, `scorecard`, and `scorecardRule`, and `POST /v1/entities/aggregate` with `countValues` grouped by property / relation / scorecard / scorecard-rule.

**Contextual query rules** inject the caller's identity at evaluation time: `{"context": "user" | "userTeams", "property": "..."}` usable in either the `property` or `value` slot. This replaces the deprecated `{{getUserTeams()}}` dynamic-property syntax and works in API requests, catalog page filters, dashboard widgets, and action input datasets.

**What it is not:** there is no Cypher/GQL/SPARQL surface, no path-finding or shortest-path, no subgraph extraction endpoint, no graph-native storage exposed. Traversal is bounded, declarative, and path-explicit.

---

## 4. Write capability for an external agent or API client

Extensive. Authentication: `POST /v1/auth/access_token` with client ID/secret; Bearer JWT; OAuth scopes appear on operations (`create:blueprints`, `read:entities`, …).

**Entity upsert** — `POST /v1/blueprints/{bp}/entities` with query params:
- `upsert` (required param, default `false`) — overwrite whole entity if it exists
- `merge` — with `upsert=true`, merge rather than replace
- `create_missing_related_entities` — create related entities that don't exist yet
- `validation_only` — dry run, return validation errors only
- `delete_dependents` (on DELETE) — cascade
- `run_id`, `node_run_identifier` — tie writes to an action/workflow run
- `ocean_info_event_type`, `ocean_info_resync_id` — sync provenance hints

Bulk: `POST .../entities/bulk`, **max 20 entities per request**, returns `207 Multi-Status` for partial success. Bulk delete: `POST .../bulk/entities/delete` (docs say up to 100). Also `DELETE /v1/blueprints/{bp}/all-entities`.

**Search-query-as-identifier**: the `identifier`, `team`, and `relations` fields each accept a *search query object* instead of a literal string, so a writer can say "attach to whichever entity has `pagerduty_service_id = X`". Constraints: must resolve to exactly one entity, only `=` and `in` operators, no calculation/mirror properties, no entity creation on empty result.

Everything else is writable too: blueprints (POST/PUT/PATCH/DELETE, plus `rename` endpoints for properties, relations, and mirror properties that preserve data), scorecards, scorecard groups, pages, widgets, sidebar folders, teams, users, webhooks, integrations and their mapping config, org secrets, migrations, and workflows. Workflow updates support **optimistic concurrency** via an `If-Match: wfv_...` header returning `412 workflow_version_conflict`.

**Rate limits** (org-level, 5-minute windows): entities 35,000; blueprints 15,000; entity search 35,000; **single entity upsert 10,000 (burst 200)**; bulk upsert 35,000; everything else 15,000; unauthenticated 100. Headers: `x-ratelimit-period/limit/remaining/reset`.

**MCP write tools** (remote server, `https://mcp.port.io/v1` EU / `https://mcp.us.port.io/v1` US). Tool sets are role-scoped (Developer vs Builder). Builder-only **write** tools: `upsert_entity`, `upsert_blueprint`, `delete_entity`, `delete_blueprint`, `upsert_action`, `delete_action`, `upsert_workflow`, `delete_workflow`, `update_action_permissions`, `upsert_scorecard`, `delete_scorecard`, `trigger_auto_discovery`, `upsert_dashboard_page`, `upsert_widget`, `update_entity_page`, `upsert_sidebar_folder`, `delete_sidebar_folder`, `delete_widget`, `duplicate_page`, `move_page`, `upsert_plugin`, `install_library_plugin`. Execution tools available to both roles: `trigger_run`, `run_action`. Read tools include `list_blueprints`, `list_entities`, `list_scorecards`, `list_actions`, `list_workflows`, `list_self_service_triggers`, `get_workflow_run`, `track_action_run`, `search_audit_logs`, `simulate_blueprint_permissions`, `describe_user_details`, `load_skill`, `search_port_knowledge_sources`, `get_page`, `get_sidebar`, `load_widget_schema`, and five integration-introspection tools.

Write access is gated two ways: the `x-read-only-mode: 1` header **removes write tools from the tool list entirely**, and `x-allowed-actions-to-run` restricts `run_action` to a comma-separated allowlist. Auth is OAuth 2.0 with `authorization_code`, `refresh_token`, and `client_credentials` grants (verified live at `/.well-known/oauth-authorization-server`); machine tokens live ~3 hours, no refresh token, client_credentials rate-limited to 50 req / 15 min.

---

## 5. Provenance, staleness, contradiction, temporality

**Provenance — thin but not absent.** Every entity carries `$createdBy` / `$updatedBy` / `$createdAt` / `$updatedAt` — *last writer only*, not per-field. The **audit log** (`GET /v1/audit-log`) is the real provenance store: filterable by entity, blueprint, run_id, webhookId, `origin` (which integration), `InstallationId`, resource type, action (`CREATE|UPDATE|DELETE`), status, time range — and `includes` can request a **`diff`**. `Type` values distinguish UI / API / WEBHOOK / K8S EXPORTER / GITHUB EXPORTER / GITHUB GITOPS / TERRAFORM / PULUMI / AWS EXPORTER / GH ACTION / AGGREGATION PROPERTY / PORT AUTOMATION / PORT INTERNAL. So *which system wrote this* is recoverable from logs, not from the entity itself.

**Contradiction — one real mechanism, `union`.** Array properties (`string`/`number` items only) and `many` relations and `ownership` can set `"union": true` ("Multi sources ingestion" in the UI). Each writer then writes `{"<sourceKey>": [values]}` and owns only its slice; UI edits are stored under `user:{userId}`. Reads return the **merged, deduplicated array** — the source keys are *not* returned. Documented example: Snyk writes `{"snyk": [...]}`, Dependabot writes `{"dependabot": [...]}`, Alice edits in the UI, and a GET returns the union. `null` clears a slice. **`union` cannot be toggled after creation**; `minItems`/`maxItems` unsupported. Outside `union`, the documented behaviour is blunt last-writer-wins: *"Every time an integration syncs an entity, the relation value in Port is replaced with whatever the mapping returns… If two integrations both write to the same relation, the last sync to run wins."*

**Temporality — property history exists.** `POST /v1/entities/properties-history` returns historical values for named properties over a time range, bucketed by `hour|day|isoWeek|month|quarter`, with presets up to `last3Years` and full IANA timezone support. `POST /v1/entities/aggregate-over-time` aggregates (`average|sum|min|max|median|last`) across time buckets, and aggregation properties support `averageOf: hour|day|week|month|total`. There is **no bitemporality, no valid-time vs transaction-time distinction, and no as-of query** — you cannot ask "what did the catalog look like on date X".

**Staleness — procedural, not a first-class field.** There is no per-property `last_verified` or confidence score. Freshness is a function of the sync mechanism: **full resync** (scheduled/on-demand, with reconciliation that deletes stale entities and reingests dependents), **incremental sync** (created/updated since last run), and **live events** (webhooks or source watch APIs). `entityDeletionThreshold` (0/1) gates the deletion mechanism. Removing a `kind` from a mapping does **not** delete its entities — the docs prescribe a manual 3-step cleanup and warn "Entity deletion is permanent and cannot be undone."

---

## 6. Cross-repo scope and infrastructure modeling

**Cross-repo: yes, structurally — but not as code search.** Port has no code index and no cross-repo semantic search. It models repos as *entities* and joins them by relation. GitLab v2 kinds: projects, groups, groups-with-members, projects-with-members, issues, merge-requests, files, folders, skills, plugins, members, pipelines, jobs, releases, tags, branches, deployments. GitHub, Bitbucket Cloud/Server, and Azure DevOps are comparable. Monorepos get a dedicated docs page and `folder`/`file` kinds.

Two mapping features get closest to cross-repo querying: **`includedFiles`** (fetch named files — README, CODEOWNERS — into `.__includedFiles["path"]`) and **`searchQueries`** (run GitLab Advanced Search blob queries like `filename:port.yml` and store booleans as `.__searchQueries["name"]`, for scorecard evaluation). Both are per-repo enrichment during ingestion, not ad-hoc cross-repo query.

**Infrastructure: strongly modeled.** AWS v3 (open source, hosted-by-Port or self-hosted, CloudFormation-created IAM roles, AWS Organizations account auto-discovery, GovCloud support, CloudTrail→EventBridge live events) covers 33 declared kinds including `AWS::EC2::Instance`, `AWS::EKS::Cluster`, `AWS::ECS::Service`, `AWS::RDS::DBCluster`, `AWS::Lambda::Function`, `AWS::S3::Bucket`, `AWS::DynamoDB::Table`, `AWS::MSK::Cluster`, `AWS::CodePipeline::*`, `AWS::CodeDeploy::*`. Note: v3 **does not** support custom Cloud Control API kinds (the legacy AWS exporter did). Plus Azure (incl. Azure Resource Graph), GCP, Kubernetes (with Istio/FluxCD/Knative/Kyverno/OpenShift/Trivy templates and a Port CRD), ArgoCD, Terraform Cloud/Enterprise (Organization, Project, Workspace, Run, State Version, State File, Health Assessment), Kubecost/OpenCost.

**Terraform is bidirectional.** `port-labs/terraform-provider-port-labs` v2.28.2 exposes `port_blueprint`, `port_entity`, `port_relation`, `port_aggregation_properties`, `port_action`, `port_workflow`, `port_scorecard`, `port_scorecard_group`, `port_page`, `port_folder`, `port_team`, `port_webhook`, `port_integration`, `port_organization`, `port_organization_secret`, `port_system_blueprint`, plus a `port_search` data source. `port_integration` has a documented **two-apply workflow** (create without `config`, then add `config` to override provisioned default mappings). A Pulumi provider mirrors this.

---

## 7. Ingestion & mapping

Methods: **native integrations** (~64 plug & play, most built on the open-source **Ocean** framework — Apache-2.0, 50 integrations in-tree), **MCP connectors** (query-at-runtime, no ingestion), **REST API**, **webhooks** (with signature verification), **GitOps** (`port.yml` in repos, Port CRD for k8s), **S3 ingestion**, **CI/CD steps** (GitHub Actions, GitLab, Jenkins, CircleCI, Azure Pipelines, Codefresh), **Terraform/Pulumi**, and **custom Ocean integrations**.

Mapping is YAML + **JQ**, per-resource: `kind`, `selector` (request-shaping params + a `query` JQ filter applied to the *response*), and `port.entity.mappings` (identifier, title, blueprint, properties, relations). Resources execute **sequentially top-to-bottom**, so relation targets must be listed first. `itemsToParse` / `itemsToParseName` / `itemsToParseTopLevelTransform` fan an array out into multiple entities. Global flags: `createMissingRelatedEntities`, `deleteDependentEntities`, `entityDeletionThreshold`. JQ runtime is **UTC**. A visual form editor exists alongside the YAML editor, plus a `test_integration_mapping` MCP tool and `get_integration_kinds_with_examples`.

**Catalog auto-discovery** is an LLM feature: pick a target blueprint and related blueprints, Port AI proposes create/update suggestions for review and bulk approve/decline. Limits: only the **500 most recently added entities per related blueprint**, property values truncated to **100 characters**, **Port's LLM only — no BYO-LLM**.

---

## 8. Workflows (the execution layer)

A workflow is a **directed graph of nodes + connections**. Node types: **triggers** (`SELF_SERVE_TRIGGER`, event trigger on entity create/update/delete, schedule/cron trigger, agent-tool invocation), **actions** (`WEBHOOK`, `KAFKA`, `upsert_entity`, `integration_action`, `ai`, `ai_agent`, Port execution agent), and **flow nodes** (`condition` with JQ outlets + fallback edge, `input` = human-in-the-loop pause). Multiple triggers per workflow are supported; `.outputs.trigger` is a stable alias for whichever fired. Data flows between nodes via JQ (`{{ .outputs.trigger.service }}`).

Integration action nodes are declared by each Ocean integration's `.port/spec.json` (e.g. GitLab declares `trigger_pipeline` with typed inputs). Native action nodes exist for GitHub, GitLab, Azure DevOps, Jira, Linear, Claude managed agents, and Cursor cloud agents.

**Every self-service workflow is automatically an MCP tool.** Agents call `list_self_service_triggers` (returns `workflowTitle`, `workflowDescription`, `nodeIdentifier`, and the `userInputs` JSON schema) then `trigger_run` with `{type: "WORKFLOW", identifier, nodeIdentifier, inputs}`. Permissions are identical for humans and agents, with one sharp caveat quoted verbatim: *"Agents that connect to the Port MCP server using an organization machine token (client credentials) bypass static role, user, and team checks by default — the token itself carries the authorization."* Only `policy` rules (including `workflowRun.source` = UI/API/MCP) are enforceable against machine tokens. *"Admins can always invoke all workflows regardless of the permissions configuration."*

---

## 9. AI surface

**Port AI** is an MCP *client* over Port's own MCP server. Endpoints `POST /v1/ai/invoke` and `POST /v1/agent/{id}/invoke`, both **SSE streaming** (`tool_call`, `tool_result`, `execution`, `done`). Request fields: `prompt`/`userPrompt`, `tools` (regex allowlist), `chatMode` (`ask` = read-only tools + `run_action`; `plan`; `build`), `executionMode`, `toolApprovalOverrides`, `mcpServers` (max 5), `outputSchema` (structured JSON output), `provider`/`model`, `labels`.

Approval model, three-tier with documented priority: per-invocation `toolApprovalOverrides` > persistent user preferences > MCP `readOnlyHint` annotation. Defaults: read tools automatic, write tools approval, external MCP tools approval. Paused invocations resume via `toolApprovals` entries (`approve` / `approve_with_edit` + `editedArguments` / `reject` + `rejectionReason`).

**BYO-LLM**: Anthropic, OpenAI, Azure OpenAI, Azure Anthropic, AWS Bedrock, Vertex Gemini, Vertex Anthropic, plus generic OpenAI-compatible and Anthropic-compatible endpoints. Port-managed defaults: **200 LLM calls/min, 500,000 tokens/min, 500 AI invocations/month**.

**Agent management** covers Port custom agents (`_ai_agent` entities with prompt, allowed tools, `execution_mode`, MCP-connector grants), external agents (Claude managed agents, Cursor cloud agents), an **AI registry** (MCP registry, skills registry with usage analytics, prompts), and an **AI Gateway**. Access to *any* AI feature requires Read + Register + Update on `_ai_invocations`.

---

## 10. Governance, pricing, ops

**RBAC:** roles Admin / Member / `<blueprint>-moderator`. Blueprint permissions split into `entities` (read/register/unregister/update) and per-property/per-relation `updateProperties`/`updateRelations`, each accepting `roles`, `users`, `teams`, `ownedByTeam`, and an advanced dynamic `policy`. `POST /v1/blueprints/{bp}/permissions/simulate` simulates a user's effective access. Terraform/Pulumi support everything **except** advanced dynamic `policy`. Page permissions and private pages are separate.

**Scorecards:** `{identifier, title, levels[{title,color}], rules[{identifier, title, level, description, query:{combinator, conditions[]}}], filter}`. Levels are ordered; an entity must pass *all* rules at a level to reach it. Documented gaps: **no rule weighting**, **no property-to-property comparison** (workaround: calculation property), **no file-content inspection**. Materialized as `_scorecard` / `_rule` / `_rule_result` entities with auto-created dynamic relations to the target blueprint.

**Pricing** (port.io/pricing, verified verbatim): Free $0 up to 15 seats / 10k entities / 400 runs / community support. Basic $30 per month/seat up to 50 seats / 50k entities / 400 runs / commercial support. Standard $40 per month/seat up to 200 seats / 250k entities / 1.6K runs / 5 workspaces / SSO. Enterprise custom / >1M entities / >8K runs / 20 workspaces / SSO / SCIM / Private Link / IP allowlist / 99.9% SLA. Free orgs with no sign-in for 3 months are blocked; at 5 months **permanently deleted**.

**Other:** EU (`api.port.io`) and US (`api.us.port.io`) regions, multi-org management with cross-environment migration, SSO (OIDC/SAML/LDAP: Okta, Azure AD/Entra, Google Workspace, JumpCloud, OneLogin), SCIM, audit log, usage dashboard, `port_organization_secret` secrets, Port CLI (`@port-labs/port-cli` — `port api call`, `port compare --source X --target Y --fail-on-diff`), an n8n node (`n8n-nodes-portio-experimental`), a Backstage plugin, and a plugin system with a public `port-plugins` library for custom dashboard widgets.

---

## 11. Marketed vs documented

- **Marketed:** "Context Lake", "unified engineering knowledge layer", "semantically-rich source of truth", "ontology not a schema". **Documented:** the Context Lake is explicitly *"not a separate feature, but rather the powerful result of Port's core capabilities working together."* It is the catalog + business context + RBAC + scorecards, renamed. There is no separate lake store, no embedding index, no vector search exposed.
- **Marketed:** "ontology". **Documented:** the ontology is *prose in `description` fields* plus relation titles and property-type choices. The "Define your ontology" page is a **writing-style guide**, not a formal ontology language. No classes, no inheritance, no inference, no axioms.
- **Marketed:** "100+ integrations". **Documented:** the available-integrations page enumerates **64**.
- **Marketed:** "same permissions for humans and agents". **Documented:** machine tokens bypass static role/user/team checks; only `policy` rules bind them.
