// 배포 단위 값(deploy/workloads/<워크로드>/values.yaml)의 정적 시험(BUILD_ORDER PRF-050·PRF-137, HOT-400 묶음 BAT-057 계획 §6 S4·S5·S6, ADR-0288 결정 7·8).
// 정본: ADR-0288 결정 8(배포 단위 둘, 비밀은 secretEnvFrom, 발급자 셋이 같은 값 https://queue.peaket.example [가정]), ADR-0285 결정 5·6(포트 REST 8080·지표 9464·
// 업무 gRPC 50051·제어 50061, 업무 gRPC 주소는 <워크로드>-grpc:<포트>), docs/features/seat-hold.md §2 '입장 토큰 공개키 묶음 주기 읽기'의 '배포 값'·'정적 묶음',
// docs/features/queue-admission.md §6 '키 설정'·'묶음 배포'(GET /internal/jwks/admission.json, queue-svc 앱 포트), docs/devops.md §5.2 '네임스페이스 지도'(queue-svc는 queue),
// docs/security/secrets-and-keys.md(비밀은 Secrets Manager → Secret). 값은 정본에서 그대로 적는다(값 파일·생성기에서 가져오지 않는다).
// 실행(저장소 뿌리): node --test "deploy/workloads/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';
import { ensureTool } from '../../../tools/local/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKLOADS = resolve(HERE, '..');
const REPO = resolve(WORKLOADS, '..', '..');
const CHART = join(REPO, 'deploy', 'charts', 'peaket-service');
const helm = await ensureTool('helm');

// ---- 정본 값 ----
const REST_PORT = 8080;
const METRICS_PORT = 9464;
const GRPC_PORT = 50051;
const CONTROL_PORT = 50061;
const ADMISSION_ISSUER = 'https://queue.peaket.example';
/** 서비스 시작 명령(services/<서비스>/package.json의 start와 같은 뜻: 텔레메트리를 먼저 읽고 dist/main.js) */
const COMMAND = ['node', '--import', '@peaket/platform/telemetry/register', 'dist/main.js'];
/** queue-svc가 비밀로만 받는 값(docs/features/queue-admission.md §3 '설정값'·§6 '키 설정', docs/security/secrets-and-keys.md): 입장 토큰 개인 키, 대기표 키, 도착 시각 쿠키 키, 최초 방문 쿠키 키, 내부 토큰 */
const QUEUE_SECRETS = ['PEAKET_ADMISSION_TOKEN_KEY', 'PEAKET_QUEUE_TOKEN_KEY', 'PEAKET_QUEUE_TOKEN_KEY_PREVIOUS', 'PEAKET_ARRIVAL_COOKIE_KEY', 'PEAKET_ARRIVAL_COOKIE_KEY_PREVIOUS', 'PEAKET_FIRST_VISIT_COOKIE_KEYS', 'PEAKET_INTERNAL_TOKEN', 'PEAKET_QUEUE_REDIS_URL', 'PEAKET_QUEUE_REDIS_CLUSTER_URLS'];
/** purchase-svc가 비밀로만 받는 값: 서버 ECDH 개인키, 좌석 Redis 주소, DB 주소, 내부 토큰 */
const PURCHASE_SECRETS = ['PEAKET_PURCHASE_ECDH_KEY', 'PEAKET_SEAT_REDIS_URL', 'PEAKET_SEAT_REDIS_CLUSTER_URLS', 'PEAKET_DATABASE_URL', 'PEAKET_INTERNAL_TOKEN'];
/** 비밀 같은 이름(값을 env에 두면 안 된다) */
const SECRET_LIKE = /(_KEY|_KEYS|_KEY_PREVIOUS|_SECRET|_PASSWORD|_TOKEN)$/;

function load(name) {
  const file = join(WORKLOADS, name, 'values.yaml');
  assert.ok(existsSync(file), `배포 단위 값이 없다: deploy/workloads/${name}/values.yaml`);
  return parse(readFileSync(file, 'utf8'));
}
/** 차트를 identity 배포 단위 값으로 렌더한다(RV-01: 환경 값 계약, RV-07: secretEnvFrom/ExternalSecret만 쓰는지) */
function renderIdentity(sets) {
  const r = spawnSync(
    helm,
    [
      'template', 'identity', CHART, '--namespace', 'core',
      '-f', join(WORKLOADS, 'identity-svc', 'values.yaml'),
      '--set', 'image.repository=peaket/identity-svc', '--set', 'image.tag=local', '--set', 'env.PEAKET_ENV=local',
      ...sets.flatMap((s) => ['--set', s]),
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return { error: r.stderr };
  return { objects: parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean) };
}
const findObject = (objs, kind, name) => objs.find((o) => o.kind === kind && o.metadata?.name === name);
/** 두 Deployment가 받는 env와 서비스 Deployment만 받는 service.env를 합친 것(같은 이름이 둘에 있으면 던진다) */
function envOf(v, label) {
  const top = v?.env ?? {};
  const svc = v?.service?.env ?? {};
  for (const k of Object.keys(top)) assert.ok(!(k in svc), `${label}: ${k}가 env와 service.env에 둘 다 있다`);
  return { ...top, ...svc };
}
/** 환경 덧씌우기(deploy/envs/<환경>/<서비스>.yaml)의 값들(있으면 같은 규칙을 본다) */
function overlays(name) {
  const dir = join(REPO, 'deploy', 'envs');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const f = join(dir, e.name, `${name}.yaml`);
    if (existsSync(f)) for (const d of parseAllDocuments(readFileSync(f, 'utf8'))) out.push({ file: `deploy/envs/${e.name}/${name}.yaml`, v: d.toJS() });
  }
  return out;
}
function assertNoSecrets(v, secrets, label) {
  const env = envOf(v, label);
  for (const k of secrets) assert.equal(env[k], undefined, `${label}: 비밀 ${k}를 env에 두었다(secretEnvFrom으로만 받는다)`);
  for (const k of Object.keys(env)) assert.doesNotMatch(k, SECRET_LIKE, `${label}: 비밀 같은 이름 ${k}를 env에 두었다`);
  assert.equal(typeof v.secretEnvFrom, 'string', `${label}: secretEnvFrom이 없다`);
  assert.notEqual(v.secretEnvFrom.trim(), '', `${label}: secretEnvFrom이 비었다`);
  // 값 파일 글 어디에도 JWK·PEM 같은 키 값이 없다
  const raw = JSON.stringify(v);
  assert.doesNotMatch(raw, /"kty"|"d"\s*:|BEGIN [A-Z ]*PRIVATE KEY/, `${label}: 키 값이 들어 있다`);
}

