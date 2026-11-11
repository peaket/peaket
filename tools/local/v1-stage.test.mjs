// v1 측정 무대(node tools/local/cluster.mjs v1, docs/verification.md §3.8 '합본의 v1 무대', BUILD_ORDER PRF-215 ③)의 순수 함수 시험.
// 실제 kind에 올려 보는 것은 loadtest/e2e/v1-rehearsal.e2e.mjs다. 시험 값은 코드 상수와 다르게 고른다(복제 3 대신 2·5 등).
// 실행: node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';
import { ensureTool } from './tools.mjs';
import { kafkaTopicArgs, redisTlsCertArgs, redisTlsNames, V1_DATABASES, V1_HOST_DIRS, V1_KAFKA_TOPICS, V1_NGINX_IMAGE, V1_NGINX_TAG, V1_POSTGRES_TAG, V1_PRELOAD_IMAGES, V1_VALKEY_TAG, v1HelmArgs, v1Layout, v1MigrationJob, v1Plan, v1Secrets, v1SimulatorObjects, v1StateCacheConf, v1StateCacheObjects, v1ValkeyObjects } from './v1-objects.mjs';
import { envFileText, V1_ADMISSION_ISSUER, V1_PATHS, V1_PORTS, V1_SERVICES, v1ClientKey, v1EnvFiles, v1Keys, v1SharedSecret } from './v1-stage.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TLS = { ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n', cert: '-----BEGIN CERTIFICATE-----\nSRV\n-----END CERTIFICATE-----\n', key: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n' };
const envOf = (text) => Object.fromEntries(text.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

test('PRF215_v1Plan은_기본이_TLS켬·복제값파일이고_on·off·1~8만받는다', () => {
  assert.deepEqual(v1Plan([]), { redisTls: true, replicas: undefined });
  assert.deepEqual(v1Plan(['--redis-tls', 'off', '--replicas', '2']), { redisTls: false, replicas: 2 });
  for (const bad of [['--redis-tls'], ['--redis-tls', 'yes'], ['--replicas', '0'], ['--replicas', '9'], ['--replicas', '2.5'], ['--tls']]) assert.throws(() => v1Plan(bad), Error, bad.join(' '));
});

test('PRF215_주소는_TLS켬이면_대기열·좌석모두rediss이고_끔이면redis다(TLS 끔인데 rediss면 연결이 실패한다)', () => {
  const on = v1Layout({ redisTls: true });
  const off = v1Layout({ redisTls: false });
  assert.equal(on.queueRedisUrl, 'rediss://valkey-queue.v1.svc.cluster.local:6379');
  assert.equal(on.seatRedisUrl, 'rediss://valkey-seat.v1.svc.cluster.local:6379');
  assert.equal(off.queueRedisUrl, 'redis://valkey-queue.v1.svc.cluster.local:6379');
  assert.equal(off.seatRedisUrl, 'redis://valkey-seat.v1.svc.cluster.local:6379');
  assert.notEqual(V1_DATABASES.purchase, V1_DATABASES.payment);
  assert.equal(on.queueUrl, `http://bundle.v1.svc.cluster.local:${V1_PORTS['queue-svc'].app}`);
  assert.equal(on.purchaseUrl, `http://bundle.v1.svc.cluster.local:${V1_PORTS['purchase-svc'].app}`);
  assert.throws(() => v1Layout({ redisTls: 'on' }), TypeError);
});

test('BAT028_로컬무대는_고정다이제스트대신_태그를쓰고_미리실을목록에넣는다', () => {
  assert.ok(V1_PRELOAD_IMAGES.includes(V1_VALKEY_TAG));
  assert.ok(V1_PRELOAD_IMAGES.includes(V1_POSTGRES_TAG));
  for (const tag of V1_PRELOAD_IMAGES) assert.match(tag, /^[a-z0-9./_-]+:[A-Za-z0-9._-]+$/);
});

test('PRF215_Valkey는_TLS켬이면_TLS포트만열고_인증서를붙이며_끔이면_평문포트만이고_인증서를붙이지않는다', () => {
  const [svcOn, depOn] = v1ValkeyObjects('valkey-seat', { tls: true });
  const [, depOff] = v1ValkeyObjects('valkey-seat', { tls: false });
  assert.equal(svcOn.spec.ports[0].port, 6379);
  const on = depOn.spec.template.spec;
  const off = depOff.spec.template.spec;
  assert.equal(on.containers[0].image, V1_VALKEY_TAG);
  const argsOn = on.containers[0].args.join(' ');
  assert.match(argsOn, /--port 0 --tls-port 6379/);
  assert.match(argsOn, /--tls-auth-clients no/);
  assert.match(argsOn, /--save {2}--appendonly no/);
  assert.deepEqual(on.volumes.map((v) => v.name), ['data', 'tls']);
  assert.equal(on.volumes[1].secret.secretName, 'v1-redis-tls');
  assert.doesNotMatch(off.containers[0].args.join(' '), /tls/);
  assert.match(off.containers[0].args.join(' '), /--port 6379$/);
  assert.deepEqual(off.volumes.map((v) => v.name), ['data']);
  assert.equal(on.automountServiceAccountToken, false);
  assert.throws(() => v1ValkeyObjects('valkey', { tls: true }), RangeError);
});

test('PRF215_TLS인증서의_SAN은_두Valkey의_짧은이름·svc·cluster.local이다', () => {
  assert.deepEqual(redisTlsNames(), ['valkey-queue', 'valkey-queue.v1.svc', 'valkey-queue.v1.svc.cluster.local', 'valkey-seat', 'valkey-seat.v1.svc', 'valkey-seat.v1.svc.cluster.local']);
  const [ca, req, sign] = redisTlsCertArgs('/t');
  assert.ok(ca.includes('-x509') && ca.includes('/t/ca.crt'));
  assert.ok(req.join(' ').includes('subjectAltName=DNS:valkey-queue,DNS:valkey-queue.v1.svc'));
  assert.ok(sign.includes('-copy_extensions') && sign.includes('/t/tls.crt'));
});

test('PRF215_서비스별환경파일은_서비스마다_제주소·포트만있고_다른서비스의값이없다', () => {
  const keys = v1Keys();
  const f = v1EnvFiles({ keys, queueRedisUrl: 'rediss://q:6379', seatRedisUrl: 'rediss://s:6379', purchaseDatabaseUrl: 'postgres://p/pu', paymentDatabaseUrl: 'postgres://p/pa', seatmapDir: '/sm', batchResultDir: '/br', pgSimUrl: 'http://sim:8790', kafkaBrokers: 'k:9092', prometheusUrl: 'http://prom:9090', paymentPodCount: 5 });
  assert.deepEqual(Object.keys(f).sort(), [...V1_SERVICES].sort());
  assert.equal(f['queue-svc'].PEAKET_QUEUE_REDIS_URL, 'rediss://q:6379');
  assert.equal(f['admission-ctrl'].PEAKET_QUEUE_REDIS_URL, 'rediss://q:6379');
  assert.equal(f['purchase-svc'].PEAKET_SEAT_REDIS_URL, 'rediss://s:6379');
  assert.equal(f['purchase-svc'].PEAKET_DATABASE_URL, 'postgres://p/pu');
  assert.equal(f['payment-svc'].PEAKET_DATABASE_URL, 'postgres://p/pa');
  assert.equal(f['payment-svc'].PEAKET_PAYMENT_POD_COUNT, '5');
  assert.equal(f['purchase-svc'].PEAKET_PAYMENT_GRPC_ADDR, `127.0.0.1:${V1_PORTS['payment-svc'].grpc}`);
  assert.equal(f['payment-svc'].PEAKET_PG_DEFAULT, 'SIMULATOR');
  assert.equal(f['payment-svc'].PEAKET_PG_FALLBACK, 'none');
  for (const [svc, key] of [['queue-svc', 'PEAKET_SEAT_REDIS_URL'], ['queue-svc', 'PEAKET_DATABASE_URL'], ['admission-ctrl', 'PEAKET_DATABASE_URL'], ['purchase-svc', 'PEAKET_QUEUE_REDIS_URL'], ['payment-svc', 'PEAKET_SEAT_REDIS_URL'], ['payment-svc', 'PEAKET_QUEUE_TOKEN_KEY'], ['purchase-svc', 'PEAKET_ADMISSION_TOKEN_KEY'], ['queue-svc', 'PEAKET_PURCHASE_ECDH_KEY']]) {
    assert.ok(!(key in f[svc]), `${svc}에 ${key}가 없다`);
  }
  // 포트는 서비스마다 다르고 합본 관리 포트와도 다르다
  const ports = V1_SERVICES.flatMap((s) => [f[s].PORT, f[s].PEAKET_MANAGEMENT_PORT, ...(s === 'payment-svc' || s === 'queue-svc' ? [f[s].PEAKET_GRPC_PORT] : [])]).map(Number);
  // queue-svc 업무 gRPC는 payment-svc와 다른 포트로 파드 안에만 연다
  assert.equal(f['queue-svc'].PEAKET_GRPC_HOST, '127.0.0.1');
  assert.notEqual(f['queue-svc'].PEAKET_GRPC_PORT, f['payment-svc'].PEAKET_GRPC_PORT);
  assert.equal(new Set([...ports, V1_PORTS.bundleManagement]).size, ports.length + 1);
  // 공개키와 개인키가 짝이다: queue-svc의 입장 토큰 서명 키 ↔ purchase-svc의 공개키 묶음, purchase-svc의 ECDH 개인키 ↔ queue-svc의 ECDH 공개키
  const adm = JSON.parse(f['queue-svc'].PEAKET_ADMISSION_TOKEN_KEY);
  const jwks = JSON.parse(f['purchase-svc'].PEAKET_ADMISSION_JWKS);
  assert.deepEqual([jwks.keys[0].x, jwks.keys[0].kid], [adm.x, adm.kid]);
  assert.ok(!('d' in jwks.keys[0]));
  const ecdhPub = JSON.parse(f['queue-svc'].PEAKET_PURCHASE_ECDH_PUBLIC_JWK);
  assert.ok(!('d' in ecdhPub));
  const c = v1ClientKey(ecdhPub);
  assert.equal(v1SharedSecret(JSON.parse(f['purchase-svc'].PEAKET_PURCHASE_ECDH_KEY), c.clientPublicKey), c.sharedSecretHex);
  assert.equal(f['queue-svc'].PEAKET_ADMISSION_TOKEN_ISSUER, f['purchase-svc'].PEAKET_ADMISSION_ISSUER);
  assert.equal(f['queue-svc'].PEAKET_ADMISSION_TOKEN_ISSUER, V1_ADMISSION_ISSUER);
  assert.equal(f['queue-svc'].PEAKET_TEST_BATCH_RANDOMNESS, f['admission-ctrl'].PEAKET_TEST_BATCH_RANDOMNESS);
  // 파일은 PEAKET_ENV를 적지 않는다(합본이 거부한다)
  for (const s of V1_SERVICES) assert.ok(!('PEAKET_ENV' in f[s]), s);
});

test('PRF215_환경파일글은_이름차례이고_줄바꿈값·틀린이름은_값없이_거부한다', () => {
  assert.equal(envFileText({ B: '2', A: '{"x":"a=b"}' }), 'A={"x":"a=b"}\nB=2\n');
  assert.throws(() => envFileText({ A: 'sk_live\nX=1' }), (e) => e instanceof RangeError && !e.message.includes('sk_live'));
  assert.throws(() => envFileText({ 'a-b': '1' }), RangeError);
});

test('PRF215_Secret은_합본환경파일넷·릴레이둘·TLS·시뮬레이터키이고_합본파일의주소는_무대주소와같다', () => {
  const keys = v1Keys();
  const layout = v1Layout({ redisTls: false });
  const secrets = v1Secrets({ keys, layout, tls: TLS, replicas: 2 });
  assert.deepEqual(secrets.map((x) => x.metadata.name), ['v1-bundle-env', 'v1-relay-purchase', 'v1-relay-payment', 'v1-redis-tls', 'pg-simulator', 'v1-postgres']);
  for (const x of secrets) assert.equal(x.metadata.namespace, 'v1');
  const files = secrets[0].stringData;
  assert.deepEqual(Object.keys(files).sort(), V1_SERVICES.map((s) => `${s}.env`).sort());
  const queue = envOf(files['queue-svc.env']);
  const purchase = envOf(files['purchase-svc.env']);
  const payment = envOf(files['payment-svc.env']);
  assert.equal(queue.PEAKET_QUEUE_REDIS_URL, 'redis://valkey-queue.v1.svc.cluster.local:6379');
  assert.equal(purchase.PEAKET_SEAT_REDIS_URL, 'redis://valkey-seat.v1.svc.cluster.local:6379');
  assert.equal(purchase.PEAKET_SEATMAP_DIR, V1_PATHS.seatmapDir);
  assert.equal(queue.PEAKET_BATCH_RESULT_DIR, V1_PATHS.batchResultDir);
  assert.equal(payment.PEAKET_PAYMENT_POD_COUNT, '2');
  assert.equal(payment.PEAKET_PG_SIM_SECRET_KEY, keys.pgSim.secretKey);
  const relay = secrets[1].stringData;
  assert.deepEqual([relay.PEAKET_DATABASE_URL, relay.PEAKET_OUTBOX_DATABASE_URL, relay.PEAKET_MAINTENANCE_DATABASE_URL], Array(3).fill(purchase.PEAKET_DATABASE_URL));
  assert.equal(relay.PEAKET_SEAT_REDIS_URL, layout.seatRedisUrl);
  assert.equal(secrets[2].stringData.PEAKET_DATABASE_URL, payment.PEAKET_DATABASE_URL);
  assert.deepEqual(secrets[3].stringData, { 'ca.crt': TLS.ca, 'tls.crt': TLS.cert, 'tls.key': TLS.key });
  assert.deepEqual(secrets[4].stringData, { PG_SIMULATOR_SECRET_KEY: keys.pgSim.secretKey });
  assert.throws(() => v1Secrets({ keys, layout, tls: TLS, replicas: 0 }), RangeError);
});

test('PRF215_비밀아닌객체(잡·Valkey·캐시·시뮬레이터)에는_시험키와_DB주소가_없다(Secret으로만_잇는다)', () => {
  const keys = v1Keys();
  const layout = v1Layout({ redisTls: true });
  const plain = JSON.stringify([v1MigrationJob('purchase'), v1MigrationJob('payment'), ...v1ValkeyObjects('valkey-queue', { tls: true }), ...v1StateCacheObjects(), ...v1SimulatorObjects()]);
  for (const s of [keys.pgSim.secretKey, keys.queueTokenKey, keys.ecdh.privateJwk.d, keys.admission.privateJwk.d, keys.dbPassword, 'postgres://', 'peaket-local@']) assert.ok(!plain.includes(s), s);
});

test('PRF215_마이그레이션잡은_합본이미지로_패키지실제경로에서_스크립트를부르고_DB주소는_릴레이Secret에서받는다', () => {
  const j = v1MigrationJob('payment');
  const c = j.spec.template.spec.containers[0];
  assert.equal(j.metadata.name, 'v1-migrate-payment');
  assert.equal(c.image, 'peaket/bundle:local');
  assert.equal(c.imagePullPolicy, 'Never');
  assert.deepEqual(c.command, ['sh', '-c', 'cd "$(readlink -f node_modules/@peaket/payment-svc)" && exec node scripts/migrate.mjs']);
  assert.deepEqual(c.envFrom, [{ secretRef: { name: 'v1-relay-payment' } }]);
  assert.equal(c.securityContext.readOnlyRootFilesystem, true);
  assert.equal(j.spec.backoffLimit, 0);
  assert.throws(() => v1MigrationJob('queue'), RangeError);
});

test('PRF215_Kafka토픽은_무대가쓰는것만_없을때만만든다', () => {
  assert.deepEqual([...V1_KAFKA_TOPICS].sort(), ['identity.accounts-withdrawn', 'telemetry.behavior', 'trade.orders', 'trade.payments', 'trade.purchase-sessions', 'trade.seats']);
  const a = kafkaTopicArgs('trade.payments');
  assert.ok(a.includes('--if-not-exists'));
  // 도구 JVM 힙을 작게 준다(브로커 컨테이너 메모리 한도를 함께 쓴다)
  assert.deepEqual(a.slice(a.indexOf('--') + 1, a.indexOf('--') + 3), ['env', 'KAFKA_HEAP_OPTS=-Xms32m -Xmx96m']);
  assert.equal(a[a.indexOf('--topic') + 1], 'trade.payments');
  assert.throws(() => kafkaTopicArgs('trade.unknown'), RangeError);
});

test('PRF215_nginx캐시는_대기상태파일만캐시하고_잠금만켜고_낡은값허용을끈다', () => {
  const conf = v1StateCacheConf('origin:18080');
  assert.match(conf, /upstream origin \{ server origin:18080; keepalive 64; \}/);
  const loc = /location ~ \^\/v1\/queues\/\[\^\/\]\+\/segment-states\/\[0-9\]\+\[\.\]json\$ \{([\s\S]*?)\n {4}\}/.exec(conf)?.[1];
  assert.ok(loc, '대기 상태 파일 경로');
  assert.match(loc, /proxy_cache state;/);
  assert.match(loc, /proxy_cache_lock on;/);
  assert.match(loc, /proxy_cache_use_stale off;/);
  assert.match(loc, /proxy_cache_background_update off;/);
  // 나머지 경로는 캐시 없이
  assert.match(conf, /location \/ \{ proxy_pass http:\/\/origin;[^}]*\}/);
  assert.doesNotMatch(/location \/ \{([^}]*)\}/.exec(conf)[1], /proxy_cache/);
  const [, , dep] = v1StateCacheObjects();
  assert.equal(dep.spec.template.spec.containers[0].image, V1_NGINX_TAG);
  assert.equal(dep.spec.template.spec.containers[0].imagePullPolicy, 'Never');
  assert.equal(`${V1_NGINX_TAG}@${V1_NGINX_IMAGE.split('@')[1]}`, V1_NGINX_IMAGE);
});

