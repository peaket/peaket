// F-09-3(HOT-430) 데이터 계층 기준·역할 기본값·MSK IAM 계약 시험.
// 정본: docs/BUILD_ORDER.md:140·:575, docs/devops.md:689~693·:764·:769·:938·:941,
// docs/architecture.md:833, docs/data.md:18~25·:3091~3108·:3163~3177,
// docs/infra.md:13·:176·:325~327·:478~483·:550~551,
// docs/security/secrets-and-keys.md:10·:78~80, docs/security/asvs/delivery.md:75·:147,
// docs/api/avro/README.md:64~74, docs/streaming.md:116~154.
// 실제 AWS·Redis·MSK·Docker는 쓰지 않는다. 이 파일은 원천 YAML·생성 파일·검사기 계약만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC = join(ROOT, 'deploy', 'data', 'peaket-data.yaml');
const GEN = join(ROOT, 'deploy', 'data', 'generated');
const SERVICES = ['core', 'identity', 'ops', 'payment', 'purchase', 'ticket'];

function readSpec() {
  assert.ok(existsSync(SPEC), 'deploy/data/peaket-data.yaml가 없다');
  return parse(readFileSync(SPEC, 'utf8'));
}

function readGen(name) {
  const path = join(GEN, name);
  assert.ok(existsSync(path), `deploy/data/generated/${name}가 없다`);
  return readFileSync(path, 'utf8');
}

function readGenYaml(name) {
  return parse(readGen(name));
}