test('PRF-050 queue-svc 배포 단위: 이름·앱 8080·관리 9464, extraPorts 업무 gRPC 50051·제어 50061과 그 포트를 가리키는 PEAKET_GRPC_PORT·PEAKET_QUEUE_CONTROL_GRPC_PORT, 시작 명령 dist/main.js, 업무 gRPC 주소 둘', () => {
  const v = load('queue-svc');
  assert.equal(v.name, 'queue-svc');
  assert.equal(v.service?.port, REST_PORT, 'service.port');
  assert.equal(v.managementPort, METRICS_PORT, 'managementPort');
  assert.notEqual(v.service?.enabled, false, '서비스 Deployment가 꺼졌다');
  const extra = (v.service?.extraPorts ?? []).map((p) => ({ name: p.name, port: p.port }));
  assert.deepEqual(extra.map((p) => p.port).sort(), [GRPC_PORT, CONTROL_PORT].sort(), `extraPorts ${JSON.stringify(extra)}`);
  assert.equal(new Set(extra.map((p) => p.name)).size, extra.length, 'extraPorts 이름이 겹친다');
  assert.deepEqual(v.service?.command, COMMAND, '시작 명령');
  const pkg = JSON.parse(readFileSync(join(REPO, 'services', 'queue-svc', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts?.start, COMMAND.join(' '), 'queue-svc package.json start와 같은 명령');
  const env = envOf(v, 'queue-svc');
  assert.equal(env.PEAKET_GRPC_PORT, String(GRPC_PORT), 'PEAKET_GRPC_PORT');
  assert.equal(env.PEAKET_QUEUE_CONTROL_GRPC_PORT, String(CONTROL_PORT), 'PEAKET_QUEUE_CONTROL_GRPC_PORT');
  // 업무 gRPC는 웨이포인트를 붙인 전용 Service <워크로드>-grpc:50051(ADR-0285 결정 5)
  assert.equal(env.PEAKET_IDENTITY_GRPC_URL, `identity-svc-grpc:${GRPC_PORT}`, 'PEAKET_IDENTITY_GRPC_URL');
  assert.equal(env.PEAKET_TRUST_GRPC_URL, `trust-svc-grpc:${GRPC_PORT}`, 'PEAKET_TRUST_GRPC_URL');
  // 운영 값이다: 로컬 전용 설정(PEAKET_ENV를 배포 단위에 박음, 정적 키)을 두지 않는다
  assert.equal(env.PEAKET_ENV, undefined, 'PEAKET_ENV는 환경 값에 둔다');
});

test('PRF-050 [ASVS v5.0.0-9.1.3] queue-svc 배포 단위: 입장 토큰 개인 키·대기표 키·도착 쿠키 키·최초 방문 쿠키 키·내부 토큰·Redis 주소는 env에 없고 secretEnvFrom이 비지 않았다', () => {
  const v = load('queue-svc');
  assertNoSecrets(v, QUEUE_SECRETS, 'queue-svc');
  for (const o of overlays('queue-svc')) for (const k of QUEUE_SECRETS) assert.equal(envOf(o.v, o.file)[k], undefined, `${o.file}: 비밀 ${k}`);
});

test('PRF-137 Q-T69 ④ purchase-svc 배포 단위: PEAKET_ADMISSION_JWKS_URL은 queue-svc 앱 포트의 /internal/jwks/admission.json이고 PEAKET_ADMISSION_ISSUER가 있으며 정적 PEAKET_ADMISSION_JWKS가 없다', () => {
  const v = load('purchase-svc');
  assert.equal(v.name, 'purchase-svc');
  assert.equal(v.service?.port, REST_PORT, 'service.port');
  assert.equal(v.managementPort, METRICS_PORT, 'managementPort');
  assert.deepEqual(v.service?.command, COMMAND, '시작 명령');
  const env = envOf(v, 'purchase-svc');
  const raw = env.PEAKET_ADMISSION_JWKS_URL;
  assert.equal(typeof raw, 'string', 'PEAKET_ADMISSION_JWKS_URL이 없다');
  const u = new URL(raw);
  assert.ok(['http:', 'https:'].includes(u.protocol), `묶음 주소의 scheme ${u.protocol}`);
  // 클러스터 안 queue-svc Service(네임스페이스 queue)의 앱 포트
  assert.ok(['queue-svc.queue', 'queue-svc.queue.svc', 'queue-svc.queue.svc.cluster.local'].includes(u.hostname), `묶음 주소의 호스트 ${u.hostname}`);
  assert.equal(Number(u.port || (u.protocol === 'https:' ? 443 : 80)), REST_PORT, '묶음 주소의 포트(queue-svc 앱 포트)');
  assert.equal(u.pathname, '/internal/jwks/admission.json', '묶음 경로');
  assert.equal(u.search + u.hash + u.username + u.password, '', '묶음 주소에 쿼리·조각·사용자 정보');
  assert.equal(typeof env.PEAKET_ADMISSION_ISSUER, 'string', 'PEAKET_ADMISSION_ISSUER가 없다');
  // 정적 묶음은 local·ci만 받는다(두 값이 함께 있으면 시작하지 않는다)
  assert.equal(env.PEAKET_ADMISSION_JWKS, undefined, '정적 PEAKET_ADMISSION_JWKS를 두었다');
  for (const o of overlays('purchase-svc')) assert.equal(envOf(o.v, o.file).PEAKET_ADMISSION_JWKS, undefined, `${o.file}: 정적 묶음`);
});

test('PRF-137 purchase-svc 배포 단위: PEAKET_SEATMAP_DIR은 서비스 파드에 붙인 볼륨의 자리와 같고(읽기 전용), 비밀(ECDH 개인키·좌석 Redis·DB 주소·내부 토큰)은 env에 없다', () => {
  const v = load('purchase-svc');
  const env = envOf(v, 'purchase-svc');
  const dir = env.PEAKET_SEATMAP_DIR;
  assert.equal(typeof dir, 'string', 'PEAKET_SEATMAP_DIR이 없다');
  const mounts = (v.service?.volumeMounts ?? []).filter((m) => m.mountPath === dir);
  assert.equal(mounts.length, 1, `${dir}에 붙인 volumeMount가 하나여야 한다(${mounts.length})`);
  assert.equal(mounts[0].readOnly, true, '좌석맵 판 볼륨은 읽기 전용');
  const vol = (v.service?.volumes ?? []).find((x) => x.name === mounts[0].name);
  assert.ok(vol, `volumeMount ${mounts[0].name}의 볼륨이 service.volumes에 없다`);
  assertNoSecrets(v, PURCHASE_SECRETS, 'purchase-svc');
});

test('F-05-3 IR-01 purchase-svc가 queue-svc 우선 구매 권리 gRPC를 부를 수 있고 업무 gRPC 주소가 mesh와 맞는다', () => {
  const v = load('purchase-svc');
  const env = envOf(v, 'purchase-svc');
  assert.equal(env.PEAKET_QUEUE_GRPC_ADDR, 'queue-svc-grpc:50051', 'PEAKET_QUEUE_GRPC_ADDR');

  const source = parse(readFileSync(join(REPO, 'deploy', 'platform', 'mesh', 'port-allow.yaml'), 'utf8'));
  const callers = source.workloads['queue-svc'].ports.grpc.services['peaket.queue.v1.PriorityGrantService'];
  assert.deepEqual(callers, ['ops-svc', 'purchase-svc'], 'PriorityGrantService 부르는 쪽');

  const policies = yamlDocs('deploy', 'platform', 'mesh', 'policies.yaml');
  const policy = policies.find((o) => o.kind === 'AuthorizationPolicy' && o.metadata?.name === 'queue-svc-waypoint-callers');
  assert.ok(policy, 'AuthorizationPolicy queue-svc-waypoint-callers가 없다');
  const rule = policy.spec.rules.find((r) => r.to?.some((t) => t.operation?.paths?.includes('/peaket.queue.v1.PriorityGrantService/*')));
  assert.ok(rule, 'PriorityGrantService L7 ALLOW 규칙이 없다');
  const principals = rule.from.flatMap((f) => f.source?.principals ?? []);
  assert.ok(principals.includes('cluster.local/ns/purchase/sa/purchase-svc'), 'purchase-svc 주체가 없다');
  assert.ok(principals.includes('cluster.local/ns/core/sa/ops-svc'), 'ops-svc 주체가 없다');
});

test('ADR-0288 결정 8 [ASVS v5.0.0-9.2.2] 입장 토큰 발급자 셋(queue-svc PEAKET_ADMISSION_TOKEN_ISSUER, purchase-svc PEAKET_ADMISSION_ISSUER, gw-fan admissionIssuer)이 같은 https 값 https://queue.peaket.example이다', () => {
  const q = envOf(load('queue-svc'), 'queue-svc').PEAKET_ADMISSION_TOKEN_ISSUER;
  const p = envOf(load('purchase-svc'), 'purchase-svc').PEAKET_ADMISSION_ISSUER;
  // gw-fan의 공통 Lua 설정(admission 참인 것)의 admissionIssuer
  const gw = [];
  const dir = join(REPO, 'deploy', 'gateways');
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)))
    for (const d of parseAllDocuments(readFileSync(join(dir, f), 'utf8'))) {
      const o = d.toJS();
      if (o?.kind !== 'EnvoyExtensionPolicy') continue;
      for (const l of o.spec?.lua ?? []) if (l.filterContext?.admission === true) gw.push(l.filterContext.admissionIssuer);
    }
  assert.ok(gw.length > 0, 'gw-fan에 admission 설정이 없다');
  const all = [q, p, ...gw];
  for (const x of all) assert.equal(x, ADMISSION_ISSUER, `발급자 ${JSON.stringify(all)}`);
  assert.match(ADMISSION_ISSUER, /^https:\/\//);
  // 환경 덧씌우기가 발급자를 다른 값으로 바꾸지 않는다
  for (const [name, key] of [
    ['queue-svc', 'PEAKET_ADMISSION_TOKEN_ISSUER'],
    ['purchase-svc', 'PEAKET_ADMISSION_ISSUER'],
  ])
    for (const o of overlays(name)) {
      const x = envOf(o.v, o.file)[key];
      if (x !== undefined) assert.equal(x, ADMISSION_ISSUER, `${o.file}: ${key}`);
    }
});

