// BAT-087 데모 오버레이가 실제 백엔드를 보는지(DS-03), 출처·호스트·포트·SAN(DS-04),
// 생성 객체에 비밀·개인정보가 없는지(DS-12), 서버 액션 키가 Secret으로만 가는지(W12S-03, docs/review/plans/W12-ci-sec.md §3)를 순수 함수로 본다.
// 정본: docs/review/plans/BAT-087.md §5 '이미지·워크로드'·'호스트·포트', §6 DS-03·04·12, §9 M2·M3·M4·M12.
// 실행(저장소 뿌리): node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { gatewayCertArgs, listenerCertificates, readGatewayObjects } from './gateway-objects.mjs';
import {
  DEMO_CLUSTER,
  DEMO_GATEWAY_BASE_PORT,
  DEMO_GATEWAY_PORTS,
  DEMO_HOSTS,
  DEMO_NAMESPACES,
  DEMO_OVERLAY_DIR,
  DEMO_WORKLOADS,
  demoAppObjects,
  demoDatabaseUrls,
  demoExpectedWorkloads,
  demoGatewayObjects,
  demoHosts,
  demoNamespaces,
  demoOrigins,
  demoPostgresObjects,
  demoSecrets,
  demoValkeyObjects,
} from './demo-objects.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATEWAY_DIR = join(REPO, 'deploy', 'gateways');
/** backendRef로 설 수 있는 워크로드 이름(계획 §6 DS-03) */
const ALLOWED_BACKENDS = new Set(['identity-svc', 'core-svc', 'ticket-svc', 'purchase-svc', 'payment-svc', 'queue-svc', 'ops-svc', 'web', 'partner', 'console-host', 'scanner', 'queue-room']);
/** 게이트웨이 다섯 + console·scanner 앱 호스트(포트는 게이트웨이별) */
const HOST_KEYS = ['www', 'api', 'queue', 'queue-files', 'partner', 'partner-api', 'ops-api', 'console', 'scanner-api', 'scanner'];
/** 대기실 정규식 셋(계획 §5 B5·DS-04) */
const QUEUE_ROOM_PATHS = ['^/queue/[^/]+/?$', '^/(en|ja|zh)/queue/[^/]+/?$', '^/events/[^/]+/?$', '^/(en|ja|zh)/events/[^/]+/?$', '^/shop/[^/]+/queue$'];

const objects = () => demoGatewayObjects(readGatewayObjects(GATEWAY_DIR));
const stringify = (o) => JSON.stringify(o);
const walk = (value, visit) => {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit);
  } else if (value && typeof value === 'object') {
    visit(value);
    for (const v of Object.values(value)) walk(v, visit);
  }
  return value;
};
const originStrings = (value) => {
  const out = [];
  walk(value, (o) => {
    for (const key of ['allowOrigins', 'additionalOrigins']) if (Array.isArray(o[key])) out.push(...o[key]);
  });
  return out;
};
const routesByName = (defs, name) => defs.find((o) => o.kind === 'HTTPRoute' && o.metadata?.name === name);
const backendRefs = (defs) => defs.filter((o) => o.kind === 'HTTPRoute').flatMap((o) => (o.spec?.rules ?? []).flatMap((r) => r.backendRefs ?? []));

