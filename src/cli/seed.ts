/**
 * Seed the motivating scenario by hand.
 *
 * This is the walking skeleton's kill criterion: a PERFECT graph, with no
 * extraction errors and no resolution errors to blame. If traversal over this
 * is not obviously better than grepping four repos and reading the Terraform,
 * the concept is wrong and the project should stop here.
 *
 * Everything goes through the real ingest path - the same door an agent uses.
 */
import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { ingest, type ObservationInput } from '../store/observations.ts'

const REPO_CLIENT = 'gitlab:1001'
const REPO_SVC_B = 'gitlab:1002'
const REPO_SVC_C = 'gitlab:1003'
const REPO_INFRA = 'gitlab:1004'

const db = await open()
await migrate(db, { quiet: true })

// Wipe prior seed so this is repeatable.
await db.exec(`
  truncate mention, assertion, proposition, entity_identifier, entity_alias,
           entity_merge, entity_distinct, entity, ingest_batch restart identity cascade;
`)

const obs: ObservationInput[] = []
const at = (i: number) => i // readability helper for `about` indices

// --- repos -----------------------------------------------------------------
const ID_CLIENT_A = [{ authority: 'git_remote', value: 'gitlab.com/acme/client-a' }]
const ID_SVC_B = [{ authority: 'git_remote', value: 'gitlab.com/acme/service-b' }]
const ID_SVC_C = [
  { authority: 'git_remote', value: 'gitlab.com/acme/service-c' },
  { authority: 'otel_service', value: 'notifications/service-c' },
]

obs.push(
  { subject: 'Client A', subject_kind: 'client', subject_identifiers: ID_CLIENT_A, predicate: 'lives_in_repo',
    object: 'client-a', object_kind: 'repo',
    object_identifiers: [{ authority: 'gitlab_project', value: REPO_CLIENT }],
    evidence: [{ repo: REPO_CLIENT, path: 'package.json' }] },
  { subject: 'Service B', subject_kind: 'service', subject_identifiers: ID_SVC_B, predicate: 'lives_in_repo',
    object: 'service-b', object_kind: 'repo',
    object_identifiers: [{ authority: 'gitlab_project', value: REPO_SVC_B }] },
  { subject: 'Service C', subject_kind: 'service', subject_identifiers: ID_SVC_C, predicate: 'lives_in_repo',
    object: 'service-c', object_kind: 'repo',
    object_identifiers: [{ authority: 'gitlab_project', value: REPO_SVC_C }] },
  { subject: 'notifications-infra', subject_kind: 'iac_module',
    subject_identifiers: [{ authority: 'tf_address', value: 'module.notifications' }], predicate: 'lives_in_repo',
    object: 'platform-terraform', object_kind: 'repo',
    object_identifiers: [{ authority: 'gitlab_project', value: REPO_INFRA }] },
)

// --- the call graph --------------------------------------------------------
obs.push(
  { subject: 'Client A', subject_kind: 'client', predicate: 'calls',
    object: 'Service B', object_kind: 'service',
    evidence: [{ repo: REPO_CLIENT, path: 'src/api/profile.ts', lines: [22, 31] }], confidence: 0.9 },
  { subject: 'Client A', subject_kind: 'client', predicate: 'calls',
    object: 'GET /notifications', object_kind: 'endpoint',
    qualifiers: { path: '/notifications', method: 'GET' },
    evidence: [{
      repo: REPO_CLIENT, path: 'src/features/notifications/list.ts', lines: [14, 17],
      enclosing_symbol: 'useNotificationList',
      span_text: [
        'export function useNotificationList() {',
        "  return useQuery(['notifications'], () =>",
        "    api.get('/notifications').then((r) => r.data))",
        '}',
      ].join('\n'),
    }],
    note: 'The notification bell polls this endpoint every 30s.', confidence: 0.95 },
  { subject: 'Service C', subject_kind: 'service', predicate: 'exposes_endpoint',
    object: 'GET /notifications', object_kind: 'endpoint',
    qualifiers: { path: '/notifications', method: 'GET' },
    evidence: [{ repo: REPO_SVC_C, path: 'src/routes/notifications.ts', lines: [8, 12] }], confidence: 0.95 },
  { subject: 'Service B', subject_kind: 'service', predicate: 'publishes_to',
    object: 'Queue D', object_kind: 'queue',
    evidence: [{ repo: REPO_SVC_B, path: 'src/events/publisher.ts', lines: [40, 52] }] },
  { subject: 'Service B', subject_kind: 'service', predicate: 'caches_in',
    object: 'Redis cache E', object_kind: 'cache',
    evidence: [{ repo: REPO_SVC_B, path: 'src/cache.ts', lines: [11, 20] }] },
)