test('PRF-050 PRF-137 메시 생성 대조(node tools/ci/mesh-policies.mjs --check)가 두 배포 단위 값과 함께 문제 없이 맞다', () => {
  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'ci', 'mesh-policies.mjs'), '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, `mesh-policies --check 종료 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /deploy\/workloads\/(queue|purchase)-svc/, '배포 단위 값 문제가 보고됐다');
});

// --- BAS-140 배포 값과 경보·정책(묶음 BAT-080 G4·G5·G6, ADR-0310·0311·0312) ---
// 정본: docs/BUILD_ORDER.md:416, docs/security/secrets-and-keys.md '팬 액세스 토큰 서명 키'(51행), docs/features/identity.md §2(52행)·§3,
// docs/features/seat-hold.md §7(realtime-gw·좌석 Redis 구독 ACL), docs/observability.md §5 SEV2·G-06, docs/devops.md §5.2(네임스페이스 지도).

const repoText = (...p) => readFileSync(join(REPO, ...p), 'utf8');
/** 저장소의 YAML 파일 하나를 문서 목록으로 읽는다 */
function yamlDocs(...p) {
  const file = join(REPO, ...p);
  assert.ok(existsSync(file), `YAML 파일이 없다: ${p.join('/')}`);
  return parseAllDocuments(readFileSync(file, 'utf8'))
    .map((d) => d.toJS())
    .filter(Boolean);
}
const allEnv = (v, label) => ({
  ...envOf(v ?? {}, label),
  ...(v?.outboxRelay?.env ?? {}),
});

