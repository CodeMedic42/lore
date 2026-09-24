# OpenTelemetry — Research Dossier

**Researched:** 2026-09-24. **Versions read:** Semantic Conventions `v1.44.0` (repo HEAD `838e414e`, 2026-09-22); Specification `v1.61.0` (released 2026-09-14; repo HEAD 2026-09-23); OTLP protobuf `v1.11.0` (2026-07-21, repo HEAD 2026-09-22); Collector releases `v0.161.0` (2026-09-16); collector-contrib HEAD 2026-09-24; Weaver `v0.26.1` (2026-09-02).

**License / cost:** Apache License 2.0 across spec, semconv, proto, collector, Weaver. CNCF project — accepted 2019-05-07, Incubating 2021-08-26, **Graduated 2026-05-11**. There is no pricing page and no commercial edition; OTel is a specification plus reference implementations. Cost lives entirely in the vendor backends that ingest OTLP.

---

## 1. What OpenTelemetry actually is

OTel is three separable things, and conflating them causes most analysis errors:

1. **A wire format and data model** (OTLP protobuf/JSON) for traces, metrics, logs, and profiles.
2. **A registry of typed attribute and entity definitions** — the semantic conventions — which is the closest thing in the industry to a vendor-neutral typed schema for running infrastructure.
3. **A pipeline runtime** (the Collector) with receivers/processors/exporters/connectors/extensions, including components that *derive* new telemetry from existing telemetry.

OTel does not store anything. There is no query language, no database, no API to read back what was sent. Every read-side capability belongs to a backend (Jaeger, Tempo, Prometheus, Datadog, Grafana, Honeycomb). This is the single most important framing fact.

---

## 2. Semantic conventions as a typed schema

**Scale (counted from `model/` at HEAD):** ~933 non-deprecated attribute definitions, 505 metric definitions, 66 span group definitions, 90 top-level namespaces, **64 entity type definitions**.

### 2.1 The entity model (the interesting part)

Since the Entities work landed, semconv YAML has a first-class `type: entity` group. Each entity has a `name` (the entity type string), a `stability`, and attributes tagged `role: identifying` or `role: descriptive`. Example, verbatim from `model/service/entities.yaml`:

```yaml
- id: entity.service
  type: entity
  name: service
  brief: A logical unit of an application or system that performs a specific function.
  stability: stable
  attributes:
    - ref: service.name
      requirement_level: required
      role: identifying
    - ref: service.version
      role: descriptive
    - ref: service.criticality
      requirement_level: recommended
      role: descriptive
```

The 64 entity types: `service`, `service.instance`, `service.namespace`, `host`, `host.cpu`, `process`, `process.executable`, `process.runtime`, `container`, `container.image`, `container.runtime`, `deployment`, `os`, `device`, `app`, `android`, `browser`, `browser.document`, `webengine`, `faas`, `cloud`, `telemetry.sdk`, `telemetry.distro`, `otel.scope`, `zos.software`, `heroku`; Kubernetes: `k8s.cluster`, `k8s.node`, `k8s.node.system_container`, `k8s.namespace`, `k8s.pod`, `k8s.container`, `k8s.deployment`, `k8s.replicaset`, `k8s.replicationcontroller`, `k8s.statefulset`, `k8s.daemonset`, `k8s.job`, `k8s.cronjob`, `k8s.hpa`, `k8s.service`, `k8s.persistentvolume`, `k8s.persistentvolumeclaim`, `k8s.resourcequota`, `openshift.clusterquota`; cloud: `aws.ecs`, `aws.eks`, `aws.log`, `gcp.gce`, `gcp.gce.instance_group_manager`, `gcp.cloud_run`, `gcp.apphub.application`, `gcp.apphub.service`, `gcp.apphub.workload`, `cloudfoundry.app`/`org`/`space`/`process`/`system`; delivery: `cicd.pipeline`, `cicd.pipeline.run`, `cicd.worker`, `vcs.repository`, `vcs.ref`.

**Identity rules** (from `specification/entities/data-model.md`, status **Development**): "Minimally Sufficient Identity" — include the minimal attribute set that uniquely identifies; "Repeatable Identity" — two independent observers reporting the same entity "MUST be able to supply identical values for all identifying attributes"; and if an observer cannot reliably obtain an identifying attribute it "MUST NOT emit telemetry using that entity type." Merge rule: entities merge iff type, schema_url, and all identity attributes match exactly; descriptive attributes from the newer entity overwrite.