/** demoSecrets가 요구하는 시험용 키(값은 가짜다) */
function demoSecretKeys() {
  return {
    dbPassword: 'abcdefghijklmnop',
    idvSecret: 'idv-secret',
    pgSim: { secretKey: 'sim_sk_x', clientKey: 'sim_ck_x' },
    tokenKeys: { fan: { privateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd', kid: 'fan' } } },
    pepperKey: 'pepper',
    totpKey: 'totp',
    internalToken: 'internal',
    admission: { privateJwk: { kty: 'EC', d: 'd' }, jwks: { keys: [] } },
    ecdh: { privateJwk: { kty: 'EC', d: 'd' }, publicJwk: { kty: 'EC', x: 'x', y: 'y' } },
  };
}

const demoSecretsOf = () => demoSecrets({ keys: demoSecretKeys(), bootstrap: { version: 1, accounts: [], promoters: [] } });
const secretNamed = (name) => demoSecretsOf().find((s) => s.metadata.name === name);

test('DS-03 게이트웨이 객체는 실제 서비스 backendRef만 쓰고 gateway-echo·localGatewayObjects 흔적이 없다', () => {
  const defs = objects();
  const refs = backendRefs(defs);
  assert.ok(refs.length > 0, 'HTTPRoute backendRef가 하나도 없다');
  for (const ref of refs) {
    assert.ok(ALLOWED_BACKENDS.has(ref.name), `backendRef ${ref.name}이 실제 워크로드가 아니다`);
    assert.notEqual(ref.name, 'gateway-echo', '대역 백엔드 gateway-echo를 가리킨다');
    assert.notEqual(ref.name, 'peaket-echo', '대역 백엔드 peaket-echo를 가리킨다');
  }
  // 계획 B7의 실제 백엔드가 모두 어딘가에 선다
  const names = new Set(refs.map((r) => r.name));
  for (const name of ['identity-svc', 'core-svc', 'ticket-svc', 'purchase-svc', 'payment-svc', 'queue-svc', 'ops-svc']) {
    assert.ok(names.has(name), `${name} backendRef가 없다`);
  }
  // bundle이 덮는 네 서비스는 purchase 네임스페이스의 bundle 파드 하나를 본다(감독 결정 2).
  // admission-ctrl은 게이트웨이가 직접 부르지 않는다(내부 gRPC) — backendRef 목록에 없어도 된다.
  for (const name of ['queue-svc', 'purchase-svc', 'payment-svc']) {
    const hits = refs.filter((r) => r.name === name);
    assert.ok(hits.length > 0, `${name} backendRef가 없다`);
    for (const ref of hits) assert.equal(ref.namespace, 'purchase', `${name} backendRef 네임스페이스`);
  }
  assert.doesNotMatch(stringify(defs), /gateway-echo/, '객체 어딘가에 gateway-echo가 남아 있다');
});

test('DS-03 ReferenceGrant가 데모 네임스페이스 여섯에 남아 있다', () => {
  const defs = objects();
  const namespaces = new Set(defs.filter((o) => o.kind === 'ReferenceGrant').map((o) => o.metadata?.namespace));
  for (const ns of DEMO_NAMESPACES) assert.ok(namespaces.has(ns), `${ns} 네임스페이스 ReferenceGrant가 없다(라우트가 Programmed되지 않는다)`);
  assert.equal(DEMO_NAMESPACES.length, 6, `데모 네임스페이스 수 ${DEMO_NAMESPACES.length}`);
  assert.deepEqual([...DEMO_NAMESPACES].sort(), ['core', 'purchase', 'queue', 'ticket', 'trust', 'web'].sort(), '데모 네임스페이스 목록');
});

test('DS-03 게이트웨이 객체는 입력을 바꾸지 않고 앱 리스너·라우트를 더한다', () => {
  const input = readGatewayObjects(GATEWAY_DIR);
  const before = stringify(input);
  const defs = demoGatewayObjects(input);
  assert.equal(stringify(input), before, '입력 게이트웨이 객체를 바꿨다');
  const ops = defs.find((o) => o.kind === 'Gateway' && o.metadata?.name === 'gw-ops');
  const scanner = defs.find((o) => o.kind === 'Gateway' && o.metadata?.name === 'gw-scanner');
  assert.ok(ops?.spec?.listeners?.some((l) => l.name === 'console' && l.hostname === DEMO_HOSTS.console), 'gw-ops에 console 리스너가 없다');
  assert.ok(scanner?.spec?.listeners?.some((l) => l.name === 'scanner' && l.hostname === DEMO_HOSTS.scanner), 'gw-scanner에 scanner 리스너가 없다');
  assert.equal(routesByName(defs, 'demo-console')?.spec?.rules?.[0]?.backendRefs?.[0]?.name, 'console-host', 'console 앱 라우트');
  assert.equal(routesByName(defs, 'demo-scanner')?.spec?.rules?.[0]?.backendRefs?.[0]?.name, 'scanner', 'scanner 앱 라우트');
  assert.equal(routesByName(defs, 'demo-queue-room')?.spec?.rules?.[0]?.backendRefs?.[0]?.name, 'queue-room', '대기실 라우트');
  assert.equal(routesByName(defs, 'demo-queue-verify')?.spec?.rules?.[0]?.backendRefs?.[0]?.name, 'web', '/verify는 소비자 웹으로 간다');
});

test('DS-04 호스트·포트 지도가 18441~18445와 identity gRPC·모의 기관 포트를 지킨다', () => {
  assert.equal(DEMO_CLUSTER, 'lane4-demo', '데모 클러스터 이름');
  assert.equal(DEMO_GATEWAY_BASE_PORT, 18441, '게이트웨이 시작 포트');
  assert.deepEqual(DEMO_GATEWAY_PORTS, {
    www: 18441,
    api: 18441,
    queue: 18442,
    'queue-files': 18442,
    partner: 18443,
    'partner-api': 18443,
    'ops-api': 18444,
    console: 18444,
    'scanner-api': 18445,
    scanner: 18445,
  });
  const origins = demoOrigins();
  assert.deepEqual(Object.keys(origins).sort(), [...HOST_KEYS].sort(), '출처 호스트 키');
  for (const key of HOST_KEYS) {
    assert.equal(origins[key], `https://${DEMO_HOSTS[key]}:${DEMO_GATEWAY_PORTS[key]}`, `${key}의 포트 붙은 출처`);
    assert.match(origins[key], /:1844[1-5]$/, `${key}의 출처에 18441~18445 포트가 없다`);
  }
  assert.deepEqual(demoHosts(), DEMO_HOSTS, 'demoHosts가 정본 호스트 표와 다르다');
  // 호스트 이름은 정본 그대로이고 포트가 붙지 않는다
  for (const key of HOST_KEYS) assert.doesNotMatch(DEMO_HOSTS[key], /:\d+$/, `${key} 호스트에 포트가 붙었다`);
  // 이 PC 포트다(게이트웨이 호스트 포트 18441~18445, gRPC 19051, 모의 기관 18920)
  assert.deepEqual(listenerCertificates(objects()).map((c) => c.listener).sort(), [...HOST_KEYS].sort(), '게이트웨이 리스너 목록');
});

test('DS-04 CORS 허용 출처와 CSRF 추가 출처가 모두 포트 붙은 값이다', () => {
  const defs = objects();
  const origins = new Set(Object.values(demoOrigins()));
  const found = originStrings(defs);
  assert.ok(found.length > 0, 'CORS 허용 출처가 하나도 없다');
  for (const value of found) {
    assert.match(value, /^https:\/\/[a-z.-]+:\d{5}$/, `출처 ${value}에 포트가 없거나 모양이 틀렸다`);
    assert.ok(origins.has(value), `출처 ${value}가 demoOrigins에 없다`);
  }
  // 원본 정의(포트 없음)가 새어 나오지 않는다
  assert.ok(!found.includes('https://www.peaket.example'), '포트 없는 www 출처가 남아 있다');
  assert.ok(!found.includes('https://console.peaket.example'), '포트 없는 console 출처가 남아 있다');
});

test('DS-04 인증서 SAN에 열 호스트가 모두 들어간다', () => {
  const hosts = [...new Set(listenerCertificates(objects()).map((c) => c.host))];
  assert.deepEqual(hosts.sort(), HOST_KEYS.map((k) => DEMO_HOSTS[k]).sort(), '인증서에 넣을 호스트 목록');
  const args = gatewayCertArgs('key.pem', 'cert.pem', hosts);
  const san = args[args.indexOf('-addext') + 1];
  assert.match(san, /^subjectAltName=/, 'subjectAltName이 없다');
  for (const host of Object.values(DEMO_HOSTS)) assert.ok(san.includes(`DNS:${host}`), `SAN에 ${host}가 없다`);
});

test('DS-04 대기실 정규식은 /queue·/events를 잡고 /{id}/verify를 잡지 않는다', () => {
  const defs = objects();
  const route = routesByName(defs, 'demo-queue-room');
  assert.ok(route, '대기실 HTTPRoute가 없다');
  const matches = route.spec.rules[0].matches.map((m) => m.path);
  // /_q/ PathPrefix는 자산 경로에서 게이트웨이 not-found 정규식에 먼저 잡혀 404가 났다.
  // 정규식 ^/_q/.*로 자산·셸을 함께 잡는다(배포 확인 2026-11-21)
  assert.deepEqual(matches.map((p) => p.value), ['^/_q/.*', ...QUEUE_ROOM_PATHS], '대기실 경로 목록');
  for (const p of matches) assert.equal(p.type, 'RegularExpression', `대기실 경로 ${p.value}의 종류`);
  const regexes = QUEUE_ROOM_PATHS.map((p) => new RegExp(p));
  for (const ok of ['/queue/abc', '/queue/abc/', '/en/queue/abc', '/ja/queue/abc/', '/zh/queue/abc', '/events/abc', '/events/abc/', '/en/events/abc', '/ja/events/abc/', '/zh/events/abc', '/shop/event-1/queue']) {
    assert.ok(regexes.some((r) => r.test(ok)), `대기실 경로 ${ok}를 잡지 않는다`);
  }
  for (const bad of ['/queue/abc/verify', '/queue/abc/verify/', '/en/queue/abc/verify', '/events/abc/verify', '/events/abc/verify/', '/en/events/abc/verify', '/shop/event-1/queue/extra']) {
    assert.ok(!regexes.some((r) => r.test(bad)), `대기실 정규식이 ${bad}까지 잡는다(추가 검증 화면이 대기실 셸로 간다)`);
  }
  // verify는 소비자 웹 라우트가 따로 받는다
  const verify = routesByName(defs, 'demo-queue-verify');
  assert.ok(verify, '/verify 라우트가 없다');
  const verifyRegex = new RegExp(verify.spec.rules[0].matches[0].path.value);
  assert.ok(verifyRegex.test('/queue/abc/verify'), '/queue/{id}/verify를 잡는 라우트가 없다');
  assert.ok(verifyRegex.test('/en/queue/abc/verify'), '/en/queue/{id}/verify를 잡는 라우트가 없다');
  assert.ok(verifyRegex.test('/events/abc/verify'), '/events/{id}/verify를 잡는 라우트가 없다');
  assert.ok(verifyRegex.test('/en/events/abc/verify'), '/en/events/{id}/verify를 잡는 라우트가 없다');
});

test('DS-04 게이트웨이 프록시는 로컬 kind 값(ClusterIP·100m·추적 없음)을 쓴다', () => {
  const defs = objects();
  for (const p of defs.filter((o) => o.kind === 'EnvoyProxy')) {
    const k = p.spec?.provider?.kubernetes;
    assert.equal(k?.envoyService?.type, 'ClusterIP', `${p.metadata.name}의 프록시 Service 종류`);
    assert.equal(k?.envoyDeployment?.container?.resources?.requests?.cpu, '100m', `${p.metadata.name}의 CPU 요청`);
    assert.equal(p.spec?.telemetry?.tracing, undefined, `${p.metadata.name}에 추적이 남아 있다(로컬에 수집기가 없다)`);
  }
});

test('RV-02 합본 환경 파일이 결제 복귀·대기열 CORS에 실제 웹 출처를 쓴다', () => {
  const env = secretNamed('demo-bundle-env')?.stringData ?? {};
  const origin = demoOrigins().www;
  assert.equal(origin, 'https://www.peaket.example:18441', '데모 웹 출처');
  for (const svc of ['queue-svc', 'payment-svc']) {
    const lines = String(env[`${svc}.env`] ?? '').split('\n');
    assert.ok(env[`${svc}.env`], `${svc}.env가 없다`);
    assert.ok(lines.includes(`PEAKET_WEB_ORIGIN=${origin}`), `${svc}.env에 PEAKET_WEB_ORIGIN=${origin}이 없다(결제 복귀·대기열 CORS가 다른 출처를 쓴다)`);
  }
});

test('RV-03 core 실행 Secret은 슈퍼유저 DSN을 주지 않고 부트스트랩 Secret이 따로 있다', () => {
  const core = secretNamed('demo-core');
  assert.ok(core, 'demo-core Secret이 없다');
  assert.equal(core.stringData.PEAKET_BOOTSTRAP_DATABASE_URL, undefined, 'demo-core가 슈퍼유저 DSN을 준다(core-svc 파드가 envFrom으로 받는다)');
  assert.doesNotMatch(JSON.stringify(core.stringData), /postgres:\/\/postgres:/, 'demo-core에 슈퍼유저 DSN이 있다');
  const boot = secretNamed('demo-bootstrap-core');
  assert.ok(boot, 'demo-bootstrap-core Secret이 없다(부트스트랩 Job 전용)');
  assert.match(String(boot.stringData.PEAKET_BOOTSTRAP_DATABASE_URL ?? ''), /^postgres:\/\/postgres:/, '부트스트랩 Secret에 슈퍼유저 DSN이 없다');
  // core-svc 오버레이는 demo-core만 받는다(부트스트랩 Secret을 envFrom으로 받지 않는다)
  const overlay = parseYaml(readFileSync(join(REPO, 'deploy/envs/local/demo/core-svc.yaml'), 'utf8'));
  assert.equal(overlay.secretEnvFrom, 'demo-core', 'core-svc 오버레이의 Secret');
  // 시드 적용기는 core 부트스트랩 Job에만 demo-bootstrap-core를 준다
  const seedSource = readFileSync(join(REPO, 'tools', 'local', 'demo-seed.mjs'), 'utf8');
  assert.match(seedSource, /name: 'demo-bootstrap-core'[^}]*secret: 'demo-bootstrap-core'/, 'core 부트스트랩 Job이 demo-bootstrap-core를 쓰지 않는다');
  assert.doesNotMatch(seedSource, /name: 'demo-bootstrap-core'[^}]*secret: 'demo-core'/, 'core 부트스트랩 Job이 demo-core(역할 주소)를 쓴다');
});