test('ID-01 identity-svc 배포 값: 이름·앱 8080·업무 gRPC 50051(extraPorts·PEAKET_GRPC_PORT)·관리 9464·시작 명령 dist/main.js이고 자기 gRPC 주소는 없다', () => {
  const v = load('identity-svc');
  assert.equal(v.name, 'identity-svc');
  assert.equal(v.service?.port, REST_PORT, 'service.port');
  assert.equal(v.managementPort, METRICS_PORT, 'managementPort');
  assert.notEqual(v.service?.enabled, false, '서비스 Deployment가 꺼졌다');
  const grpc = (v.service?.extraPorts ?? []).filter((p) => p.port === GRPC_PORT);
  assert.equal(grpc.length, 1, `업무 gRPC ${GRPC_PORT} extraPorts`);
  assert.equal(grpc[0].name, 'grpc');
  assert.deepEqual(v.service?.command, COMMAND, '시작 명령');
  const env = envOf(v, 'identity-svc');
  assert.equal(env.PEAKET_GRPC_PORT, String(GRPC_PORT), 'PEAKET_GRPC_PORT');
  // 자기 자신을 부르는 gRPC 주소를 두지 않는다(자기 호출은 in-process다)
  assert.equal(env.PEAKET_IDENTITY_GRPC_URL, undefined, 'PEAKET_IDENTITY_GRPC_URL');
});

test('ID-02 identity Outbox 릴레이: 켜져 있고 같은 이미지의 dist/relay.js·복제 2이며 DB·Kafka 주소는 Secret 이름으로만 받는다', () => {
  const v = load('identity-svc');
  const relay = v.outboxRelay;
  assert.ok(relay, 'outboxRelay 값이 없다');
  assert.equal(relay.enabled, true, 'Outbox 릴레이가 꺼져 있다(일 파티션이 끝나지 않는다)');
  assert.equal(relay.replicas, 2, '릴레이 복제');
  assert.deepEqual(relay.command, [...COMMAND.slice(0, -1), 'dist/relay.js'], '릴레이 시작 명령');
  // 같은 이미지를 쓴다: 릴레이 값이 image를 덮어쓰지 않는다
  assert.equal(relay.image, undefined, '릴레이가 다른 이미지를 쓴다');
  assert.equal(typeof relay.secretEnvFrom, 'string', 'relay secretEnvFrom');
  assert.notEqual(relay.secretEnvFrom.trim(), '', 'relay secretEnvFrom');
  for (const k of ['PEAKET_OUTBOX_DATABASE_URL', 'PEAKET_MAINTENANCE_DATABASE_URL', 'PEAKET_KAFKA_BROKERS', 'PEAKET_DATABASE_URL']) {
    assert.equal((relay.env ?? {})[k], undefined, `릴레이 비밀 ${k}를 env에 두었다`);
  }
  assert.doesNotMatch(repoText('deploy', 'workloads', 'identity-svc', 'values.yaml'), /postgres(ql)?:\/\/[^\s]*:[^\s]*@/, '릴레이 DB 주소 값이 파일에 있다');
});