The canonical service identity is the triplet: `service.namespace, service.name, service.instance.id` "MUST be globally unique."

### 2.2 Wire representation

`Resource` gained `repeated EntityRef entity_refs = 3` since OTLP **v1.6.0**, status Development. `EntityRef` carries `schema_url`, `type`, `id_keys[]`, `description_keys[]` — **key references only**, not values: "entities do not carry their own key-value pairs directly. Instead, they reference keys in `resource.attributes` to remain backward compatible with OTLP 1.x."

### 2.3 Relationships — the decisive finding

The **Resource-attached entity model has no edges at all.** `specification/entities/data-model.md` says flatly: *"Entity relationship modelling will be refined in future specification work."* Confirmed structurally in Weaver's `semconv.schema.v2.json`: the `Entity` definition has properties `annotations, brief, deprecated, description, identity, note, requirement_level, stability, type` with `additionalProperties: false`. **There is no relationship field.**

`entity_associations` in metric/span/event YAML is *not* entity→entity. Its schema description: "Which resources this **metric** should be associated with… implicit `one_of`… each entry is an entity reference or a nested `one_of`/`all_of` expression." It binds a *signal* to the entity types it should be attached to (e.g. `k8s.pod.uptime` → `k8s.pod`). It is a signal-typing rule, not a topology edge.

Edges exist in exactly one place: **Entity Events** (`specification/entities/entity-events.md`, status **Development**). Two event types on the Logs data model: `entity.state` and `entity.delete`. `entity.state` carries optional `entity.relationships`, an array of `{relationship.type, entity.type, entity.id}` with explicit direction `source --[type]--> target`, source being the emitting entity. The spec states directly: *"Resource data cannot contain relationship information."*

Relationship types are an **open enumeration**: *"Standard relationship types SHOULD be defined in OpenTelemetry semantic conventions."* Grepping all of `model/` for relationship-type definitions returns **nothing** — no standard types are defined yet. The spec's illustrative examples (`scheduled_on`, `part_of`, `contains`, `depends_on`, `runs_on`, `hosts`) appear only in prose. There is a placement heuristic: put the relationship on the entity with the **shorter lifespan / higher churn** (pod→replicaset, not replicaset→pod), because each state event carries the complete current relationship array. Deletes are best-effort; receivers must expire entities using `entity.report.interval` and must tolerate out-of-order deletes.

`entity-propagation.md` adds `OTEL_ENTITIES`, an env-var grammar `type{id=v,...}[desc=v,...]@schema_url` separated by `;`, with a required `EnvEntityDetector` in SDKs — how an orchestrator pushes entity identity into a child process.

### 2.4 Database, messaging, cloud conventions

**Database** (`model/db`): 13 core attributes — `db.system.name` (41-value closed enum incl. `postgresql`, `mysql`, `mongodb`, `redis`, `neo4j`, `clickhouse`, `aws.dynamodb`, `azure.cosmosdb`, `gcp.spanner`, `microsoft.sql_server`, `oracle.db`, `elasticsearch`, `cassandra`…), plus `db.namespace`, `db.collection.name`, `db.operation.name`, `db.query.text`, `db.query.summary`, `db.query.parameter.<key>`, `db.stored_procedure.name`, `db.operation.batch.size`, `db.response.status_code`, `db.response.returned_rows`, `db.client.connection.*`. 11 metrics (`db.client.operation.duration`, connection pool family). Per-system span refinements exist for SQL Server, PostgreSQL, MySQL, MariaDB, Cassandra, HBase, CouchDB, Redis, MongoDB, Elasticsearch — all `span_kind: client`.

**Messaging** (`model/messaging`): ~40 attributes. `messaging.system` enum (`kafka`, `rabbitmq`, `rocketmq`, `pulsar`, `activemq`, `jms`, `aws_sqs`, `aws.sns`, `gcp_pubsub`, `servicebus`, `eventhubs`, `eventgrid`), plus `messaging.destination.name`, `.subscription.name`, `.partition.id`, `.template`, `.anonymous`, `.temporary`; `messaging.consumer.group.name`, `messaging.operation.type`/`.name`, `messaging.batch.message_count`, `messaging.message.id`/`.conversation_id`/`.body.size`/`.envelope.size`; system-specific namespaces for Kafka (`kafka.cluster.id`, `kafka.offset`, `kafka.message.key`, `kafka.message.tombstone`), RabbitMQ, RocketMQ, GCP PubSub, Service Bus, Event Hubs. Span topology is modelled with "Create" spans plus a client "Send" span that **links** to the creation context — links are load-bearing here.

