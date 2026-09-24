# Pulumi Insights / Pulumi Cloud — Research Dossier

**Researched:** 2026-09-24. Docs pages generated for Pulumi CLI **v3.264.0**. Graph contract `schemaVersion` observed in docs examples: `2026-07-29` / `2026-08-25`. OpenAPI spec fetched live from `https://api.pulumi.com/api/openapi/pulumi-spec.json` (OpenAPI 3.0.3, 479 paths, 819 schemas).

> Naming note: the product formerly marketed as **Pulumi Insights** has been renamed in the docs IA to **Discovery & governance** (`/docs/discovery-governance/`). `/docs/insights/*` now redirects there. The API surface, CLI verbs (`pulumi insights …`) and REST paths (`/api/preview/insights/...`) still say "insights". **Pulumi Copilot** is gone: `/docs/pulumi-cloud/copilot/` 301-redirects to the Neo product page. Copilot's residue survives only as CLI capability flags (`copilot-summarize-error`, `copilot-explain-preview`) and the `AgentTask` schema description ("A Pulumi Copilot agent task").

---

## 1. What it actually is

Pulumi Cloud is the SaaS control plane for Pulumi IaC. Layered on it are three things relevant here:

1. **Discovery** — agentless scanners that authenticate to cloud accounts via Pulumi ESC and upsert every resource they find into a per-org index, whether or not Pulumi manages it.
2. **Resource Search / Property Search** — a Lucene-subset query language over that index (IaC state + discovered resources, unified).
3. **Context API** — a read-only *graph* query API (public preview, contract dated 2026-08-26 launch) over resources and stacks connected by typed edges.

On top sits **Neo**, an agent (Claude models, default via Amazon Bedrock) that consumes all three and writes changes back as *code* through pull requests.

---

## 2. Data model

### 2.1 Resource Search index (`ResourceResult`, from the OpenAPI spec)

Fields: `created`, `custom`, `delete`, `dependencies[]` (URNs), `external`, `id`, `matches`, `modified`, `module`, `name`, `package`, `parent_urn`, `pending`, `project`, `protected`, `provider_urn`, `stack`, `type`, `urn`, `teams[]`, `properties` (full input/output JSON, opt-in), `metadata`, `category`, `account`, `dependents[]`, `managed`, `fingerprint`, `sourceCount`.

Two fields carry the provenance story:
- **`managed`** — *"'Pulumi' for a resource in a Pulumi IaC stack, 'Terraform' / 'CloudFormation' / 'ARM' for one discovered under another IaC tool, and 'Other' for one Insights scanning found under no known tool."* (The UI collapses this to Pulumi / Other.)
- **`sourceCount`** — a resource can be seen by multiple sources (an IaC stack *and* a Discovery scan). `collapse=true` consolidates them; the UI shows a "spoke" icon. Under group-by, a consolidated resource can appear in **multiple** groups.

Queryable fields (docs): `category`, `created`, `custom`, `delete`, `dependency`, `id`, `modified`, `name`, `package`, `parent.urn`, `pending`, `project`, `protected`, `provider.urn`, `stack`, `type`, `urn`, `version`, plus `team`, `module`, `provider`, `managed`. Rule of thumb from docs: *"any column visible in the UI can be queried as a field by taking the lowercase column name and adding a `:`"*.

