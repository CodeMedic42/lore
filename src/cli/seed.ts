/**
 * Seeds the scenario the project owner described: a notification client, the two
 * services behind it, the infrastructure underneath, and a rewrite in progress.
 *
 * Deliberately INCOMPLETE in a few places, because the point is no longer just
 * "can it traverse" - it is "does it know what it does not know". The gaps left
 * here are the ones a real codebase leaves.
 */
import { open } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { ingest, type ObservationInput } from '../store/observations.ts'
import { maintain } from '../store/maintain.ts'

const R_CLIENT = 'gitlab:2001'
const R_NOTIF = 'gitlab:2002'
const R_COMMON = 'gitlab:2003'
const R_INFRA = 'gitlab:2004'

const db = await open()
await migrate(db, { quiet: true })
await db.exec(`
  truncate mention, assertion, proposition, entity_identifier, entity_alias,
           entity_merge, entity_distinct, merge_candidate, entity, ingest_batch
  restart identity cascade;
`)

const obs: ObservationInput[] = []
const svc = (name: string) => ({ subject: name, subject_kind: 'service' })
const cli = (name: string) => ({ subject: name, subject_kind: 'client' })
const tech = (name: string) => ({ object: name, object_kind: 'technology' })

// ── 1, 12, 13: the projects and their repos ────────────────────────────────
obs.push(
  { ...cli('notification-client'), predicate: 'lives_in_repo', object: 'notification-client', object_kind: 'repo',
    subject_identifiers: [{ authority: 'git_remote', value: 'gitlab.com/acme/notification-client' }],
    object_identifiers: [{ authority: 'gitlab_project', value: R_CLIENT }] },
  { ...svc('notifications-service'), predicate: 'lives_in_repo', object: 'notifications-service', object_kind: 'repo',
    subject_identifiers: [{ authority: 'git_remote', value: 'gitlab.com/acme/notifications-service' }],
    object_identifiers: [{ authority: 'gitlab_project', value: R_NOTIF }] },
  { ...svc('common-service'), predicate: 'lives_in_repo', object: 'common-service', object_kind: 'repo',
    subject_identifiers: [{ authority: 'git_remote', value: 'gitlab.com/acme/common-service' }],
    object_identifiers: [{ authority: 'gitlab_project', value: R_COMMON }] },
)

// ── 2, 3, 4, 5: what the client is made of ─────────────────────────────────
obs.push(
  { ...cli('notification-client'), predicate: 'written_in',     ...tech('JavaScript') },
  { ...cli('notification-client'), predicate: 'written_in',     ...tech('SCSS') },
  { ...cli('notification-client'), predicate: 'uses_framework', ...tech('React'),
    evidence: [{ repo: R_CLIENT, path: 'package.json' }] },
  { ...cli('notification-client'), predicate: 'built_with',     ...tech('Webpack'),
    evidence: [{ repo: R_CLIENT, path: 'webpack.config.js' }] },
  { ...cli('notification-client'), predicate: 'tests_with',     ...tech('Jest') },
  { ...svc('notifications-service'), predicate: 'written_in',   ...tech('Node.js') },
  { ...svc('common-service'),       predicate: 'written_in',    ...tech('Node.js') },
)

// ── 6, 7, 8: the HTTP calls the client makes ───────────────────────────────
// Note the endpoint names are as the CLIENT sees them - a URL built from a
// per-environment base. The service will name the same route differently.
obs.push(
  { ...cli('notification-client'), predicate: 'calls',
    object: 'GET {notifications-service-url}/v1/notifications', object_kind: 'endpoint',
    qualifiers: { path: '/v1/notifications', method: 'GET' },
    evidence: [{ repo: R_CLIENT, path: 'src/api/notifications.js', lines: [8, 11] }] },
  { ...cli('notification-client'), predicate: 'calls',
    object: 'POST {notifications-service-url}/v1/notifications', object_kind: 'endpoint',
    qualifiers: { path: '/v1/notifications', method: 'POST' },
    evidence: [{ repo: R_CLIENT, path: 'src/api/notifications.js', lines: [13, 17] }] },
  { ...cli('notification-client'), predicate: 'calls',
    object: 'GET {common-service-url}/v2/session', object_kind: 'endpoint',
    qualifiers: { path: '/v2/session', method: 'GET' },
    evidence: [{ repo: R_CLIENT, path: 'src/api/session.js', lines: [4, 9] }] },
)

// ── 9: the base URLs differ per environment ────────────────────────────────
obs.push(
  { ...cli('notification-client'), predicate: 'serves_at',
    object_literal: 'http://dev-notifications.com',  qualifiers: { env_of_target: 'dev' } },
  { ...cli('notification-client'), predicate: 'serves_at',
    object_literal: 'http://test-notifications.com', qualifiers: { env_of_target: 'test' } },
)

// ── 10: the route is DEFINED over in the service repo ──────────────────────
// Recorded from the service side, so it is a different endpoint entity with a
// different name. Matching them is the cross-repo join.
obs.push(
  { ...svc('notifications-service'), predicate: 'exposes_endpoint',
    object: 'GET /v1/notifications', object_kind: 'endpoint',
    qualifiers: { path: '/v1/notifications', method: 'GET' },
    evidence: [{ repo: R_NOTIF, path: 'src/routes/notifications.js', lines: [12, 20] }] },
)
// ── 11 is DELIBERATELY ABSENT: nobody has recorded who serves /v2/session.
//    It should surface as a gap with a proposed answer, below.
obs.push(
  { ...svc('common-service'), predicate: 'exposes_endpoint',
    object: '/v2/session', object_kind: 'endpoint',
    qualifiers: { path: '/v2/session', method: 'GET' },
    evidence: [{ repo: R_COMMON, path: 'src/routes/session.js', lines: [5, 14] }] },
)