**Cloud** (`model/cloud`): the `cloud` entity carries `cloud.provider`, `cloud.account.id`, `cloud.region`, `cloud.availability_zone`, `cloud.resource_id`, `cloud.platform`. `cloud.platform` is a ~50-value enum spanning AWS/Azure/GCP/Alibaba/Tencent/IBM/Oracle/Hetzner/Vultr/Akamai/Scaleway/Heroku compute and serverless surfaces.

### 2.5 Schema extensibility

Two mechanisms, both real:

- **Telemetry Schemas / Schema URL** (`http[s]://server[:port]/path/<version>`). Schema file formats 1.0.0 and 1.1.0. Schema versions track semconv versions; files are immutable and permanently cacheable. Transformations exist to migrate telemetry across versions (attribute/metric renames etc.), deliberately scoped to "bare minimum necessary."
- **Weaver** (`open-telemetry/weaver`, Rust, v0.26.1). Commands: `registry check`, `resolve`, `diff`, `generate`, `live-check`, `emit`, `mcp`. Users define **their own registries** that import/extend the OTel one, enforce Rego policies (incl. `entity_refs` / `lookup_entity` helpers for `entity_associations`), generate typed code from schema, and validate live OTLP against the registry with CEL-based matchers.

---

## 3. Deriving a service dependency graph from traces