test('DS-12 데모 객체·시드에 개인 키·Bearer 토큰·비밀 값이 없다', () => {
  const generated = [demoNamespaces(), demoPostgresObjects(), demoValkeyObjects(), demoAppObjects(), objects()];
  for (const list of generated) {
    const text = stringify(list);
    assert.doesNotMatch(text, /BEGIN (?:RSA |EC )?PRIVATE KEY/, '생성 객체에 개인 키가 있다');
    assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]{20,}/, '생성 객체에 Bearer 토큰이 있다');
    assert.doesNotMatch(text, /"(?:password|totp|privateKey|secret)"\s*:\s*"(?!\$)/i, '생성 객체에 비밀 값 칸이 있다');
    // JWK 개인키(d)가 공개 객체에 섞이지 않는다
    walk(list, (o) => {
      if (o.kty && o.d) assert.fail(`생성 객체에 개인 JWK가 있다(${o.kid ?? o.kty})`);
    });
  }
  // Deployment/Job이 참조하는 Secret 이름만 있고 값은 객체에 없다
  for (const o of demoAppObjects()) {
    for (const c of o.spec?.template?.spec?.containers ?? []) {
      for (const e of c.env ?? []) assert.doesNotMatch(String(e.value ?? ''), /^(?:Bearer|secret_|totp_)/i, `${o.metadata.name}의 환경 값 ${e.name}에 비밀이 있다`);
    }
  }
  // DB 주소는 비밀번호가 16자 이상일 때만 만들고, 값은 Secret에만 둔다
  assert.throws(() => demoDatabaseUrls('short'), /16자/);
  const keys = {
    dbPassword: 'abcdefghijklmnop',
    idvSecret: 'idv-secret',
    pgSim: { secretKey: 'sim_sk_x', clientKey: 'sim_ck_x' },
    tokenKeys: { fan: { privateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd', kid: 'fan' } } },
    pepperKey: 'pepper',
    totpKey: 'totp',
    internalToken: 'internal',
    admission: { privateJwk: { kty: 'EC', d: 'd' }, jwks: { keys: [] } },
    ecdh: { privateJwk: { kty: 'EC', d: 'd' }, publicJwk: { kty: 'EC', x: 'x', y: 'y' } },
  };
  const secrets = demoSecrets({ keys, bootstrap: { version: 1, accounts: [], promoters: [] } });
  const names = secrets.map((s) => s.metadata.name).sort();
  for (const name of ['demo-postgres', 'demo-identity', 'demo-core', 'demo-ops', 'demo-ticket', 'demo-trust', 'demo-bundle-env', 'demo-pg-simulator', 'demo-realtime', 'demo-idv', 'demo-bootstrap']) {
    assert.ok(names.includes(name), `데모 Secret ${name}이 없다`);
  }
  for (const s of secrets) assert.equal(s.kind, 'Secret', `${s.metadata?.name}이 Secret이 아니다`);
  // 시드·객체 목록(Secret 제외)에는 값이 아니라 환경 값 이름만 있다
  const workloadNames = new Set(DEMO_WORKLOADS.map((w) => w.name));
  assert.equal(workloadNames.size, 13, `데모 워크로드 수 ${workloadNames.size}`);
});

test('DS-12 demo-status가 견줄 기대 워크로드는 15개이고 차트 밖 둘을 포함한다', () => {
  const expected = demoExpectedWorkloads();
  assert.equal(expected.length, 15, `기대 워크로드 수 ${expected.length}`);
  assert.deepEqual(expected.slice(0, 13).map((w) => w.name), DEMO_WORKLOADS.map((w) => w.name), '차트 워크로드 순서');
  assert.deepEqual(expected.slice(13), [
    { name: 'mock-idv', namespace: 'core', expected: 1 },
    { name: 'core-seatmap-worker', namespace: 'core', expected: 1 },
  ]);
  for (const w of expected) {
    assert.ok(w.name && w.namespace, '워크로드 이름·네임스페이스가 비었다');
    assert.ok(Number.isInteger(w.expected) && w.expected >= 1, `${w.name}의 기대 복제 수가 0이다`);
  }
});

// ---------- W12S-03 서버 액션 키는 무대마다 만든 값을 Secret으로만(docs/review/plans/W12-ci-sec.md §3) ----------
// 정본: docs/infra.md '로컬 데모의 비밀'(서버 액션 키도 같은 비밀 파일에서 무작위 32바이트로 만들어 웹·파트너가 같은 값을 Secret으로만 받고,
// 오버레이 값 파일에는 굽지 않는다), docs/devops.md §4.4 '시험·데모 값의 꼴과 도구 판' ②.
const SERVER_ACTIONS_ENV = 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY';
/** 예전 데모 상수(공개된 값). 글자 그대로 두지 않고 문구 조각을 이어 그 자리에서 base64로 만든다(계획 §3 첫 줄) */
const OLD_DEMO_KEY = Buffer.from(`${['peaket', 'demo', 'server', 'actions', 'key'].join('-')}--`).toString('base64');

test('W12S-03 ① demoSecrets의 demo-web·demo-partner(네임스페이스 web)가 입력 keys.serverActionsKey를 그대로 싣는다', () => {
  // 시험 값은 실행 때 무작위로 만든다(예전 상수와도 다르다)
  const serverActionsKey = randomBytes(32).toString('base64');
  assert.notEqual(serverActionsKey, OLD_DEMO_KEY);
  const secrets = demoSecrets({ keys: { ...demoSecretKeys(), serverActionsKey }, bootstrap: { version: 1, accounts: [], promoters: [] } });
  const webNamespace = DEMO_WORKLOADS.find((w) => w.name === 'web')?.namespace;
  const partnerNamespace = DEMO_WORKLOADS.find((w) => w.name === 'partner')?.namespace;
  assert.equal(webNamespace, 'web', 'web 워크로드의 네임스페이스');
  assert.equal(partnerNamespace, 'web', 'partner 워크로드의 네임스페이스');
  for (const [name, namespace] of [['demo-web', webNamespace], ['demo-partner', partnerNamespace]]) {
    const s = secrets.find((o) => o.metadata?.name === name);
    assert.ok(s, `데모 Secret ${name}이 없다`);
    assert.equal(s.kind, 'Secret', `${name}의 종류`);
    assert.equal(s.metadata.namespace, namespace, `${name}의 네임스페이스(워크로드와 같아야 envFrom으로 읽는다)`);
    assert.equal(s.stringData?.[SERVER_ACTIONS_ENV], serverActionsKey, `${name}의 ${SERVER_ACTIONS_ENV}가 입력 keys.serverActionsKey가 아니다`);
  }
});

test('W12S-03 ② demo-objects 모듈이 예전 데모 상수 DEMO_SERVER_ACTIONS_KEY를 내놓지 않는다', async () => {
  const mod = await import('./demo-objects.mjs');
  assert.equal(Object.hasOwn(mod, 'DEMO_SERVER_ACTIONS_KEY'), false, 'DEMO_SERVER_ACTIONS_KEY가 아직 있다(무대마다 만든 값을 쓴다)');
  // 이름만 바꿔 같은 값을 내놓아도 안 된다
  const same = Object.entries(mod).filter(([, v]) => v === OLD_DEMO_KEY).map(([k]) => k);
  assert.deepEqual(same, [], `예전 데모 상수 값을 내놓는 이름: ${same.join(', ')}`);
});

test('W12S-03 ③ 데모 오버레이 값 파일의 env에 서버 액션 키가 없고 web·partner는 secretEnvFrom으로 demo-web·demo-partner를 받는다', () => {
  const files = readdirSync(join(REPO, DEMO_OVERLAY_DIR)).filter((f) => f.endsWith('.yaml'));
  assert.equal(files.length, DEMO_WORKLOADS.length, `${DEMO_OVERLAY_DIR}의 값 파일 수`);
  const withKey = [];
  for (const f of files) {
    const values = parseYaml(readFileSync(join(REPO, DEMO_OVERLAY_DIR, f), 'utf8'));
    if (values?.env && Object.hasOwn(values.env, SERVER_ACTIONS_ENV)) withKey.push(f);
  }
  assert.deepEqual(withKey, [], `값 파일 env에 ${SERVER_ACTIONS_ENV}가 있다(Secret으로만 준다): ${withKey.join(', ')}`);
  const web = parseYaml(readFileSync(join(REPO, DEMO_OVERLAY_DIR, 'web.yaml'), 'utf8'));
  const partner = parseYaml(readFileSync(join(REPO, DEMO_OVERLAY_DIR, 'partner.yaml'), 'utf8'));
  assert.equal(web.secretEnvFrom, 'demo-web', 'web 오버레이의 secretEnvFrom');
  assert.equal(partner.secretEnvFrom, 'demo-partner', 'partner 오버레이의 secretEnvFrom');
});

test('W12S-03 ④ 예전 데모 상수 값이 오버레이 폴더·데모 이미지 Dockerfile·데모 도구 원본에 남지 않는다', () => {
  const files = [
    ...readdirSync(join(REPO, DEMO_OVERLAY_DIR)).map((f) => `${DEMO_OVERLAY_DIR}/${f}`),
    'apps/web/Dockerfile',
    'apps/partner/Dockerfile',
    ...readdirSync(join(REPO, 'tools', 'local')).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map((f) => `tools/local/${f}`),
  ];
  assert.ok(files.length > DEMO_WORKLOADS.length + 2, `볼 파일이 너무 적다: ${files.length}`);
  const unpadded = OLD_DEMO_KEY.replace(/=+$/, '');
  const hits = files.filter((f) => readFileSync(join(REPO, f), 'utf8').includes(unpadded));
  assert.deepEqual(hits, [], `예전 데모 상수 값이 남은 파일: ${hits.join(', ')}`);
});