// ── 14: what the client is FOR ─────────────────────────────────────────────
obs.push(
  { ...cli('notification-client'), predicate: 'implements',
    object: 'notification list', object_kind: 'capability' },
  { subject: 'notification list', subject_kind: 'capability', predicate: 'note',
    object_literal: 'Shows a user the list of notifications waiting for them to review, newest first.' },
  { ...svc('notifications-service'), predicate: 'implements',
    object: 'notification list', object_kind: 'capability' },
  { ...svc('common-service'), predicate: 'implements',
    object: 'authentication', object_kind: 'capability' },
  { subject: 'authentication', subject_kind: 'capability', predicate: 'note',
    object_literal: 'Session tokens issued and validated by common-service; clients call /v2/session to establish one.' },
  { ...svc('notifications-service'), predicate: 'handles_data',
    object: 'user notification data', object_kind: 'data_concept' },
)

// ── 15, 16: the rewrite in progress ────────────────────────────────────────
obs.push(
  { ...cli('new-notification-client'), predicate: 'lives_in_repo',
    object: 'notification-client', object_kind: 'repo' },
  { ...cli('new-notification-client'), predicate: 'uses_framework', ...tech('Angular') },
  { ...cli('new-notification-client'), predicate: 'written_in',     ...tech('TypeScript') },
  { ...cli('new-notification-client'), predicate: 'supersedes',
    object: 'notification-client', object_kind: 'client' },
  { subject: 'new-notification-client', subject_kind: 'client', predicate: 'note',
    object_literal: 'Angular rewrite, in progress. Both clients exist in the repo during the migration.' },
)

// ── the data chain behind the notification list ────────────────────────────
const cacheRead = obs.length
obs.push({
  ...svc('notifications-service'), predicate: 'reads_from',
  object: 'notifications-cache', object_kind: 'cache',
  qualifiers: { role: 'cache', key_pattern: 'notif:*', ttl_seconds: 60 },
  evidence: [{ repo: R_NOTIF, path: 'src/notifications/cache.js', lines: [40, 44] }],
})
obs.push(
  { about: cacheRead, predicate: 'falls_back_to', object: 'notifications-db', object_kind: 'datastore' },
  { ...svc('notifications-service'), predicate: 'reads_from',
    object: 'notifications-db', object_kind: 'datastore',
    qualifiers: { role: 'origin', table: 'notifications' } },
  { subject: 'notifications-db', subject_kind: 'datastore', predicate: 'provisioned_by',
    object: 'notifications-infra', object_kind: 'iac_module',
    object_identifiers: [{ authority: 'tf_address', value: 'module.notifications' }] },
  { subject: 'notifications-infra', subject_kind: 'iac_module', predicate: 'lives_in_repo',
    object: 'platform-terraform', object_kind: 'repo',
    object_identifiers: [{ authority: 'gitlab_project', value: R_INFRA }] },
  { subject: 'notifications-db', subject_kind: 'datastore', predicate: 'deployed_to',
    object: 'aws-prod-eu-west-1', object_kind: 'cloud_resource',
    object_identifiers: [{ authority: 'arn', value: 'arn:aws:rds:eu-west-1:111122223333:db:notifications' }] },
  { subject: 'notifications-db', subject_kind: 'datastore', predicate: 'connect_via',
    object_literal: 'psql -h notifications.cluster-abc.eu-west-1.rds.amazonaws.com -p 5432 -U readonly -d notifications (VPN or bastion required)' },
  { subject: 'notifications-db', subject_kind: 'datastore', predicate: 'secret_at',
    object_literal: 'AWS Secrets Manager: prod/notifications/readonly (eu-west-1)' },
  // an alert, for "what alerts are set up in AWS"
  { subject: 'notifications-db-cpu-high', subject_kind: 'alert', predicate: 'monitors',
    object: 'notifications-db', object_kind: 'datastore',
    subject_identifiers: [{ authority: 'arn', value: 'arn:aws:cloudwatch:eu-west-1:111122223333:alarm:notif-db-cpu' }] },
  { subject: 'notifications-db-cpu-high', subject_kind: 'alert', predicate: 'note',
    object_literal: 'CloudWatch alarm: RDS CPU above 80% for 5 minutes, pages the platform on-call rota.' },
  // CI
  { subject: 'notification-client', subject_kind: 'client', predicate: 'built_by',
    object: 'client-ci', object_kind: 'pipeline' },
  { subject: 'client-ci', subject_kind: 'pipeline', predicate: 'note',
    object_literal: 'GitLab CI: install, jest, webpack build, upload static bundle to S3, invalidate CloudFront.' },
)

const result = await ingest(db, {
  session: 'seed', agent: 'seed-cli/human', env: 'prod', method: 'human',
  scope_key: 'seed@manual', observations: obs,
})

console.log(`seeded: ${result.accepted} accepted, ${result.rejected} rejected`)
for (const r of result.results.filter((x) => !x.accepted)) console.log(`  ! [${r.index}] ${r.error}`)

await maintain(db)

const c = await db.query<{ e: string; p: string; a: string }>(`
  select (select count(*) from entity)::text e,
         (select count(*) from proposition)::text p,
         (select count(*) from assertion)::text a`)
console.log(`graph: ${c.rows[0]!.e} entities, ${c.rows[0]!.p} propositions, ${c.rows[0]!.a} assertions`)
await db.close()