test('ID-03 identity 토큰 키 세벌과 교체 값: _KEY·_NEXT·_PREVIOUS·_PREVIOUS_UNTIL이 ExternalSecret 경로만 가리키고 교체 차례가 주석에 있다 [ASVS v5.0.0-13.1.4] [ASVS v5.0.0-13.3.4]', () => {
  const v = load('identity-svc');
  const es = v.externalSecret;
  assert.ok(es, 'externalSecret 값이 없다');
  assert.equal(es.enabled, true);
  assert.equal(typeof es.secretStoreRef?.name, 'string');
  assert.notEqual(es.secretStoreRef.name.trim(), '');
  assert.equal(es.secretStoreRef.kind, 'ClusterSecretStore');
  assert.equal(es.target?.name, v.secretEnvFrom, 'target.name이 서비스가 받는 Secret 이름과 다르다');
  const data = es.data ?? [];
  const want = [];
  for (const role of ['FAN', 'ADMIN', 'STAFF']) {
    for (const suffix of ['TOKEN_KEY', 'TOKEN_KEY_NEXT', 'TOKEN_KEY_PREVIOUS', 'TOKEN_KEY_PREVIOUS_UNTIL']) want.push(`PEAKET_${role}_${suffix}`);
  }
  assert.deepEqual(data.map((d) => d.secretKey).sort(), [...want].sort(), '토큰 키 12개');
  for (const d of data) {
    // remoteRef(Secrets Manager 경로)만 온다. 값(value·valueFrom)은 두지 않는다
    assert.deepEqual(Object.keys(d).sort(), ['remoteRef', 'secretKey'], d.secretKey);
    assert.deepEqual(Object.keys(d.remoteRef ?? {}), ['key'], d.secretKey);
    assert.equal(typeof d.remoteRef.key, 'string', d.secretKey);
    // 환경은 차트가 externalSecret.environment로 붙인다: 값 파일의 경로는 환경 안쪽(identity/...)만 적는다
    assert.doesNotMatch(d.remoteRef.key, /^peaket\//, `${d.secretKey}: 값 파일에 peaket/ 경로가 박혀 있다(환경은 차트가 붙인다)`);
  }

  // ---- RV-01: 환경(peaket/<환경>/...)은 배포 단위 값이 아니라 차트 계약이 정한다 ----
  // 정본: docs/security/asvs/delivery.md 13.3.2(환경 비밀 최소 권한), docs/security/secrets-and-keys.md 51행
  const chartValues = parse(readFileSync(join(CHART, 'values.yaml'), 'utf8'));
  assert.ok(chartValues.externalSecret, '차트에 externalSecret 기본 값이 없다');
  assert.equal(chartValues.externalSecret.environment, '', '차트 기본값 externalSecret.environment(환경 값이 채운다)');
  const text = repoText('deploy', 'workloads', 'identity-svc', 'values.yaml');
  // 모든 환경이 함께 쓰는 배포 단위 기본 값에 운영 경로를 박으면 첫 데모 승격이 운영 키를 가리킨다
  assert.doesNotMatch(text, /peaket\/prod/, '배포 단위 기본 값에 peaket/prod가 박혀 있다');
  // 환경 값이 없으면 렌더를 멈춘다(빈 환경으로 Secrets Manager 경로를 만들지 않는다)
  const missing = renderIdentity([]);
  assert.notEqual(missing.error, undefined, 'externalSecret.environment 없이 ExternalSecret을 렌더했다');
  assert.match(missing.error, /externalSecret\.environment/, `환경 값이 없을 때의 렌더 오류: ${missing.error}`);
  // 환경이 local이면 모든 remoteRef가 peaket/local/로 시작한다
  const local = renderIdentity(['externalSecret.environment=local']);
  assert.equal(local.error, undefined, local.error);
  const rendered = findObject(local.objects, 'ExternalSecret', 'identity-svc');
  assert.ok(rendered, '렌더한 ExternalSecret identity-svc가 없다');
  assert.equal(rendered.spec.target.name, v.secretEnvFrom, '렌더한 target.name');
  const keys = (rendered.spec.data ?? []).map((d) => d.remoteRef.key);
  assert.equal(keys.length, data.length, '렌더한 remoteRef 수');
  for (const key of keys) assert.match(key, /^peaket\/local\//, `환경 local의 remoteRef ${key}`);

  // ---- RV-07: 토큰 키는 ConfigMap·값 인라인이 아니라 secretEnvFrom/ExternalSecret으로만 온다 ----
  const env = envOf(v, 'identity-svc');
  for (const key of want) assert.equal(env[key], undefined, `${key}를 env에 인라인으로 두었다`);
  assert.equal(Array.isArray(v.service?.envFrom), false, 'service.envFrom은 차트가 secretEnvFrom으로 만든다');
  const dep = findObject(local.objects, 'Deployment', 'identity-svc');
  assert.ok(dep, 'Deployment identity-svc');
  assert.deepEqual(dep.spec.template.spec.containers[0].envFrom, [{ secretRef: { name: v.secretEnvFrom } }], '서비스가 받는 Secret은 secretEnvFrom 하나다');
  for (const e of dep.spec.template.spec.containers[0].env ?? []) assert.doesNotMatch(e.name, /^PEAKET_(FAN|ADMIN|STAFF)_TOKEN_KEY/, `${e.name}를 env에 두었다`);
  for (const o of local.objects) {
    if (o.kind === 'ConfigMap') assert.doesNotMatch(JSON.stringify(o), /PEAKET_(FAN|ADMIN|STAFF)_TOKEN_KEY/, `ConfigMap ${o.metadata?.name}에 토큰 키가 있다`);
  }
  // 값 파일에는 경로만 있다: value·valueFrom·개인 JWK(kty·d)·PEM이 없다
  assert.doesNotMatch(text, /^\s*(value|valueFrom)\s*:/m, '값 파일에 value/valueFrom이 있다');
  assert.doesNotMatch(text, /"kty"|BEGIN [A-Z ]*PRIVATE KEY|"d"\s*:/, '키 값(개인 JWK·PEM)이 파일에 있다');
  // 교체 차례(정본과 같은 순서): ① _NEXT(공개 JWK) → ② 다음 키를 지금 키로, 지금 키를 _PREVIOUS로(_PREVIOUS_UNTIL 설정) → ③ 끝 시각 뒤 지운다
  // 정본: docs/features/identity.md §3 189행, docs/security/secrets-and-keys.md 51행('팬 액세스 토큰 서명 키')
  const comments = text.split(/\r?\n/).filter((l) => /^\s*#/.test(l)).join('\n');
  const at = (re) => {
    const m = re.exec(comments);
    return m ? m.index : -1;
  };
  const nextAt = at(/_TOKEN_KEY_NEXT/);
  const currentAt = at(/_TOKEN_KEY\b/);
  const prevAt = at(/_TOKEN_KEY_PREVIOUS\b/);
  const untilAt = at(/_TOKEN_KEY_PREVIOUS_UNTIL/);
  assert.ok(nextAt >= 0 && currentAt > nextAt && prevAt > currentAt && untilAt > prevAt, `교체 차례(_NEXT → 현재 → _PREVIOUS → _PREVIOUS_UNTIL)가 주석에 없다(${[nextAt, currentAt, prevAt, untilAt]})`);
  assert.match(comments, /캐시 5분/, '받는 쪽 캐시 5분(docs/features/identity.md §3)을 기다린다는 글이 없다');
  const doc = repoText('docs', 'security', 'secrets-and-keys.md');
  for (const wantDoc of ['_KEY_NEXT', '캐시(5분)', '_KEY_PREVIOUS', '_KEY_PREVIOUS_UNTIL']) assert.ok(doc.includes(wantDoc), `정본 secrets-and-keys.md에 ${wantDoc}`);
  assert.match(repoText('docs', 'features', 'identity.md'), /교체는 두 단계다/);
});

test('ID-04 identity PEAKET_COOKIE_DOMAIN은 값 파일에 있고 비밀 목록에 없다(도메인은 비밀이 아니다)', () => {
  const v = load('identity-svc');
  const env = envOf(v, 'identity-svc');
  assert.equal(typeof env.PEAKET_COOKIE_DOMAIN, 'string', 'PEAKET_COOKIE_DOMAIN');
  assert.match(env.PEAKET_COOKIE_DOMAIN, /^[a-z0-9.-]+\.[a-z]{2,}$/i, '쿠키 도메인 꼴');
  const secretKeys = (v.externalSecret?.data ?? []).map((d) => d.secretKey);
  assert.equal(secretKeys.includes('PEAKET_COOKIE_DOMAIN'), false, '도메인을 ExternalSecret으로 받는다');
  // 비밀 같은 이름과 키 값이 env에 없다
  assertNoSecrets(v, [], 'identity-svc');
});

test('ID-05 I-T15 ② 메시없는실행 identity-svc gRPC 50051은 허용목록 열둘만받고 gw-queue·stranger·image-worker·partner는 거부한다', () => {
  const nps = yamlDocs('deploy', 'platform', 'mesh', 'meshless-networkpolicies.yaml');
  const np = nps.find((o) => o.kind === 'NetworkPolicy' && o.metadata?.name === 'identity-svc-ports');
  assert.ok(np, 'NetworkPolicy identity-svc-ports가 없다');
  assert.equal(np.metadata.namespace, 'core');
  const rule = (np.spec.ingress ?? []).find((r) => (r.ports ?? []).some((p) => p.port === GRPC_PORT));
  assert.ok(rule, `gRPC ${GRPC_PORT} 규칙이 없다`);
  // 부르는 파드 목록: docs/features/identity.md §2(52행) + docs/architecture.md §5 포트 표(743행, AdminAuthzService는 purchase-svc·admission-ctrl도 부른다)
  const allowed = ['admission-ctrl', 'core-notify-sender', 'core-svc', 'identity-svc', 'inv-ingest', 'ops-svc', 'payment-svc', 'purchase-svc', 'queue-svc', 'ticket-svc', 'trust-svc', 'web'].sort();
  const got = rule.from.map((f) => f.podSelector?.matchLabels?.['app.kubernetes.io/name']).sort();
  assert.deepEqual(got, allowed, 'identity-svc gRPC 50051 허용 목록');
  // 모든 출처는 네임스페이스+파드 라벨을 함께 쓴다(빈 선택자는 모두 허용이 된다)
  for (const f of rule.from) {
    assert.deepEqual(Object.keys(f).sort(), ['namespaceSelector', 'podSelector'], '출처에 빈 선택자');
    assert.notEqual(f.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'], undefined);
    assert.ok(Object.keys(f.podSelector?.matchLabels ?? {}).length > 0);
  }
  const denied = [
    ['envoy-gateway-system', 'gw-queue'],
    ['envoy-gateway-system', 'gw-fan'],
    ['core', 'image-worker'],
    ['web', 'partner'],
    ['core', 'stranger'],
  ];
  for (const [ns, name] of denied) {
    const hit = rule.from.some(
      (f) =>
        f.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === ns &&
        f.podSelector?.matchLabels?.['app.kubernetes.io/name'] === name,
    );
    assert.equal(hit, false, `${ns}/${name}가 identity-svc gRPC ${GRPC_PORT}에 닿는다`);
  }
});

test('ID-06 I-T50 ③ waypoint L7: SessionService는 web만, IdentityService는 purchase-svc만 받고 purchase-svc→SessionService·web→IdentityService는 거부한다', () => {
  const policies = yamlDocs('deploy', 'platform', 'mesh', 'policies.yaml');
  const p = policies.find((o) => o.kind === 'AuthorizationPolicy' && o.metadata?.name === 'identity-svc-waypoint-callers');
  assert.ok(p, 'AuthorizationPolicy identity-svc-waypoint-callers가 없다');
  assert.equal(p.metadata.namespace, 'core');
  const ruleFor = (path) => {
    const hits = p.spec.rules.filter((r) => (r.to ?? []).some((t) => (t.operation?.paths ?? []).includes(path)));
    assert.equal(hits.length, 1, `${path} 규칙이 하나가 아니다(${hits.length})`);
    return hits[0].from.flatMap((f) => f.source.principals ?? []);
  };
  assert.deepEqual(ruleFor('/peaket.identity.v1.SessionService/*'), ['cluster.local/ns/web/sa/web']);
  assert.deepEqual(ruleFor('/peaket.identity.v1.IdentityService/*'), ['cluster.local/ns/purchase/sa/purchase-svc']);
  // ALLOW 정책에 없으면 거부다(정책을 두지 않아 모두 허용되는 것이 아니다)
  assert.equal(ruleFor('/peaket.identity.v1.SessionService/*').some((x) => x.includes('/purchase/')), false);
  assert.equal(ruleFor('/peaket.identity.v1.IdentityService/*').some((x) => x.includes('/web/')), false);
  // 웨이포인트 정책은 서비스·메서드 경로마다 부르는 쪽을 적고, 모든 주체는 cluster.local/ns/<ns>/sa/<sa> 꼴이다
  for (const r of p.spec.rules) {
    for (const path of r.to.flatMap((t) => t.operation?.paths ?? [])) assert.match(path, /^\/peaket\.identity\.v1\.[A-Za-z]+\/(\*|[A-Za-z]+)$/);
    for (const principal of r.from.flatMap((f) => f.source?.principals ?? [])) assert.match(principal, /^cluster\.local\/ns\/[a-z0-9-]+\/sa\/[a-z0-9-]+$/);
  }
});

test('RG-01 realtime-gw 배포 값: 앱 8080·관리 9464·복제 2·종료 유예 30초(내리기 마감 10초보다 김)·좌석 Redis ACL 비밀은 Secret 이름으로만·태그는 local만', () => {
  const v = load('realtime-gw');
  assert.equal(v.name, 'realtime-gw');
  assert.equal(v.service?.port, REST_PORT, 'service.port');
  assert.equal(v.managementPort, METRICS_PORT, 'managementPort');
  assert.equal(v.service?.replicas, 2, 'service.replicas');
  assert.equal(v.service?.preStopSleepSeconds, 5, 'preStop');
  assert.equal(v.service?.terminationGracePeriodSeconds, 30, '종료 유예 30초 [가정]');
  // 내리기 마감 10초(docs/features/seat-hold.md §7, ADR-0297 결정 5)보다 길어야 연결을 닫고 구독을 풀 시간이 있다
  const DRAIN_DEADLINE_S = 10;
  assert.ok(v.service.terminationGracePeriodSeconds > DRAIN_DEADLINE_S, `종료 유예 ${v.service.terminationGracePeriodSeconds} ≤ 내리기 마감 ${DRAIN_DEADLINE_S}`);
  assert.ok(v.service.terminationGracePeriodSeconds > v.service.preStopSleepSeconds);
  assert.equal(typeof v.secretEnvFrom, 'string', 'secretEnvFrom');
  assert.notEqual(v.secretEnvFrom.trim(), '');
  // 좌석 Redis 주소·ACL 사용자 비밀·입장 토큰 공개키는 env에 없다
  const env = envOf(v, 'realtime-gw');
  for (const k of ['PEAKET_SEAT_REDIS_URL', 'PEAKET_SEAT_REDIS_CLUSTER_URLS', 'PEAKET_ADMISSION_JWKS', 'PEAKET_SEAT_REDIS_ACL_PASSWORD']) {
    assert.equal(env[k], undefined, `비밀 ${k}를 env에 두었다`);
  }
  const text = repoText('deploy', 'workloads', 'realtime-gw', 'values.yaml');
  assert.match(text, /ACL/, '좌석 Redis 구독 ACL 사용자 글이 없다');
  assert.match(text, /PEAKET_SEAT_REDIS_URL|PEAKET_SEAT_REDIS_CLUSTER_URLS/, '좌석 Redis 주소 Secret 이름 글이 없다');
  // 배포 단위 값은 태그를 고정하지 않는다(운영은 다이제스트만, local만 태그)
  assert.doesNotMatch(text, /^\s*tag:/m, '배포 단위 값에 이미지 태그가 있다');
  assert.equal(v.image, undefined, '배포 단위 값에 image가 있다');
});

test('RG-03 local realtime-gw 값: local 태그·PEAKET_ENV=local·좌석 Redis 주소는 Secret이고 kind 배포 단계가 그 파일과 Secret을 읽는다', () => {
  const v = parse(readFileSync(join(REPO, 'deploy', 'envs', 'local', 'v1-realtime-gw.yaml'), 'utf8'));
  assert.equal(v.name, 'realtime-gw');
  assert.deepEqual(v.image, { repository: 'peaket/realtime-gw', tag: 'local', pullPolicy: 'Never' });
  assert.equal(v.env?.PEAKET_ENV, 'local');
  assert.equal(v.secretEnvFrom, 'v1-realtime-gw');
  assert.equal(v.service?.port, REST_PORT);
  assert.equal(v.service?.replicas, 2);
  assert.equal(v.service?.terminationGracePeriodSeconds, 30);
  const env = envOf(v, 'v1-realtime-gw');
  for (const k of ['PEAKET_SEAT_REDIS_URL', 'PEAKET_SEAT_REDIS_CLUSTER_URLS', 'PEAKET_ADMISSION_JWKS']) assert.equal(env[k], undefined, `${k}를 env에 두었다`);
  const cluster = repoText('tools', 'local', 'cluster.mjs');
  assert.match(cluster, /deploy['"],\s*['"]envs['"],\s*['"]local['"],\s*['"]v1-realtime-gw\.yaml/, 'cluster.mjs가 local 값을 읽지 않는다');
  assert.match(cluster, /PEAKET_SEAT_REDIS_URL/, 'cluster.mjs가 좌석 Redis 주소 Secret을 만들지 않는다');
  assert.match(cluster, /'v1-realtime-gw'/, 'cluster.mjs가 Secret 이름 v1-realtime-gw를 쓰지 않는다');
  assert.match(cluster, /['"]realtime-gw['"]\s*:\s*realtimeGw/, 'cluster.mjs에 realtime-gw 명령이 없다');
});

test('NS-01 우선순위 클래스는 peaket-control(100000)·peaket-addon(10000) 둘이고 globalDefault가 없다', () => {
  const classes = yamlDocs('deploy', 'policies', 'priority-classes.yaml').filter((o) => o.kind === 'PriorityClass');
  assert.deepEqual(classes.map((c) => c.metadata.name).sort(), ['peaket-addon', 'peaket-control']);
  const control = classes.find((c) => c.metadata.name === 'peaket-control');
  const addon = classes.find((c) => c.metadata.name === 'peaket-addon');
  assert.equal(control.value, 100000, 'peaket-control 값 [가정]');
  assert.equal(addon.value, 10000, 'peaket-addon 값 [가정]');
  assert.ok(control.value > addon.value, '제어 길이 애드온보다 높아야 한다');
  // globalDefault를 두면 우선순위를 적지 않은 모든 파드(핫패스 포함)의 축출 순서가 바뀐다
  for (const c of classes) assert.equal('globalDefault' in c, false, `${c.metadata.name}: globalDefault`);
});

test('NS-02 ResourceQuota는 data·observability 두 네임스페이스에만 있고 핫패스·서비스·애드온에는 없다', () => {
  const quotas = yamlDocs('deploy', 'policies', 'resource-quotas.yaml').filter((o) => o.kind === 'ResourceQuota');
  assert.deepEqual(quotas.map((q) => q.metadata.namespace).sort(), ['data', 'observability']);
  for (const q of quotas) {
    const hard = q.spec?.hard ?? {};
    for (const k of ['requests.cpu', 'requests.memory', 'limits.cpu', 'limits.memory']) {
      assert.ok(k in hard, `${q.metadata.namespace}: ${k}`);
      assert.ok(Number(String(hard[k]).replace(/Gi$|m$/, '')) > 0, `${q.metadata.namespace}: ${k} 값`);
    }
  }
  // 핫패스·서비스 네임스페이스(오픈 때 확장을 할당량이 막으면 안 된다)
  for (const ns of ['queue', 'purchase', 'ticket', 'trust', 'core', 'web', 'platform', 'otel', 'ops-breakglass', 'envoy-gateway-system']) {
    assert.equal(quotas.some((q) => q.metadata.namespace === ns), false, `${ns}에 ResourceQuota`);
  }
  assert.match(repoText('deploy', 'policies', 'resource-quotas.yaml'), /NodePool|BAT-076/, 'NodePool 한도(80%)로 맞출 자리 글이 없다');
});

test('NS-03 docs/devops.md §5.2 네임스페이스 지도와 deploy/projects가 같고 data·observability 할당량은 NodePool 한도의 80% [가정]이다', () => {
  const doc = repoText('docs', 'devops.md');
  const rows = [];
  for (const line of doc.split(/\r?\n/)) {
    // | `queue` | queue | ... 처럼 네임스페이스가 백틱으로 시작하는 행만 지도다
    const m = /^\s*\|\s*`([a-z0-9-]+)`\s*\|\s*([a-z]+)\s*\|(.*)$/.exec(line);
    if (m) rows.push({ namespace: m[1], project: m[2], rest: m[3] });
  }
  assert.ok(rows.length >= 10, `네임스페이스 지도 행을 읽지 못했다(${rows.length})`);
  const projects = yamlDocs('deploy', 'projects', 'appprojects.yaml').filter((o) => o.kind === 'AppProject');
  for (const row of rows) {
    const name = `peaket-${row.project}`;
    const p = projects.find((x) => x.metadata.name === name);
    assert.ok(p, `${row.namespace}: AppProject ${name}이 없다`);
    const ns = (p.spec.destinations ?? []).map((d) => d.namespace);
    assert.ok(ns.includes(row.namespace), `${row.namespace}: ${name}의 destinations에 없다`);
  }
  // 지도에 있는 팀이 곧 AppProject 이름이다
  assert.deepEqual([...new Set(rows.map((r) => r.project))].sort(), ['core', 'data', 'frontend', 'observability', 'platform', 'purchase', 'queue', 'ticket', 'trust']);
  // 할당량은 NodePool 한도의 80% [가정] — 한도는 BAT-076의 Terraform에 생긴다. 지금은 표와 값 파일이 그 자리를 가리키는지만 본다
  for (const ns of ['data', 'observability']) {
    const row = rows.find((r) => r.namespace === ns);
    assert.match(row.rest, /80%/, `${ns} 행의 자원 할당량이 80% [가정]이 아니다`);
  }
  const quotas = yamlDocs('deploy', 'policies', 'resource-quotas.yaml').filter((o) => o.kind === 'ResourceQuota');
  assert.deepEqual(quotas.map((q) => q.metadata.namespace).sort(), ['data', 'observability']);
});


// --- BAT-197 봇 표본 검토 배포 값(리뷰 RV-05, BOT-080) ---
// 정본: docs/features/bot-defense.md §9·§13, docs/security/secrets-and-keys.md(분석 저장소 읽기 비밀), 계획 BAT-197 §7.5.

test('BAT-197 ops-svc 배포 단위: 표본 검토 trust gRPC·ClickHouse 읽기 값이 있고 분석 저장소 비밀은 secretEnvFrom에만 있다', () => {
  const v = load('ops-svc');
  assert.equal(v.name, 'ops-svc');
  assert.equal(v.secretEnvFrom, 'ops-svc-secrets', 'secretEnvFrom');
  const env = envOf(v, 'ops-svc');
  // 판정 HUMAN·BOT을 trust-svc ApplyLabel로 보내는 업무 gRPC 주소(ADR-0285 결정 5)
  assert.equal(env.PEAKET_TRUST_GRPC_URL, `trust-svc-grpc:${GRPC_PORT}`, 'PEAKET_TRUST_GRPC_URL');
  // 후보 원장은 분석 저장소 ClickHouse다. local·ci는 fixture로 대신하고 운영만 clickhouse다
  assert.equal(env.PEAKET_BOT_REVIEW_SOURCE, 'clickhouse', 'PEAKET_BOT_REVIEW_SOURCE');
  assert.equal(env.PEAKET_ANALYTICS_CLICKHOUSE_URL, 'http://clickhouse.analytics.svc.cluster.local:8123', 'PEAKET_ANALYTICS_CLICKHOUSE_URL');
  // 읽기 전용 사용자다(카드·판정 표를 쓰지 않는다)
  assert.equal(env.PEAKET_ANALYTICS_CLICKHOUSE_USER, 'an_ops_reader', 'PEAKET_ANALYTICS_CLICKHOUSE_USER');
  // 비밀번호는 env에 두지 않고 Secret(ops-svc-secrets)의 같은 이름 키로만 받는다
  assertNoSecrets(v, ['PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD'], 'ops-svc');
  for (const o of overlays('ops-svc')) {
    assert.equal(envOf(o.v, o.file).PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD, undefined, `${o.file}: 분석 저장소 비밀을 env에 두었다`);
  }
  // 배포 담당이 Secret 키 이름을 알 수 있게 비밀 목록에 자리가 있다
  const doc = repoText('docs', 'security', 'secrets-and-keys.md');
  assert.ok(doc.includes('PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD'), '비밀 목록에 PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD 자리가 없다');
  assert.match(doc, /an_ops_reader/, '비밀 목록에 읽기 사용자 an_ops_reader가 없다');
});
