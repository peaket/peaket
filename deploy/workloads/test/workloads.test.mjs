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

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKLOADS = resolve(HERE, '..');
const REPO = resolve(WORKLOADS, '..', '..');

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