test('PRF215_nginx판은_빈응답대역(loadtest/runner/manifests.mjs)과_같다', async () => {
  const { NULL_TARGET_IMAGE } = await import('../../loadtest/runner/manifests.mjs');
  assert.equal(V1_NGINX_IMAGE, NULL_TARGET_IMAGE);
});

test('PRF215_helm인자는_세릴리스이고_복제수는_합본에만_1~8로준다', () => {
  const b = v1HelmArgs('v1-bundle', '/r', { replicas: 2 });
  assert.deepEqual(b.slice(0, 4), ['upgrade', '--install', 'bundle', '/r/deploy/charts/peaket-service']);
  assert.ok(b.includes('/r/deploy/envs/local/v1-bundle.yaml'));
  assert.deepEqual(b.slice(-2), ['--set', 'service.replicas=2']);
  assert.ok(!v1HelmArgs('v1-bundle', '/r').includes('--set'));
  assert.equal(v1HelmArgs('v1-purchase-relay', '/r')[2], 'purchase-svc-relay');
  assert.throws(() => v1HelmArgs('v1-purchase-relay', '/r', { replicas: 2 }), RangeError);
  assert.throws(() => v1HelmArgs('v1-bundle', '/r', { replicas: 9 }), RangeError);
  assert.throws(() => v1HelmArgs('v1-queue', '/r'), RangeError);
});