The `servicegraph` / `service_graph` connector (`connector/servicegraphconnector`, **alpha**, traces→metrics, owned by @mapno and @JaredTan95, derived from Grafana Tempo's service graph processor). Read from `connector.go` at HEAD:

- Resource must have `service.name`; spans without it are skipped entirely.
- Edges are built by **pairing two spans** in an in-memory store keyed by `(traceID, spanID)`:
  - `CLIENT` span → upsert edge keyed on its own span ID, set `ClientService`.
  - `SERVER` span → upsert edge keyed on `(traceID, parentSpanID)`, set `ServerService`. The pair meets on the client's span ID.
  - `PRODUCER` → edge keyed on own span ID, `ConnectionType = MessagingSystem`.
  - `CONSUMER` → **if `span.Links()` is empty**, fall back to `(traceID, parentSpanID)`; **otherwise iterate every link**, and for each create a consumer-keyed edge via `store.NewLinkedConsumerKey(consumerTrace, consumerSpan, producerTrace, producerSpan)` with `e.ProducerKey` set, so the store reconciles one producer → many consumers. This is the only place span links materially shape graph topology.
  - `INTERNAL` → "this span is not part of an edge."
- **Databases collapse to a single span**: if any of `database_name_attributes` (default `[db.name]`) is present on a client/producer span, the edge is completed immediately with `ServerService = dbName`, `ConnectionType = database` — no server span awaited.
- **Virtual nodes** for uninstrumented peers: `virtual_node_peer_attributes` (default `[peer.service, db.name, db.system]`, ordered by priority) synthesize a node when the far side never reports. `virtual_node_extra_label` adds `virtual_node=client|server`.
- Store: `ttl` 2s, `max_items` 1000; `metrics_flush_interval` 60s; `cache_loop` 1m.

**Output is six Prometheus-shaped metric series, not a graph object:** `traces_service_graph_request_total`, `_request_failed_total`, `_request_server` (histogram), `_request_client` (histogram), `_unpaired_spans_total`, `_dropped_spans_total` — all labelled `client`, `server`, `connection_type` (`unset` | `messaging_system` | `database` | virtual-node), plus configurable `dimensions` prefixed `client_`/`server_`. The graph is whatever a visualizer (Grafana ≥ 9.0.4 with a Tempo datasource pointed at Prometheus) reconstructs from those labels.

**Hard operational constraint, stated in the README:** "it needs to process all spans of a trace to function properly. If spans of a trace are spread out over multiple instances, spans are not paired up reliably" — requiring a `loadbalancingexporter` layer in front. Internal counters `otelcol_connector_servicegraph_dropped_spans`, `_expired_edges`, `_total_edges` expose how lossy this is in practice.

Note `peer.service` is now **deprecated**, renamed to `service.peer.name`; new `service.peer.name` / `service.peer.namespace` are `development`, `opt_in`.

---

## 4. Span links

Structurally minimal. `Link` = `{trace_id, span_id, trace_state, attributes[], dropped_attributes_count, flags}` (flags since OTLP v1.1.0, encoding W3C trace flags plus a tri-state is-remote). API: `AddLink`, links preferred at span creation, order preserved, links visible to Samplers. Semantics per `overview.md`: batching (one span initiated by many), trust-boundary trace restarts, and scatter/gather where "It is recommended… to not set parent of the Span… as semantically the parent field represents a single parent scenario."

**There are no link semantic conventions.** No `link.type`, no relationship taxonomy. Grepping `model/` for link attribute definitions yields nothing — the only mentions are prose in messaging spans. A link is an untyped pointer; any meaning must be encoded in ad-hoc link attributes that no convention defines and no consumer is obliged to interpret. `SpanKind` (`CLIENT`/`SERVER`/`PRODUCER`/`CONSUMER`/`INTERNAL`) carries the only standardized directional semantics, and it describes two axes only: outgoing vs incoming, request/response vs deferred execution.

---

## 5. MCP surface

No MCP server exists in the core OTel project. The only first-party one is **`weaver registry mcp`** (stdio), which exposes the **semantic convention registry**, not telemetry. Eight tools, per `crates/weaver_mcp/README.md`:

| Tool | Read/Write |
|---|---|
| `search` (query, type ∈ all/attribute/metric/span/event/entity, stability, limit=20) | read |
| `get_attribute` (key) | read |
| `get_metric` (name) | read |
| `get_span` (type) | read |
| `get_event` (name) | read |
| `get_entity` (type) | read |
| `live_check` (samples[], output ∈ full/findings_only) | read/validate — no persistence |
| `browse_namespace` (prefix) | read |

**All eight are read-only.** None mutate the registry, none emit telemetry, none query a backend. Third-party MCP servers (traceloop/opentelemetry-mcp-server, MoebiusX/otel-mcp-server, liatrio-labs otel-instrumentation-mcp) query *backends* over OTel data, but are not OTel-project artifacts.

---

## 6. What OTel fundamentally cannot express

**Code-level structure — five attributes, total.** `model/code/` defines exactly `code.function.name`, `code.file.path`, `code.line.number`, `code.column.number`, `code.stacktrace`. That is the entire code vocabulary. There is no notion of module, package, class, symbol, call edge, type, interface, import, or function signature. `code.function.name` is an opaque string whose format is explicitly language-dependent and unparseable in general ("Values and format depends on each language runtime, thus it is impossible to provide an exhaustive list of examples"). These attributes decorate a *span* — they are a breadcrumb to where an operation happened, not a model of the codebase. Notably, all five "MUST NOT be used on the Profile signal since the data is already captured in 'message Function'."

**Repo-level structure — repo/ref/change only.** `vcs.repository` entity: identity `vcs.repository.url.full`, descriptive `vcs.repository.name`. `vcs.ref` entity: identity `vcs.ref.head.revision`. Attributes cover `vcs.change.id/title/state`, `vcs.ref.base/head.name/type/revision`, `vcs.line_change.type`, `vcs.owner.name`, `vcs.provider.name`. Metrics are DORA-flavoured aggregates: `vcs.change.count`, `.duration`, `.time_to_approval`, `.time_to_merge`, `vcs.ref.lines_delta`, `.revisions_delta`, `.time`, `vcs.contributor.count`, `vcs.repository.count`. There is **no file entity, no directory, no module, no dependency edge, no build-target, no code-owner mapping**. `artifact.purl` (Package URL) exists as an attribute but `artifact` is *not* an entity type and participates in no relationship.

**No link from service to repo.** Nothing in semconv connects a `service` entity to a `vcs.repository` entity. `service.version` is explicitly format-free ("The format is not defined by these conventions", examples `2.0.0`, `a01dbef8a`) so a commit SHA *may* appear there by convention but is not modelled as a reference. The absent relationship model is exactly what would be needed.

**No ownership or org model.** `service.namespace` is described as "for example the team name that owns a group of services" — a naming convention, not an owner entity. `service.criticality` (alpha: critical/high/medium/low) and `service.instance.cost_center.id`/`.name` (development) are the only governance-ish fields. No team entity, no on-call, no tier definition, no SLO object.

**No API/endpoint catalog.** `http.route` and `rpc.service`/`rpc.method` are span attributes, not entities. There is no schema object for an API, its operations, or its consumers.

**No temporal graph, no provenance, no contradiction handling.** See §7.

**No storage or read API.** Nothing to query, nothing to write back to.

---

## 7. Provenance, staleness, contradiction, temporality

Mostly absent, with three narrow exceptions.

- **Provenance:** none at the attribute level. An attribute is a bare key/value; there is no field for who asserted it, from what source, with what confidence. The nearest proxies are `otel.scope` (instrumentation scope name/version), `telemetry.sdk.*` and `telemetry.distro.*` — these say *which library produced the signal*, not *where a fact came from*. The Entities "Repeatable Identity" rule is an attempt to make multi-observer agreement *definitionally impossible to violate* rather than to record and reconcile disagreement: an observer that cannot produce the canonical identifying attributes "MUST NOT emit telemetry using that entity type."
- **Contradiction:** resolved by last-write-wins, not surfaced. Entity merge: "Conflicting descriptive attributes values from the new entity overwrite descriptive attribute values from the current entity." For shared descriptive keys across entities in one signal, the rule is ownership-by-specificity: the attribute "MUST be referenced by the most specific entity, the one closest in the topology graph" — e.g. `cloud.availability_zone` belongs to `k8s.node`, not `k8s.cluster`. There is no mechanism to represent "two sources disagree."
- **Staleness:** the one genuinely good mechanism. `entity.report.interval` (int64 seconds; `0` = no periodic events) lets receivers compute when the next state event is due and "infer that an entity is gone if events stop arriving." Delete events are explicitly not guaranteed and may arrive out of order; receivers must expire on the heartbeat. In the service graph connector, staleness is cruder: a 2s store TTL and a 1000-item cap, with expired pairs counted as `unpaired_spans` / `expired_edges`.
- **Temporality:** every signal is timestamped, so history is a time series of observations. But there is no bitemporality (no valid-time vs transaction-time), no "as-of" query model, no versioning of an entity's identity, and — since Resource carries no relationships — no way to ask when an edge appeared or disappeared except by replaying entity-state event streams yourself. Metrics have `aggregation_temporality` (delta/cumulative), which is about counters, not facts.

---

## 8. Cross-repo and infrastructure modelling

**Cross-repo: effectively nil.** `vcs.repository` is an entity, but with no relationships it cannot connect to another repository, to a service, to a build artifact, or to a deployment. There is no dependency graph, no monorepo/multi-repo notion, no cross-repo query. Any multi-repo view must be constructed entirely outside OTel.

**Infrastructure: this is OTel's strongest ground.** 64 entity types with declared identifying attributes constitute a genuine typed schema for running infrastructure — Kubernetes (19 types, from cluster down to container and HPA and PVC), hosts, processes, containers, container images, cloud accounts/regions/platforms across 12 providers, FaaS, CloudFoundry, GCP AppHub, AWS ECS/EKS, OpenShift, plus CI/CD pipelines/runs/workers. Identity is composite and mostly UID-based (`k8s.pod.uid`, `k8s.node.uid`, `container.id`, `host.id`). Population is automated in practice by `k8sattributesprocessor` and `resourcedetectionprocessor`. `entity_associations` on 500+ metric definitions declares which entity each infrastructure metric attaches to. What is missing is the topology: the pod→node, container→pod, process→host edges exist only as prose examples in a Development-status events spec, with no standard relationship-type vocabulary defined anywhere in the model.

---

## 9. Summary judgement

OTel gives you, for free and vendor-neutrally: a rigorous typed vocabulary for *runtime* entities, a graduated-project guarantee of stability for the stable subset, tooling (Weaver) to extend that vocabulary with your own registry and enforce it in CI and against live traffic, and one alpha component that reconstructs a service-to-service call graph from trace span pairing and emits it as Prometheus labels.

It gives you nothing about source code beyond a file path and a function name string, nothing about repositories beyond a URL and a commit SHA, no edges in the Resource model at all, no provenance, no contradiction model, no storage, and no read API. A knowledge graph spanning code and infrastructure can *consume* OTel as an authoritative source of runtime entity identity and observed service dependencies — and should, because re-inventing `k8s.pod.uid` or `db.system.name` is wasted work — but it cannot be built *on* OTel, because the two things such a graph most needs (typed edges and code structure) are precisely the two things OTel does not define.