// --- the read path, with its fallback --------------------------------------
// `reads_from` with role=cache is IDENTIFYING (it is a different edge from the
// origin read). ttl_seconds is DESCRIPTIVE and becomes a claim about this edge.
const cacheReadIdx = obs.length
obs.push({
  subject: 'Service C', subject_kind: 'service', predicate: 'reads_from',
  object: 'Redis cache E', object_kind: 'cache',
  qualifiers: { role: 'cache', key_pattern: 'notif:*', ttl_seconds: 60 },
  evidence: [{
    repo: REPO_SVC_C, path: 'src/notifications/cache.ts', lines: [40, 44],
    enclosing_symbol: 'readNotifications',
    scip_symbol: 'scip-typescript npm @acme/service-c 1.4.0 `src/notifications/cache.ts`/readNotifications().',
    span_text: [
      'export async function readNotifications(userId: string) {',
      "  const cached = await redis.get(`notif:${userId}`)",
      '  if (cached) return JSON.parse(cached)',
      '  return loadFromDb(userId)',
      '}',
    ].join('\n'),
  }],
  note: 'Served from cache when present and not stale.', confidence: 0.9,
})

// Asserted ABOUT the edge above: claims-about-claims, the subject_prop path.
obs.push({
  about: at(cacheReadIdx), predicate: 'falls_back_to',
  object: 'notifications-db', object_kind: 'datastore',
  evidence: [{ repo: REPO_SVC_C, path: 'src/notifications/cache.ts', lines: [59, 74] }],
  confidence: 0.9,
})

obs.push({
  subject: 'Service C', subject_kind: 'service', predicate: 'reads_from',
  object: 'notifications-db', object_kind: 'datastore',
  qualifiers: { role: 'origin', table: 'notifications' },
  evidence: [{ repo: REPO_SVC_C, path: 'src/notifications/repository.ts', lines: [18, 44] }], confidence: 0.9,
})

// --- infrastructure --------------------------------------------------------
obs.push(
  { subject: 'notifications-db', subject_kind: 'datastore', predicate: 'provisioned_by',
    object: 'notifications-infra', object_kind: 'iac_module',
    object_identifiers: [{ authority: 'tf_address', value: 'module.notifications_db' }],
    evidence: [{ repo: REPO_INFRA, path: 'modules/notifications/rds.tf', lines: [1, 48] }] },
  { subject: 'Redis cache E', subject_kind: 'cache', predicate: 'provisioned_by',
    object: 'notifications-infra', object_kind: 'iac_module',
    evidence: [{ repo: REPO_INFRA, path: 'modules/notifications/elasticache.tf', lines: [1, 30] }] },
  { subject: 'notifications-db', subject_kind: 'datastore', predicate: 'deployed_to',
    object: 'aws-prod-eu-west-1', object_kind: 'cloud_resource',
    object_identifiers: [{ authority: 'arn', value: 'arn:aws:rds:eu-west-1:111122223333:db:notifications' }] },
  // "How do I connect" - the LOCATION of the credential, never its value.
  { subject: 'notifications-db', subject_kind: 'datastore', predicate: 'connect_via',
    object_literal: 'psql -h notifications.cluster-abc.eu-west-1.rds.amazonaws.com -p 5432 -U readonly -d notifications (requires VPN or bastion via tailscale)' },
  { subject: 'notifications-db', subject_kind: 'datastore', predicate: 'secret_at',
    object_literal: 'AWS Secrets Manager: prod/notifications/readonly (region eu-west-1)' },
)

// --- a staging twin, to prove env never bridges ----------------------------
obs.push({
  subject: 'Redis cache E', subject_kind: 'cache', subject_env: 'staging', predicate: 'provisioned_by',
  object: 'notifications-infra', object_kind: 'iac_module', object_env: 'staging',
  evidence: [{ repo: REPO_INFRA, path: 'envs/staging/elasticache.tf' }],
})

const result = await ingest(db, {
  session: 'seed',
  agent: 'seed-cli/human',
  env: 'prod',
  method: 'human',
  scope_key: 'seed@manual',
  observations: obs,
})

console.log(`seeded: ${result.accepted} accepted, ${result.rejected} rejected`)
for (const r of result.results.filter((x) => !x.accepted)) {
  console.log(`  ! [${r.index}] ${r.error}`)
}

const counts = await db.query<{ entities: string; props: string; assertions: string }>(`
  select (select count(*) from entity)::text      as entities,
         (select count(*) from proposition)::text as props,
         (select count(*) from assertion)::text   as assertions
`)
console.log(`graph: ${counts.rows[0]!.entities} entities, ${counts.rows[0]!.props} propositions, ${counts.rows[0]!.assertions} assertions`)
await db.close()
