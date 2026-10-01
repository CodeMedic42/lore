# Living AI Knowledge — field report

Generated: 2026-09-29T02:02:17.507Z
Redaction: **redacted** (names replaced with stable pseudonyms; literals and paths removed)
Window: last 30 days · Driver: pg

## 1. Was it used?

| Tool | Calls | Failures | Avg ms | Max ms |
|---|---:|---:|---:|---:|
| `ask_knowledge` | 2 ████████████ | 0 | 26 | 39 |
| `record_statement` | 1 ██████······ | 0 | 6 | 6 |
| `pending_questions` | 1 ██████······ | 0 | 17 | 17 |
| `lookup_entity` | 1 ██████······ | 0 | 10 | 10 |
| `record_observations` | 1 ██████······ | 0 | 18 | 18 |

Reads: 3 · Writes: 2 · Ratio: 1.5:1

> A read-heavy ratio means the agent is consuming but not contributing;
> write-heavy means it is recording without ever benefiting, which tends to stop.

## 2. Fact density — does the premise hold?

Live edges: **44** · Cross-repository edges: **0** (0.0%)

> The plan named this as risk #1. Facts that span repositories are the ones a
> single-repo session cannot see, and therefore the only ones that justify a
> shared graph. Below ~10% and the agent is mostly restating what is already in
> front of it, which means importers should be doing the work and agents should
> only be annotating.

## 3. What is being recorded

| Predicate | Family | Count |
|---|---|---:|
| `lives_in_repo` | structure | 5 ████████████ |
| `written_in` | technology | 5 ████████████ |
| `note` | meta | 5 ████████████ |
| `implements` | capability | 3 ███████····· |
| `reads_from` | dataflow | 3 ███████····· |
| `calls` | dataflow | 3 ███████····· |
| `serves_at` | structure | 2 █████······· |
| `uses_framework` | technology | 2 █████······· |
| `exposes_endpoint` | structure | 2 █████······· |
| `tests_with` | technology | 2 █████······· |
| `frobnicates` | other | 1 ██·········· |
| `supersedes` | lifecycle | 1 ██·········· |
| `built_by` | delivery | 1 ██·········· |
| `ttl_seconds` | meta | 1 ██·········· |
| `falls_back_to` | dataflow | 1 ██·········· |
| `deployed_to` | infra | 1 ██·········· |
| `connect_via` | access | 1 ██·········· |
| `provisioned_by` | infra | 1 ██·········· |
| `handles_data` | capability | 1 ██·········· |
| `monitors` | ops | 1 ██·········· |
| `built_with` | technology | 1 ██·········· |
| `secret_at` | access | 1 ██·········· |

Entities by kind: technology=9  endpoint=5  repo=4  service=4  datastore=2  capability=2  client=2  unknown=1  cache=1  cloud_resource=1  data_concept=1  iac_module=1  pipeline=1  alert=1

Assertions: 44 · with evidence: 8 · re-verifiable (span recorded): 0
By source — inferred by agent: 2 · stated by human: 42 · derived from code: 0 · refutations: 0

## 4. Entity resolution — risk #2

Strong-identifier coverage: **28.6%** (10/35)
Provisional entities: 25 · Open merge candidates: 1 · Merges applied: 0 · Recorded as distinct: 1

> **Below the 60% line.** Resolution is running largely on name similarity, which means
> duplicate entities and fragmented answers. The fix is supplying `git_remote`,
> `gitlab_project`, `arn` or `tf_address` when recording.

Possible duplicates after normalisation: service=1  technology=1

## 5. Vocabulary fit

Predicates used that the vocabulary does not know. These are **not** errors —
they were accepted and stored. A frequent one is a sign the vocabulary is
missing a concept this codebase needs.

| Raw predicate | Times used |
|---|---:|
| `frobnicates` | 1 |

## 6. Failures and rejections

- observation rejected 1×: refusing to store literal: literal appears to contain a credential (matched postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@). Recor

## 7. Evidence health

Anchor states: unchecked=8

## 8. What the graph knows it is missing

unidentified_entity=8  dangling_endpoint=3  unprovisioned_infra=3  homeless_project=2  no_access_info=2  name_collision=1  unknown_technology=1  undescribed_concept=1  orphan_entity=1

Questions fetched: 1 · Answers recorded: 0

## 9. Sample of recorded facts

_Names are stable pseudonyms; the same service reads the same throughout._

- `service-b6ad` --[reads_from]--> `unknown-14b2` · trust 0.71 · human
- `service-f420` --[frobnicates]--> `service-93f6` · trust 0.40 · llm_inferred
- `service-f420` --[tests_with]--> `technology-7383` · trust 0.40 · llm_inferred
- `pipeline-874e` --[note]--> `[redacted 91 chars]` · trust 0.95 · human
- `client-6c96` --[built_by]--> `pipeline-874e` · trust 0.95 · human
- `alert-96b8` --[note]--> `[redacted 83 chars]` · trust 0.95 · human
- `alert-96b8` --[monitors]--> `datastore-d365` · trust 0.95 · human
- `datastore-d365` --[secret_at]--> `[redacted 60 chars]` · trust 0.95 · human
- `datastore-d365` --[connect_via]--> `[redacted 124 chars]` · trust 0.95 · human
- `datastore-d365` --[deployed_to]--> `cloud_resource-d1d1` · trust 0.95 · human
- `iac_module-2083` --[lives_in_repo]--> `repo-d11b` · trust 0.95 · human
- `datastore-d365` --[provisioned_by]--> `iac_module-2083` · trust 0.95 · human
- `service-f420` --[reads_from]--> `datastore-d365` {role=origin table=[redacted 13 chars]} · trust 0.95 · human
- `(about another claim)` --[falls_back_to]--> `datastore-d365` · trust 0.95 · human
- `(about another claim)` --[ttl_seconds]--> `[redacted 2 chars]` · trust 0.95 · human
- `service-f420` --[reads_from]--> `cache-7393` {role=cache key_pattern=[redacted 7 chars]} · trust 0.95 · human
    evidence: repo-d7af [path depth=3 .js]:40-44
- `client-b1fd` --[note]--> `[redacted 82 chars]` · trust 0.95 · human
- `client-b1fd` --[supersedes]--> `client-6c96` · trust 0.95 · human
- `client-b1fd` --[written_in]--> `technology-fd6e` · trust 0.95 · human
- `client-b1fd` --[uses_framework]--> `technology-cb2d` · trust 0.95 · human
- `client-b1fd` --[lives_in_repo]--> `repo-6c96` · trust 0.95 · human
- `service-f420` --[handles_data]--> `data_concept-b741` · trust 0.95 · human
- `capability-b046` --[note]--> `[redacted 97 chars]` · trust 0.95 · human
- `service-b6ad` --[implements]--> `capability-b046` · trust 0.95 · human
- `service-f420` --[implements]--> `capability-4cb6` · trust 0.95 · human

---

### What to look at first

1. Section 1 — if there are no calls, nothing else matters.
2. Section 2 — the cross-repo percentage decides whether the premise holds.
3. Section 5 — frequent unknown predicates say the vocabulary does not fit this stack.
4. Section 4 — coverage under 60% means answers will fragment as the graph grows.