const helm = await ensureTool('helm');
function renderValues(file, ns = 'v1') {
  const r = spawnSync(helm, ['template', 'rel', join(REPO, 'deploy', 'charts', 'peaket-service'), '--namespace', ns, '-f', join(REPO, 'deploy', 'envs', 'local', file)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean);
}
const find = (objs, kind, name) => objs.find((o) => o.kind === kind && o.metadata.name === name);

test('PRF215_합본값파일은_복제3·Lease둘·서비스포트(V1_PORTS와같음)·환경파일Secret·좌석맵·묶음결과폴더를_붙인다', () => {
  const objs = renderValues('v1-bundle.yaml');
  const dep = find(objs, 'Deployment', 'bundle');
  assert.equal(dep.spec.replicas, 3);
  const spec = dep.spec.template.spec;
  const c = spec.containers[0];
  assert.equal(spec.automountServiceAccountToken, true);
  assert.deepEqual(objs.filter((o) => o.kind === 'Lease').map((l) => l.metadata.name).sort(), ['admission-ctrl', 'payment-entry-pause']);
  const port = (name) => c.ports.find((p) => p.name === name)?.containerPort;
  assert.deepEqual(c.ports.map((p) => [p.name, p.containerPort]), [['http', V1_PORTS['queue-svc'].app], ['management', V1_PORTS.bundleManagement], ['purchase', V1_PORTS['purchase-svc'].app]]);
  const env = Object.fromEntries(c.env.map((e) => [e.name, e.value ?? e.valueFrom]));
  assert.equal(env.PEAKET_ENV, 'local');
  assert.equal(env.PEAKET_BUNDLE_ENV_DIR, V1_PATHS.envDir);
  assert.equal(env.PEAKET_BUNDLE_SERVICES, 'payment-svc,purchase-svc,admission-ctrl,queue-svc');
  assert.equal(env.NODE_EXTRA_CA_CERTS, `${V1_PATHS.redisCaDir}/ca.crt`);
  assert.equal(env.OTEL_SERVICE_NAME, 'bundle');
  const mounts = Object.fromEntries(c.volumeMounts.map((m) => [m.name, m.mountPath]));
  assert.deepEqual(mounts, { tmp: '/tmp', 'bundle-env': V1_PATHS.envDir, 'redis-tls': V1_PATHS.redisCaDir, seatmaps: V1_PATHS.seatmapDir, 'batch-results': V1_PATHS.batchResultDir });
  const vols = Object.fromEntries(spec.volumes.map((v) => [v.name, v]));
  assert.equal(vols['bundle-env'].secret.secretName, 'v1-bundle-env');
  assert.equal(vols.seatmaps.hostPath.path, V1_HOST_DIRS.seatmaps);
  assert.equal(vols['batch-results'].hostPath.path, V1_HOST_DIRS.batchResults);
  assert.deepEqual(c.resources.requests, c.resources.limits);
});

test('PRF215_릴레이값파일은_서비스Deployment없이_릴레이둘을_같은이미지로띄우고_purchase는좌석맵을붙인다', () => {
  for (const [file, name, seatmap] of [['v1-purchase-relay.yaml', 'purchase-svc', true], ['v1-payment-relay.yaml', 'payment-svc', false]]) {
    const objs = renderValues(file);
    assert.equal(find(objs, 'Deployment', name), undefined, `${name} 서비스 Deployment가 없다`);
    const relay = find(objs, 'Deployment', `${name}-outbox-relay`);
    assert.equal(relay.spec.replicas, 2);
    const c = relay.spec.template.spec.containers[0];
    assert.equal(c.image, 'peaket/bundle:local');
    assert.deepEqual(c.command.slice(-1), [`node_modules/@peaket/${name}/dist/relay.js`]);
    assert.equal(c.envFrom[0].secretRef.name, `v1-relay-${name.replace('-svc', '')}`);
    assert.equal(c.volumeMounts.some((m) => m.mountPath === V1_PATHS.seatmapDir), seatmap, name);
  }
});

test('PRF215_차트값파일의_서비스목록은_합본의_켜는차례와같다', () => {
  const v = parse(readFileSync(join(REPO, 'deploy', 'envs', 'local', 'v1-bundle.yaml'), 'utf8'));
  assert.equal(v.service.env.PEAKET_BUNDLE_SERVICES, V1_SERVICES.join(','));
});

// --- 코드 리뷰 반영(BUILD_ORDER PRF-215, 2026-11-10) ---
const objects = () => import('./v1-objects.mjs');

test('PRF215_코드리뷰M2_v1무대는_전용PostgreSQL을쓰고_max_connections가_합본최대복제×풀+릴레이보다크며_DB주소는_v1네임스페이스의_무대마다새비밀번호다', async () => {
  const m = await objects();
  assert.equal(typeof m.v1PostgresObjects, 'function', 'v1PostgresObjects');
  // 합본 파드 하나 풀 최대 58 × 복제 최대 8 + 릴레이 약 28 + 검사·psql 여유
  assert.ok(m.V1_PG_MAX_CONNECTIONS >= 8 * 58 + 28 + 10, `max_connections ${m.V1_PG_MAX_CONNECTIONS}`);
  const [svc, dep] = m.v1PostgresObjects();
  assert.deepEqual([svc.kind, svc.metadata.name, svc.metadata.namespace, svc.spec.ports[0].port], ['Service', 'postgres', 'v1', 5432]);
  const c = dep.spec.template.spec.containers[0];
  const localPg = parseAllDocuments(readFileSync(join(REPO, 'deploy', 'local', 'postgres.yaml'), 'utf8')).map((d) => d.toJS()).find((o) => o.kind === 'Deployment');
  assert.equal(c.image, localPg.spec.template.spec.containers[0].image, '로컬 PostgreSQL과 같은 판');
  assert.deepEqual(c.args, ['-c', `max_connections=${m.V1_PG_MAX_CONNECTIONS}`]);
  assert.deepEqual(c.envFrom, [{ secretRef: { name: 'v1-postgres' } }]);
  assert.ok(/^\d+Gi$/.test(c.resources.limits.memory) && Number.parseInt(c.resources.limits.memory, 10) >= 1, c.resources.limits.memory);
  assert.equal(dep.spec.template.spec.automountServiceAccountToken, false);
  const keys = v1Keys();
  assert.match(keys.dbPassword, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(v1Keys().dbPassword, keys.dbPassword);
  const secrets = v1Secrets({ keys, layout: v1Layout({ redisTls: true }), tls: TLS, replicas: 2 });
  assert.deepEqual(secrets.find((x) => x.metadata.name === 'v1-postgres')?.stringData, { POSTGRES_PASSWORD: keys.dbPassword });
  const purchase = envOf(secrets[0].stringData['purchase-svc.env']);
  const payment = envOf(secrets[0].stringData['payment-svc.env']);
  assert.equal(purchase.PEAKET_DATABASE_URL, `postgres://postgres:${keys.dbPassword}@postgres.v1.svc.cluster.local:5432/${V1_DATABASES.purchase}`);
  assert.equal(payment.PEAKET_DATABASE_URL, `postgres://postgres:${keys.dbPassword}@postgres.v1.svc.cluster.local:5432/${V1_DATABASES.payment}`);
  assert.ok(!JSON.stringify(m.v1PostgresObjects()).includes(keys.dbPassword));
});

test('PRF215_코드리뷰_무대공개값ConfigMap은_공개키·동의판·TLS·복제·nginx·연결한도만있고_개인성분이없다', async () => {
  const m = await objects();
  const keys = v1Keys();
  const cm = m.v1PublicConfigMap({ keys, redisTls: false, replicas: 2, nginx: { imageId: 'sha256:aa', platform: 'linux/amd64', manifest: 'sha256:bb' } });
  assert.deepEqual([cm.kind, cm.metadata.name, cm.metadata.namespace], ['ConfigMap', 'v1-stage-public', 'v1']);
  assert.deepEqual(Object.keys(cm.data).sort(), ['consentVersion', 'ecdhPublicJwk', 'nginxImageId', 'nginxManifest', 'nginxPlatform', 'pgMaxConnections', 'redisTls', 'replicas']);
  assert.deepEqual(JSON.parse(cm.data.ecdhPublicJwk), keys.ecdh.publicJwk);
  assert.deepEqual([cm.data.redisTls, cm.data.replicas, cm.data.pgMaxConnections], ['false', '2', String(m.V1_PG_MAX_CONNECTIONS)]);
  const text = JSON.stringify(cm);
  for (const s of [keys.ecdh.privateJwk.d, keys.admission.privateJwk.d, keys.queueTokenKey, keys.dbPassword, keys.pgSim.secretKey, keys.batchRandomness]) assert.ok(!text.includes(s));
});

test('PRF215_코드리뷰_고정nginx는_이미지ID가_고정다이제스트와같고_docker_info아키텍처의_플랫폼매니페스트가있을때만싣는다', async () => {
  const m = await objects();
  assert.equal(m.dockerPlatform('x86_64'), 'linux/amd64');
  assert.equal(m.dockerPlatform('aarch64'), 'linux/arm64');
  assert.throws(() => m.dockerPlatform('riscv64'), RangeError);
  const digest = V1_NGINX_IMAGE.split('@')[1];
  const descriptor = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:f7', platform: { architecture: 'amd64', os: 'linux' } };
  assert.deepEqual(m.pinnedImagePlan({ pinned: V1_NGINX_IMAGE, imageId: digest, descriptor, platform: 'linux/amd64' }), { tag: V1_NGINX_TAG, imageId: digest, manifest: 'sha256:f7', platform: 'linux/amd64' });
  // 태그가 다른 판을 가리킨다
  assert.throws(() => m.pinnedImagePlan({ pinned: V1_NGINX_IMAGE, imageId: 'sha256:0000', descriptor, platform: 'linux/amd64' }), /고정 판/);
  // 이 플랫폼의 매니페스트가 아니다
  assert.throws(() => m.pinnedImagePlan({ pinned: V1_NGINX_IMAGE, imageId: digest, descriptor: { ...descriptor, platform: { architecture: 'arm64', os: 'linux' } }, platform: 'linux/amd64' }), /플랫폼/);
  assert.throws(() => m.pinnedImagePlan({ pinned: V1_NGINX_IMAGE, imageId: digest, descriptor: { ...descriptor, mediaType: 'application/vnd.oci.image.index.v1+json' }, platform: 'linux/amd64' }), /매니페스트/);
  // 실은 뒤 노드의 이미지 다이제스트(ctr images ls)
  const ls = ['REF                                                     TYPE                                       DIGEST                                                                  SIZE     PLATFORMS   LABELS', `docker.io/${V1_NGINX_TAG} application/vnd.oci.image.manifest.v1+json sha256:f7 21.6 MiB linux/amd64 io.cri-containerd.image=managed`, 'docker.io/library/other:1 application/vnd.oci.image.manifest.v1+json sha256:99 1 MiB linux/amd64 -'].join('\n');
  assert.equal(m.nodeImageDigest(ls, V1_NGINX_TAG), 'sha256:f7');
  assert.equal(m.nodeImageDigest(ls, 'nginxinc/none:1'), undefined);
});

test('PRF215_코드리뷰_다시올리기는_있는_합본·릴레이만_먼저0개로줄인다', async () => {
  const m = await objects();
  assert.deepEqual(m.v1ScaleDownArgs(['deployment.apps/bundle', 'deployment.apps/valkey-seat', 'deployment.apps/payment-svc-outbox-relay']), ['-n', 'v1', 'scale', 'deployment.apps/bundle', 'deployment.apps/payment-svc-outbox-relay', '--replicas=0']);
  assert.equal(m.v1ScaleDownArgs(['deployment.apps/valkey-seat']), undefined);
  assert.equal(m.v1ScaleDownArgs([]), undefined);
});

test('PRF215_코드리뷰_결제gRPC는_파드안127.0.0.1에만열고_합본Service는_k6가부르는_queue·purchase포트만연다', () => {
  const f = v1EnvFiles({ keys: v1Keys(), queueRedisUrl: 'redis://q', seatRedisUrl: 'redis://s', purchaseDatabaseUrl: 'postgres://p/pu', paymentDatabaseUrl: 'postgres://p/pa', seatmapDir: '/sm', batchResultDir: '/br' });
  assert.equal(f['payment-svc'].PEAKET_GRPC_HOST, '127.0.0.1');
  const svc = find(renderValues('v1-bundle.yaml'), 'Service', 'bundle');
  assert.deepEqual(svc.spec.ports.map((p) => [p.name, p.port]), [['http', V1_PORTS['queue-svc'].app], ['purchase', V1_PORTS['purchase-svc'].app]]);
});

test('PRF215_코드리뷰_합본메모리는_리허설최대(약226Mi)의_두배를_올린512Mi다', () => {
  const c = find(renderValues('v1-bundle.yaml'), 'Deployment', 'bundle').spec.template.spec.containers[0];
  assert.deepEqual([c.resources.requests.memory, c.resources.limits.memory], ['512Mi', '512Mi']);
});