async function checker() {
  return import(pathToFileURL(join(ROOT, 'tools', 'ci', 'data-platform.mjs')).href);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── D-T30: MSK IAM 역할 짝 ─────────────────────────────────────────────

test('D-T30 ① 데이터 계층 기준과 생성 IAM 문서가 있고 워크로드 이름이 유일하다', () => {
  const spec = readSpec();
  assert.equal(spec.version, 1);
  const workloads = spec.mskIam.workloads;
  assert.ok(workloads.length >= 16, 'MSK에 붙는 워크로드가 16개보다 적다');
  const names = workloads.map((w) => w.name);
  assert.equal(new Set(names).size, names.length, '워크로드 이름이 겹친다');
  for (const expected of [
    ...SERVICES.map((service) => `${service}-svc-outbox-relay`),
    'purchase-svc',
    'queue-svc',
    'core-svc',
    'ops-svc',
    'trust-svc',
    'schema-registry',
    'ops-rt',
    'analytics-ingest',
    'inv-ingest',
    'trust-reassess',
    'rt-pulse',
  ]) {
    assert.ok(names.includes(expected), `${expected} 워크로드가 없다`);
  }

  const generated = readGenYaml('msk-iam.yaml');
  assert.equal(generated.workloads.length, workloads.length);
  assert.deepEqual(
    generated.workloads.map((w) => w.name).sort(),
    [...names].sort(),
  );
});

test('D-T30 ② Pod Identity 역할에는 kafka 권한이 없다', () => {
  const generated = readGenYaml('msk-iam.yaml');
  for (const workload of generated.workloads) {
    assert.deepEqual(
      workload.podIdentityRole.kafkaActions,
      [],
      `${workload.name}의 Pod Identity 역할에 kafka 권한이 있다`,
    );
    const pod = JSON.stringify(workload.podIdentityRole);
    assert.doesNotMatch(pod, /kafka-cluster:/, `${workload.name}의 Pod Identity 역할에 kafka-cluster 권한이 있다`);
  }
});

test('D-T30 ③ MSK 전용 역할의 신뢰 정책은 그 워크로드의 Pod Identity 역할만 믿는다', () => {
  const generated = readGenYaml('msk-iam.yaml');
  for (const workload of generated.workloads) {
    assert.equal(workload.mskRole.trust.action, 'sts:AssumeRole', `${workload.name}의 신뢰 동작이 틀리다`);
    assert.equal(
      workload.mskRole.trust.principal,
      workload.podIdentityRole.name,
      `${workload.name}의 신뢰 정책이 다른 주체를 믿는다`,
    );
    assert.notEqual(workload.mskRole.name, workload.podIdentityRole.name, 'MSK 역할과 Pod Identity 역할이 같다');
    assert.ok(workload.mskRole.permissions.length > 0, `${workload.name}의 MSK 권한이 비었다`);
    for (const permission of workload.mskRole.permissions) {
      assert.ok(permission.actions.length > 0);
      assert.ok(permission.resources.length > 0);
    }
  }
});

test('D-T30 ④ 토큰 함수는 역할을 못 맡으면 기본 자격으로 넘어가지 않는다', () => {
  const source = readFileSync(join(ROOT, 'packages', 'platform', 'src', 'msk-iam.ts'), 'utf8');
  assert.match(source, /generateAuthTokenFromRole/);
  assert.doesNotMatch(source, /[^A-Za-z]generateAuthToken\s*\(/, '맨 generateAuthToken(을 쓴다');
  assert.match(source, /roleArn/);
  assert.match(source, /sessionName/);

  const properties = readGen('schema-registry.properties');
  assert.match(properties, /awsAddDefaultProviders="false"/);
  assert.match(properties, /awsRoleSessionName="schema-registry-<env>"/);
});

test('D-T30 ⑤ 워크로드마다 MSK 전용 역할과 고정 세션 이름이 짝을 이룬다', () => {
  const generated = readGenYaml('msk-iam.yaml');
  const byName = new Map(generated.workloads.map((w) => [w.name, w]));

  for (const service of SERVICES) {
    assert.ok(byName.has(`${service}-svc-outbox-relay`), `${service}-svc-outbox-relay가 없다`);
    assert.equal(byName.get(`${service}-svc-outbox-relay`).sessionName, `${service}-svc-outbox-relay-<env>`);
    assert.ok(byName.get(`${service}-svc-outbox-relay`).writeTopics.length > 0, `${service} 릴레이에 쓰기 권한이 없다`);
  }

  // 요청 처리 파드에는 Outbox 쓰기 권한을 주지 않는다(docs/data.md:3164).
  assert.deepEqual(byName.get('purchase-svc').writeTopics, []);
  assert.equal(byName.get('purchase-svc').sessionName, 'purchase-svc-<env>');
  // queue-svc는 Outbox 없이 support.cases-requested 한 토픽에 직접 쓴다(docs/infra.md:551).
  assert.deepEqual(byName.get('queue-svc').writeTopics, ['support.cases-requested']);
  assert.equal(byName.get('schema-registry').sessionName, 'schema-registry-<env>');
  assert.ok(byName.get('schema-registry').readTopics.includes('_schemas'));
  assert.ok(byName.get('schema-registry').writeTopics.includes('_schemas'));
});

// ── D-T34: 저장소 비밀 교대 사용자 ──────────────────────────────────────

test('D-T34 ① 교대 사용자 둘의 SCRAM 비밀 목록을 낸다', () => {
  const ini = readGen('pgbouncer.ini');
  assert.match(ini, /^pool_mode = transaction$/m);
  assert.match(ini, /^auth_type = scram-sha-256$/m);
  assert.match(ini, /^auth_file = \/etc\/pgbouncer\/userlist\.txt$/m);
  assert.doesNotMatch(ini, /^auth_query/m, 'auth_query를 쓴다');

  const userlist = readGen('pgbouncer-userlist.template');
  for (const service of SERVICES) {
    const role = `${service}_app`;
    assert.match(userlist, new RegExp(`^"${role}" "<SCRAM-SHA-256\\$4096:`, 'm'), `${role} 항목이 없다`);
    assert.match(userlist, new RegExp(`^"${role}_clone" "<SCRAM-SHA-256\\$4096:`, 'm'), `${role}_clone 항목이 없다`);
  }
  assert.doesNotMatch(userlist, /password\s*[:=]\s*['"]?(?!<)/i, '평문 비밀번호가 있다');
});

test('D-T34 ② 새 앱 비밀은 목록 재읽기보다 늦어도 연결 재시도 안에서 성공한다', () => {
  const spec = readSpec();
  const rotation = spec.pgbouncer.rotation;
  assert.equal(rotation.strategy, 'alternating-users');
  assert.equal(rotation.intervalDays, 30);
  assert.equal(rotation.userlistRefreshSeconds, 60);
  assert.equal(rotation.appSecretRefreshSeconds, 3600);
  assert.ok(rotation.appSecretRefreshSeconds > rotation.userlistRefreshSeconds, '앱 비밀이 목록보다 먼저 갱신된다');
  assert.equal(rotation.connectRetrySeconds, 5);
  assert.equal(rotation.connectRetryAttempts, 3);
  assert.equal(rotation.authFailureMetric, 'datastore_auth_failures_total');

  const ini = readGen('pgbouncer.ini');
  assert.match(ini, /^query_wait_timeout = 5$/m);
  assert.match(ini, /^idle_transaction_timeout = 15$/m);
  assert.match(ini, /^query_timeout = 65$/m);
});

test('D-T34 ③ 두 번째 교체 뒤 첫 판 비밀은 거절되고 인증 실패 SEV2가 뜬다', () => {
  const spec = readSpec();
  const rotation = spec.pgbouncer.rotation;
  assert.equal(rotation.intervalDays, 30, '교체 주기가 30일이 아니다');
  assert.equal(rotation.restartWithinDays, 30, '30일 안 재시작이 아니다');
  assert.equal(rotation.authFailureMetric, 'datastore_auth_failures_total');
  assert.equal(rotation.severity, 'SEV2');

  // 두 세대만 유효하다: 사용자마다 지금·이전 항목 둘이고 세 번째 옛 세대는 없다.
  const userlist = readGen('pgbouncer-userlist.template');
  for (const service of SERVICES) {
    const role = `${service}_app`;
    const matches = userlist.split('\n').filter((line) => line.startsWith(`"${role}`));
    assert.equal(matches.length, 2, `${role}에 유효한 세대가 둘이 아니다`);
  }
  assert.doesNotMatch(userlist, /_old|_previous|_v1/, '세 번째 세대 항목이 있다');
});

test('[ASVS v5.0.0-13.2.2] DB·Redis·MSK 계정이 워크로드와 역할별로 나뉜다', () => {
  const spec = readSpec();
  assert.equal(spec.roles.ddl.statementTimeoutMs, 30000);
  assert.equal(spec.roles.ddl.idleInTransactionSessionTimeoutMs, 60000);
  assert.equal(spec.roles.appHotpath.statementTimeoutMs, 1000);
  assert.equal(spec.roles.appGeneral.statementTimeoutMs, 5000);
  assert.equal(spec.roles.maintenance.statementTimeoutMs, 60000);
  assert.equal(spec.roles.outboxRelay.statementTimeoutMs, 5000);
  assert.notDeepEqual(spec.roles.appHotpath.roles, spec.roles.appGeneral.roles);

  assert.equal(spec.redis.auth.mode, 'rbac');
  assert.equal(spec.redis.auth.defaultUser, 'off');
  assert.equal(spec.redis.clusters.length, 3);

  const generated = readGenYaml('msk-iam.yaml');
  for (const workload of generated.workloads) {
    assert.ok(workload.mskRole.name.startsWith('peaket-msk-'), `${workload.name}에 MSK 전용 역할 이름이 없다`);
    assert.ok(workload.podIdentityRole.name.startsWith('peaket-'), `${workload.name}에 Pod Identity 역할 이름이 없다`);
    assert.notEqual(workload.mskRole.name, workload.podIdentityRole.name);
  }
});

test('[ASVS v5.0.0-13.3.4] 교체 일정·재시작·실패 경보가 정본과 같고 생성 파일에 비밀이 없다', () => {
  const spec = readSpec();
  const rotation = spec.pgbouncer.rotation;
  assert.equal(rotation.intervalDays, 30);
  assert.equal(rotation.maintenanceWindow, '04:00-06:00 Asia/Seoul');
  assert.equal(rotation.restartWithinDays, 30);
  assert.equal(rotation.severity, 'SEV2');
  assert.equal(rotation.authFailureMetric, 'datastore_auth_failures_total');

  for (const name of [
    'pgbouncer.ini',
    'pgbouncer-userlist.template',
    'schema-registry.properties',
    'msk-configurations.yaml',
    'redis-parameter-group.yaml',
    'aurora-parameter-group.yaml',
    'role-defaults.sql',
    'topics.yaml',
    'msk-iam.yaml',
  ]) {
    const text = readGen(name);
    assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}/, `${name}에 AWS 접근 키가 있다`);
    assert.doesNotMatch(text, /\b\d{12}\b/, `${name}에 12자리 AWS 계정 ID가 있다`);
    assert.doesNotMatch(text, /aws_secret_access_key/i, `${name}에 비밀 접근 키 이름이 있다`);
    assert.doesNotMatch(text, /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/, `${name}에 개인 키가 있다`);
  }
});

// ── Redis ────────────────────────────────────────────────────────────

test('F09-3-REDIS-01 세 클러스터가 클러스터 모드·TLS·RBAC·기본 사용자 끔이다', () => {
  const spec = readSpec();
  const redis = spec.redis;
  assert.equal(redis.engine, 'valkey');
  assert.equal(redis.engineVersion, '8.1');
  assert.equal(redis.clusterMode, true);
  assert.equal(redis.multiAz, true);
  assert.equal(redis.automaticFailover, true);
  assert.equal(redis.transitEncryption, true);
  assert.equal(redis.atRestEncryption, true);
  assert.deepEqual(redis.clusters.map((c) => c.name), ['queue', 'seat', 'session-cache']);
  for (const cluster of redis.clusters) {
    assert.ok(cluster.nodeType.startsWith('cache.'), `${cluster.name}의 노드 형식이 없다`);
    assert.ok(cluster.replicasPerShard >= 1, `${cluster.name}에 복제본이 없다`);
    assert.ok(cluster.keys.length > 0, `${cluster.name}의 키 접두사가 없다`);
  }
});

test('F09-3-REDIS-02 매개변수 그룹은 noeviction·latency-tracking·슬로 로그다', () => {
  const params = readGenYaml('redis-parameter-group.yaml');
  assert.equal(params.parameters['maxmemory-policy'], 'noeviction');
  assert.equal(params.parameters['latency-tracking'], 'yes');
  assert.equal(params.parameters['slowlog-max-len'], '128');
  assert.equal(params.parameters['slowlog-log-slower-than'], '10000');
});

test('F09-3-REDIS-03 TTL 규칙과 메모리 70/85·eviction 0 경보가 있다', () => {
  const spec = readSpec();
  assert.equal(spec.redis.ttl.sessionCacheAllKeys, true);
  assert.equal(spec.redis.ttl.queueSeatPerKey, true);
  assert.equal(spec.redis.memoryAlerts.warnPercent, 70);
  assert.equal(spec.redis.memoryAlerts.criticalPercent, 85);
  assert.equal(spec.redis.memoryAlerts.evictions, 0);
});

// ── Aurora ───────────────────────────────────────────────────────────

test('F09-3-AURORA-01 다섯 클러스터가 force_ssl·verify-full이다', () => {
  const spec = readSpec();
  const aurora = spec.aurora;
  assert.equal(aurora.engine, 'aurora-postgresql');
  assert.equal(aurora.engineVersion, '18.6.1');
  assert.equal(aurora.tls.forceSsl, true);
  assert.equal(aurora.tls.clientSslMode, 'verify-full');
  assert.deepEqual(aurora.clusters.map((c) => c.name), ['purchase', 'payment', 'ticket', 'ops', 'shared']);
  assert.deepEqual(aurora.clusters.find((c) => c.name === 'shared').databases, ['identity', 'core']);
});

test('F09-3-AURORA-02 진단 매개변수 다섯이 정본 값이다', () => {
  const params = readGenYaml('aurora-parameter-group.yaml');
  assert.equal(params.parameters['rds.force_ssl'], '1');
  assert.equal(params.parameters['auto_explain.log_min_duration'], '500ms');
  assert.equal(params.parameters['auto_explain.sample_rate'], '0.1');
  assert.equal(params.parameters['log_temp_files'], '10240');
  assert.equal(params.parameters['log_parameter_max_length'], '0');
});

test('F09-3-AURORA-03 백업 35일·교차 리전 7일·삭제 보호가 있다', () => {
  const spec = readSpec();
  assert.equal(spec.aurora.backup.retentionDays, 35);
  assert.equal(spec.aurora.backup.pointInTimeRecovery, true);
  assert.equal(spec.aurora.backup.crossRegionSnapshot, true);
  assert.equal(spec.aurora.backup.crossRegionRetentionDays, 7);
  assert.equal(spec.aurora.deletionProtection, true);
});

test('F09-3-AURORA-04 연결 예산이 파드×풀+예비와 같고 80% 상한 안이다', () => {
  const spec = readSpec();
  for (const [db, pool] of Object.entries(spec.aurora.pools)) {
    assert.equal(pool.maxPods * pool.poolPerPod + pool.reserve, pool.connectionBudget, `${db} 예산 식이 틀리다`);
    assert.ok(pool.connectionBudget <= pool.maxConnections80Percent, `${db} 예산이 80% 상한을 넘는다`);
  }
  assert.equal(spec.aurora.pools.purchase.maxPods, 40);
  assert.equal(spec.aurora.pools.purchase.poolPerPod, 20);
  assert.equal(spec.aurora.pools.purchase.connectionBudget, 850);
  assert.equal(spec.aurora.pools.payment.maxPods, 12);
  assert.equal(spec.aurora.pools.payment.poolPerPod, 32);
  assert.equal(spec.aurora.pools.payment.connectionBudget, 404);
});

// ── MSK ──────────────────────────────────────────────────────────────

test('F09-3-MSK-01 세 클러스터의 브로커·RF·min ISR·acks·unclean·자동 생성이 정본과 같다', () => {
  const spec = readSpec();
  const msk = spec.msk;
  assert.equal(msk.engineVersion, '3.9.x');
  assert.deepEqual(msk.clusters.map((c) => c.name), ['trade-control', 'telemetry', 'observability']);
  const trade = msk.clusters.find((c) => c.name === 'trade-control');
  assert.equal(trade.brokers, 6);
  assert.equal(trade.replicationFactor, 3);
  assert.equal(trade.minInSyncReplicas, 2);
  assert.equal(trade.acks, 'all');
  assert.equal(trade.uncleanLeaderElection, false);
  assert.equal(trade.autoCreateTopics, false);
  for (const name of ['telemetry']) {
    const cluster = msk.clusters.find((c) => c.name === name);
    assert.equal(cluster.brokers, 3);
    assert.equal(cluster.replicationFactor, 3);
    assert.equal(cluster.minInSyncReplicas, 2);
    assert.equal(cluster.acks, 'all');
    assert.equal(cluster.uncleanLeaderElection, false);
    assert.equal(cluster.autoCreateTopics, false);
  }
  const observability = msk.clusters.find((c) => c.name === 'observability');
  assert.equal(observability.brokers, 3);
  assert.equal(observability.uncleanLeaderElection, true, '관측 전용은 MSK 기본값(가용성 우선)이다');
});

test('F09-3-MSK-02 보존 7일·탈퇴 3일·조사 3일·_schemas 3파티션이 있다', () => {
  const spec = readSpec();
  const topics = spec.msk.topicOverrides;
  const byName = new Map(topics.map((t) => [t.name, t]));
  for (const cluster of spec.msk.clusters) {
    assert.equal(cluster.retentionMs, 604800000, `${cluster.name} 기본 보존이 7일이 아니다`);
  }
  assert.equal(byName.get('identity.accounts-withdrawn').retentionMs, 259200000);
  assert.equal(byName.get('identity.accounts-withdrawn').segmentMs, 86400000);
  assert.equal(byName.get('investigation.requests').retentionMs, 259200000);
  assert.equal(byName.get('investigation.requests').partitions, 12);
  assert.equal(byName.get('_schemas').partitions, 3);
  assert.equal(byName.get('_schemas').replicationFactor, 3);
  assert.equal(byName.get('_schemas').cleanupPolicy, 'compact');

  const generated = readGenYaml('topics.yaml');
  assert.ok(generated.topics.some((t) => t.name === '_schemas' && t.partitions === 3));
  assert.ok(generated.topics.some((t) => t.name === 'investigation.requests' && t.partitions === 12));
});

test('F09-3-MSK-03 생성 MSK 설정은 거래·텔레메트리에 네 값을 적고 관측은 기본값이다', () => {
  const generated = readGenYaml('msk-configurations.yaml');
  assert.equal(generated.clusters['trade-control'].numberOfBrokerNodes, 6);
  assert.deepEqual(generated.clusters['trade-control'].configuration, {
    'auto.create.topics.enable': 'false',
    'default.replication.factor': '3',
    'min.insync.replicas': '2',
    'unclean.leader.election.enable': 'false',
  });
  assert.deepEqual(generated.clusters.telemetry.configuration, generated.clusters['trade-control'].configuration);
  assert.equal(generated.clusters.observability.configuration, 'default');
});

// ── Schema Registry ──────────────────────────────────────────────────

test('F09-3-SR-01 호환성은 BACKWARD_TRANSITIVE·주제 이름은 TopicRecordNameStrategy다', () => {
  const spec = readSpec();
  const sr = spec.schemaRegistry;
  assert.equal(sr.compatibility, 'BACKWARD_TRANSITIVE');
  assert.equal(sr.subjectNameStrategy, 'TopicRecordNameStrategy');
  assert.equal(sr.autoRegisterSchemas, false);
  assert.equal(sr.useLatestVersion, false);
});

test('F09-3-SR-02 _schemas 3파티션·RF 3·2복제·PDB 1이다', () => {
  const spec = readSpec();
  assert.equal(spec.schemaRegistry.replicas, 2);
  assert.equal(spec.schemaRegistry.pdbMinAvailable, 1);
  assert.equal(spec.schemaRegistry.kafkastore.topic, '_schemas');
  assert.equal(spec.schemaRegistry.kafkastore.topicReplicationFactor, 3);
  assert.equal(spec.schemaRegistry.kafkastore.leaderEligibility, true);
});

test('F09-3-SR-03 생성 속성은 MSK IAM kafkastore 설정을 담는다', () => {
  const properties = readGen('schema-registry.properties');
  for (const line of [
    'kafkastore.topic=_schemas',
    'kafkastore.topic.replication.factor=3',
    'kafkastore.security.protocol=SASL_SSL',
    'kafkastore.sasl.mechanism=AWS_MSK_IAM',
    'kafkastore.sasl.client.callback.handler.class=software.amazon.msk.auth.iam.IAMClientCallbackHandler',
    'kafkastore.leader.eligibility=true',
  ]) {
    assert.match(properties, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `${line}이 없다`);
  }
  assert.match(properties, /awsStsRegion="ap-northeast-2"/);
});

// ── PgBouncer ────────────────────────────────────────────────────────

test('F09-3-PGB-01 1.26.1·transaction 풀링·max_prepared_statements 200이다', () => {
  const spec = readSpec();
  assert.equal(spec.pgbouncer.version, '1.26.1');
  assert.equal(spec.pgbouncer.poolMode, 'transaction');
  assert.equal(spec.pgbouncer.maxPreparedStatements, 200);
  assert.equal(spec.pgbouncer.useAuthQuery, false);
});

test('F09-3-PGB-02 대기 5초·유휴 트랜잭션 15초·쿼리 65초·서버 600/3600초다', () => {
  const spec = readSpec();
  assert.equal(spec.pgbouncer.queryWaitTimeoutSeconds, 5);
  assert.equal(spec.pgbouncer.idleTransactionTimeoutSeconds, 15);
  assert.equal(spec.pgbouncer.queryTimeoutSeconds, 65);
  assert.equal(spec.pgbouncer.serverIdleTimeoutSeconds, 600);
  assert.equal(spec.pgbouncer.serverLifetimeSeconds, 3600);
});

test('F09-3-PGB-03 SCRAM·TLS·auth_file·DB별 풀 크기가 있다', () => {
  const spec = readSpec();
  assert.equal(spec.pgbouncer.authType, 'scram-sha-256');
  assert.equal(spec.pgbouncer.authFile, '/etc/pgbouncer/userlist.txt');
  assert.equal(spec.pgbouncer.clientTls.sslMode, 'require');
  assert.equal(spec.pgbouncer.serverTls.sslMode, 'verify-full');
  assert.equal(spec.pgbouncer.pools.purchase.defaultPoolSize, 20);
  assert.equal(spec.pgbouncer.pools.payment.defaultPoolSize, 32);
  for (const [db, pool] of Object.entries(spec.pgbouncer.pools)) {
    assert.ok(pool.minPoolSize >= 0, `${db} minPoolSize`);
    assert.ok(pool.reservePoolSize >= 0, `${db} reservePoolSize`);
  }
});

// ── 역할 기본값 ──────────────────────────────────────────────────────

test('F09-3-ROLE-01 다섯 역할 줄의 값이 정본과 같다', () => {
  const spec = readSpec();
  assert.deepEqual(spec.roles.ddl, {
    statementTimeoutMs: 30000,
    idleInTransactionSessionTimeoutMs: 60000,
  });
  assert.deepEqual(spec.roles.appHotpath.roles, ['purchase_app', 'payment_app', 'identity_app']);
  assert.equal(spec.roles.appHotpath.statementTimeoutMs, 1000);
  assert.equal(spec.roles.appHotpath.idleInTransactionSessionTimeoutMs, 10000);
  assert.deepEqual(spec.roles.appGeneral.roles, ['ticket_app', 'ops_app', 'core_app']);
  assert.equal(spec.roles.appGeneral.statementTimeoutMs, 5000);
  assert.equal(spec.roles.appGeneral.idleInTransactionSessionTimeoutMs, 10000);
  assert.equal(spec.roles.maintenance.statementTimeoutMs, 60000);
  assert.equal(spec.roles.maintenance.idleInTransactionSessionTimeoutMs, 60000);
  assert.equal(spec.roles.maintenance.workMem, '64MB');
  assert.equal(spec.roles.outboxRelay.statementTimeoutMs, 5000);
  assert.equal(spec.roles.outboxRelay.idleInTransactionSessionTimeoutMs, 30000);
});

test('F09-3-ROLE-02 서비스 여섯의 역할 이름으로 SQL을 편다', () => {
  const sql = readGen('role-defaults.sql');
  for (const line of [
    "ALTER ROLE core_ddl SET statement_timeout = '30s';",
    "ALTER ROLE core_ddl SET idle_in_transaction_session_timeout = '60s';",
    "ALTER ROLE purchase_app SET statement_timeout = '1s';",
    "ALTER ROLE purchase_app SET idle_in_transaction_session_timeout = '10s';",
    "ALTER ROLE payment_app SET statement_timeout = '1s';",
    "ALTER ROLE identity_app SET statement_timeout = '1s';",
    "ALTER ROLE ticket_app SET statement_timeout = '5s';",
    "ALTER ROLE ops_app SET statement_timeout = '5s';",
    "ALTER ROLE core_app SET statement_timeout = '5s';",
    "ALTER ROLE core_maintenance SET statement_timeout = '60s';",
    "ALTER ROLE core_maintenance SET idle_in_transaction_session_timeout = '60s';",
    "ALTER ROLE core_maintenance SET work_mem = '64MB';",
    "ALTER ROLE core_outbox_relay SET statement_timeout = '5s';",
    "ALTER ROLE core_outbox_relay SET idle_in_transaction_session_timeout = '30s';",
  ]) {
    assert.ok(sql.includes(line), `${line}이 없다`);
  }
});

test('F09-3-ROLE-03 앱 역할은 교대 사용자 둘 다에 걸고 릴레이·정비는 하나다', () => {
  const sql = readGen('role-defaults.sql');
  for (const service of SERVICES) {
    assert.ok(sql.includes(`ALTER ROLE ${service}_app SET statement_timeout`), `${service}_app`);
    assert.ok(sql.includes(`ALTER ROLE ${service}_app_clone SET statement_timeout`), `${service}_app_clone`);
    assert.ok(sql.includes(`ALTER ROLE ${service}_maintenance SET statement_timeout`), `${service}_maintenance`);
    assert.ok(sql.includes(`ALTER ROLE ${service}_outbox_relay SET statement_timeout`), `${service}_outbox_relay`);
  }
  assert.doesNotMatch(sql, /_maintenance_clone|_outbox_relay_clone|_ddl_clone/, '정비·릴레이·DDL에 교대 사용자를 만들었다');
});

// ── 검사기 음성 사례 ─────────────────────────────────────────────────

test('F09-3-NEG-01 Redis eviction 정책을 막는다', async () => {
  const { validateData } = await checker();
  const spec = clone(readSpec());
  spec.redis.parameterGroup['maxmemory-policy'] = 'volatile-lru';
  const errors = validateData(spec);
  assert.ok(errors.some((e) => /noeviction|evict/i.test(e)), errors.join('\n'));
});

test('F09-3-NEG-02 Aurora 삭제 보호 끔을 막는다', async () => {
  const { validateData } = await checker();
  const spec = clone(readSpec());
  spec.aurora.deletionProtection = false;
  const errors = validateData(spec);
  assert.ok(errors.some((e) => /deletion|삭제/i.test(e)), errors.join('\n'));
});

test('F09-3-NEG-03 거래·제어 MSK의 unclean leader election 켬을 막는다', async () => {
  const { validateData } = await checker();
  const spec = clone(readSpec());
  spec.msk.clusters.find((c) => c.name === 'trade-control').uncleanLeaderElection = true;
  const errors = validateData(spec);
  assert.ok(errors.some((e) => /unclean/i.test(e)), errors.join('\n'));
});

test('F09-3-NEG-04 Schema Registry 호환성 FULL을 막는다', async () => {
  const { validateData } = await checker();
  const spec = clone(readSpec());
  spec.schemaRegistry.compatibility = 'FULL';
  const errors = validateData(spec);
  assert.ok(errors.some((e) => /BACKWARD_TRANSITIVE/.test(e)), errors.join('\n'));
});

test('F09-3-NEG-05 PgBouncer auth_query와 단일 사용자를 막는다', async () => {
  const { validateData } = await checker();
  const spec = clone(readSpec());
  spec.pgbouncer.useAuthQuery = true;
  spec.pgbouncer.rotation.strategy = 'single-user';
  const errors = validateData(spec);
  assert.ok(errors.some((e) => /auth_query/i.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /alternating-users|단일 사용자/i.test(e)), errors.join('\n'));
});

test('F09-3-NEG-06 Pod Identity 역할의 kafka 권한을 막는다', async () => {
  const { validateData } = await checker();
  const spec = clone(readSpec());
  spec.mskIam.podIdentityHasKafkaPermissions = true;
  const errors = validateData(spec);
  assert.ok(errors.some((e) => /kafka|Pod Identity/i.test(e)), errors.join('\n'));
});

test('F09-3-NEG-07 역할 기본값 누락을 막는다', async () => {
  const { validateData } = await checker();
  const spec = clone(readSpec());
  delete spec.roles.outboxRelay;
  const errors = validateData(spec);
  assert.ok(errors.some((e) => /outboxRelay|릴레이/i.test(e)), errors.join('\n'));
});

test('F09-3-GEN-01 생성 파일이 원천과 같다', async () => {
  const { loadDataSpec, validateData, renderPgBouncerIni, renderSchemaRegistryProperties, renderRoleDefaultsSql } = await checker();
  const spec = loadDataSpec(ROOT);
  assert.deepEqual(validateData(spec), []);
  assert.equal(readGen('pgbouncer.ini'), renderPgBouncerIni(spec));
  assert.equal(readGen('schema-registry.properties'), renderSchemaRegistryProperties(spec));
  assert.equal(readGen('role-defaults.sql'), renderRoleDefaultsSql(spec));
});