Query language: implicit AND; `OR` with left-to-right precedence; parentheses; negation (`-foo`, `-name:foo`, `name:-foo` all equivalent); exact match via double quotes; range queries on `created`/`modified` (`>=`, `<=`, `[a to b]`, relative `>now-30d`); **existence** queries (`team:`, `.tags:`) and non-existence (`-.tags:`); **property queries** with a leading dot over inputs/outputs, including nested paths, quoted keys with spaces (`.tags["name containing spaces"]:value`) and array wildcards (`.foo[*].bar:baz`). Outputs take precedence over inputs. Specific array indices are **not** supported. Wildcards, fuzzy, boosting, field grouping are **not** supported (per the MCP tool's own prompt, which documents the strict subset verbatim).

### 2.2 Context API graph

Two node types only: `resource` and `stack`. Six edge types:

| edge | asserts | directions | hops |
|---|---|---|---|
| `reference` | dependent → dependency (declared) | in/out/both | multi |
| `inferred_reference` | possible dependent → dependency (inferred) | in/out/both | multi |
| `parent` | child → parent | in/out/both | multi |
| `provided_by` | managed resource → provider | in/out/both | **1** |
| `in_stack` | resource → stack | out only | 1 |
| `consumes_outputs_of` | consumer stack → producer stack | in/out | multi |

Each edge type carries a `basis` of `declared` or `inferred` — the schema distinguishes asserted facts from engine guesses, and the docs tell you to treat inferred references as *"leads to verify."*

Node identity: Pulumi URN for IaC resources, an **Insights URN** for discovered resources, `stack:<org>/<project>/<stack>` for stacks — with an explicit trap documented: selectors take the **org-free** `project/stack` form and reject the org-qualified one.

### 2.3 Discovery-side model (`/api/preview/insights/...`)

`InsightsResourceWithVersion`: `account`, `type`, `id`, **`version`** (monotonic integer), `modified`, `state` (raw JSON), `policyState`. Resources are **versioned**, and edges are versioned with them: `InsightsResourceVersionEdge` = `{sourceUrn, sourceVersion, destUrn, edgeType}`. There are endpoints to list versions, read a specific version, list that version's edges, and update policy results *per version*.

Schema extensibility: **none at the entity level for users.** You cannot define entity types or edge types. The vocabulary is fixed in code and published by `GET /api/insights/graph/schema`, which returns `nodeTypes[]` with `selectableFields` / `projectableFields` / `groupByFields` / `identity` / `fieldValues`, `edgeTypes[]` with `asserts` / `singleHop` / `directions` / `basis`, `metricOps[]` and `limits`. The only user-extensible axes are **stack tags** (arbitrary key/value, plus built-ins `pulumi:project`, `pulumi:runtime`, `gitHub:owner`, `gitHub:repo`, `vcs:owner`, `vcs:repo`, `vcs:kind`), **Insights account tags** (`GET/PUT .../accounts/{name}/tags`), and cloud-native resource tags surfaced through property search.

---

## 3. Context API mechanics (the most interesting surface)

`POST /api/insights/{orgName}/graph/query`, or `pulumi api GraphQuery --input query.json` (CLI ≥ v3.243.0). Clauses: `scope`, `anchor` (required), `traverse[]`, `aggregate`, `return`, `page`.

- **anchor**: `nodeType` + either a structured `match` (`type` token + `fields` predicates with ops `eq`, `in`, `lt`, `lte`, `gt`, `gte`, `present`, `absent`; `provider_version` compares semver) **or** a Resource Search `query` string. Omit both and you select everything visible.
- **scope**: `stacks[]` (`project/stack`, `project/*`), `accounts[]` (hierarchical — naming a parent selects descendants), `includeDiscovered` (default true). Scope bounds *anchor selection only*; **traversal can leave the scope**.
- **traverse[]**: `edgeTypes[]`, `direction`, `depth{min,max}`, `target.match` / `target.absent`, `alias`. `target.absent: true` (final step only) answers "has no reachable X".
- **aggregate**: `groupBy` (1–2 fields) + `metrics` — `count` is the only op. Not combinable with traversal.
- **return**: `select` (frontier names), `fields` (projection), `paths` (evidence paths, ≤500).

Hard engine limits: 4 traverse steps, depth.max 6, 100 scope stacks, 100 scope accounts, 2 groupBy fields, 1,000 anchors/buckets, 8,000 nodes per traversal level, 20,000 total nodes, 80,000 edge crossings, 500 paths, page size 1,000.

**Provenance & epistemics are first-class.** Every response carries `meta.resultMode` (`exact` | `truncated`), `meta.visibility` (`complete` | `trimmed` — RBAC filtering detected), `meta.schemaVersion` (dated contract revision), `pageInfo.continuationToken`, plus per-node `frontier[]` and `fieldsUnavailable`. The docs are unusually blunt: *"Do not use a truncated result, a trimmed traversal, or an unread continuation page to prove absence, produce an exhaustive cleanup list, report a complete total, or claim to have identified the full impact of a change."* And: *"Even after every page reports exact and, for a traversal, complete, the answer depends on the selector and the caller's RBAC permissions. Indexing lag, relationships the graph does not model, inferred relationships, and graph changes between pages can lead to misleading or outdated results."* Edge pagination is explicitly cumulative and *"a drain over changing data may not be complete."*

Errors are informative: `402` *"The context API requires an Enterprise subscription or similar"*, `404` *"The context API is off for this installation, it has no search cluster, or the path matches no route"*, `409` self-hosted license.

`GET /api/insights/graph/schema` also serves `Accept: text/markdown` — a **primer written for agents**, cached 24h by the CLI (`--refresh-spec` to bust).

---

## 4. Account scanning of non-Pulumi resources

Providers: **AWS, Azure, Google Cloud, OCI, Kubernetes** (enum in `CreateInsightsAccountRequest`: `aws`, `gcp`, `azure-native`, `oci`, `kubernetes`). Credentials live in a Pulumi **ESC** environment referenced as `project/environment[@version]`; AWS/Azure/GCP use OIDC (AWS wants `ReadOnlyAccess`, GCP `Viewer`, K8s needs cluster-scoped `get`/`list`).

`scanSchedule` enum: `none` | `12h` | `daily`. Scans start immediately on account creation. AWS regions become child accounts (`my-aws-account/us-east-1`); parent actions cascade. Bulk onboarding wizard (changelog 2026-07-23) enumerates an AWS Organization / Azure tenant / GCP org. Scans can run on **customer-managed workflow runners** (Enterprise) with `enabled_workflow_types: [insights_scan, policy_evaluation]` for data residency and private-VPC reach.

**Discovered stacks** (changelog 2026-07-30): CloudFormation stacks and ARM deployments are grouped into synthetic stacks, each resource mapped to its Pulumi shape with a computed `MigrationStatus` — `Migrated`, `PulumiOnly`, `Ready`, `NotFound`, `NoMatch`, `NotApplicable` (plus deprecated `Pending`, `Unmapped`). Users can annotate (`UpsertResourceMigrationAnnotation`: free-text `note`, `statusOverride` — only `Migrated` is a legal override — and `linkedResourceUrn`).

---

## 5. Resource → code linkage

This is **indirect and coarse**. There is no symbol-level or file-level mapping from a cloud resource to the line of code that declares it. What exists:

- Resource → stack (`in_stack` edge / `stack` + `project` fields) → stack **tags** `vcs:owner`, `vcs:repo`, `vcs:kind`, `gitHub:owner`, `gitHub:repo`, auto-populated on each update. So repo attribution is per-stack, not per-resource.
- The MCP `resource-search` tool's own prompt admits the gap: *"Resources may not have a repository url. This means that there is no available information about the repository that the resource is associated with."*
- **Visual Import** goes the other direction: select discovered resources → review referenced resources (grouped by `from`/`to` relationship) → `POST /api/preview/insights/{org}/import/code/generate` with `{language, urns[]}` returns `{code}` — a single file with `import` properties set, in TypeScript/Python/Go/C#/Java/YAML. An "Enhance" button hands the generated code to **Neo** for naming, comments, and cross-references. After `pulumi up`, the resources become Pulumi-managed.
- Neo reads repositories directly (clone + `AGENTS.md`), so *the agent* resolves resource→code at task time; the platform does not persist that mapping.

---

## 6. Write capability

**Graph/search APIs are read-only.** But the Discovery subsystem has a real write path: `POST /api/preview/insights/{org}/accounts/{account}/resources` — `UpsertInsightsResources` — *"Used by scanners to report resource state."* Body is `{resources: [{type, id, inputs, state, dependencies[], providerVersion}]}`, all raw JSON. That is a documented (preview) ingestion endpoint an external system could use to push its own inventory into the Pulumi graph. Also writable: `UpdateResourceVersionPolicyResults` (PUT policy results onto a resource version), account CRUD, scan trigger/cancel/pause/resume, account tags/teams, migration annotations, Services CRUD (arbitrary groupings of Pulumi Cloud items), policy issue `PATCH`, and Neo task create/respond/update/cancel.

There is also an **agent self-signup** flow (`GET /api/agents/signup/challenge` → proof-of-work → `POST /api/agents/signup`) that provisions a pre-claim Pulumi Individual Account and returns a token plus a human claim URL — designed for a CLI that detects it is running for an agent with no credentials.

---

## 7. Neo, MCP, and agent surface

**Hosted MCP server**: `https://mcp.ai.pulumi.com/mcp`, HTTP transport, OAuth / access token. Tools per docs — read: `get-stacks`, `resource-search`, `get-policy-violations`, `get-users`, `get-type`, `get-resource`, `get-function`, `list-resources`, `list-functions`; write/side-effecting: `neo-task-launcher`, `neo-get-tasks`, `neo-continue-task`, `neo-reset-conversation`, `deploy-to-aws`.

**Local MCP server** `@pulumi/mcp-server` **v0.2.0** (npm, published 2025-09-26; also `mcp/pulumi` Docker image; stdio + HTTP): `pulumi-registry-{list-resources,list-functions,get-resource,get-function,get-type}` (read), `pulumi-cli-{preview,refresh,stack-output}` (read/side-effecting), **`pulumi-cli-up` (write — deploys)**, `pulumi-resource-search` (read), `neo-task-launcher` (write). Prompts: `deploy-to-aws`, `convert-terraform-to-typescript`. Verified by decompiling `dist/index.js`.

**Neo**: surfaces are console, `pulumi neo` CLI, editors via Agent Client Protocol (Zed/JetBrains/VS Code/Cursor), Slack `@Neo`, GitHub PR `@pulumi-neo`, REST (`/api/preview/agents/{org}/tasks`, with SSE `…/events/stream`), and other agents via MCP or the `pulumi-neo-handoff` skill. Controls are two orthogonal axes: **permission mode** (`default` | `read-only`) and **approval mode** (`manual`/Review | `balanced` | `auto`), plus Plan Mode. Approval gates cover only `pulumi preview`, `pulumi up`, and opening a PR — *"During the investigation phase it reads state, opens ESC environments, and reaches the cloud accounts… without prompting."* And the sharpest caveat: *"'Read-only' is scoped to Pulumi Cloud, not to your cloud accounts."* Tasks can assume a single RBAC role you already hold (Pro/Enterprise). `agentDefinitionId` in the API reveals a preview **Custom Agents** capability, gated per org.

Automations (Pro/Enterprise) turn a prompt into a cron task (hourly/daily/weekdays/weekly), defaulting to auto-approval + read-only. Integrations: Atlassian, Datadog, Honeycomb, Linear, PagerDuty, Supabase over MCP, plus admin-configured CLI integrations run via `pulumi env run` as the acting user. Credentials are encrypted per-org and *"never exposed to the language model"* — a stronger guarantee than ESC secrets get. BYOK (Enterprise): Anthropic, Azure Foundry, or any Anthropic-Messages-compatible HTTPS endpoint, with a default and a "fast" (Haiku) model.

**Agent Skills**: an open-standard (agentskills.io) catalog in `pulumi/agent-skills`, built into Neo and installable into Claude Code/Codex/Cursor/Copilot/Gemini/Junie. 16 skills across Migration (terraform/cdk/cloudformation/arm/discovered-stack), Pulumi (overview, best-practices, component, automation-api, esc, debug-failed-operation, package-usage, provider-upgrade), Package Maintenance, Delegation (`pulumi-neo-handoff`).

---

## 8. Pricing (pulumi.com/pricing, read 2026-09-24)

Free $0 · Essentials $40/mo (40 credits) · Pro $400/mo (400) · Enterprise $2,000/mo (2,000). 1 credit = $1. Managed IaC resource-hours: $0.00025 / from $0.0005 / from $0.00075. **Discovered** resource-hours: free / $0.000025 / from $0.00005 / $0.000075 ($0.0185–$0.055 per resource-month). Workflow minutes (shared with Deployments): 500 free, then $0.01/min. Neo: **$3 per million tokens**, BYOK on Enterprise only. Free edition explicitly excludes *"Pulumi Neo, Resource Search, or Property Search."* Conformance packs (CIS, CIS Kubernetes, CMMC, HITRUST, ISO 27001, NIST, PCI DSS) and self-hosting are Enterprise. Data export and preventative policies are Pro+. Neo usage caps: $10–$1,000,000/month org-wide, optional per-member, email alerts at 50/80/95/100%.

---

## 9. Competitive glance

**HCP Terraform / Terraform Enterprise — Explorer.** `GET /organizations/:org/explorer` with four fixed views: `workspaces`, `tf_versions`, `providers`, `modules`. Operators: `is`, `is_not`, `contains`, `does_not_contain`, `is_empty`, `is_not_empty`, `gt`, `lt`, `gteq`, `lteq`, `is_before`, `is_after`, `is_within`. CSV export at `/explorer/export/csv`. Saved views. 60-second query timeout, rate-limited, *"eventually consistent."* Separately, HCP Terraform has search-and-import for discovering unmanaged cloud resources and generating config. Critically: **Explorer's unit is the workspace, not the resource, and there is no graph traversal API** — no edges, no dependency walk, no evidence paths.

**Firefly.** Cloud asset management built around a four-state classification: `managed` (codified) / `unmanaged` / `ghost` (deleted but still in code) / `modified` (drifted) — a taxonomy Pulumi lacks (Pulumi's `managed` field names the *tool*, not the drift state). REST: `POST /api/inventory`, `GET /api/inventory/{assetId}`, `GET /api/inventory/providers`, `POST /api/inventory/iac-coverage`. MCP server `@fireflyai/firefly-mcp` v1.1.8 (2025-11-13, MIT, `gofireflyio/firefly-mcp`) exposes exactly six tools: `firefly_inventory` (read; filters `assetTypes[]`, `assetState`, `providerIds[]`, `assetNames[]`, `arns[]`, `modifiedSince`, `freeTextSearch`, `responseSize` ≤100,000), `firefly_codify` (generates Terraform/Pulumi/CloudFormation/K8s), and `firefly_get_policies` / `firefly_create_policy` / `firefly_update_policy` / `firefly_delete_policy` (three writes). Broader source coverage than Pulumi (AWS, GCP, K8s, Datadog, GitHub, Akamai, Okta…), but no documented graph traversal API.

---

## 10. Honest limits vs. a "living knowledge graph" concept

- Schema is **closed**. Two node types, six edge types, one metric op (`count`). No user-defined entities, no user-defined relationships, no custom properties beyond tags.
- **Temporality is thin.** Discovered resources are versioned (`version`, `ListResourceVersions`, versioned edges) and RUM/RHUM usage is time-series, but the *search index and the Context API are point-in-time*. There is no "as of" query, no diff-between-two-times, no edge validity intervals in the query language.
- **No contradiction model.** Multi-source resources are *collapsed* (`sourceCount`, `collapse=true`), not reconciled — the API does not tell you that two sources disagree about a property.
- **Staleness** is a scan-schedule property (12h/daily) plus `modified` timestamps; there is no confidence score, no per-fact source attribution, no decay.
- Provenance that *does* exist is about **query fidelity**, not fact fidelity: `resultMode`, `visibility`, `fieldsUnavailable`, `paths` (evidence), `basis: declared|inferred`. That distinction — declared vs inferred edges, and "here is the path that proves it" — is the single best idea in the product to borrow.
