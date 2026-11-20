// BAT-087 데모 무대 연기 시험(DS-02·07~10). 실제 kind·Docker를 쓰므로 Docker 잠금 안에서만 돌린다(ADR-0283 결정 4).
// 준비: bash D:/ticketpass-locks/lock.sh take docker lane4-BAT-087
// 실행: node --test --test-timeout=3600000 tools/local/e2e/demo-stage.e2e.mjs
// - DS-02: 이미지 10개가 실제로 빌드되고(서비스·Next 앱은 node --version, nginx 앱은 nginx -t) 실행 이미지에 원본·시험·.git이 없다
// - DS-07: demo가 모든 워크로드(기대 15)를 준비하고 마이그레이션 잡이 끝났다. 하나를 0으로 줄이면 demo-status가 exit 1
// - DS-08: 게이트웨이 다섯이 실제 서비스로 답한다(www·api 200, 인증 없는 API 4xx, 502·503 아님, 대역 응답 아님)
// - DS-09: 시드를 두 번 적용해도 공연·회차·좌석·스태프·기기 수가 같고(시드 total·DB), 공개 조회가 판매 승인 뒤 값이다. 시나리오 상태는 0
// - DS-10: demo-down 두 번 exit 0, 데모 네임스페이스만 지우고 클러스터·다른 갈래는 남긴다
// 이미지가 이미 있으면 demo에 --skip-build를 준다(PEAKET_DEMO_E2E_BUILD=1이면 다시 빌드한다).
// 결과는 docs/review/measurements/BAT-087-demo-stage.md에 적는다(시험은 파일을 쓰지 않는다).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_CONTRACT_FILE, httpsJson } from '../demo-auth.mjs';
import { DEMO_IMAGES } from '../demo-images.mjs';
import { DEMO_IMAGES as DEMO_WORKLOAD_IMAGES, DEMO_NAMESPACES, demoOrigins } from '../demo-objects.mjs';
import { DEFAULT_ROOT, ensureTool } from '../tools.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLUSTER = process.env.PEAKET_DEMO_CLUSTER || 'lane4-demo';
const KUBECONFIG = process.env.PEAKET_KUBECONFIG || join(DEFAULT_ROOT, `kubeconfig-${CLUSTER}`);
const CLUSTER_CLI = join(REPO, 'tools', 'local', 'cluster.mjs');
const SEED_CLI = join(REPO, 'tools', 'local', 'demo-seed.mjs');
const AUTH_CLI = join(REPO, 'tools', 'local', 'demo-auth.mjs');
/** demo-status가 견줄 기대(차트 13 + 차트 밖 둘) */
const EXPECTED_WORKLOADS = 15;
/** 마이그레이션 잡 여섯(계획 §5는 다섯이라 적었지만 실제 구현은 identity·ticket·core·ops·purchase·payment 여섯이다) */
const MIGRATION_JOBS = ['demo-migrate-identity', 'demo-migrate-ticket', 'demo-migrate-core', 'demo-migrate-ops', 'demo-migrate-purchase', 'demo-migrate-payment'];
const MAX_BUFFER = 256 * 1024 * 1024;
const STAGE_TIMEOUT = 2_700_000;
const SEED_TIMEOUT = 1_800_000;
const BUILD_TIMEOUT = 3_600_000;

const state = {
  stageSeconds: 0,
  buildSkipped: false,
  contract: undefined,
  eventId: undefined,
  firstTotals: undefined,
  firstSeedCounts: undefined,
  baselineNamespaces: [],
  baselineClusters: [],
  seedFirst: undefined,
  seedSecond: undefined,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 4000) => (String(s ?? '').length > n ? `…${String(s).slice(-n)}` : String(s ?? ''));

/** stdout의 마지막 JSON 하나를 읽는다(앞에 경고 줄이 있어도 된다) */
function jsonOf(text) {
  const t = String(text ?? '').trim();
  try {
    return JSON.parse(t);
  } catch {}
  for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
    try {
      return JSON.parse(t.slice(i));
    } catch {}
  }
  throw new Error(`JSON을 읽지 못했다: ${tail(text, 500)}`);
}

function run(file, args, o = {}) {
  const r = spawnSync(process.execPath, [file, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: o.timeout ?? 600_000,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...(o.env ?? {}) },
  });
  return { ...r, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function must(r, what) {
  assert.equal(r.status, 0, `${what} 실패(exit ${r.status})\n${tail(r.stdout)}\n${tail(r.stderr)}`);
  return r;
}

function cli(args, o = {}) {
  return run(CLUSTER_CLI, args, o);
}

/** 테스트 러너의 argv와 무관하게 데모 kubeconfig로 kubectl을 부른다 */
async function kc(args, o = {}) {
  const k = await ensureTool('kubectl');
  try {
    return execFileSync(k, ['--kubeconfig', KUBECONFIG, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: o.timeout ?? 300_000, maxBuffer: MAX_BUFFER });
  } catch (e) {
    e.stderr = String(e.stderr ?? '');
    throw e;
  }
}

async function kindClusters() {
  const k = await ensureTool('kind');
  return execFileSync(k, ['get', 'clusters'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

async function namespaces() {
  if (!existsSync(KUBECONFIG)) return [];
  try {
    return JSON.parse(await kc(['get', 'namespaces', '-o', 'json'])).items.map((o) => o.metadata.name).sort();
  } catch (e) {
    if (/NotFound|does not exist|connection refused|no such host|GetFileAttributesEx/i.test(String(e.stderr ?? e.message))) return [];
    throw e;
  }
}

/** 이미지 열이 모두 있으면 참(있으면 demo --skip-build) */
function imagesPresent() {
  try {
    for (const image of [...DEMO_IMAGES.map((i) => i.image), ...Object.values(DEMO_WORKLOAD_IMAGES)]) {
      execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 60_000 });
    }
    return true;
  } catch {
    return false;
  }
}

/** www(앱)의 3xx를 따라가 최종 응답을 낸다. 게이트웨이가 307로 언어 경로를 줄 수 있다 */
async function getFollow(key, path, max = 3) {
  let current = path;
  let res;
  for (let i = 0; i <= max; i += 1) {
    res = await httpsJson({ host: state.contract.hosts[key], port: state.contract.ports[key], method: 'GET', path: current, headers: { accept: 'text/html' } });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.location;
    if (!loc) return res;
    current = loc.startsWith('http') ? new URL(loc).pathname + new URL(loc).search : loc;
  }
  return res;
}

/** 공개·관리 API용 쿠키 머리 */
const cookieHeader = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

/** demo-auth CLI로 관리자 쿠키를 얻는다(표준 출력 한 줄 JSON) */
function adminSession(key) {
  const r = run(AUTH_CLI, ['admin', key], { timeout: 300_000 });
  const out = must(r, `demo-auth admin ${key}`);
  return jsonOf(out.stdout);
}

async function psqlIn(db, sql) {
  return (await kc(['-n', 'purchase', 'exec', 'deploy/demo-postgres', '--', 'psql', '-U', 'postgres', '-d', db, '-tAc', sql])).trim();
}

/** 구매 DB의 시나리오 상태(주문·홀드) */
const psql = (sql) => psqlIn('peaket_demo_purchase', sql);

/**
 * core DB의 공연·회차 수. 파트너 공연 목록 API는 core-svc에 없다(HOT-260).
 * 계획 §6 DS-09대로 시드 `--json`의 total과 이 수를 견준다.
 */
async function coreSeedCounts() {
  const row = await psqlIn('peaket_demo_core', `select (select count(*) from production) || '|' || (select count(*) from "event")`);
  const [productions, events] = row.split('|').map(Number);
  assert.ok(Number.isInteger(productions) && Number.isInteger(events), `core DB의 공연·회차 수를 읽지 못했다: ${JSON.stringify(row)}`);
  return { productions, events };
}

/** 공개 조회에 쓸 회차 ID 하나(가장 이른 회차). 시드가 만든 회차는 모두 판매 승인 뒤라 공개 200이다 */
async function coreEventId() {
  return psqlIn('peaket_demo_core', `select id from "event" order by starts_at, id limit 1`);
}

before(async () => {
  // Docker·도구·기준 상태(다른 갈래를 건드리지 않았는지 나중에 견준다)
  execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 120_000 });
  for (const t of ['kind', 'kubectl', 'helm']) await ensureTool(t);
  state.baselineClusters = await kindClusters();
  state.baselineNamespaces = await namespaces();
  const ready = imagesPresent() && process.env.PEAKET_DEMO_E2E_BUILD !== '1';
  state.buildSkipped = ready;
  const started = Date.now();
  const args = ['demo', ...(ready ? ['--skip-build'] : [])];
  const r = cli(args, { timeout: BUILD_TIMEOUT });
  state.stageSeconds = Math.round((Date.now() - started) / 1000);
  must(r, `cluster.mjs ${args.join(' ')}`);
  state.contract = JSON.parse(readFileSync(DEMO_CONTRACT_FILE, 'utf8'));
  assert.equal(state.contract.cluster, CLUSTER, `접속 정보의 클러스터 ${state.contract.cluster}`);
  // 잡은 끝난 뒤 10분(TTL)에 지워진다. 무대를 올린 직후의 상태를 남겨 DS-07이 나중에도 견준다
  state.migrationJobs = JSON.parse(await kc(['get', 'jobs', '-A', '-l', 'app.kubernetes.io/part-of=peaket-demo', '-o', 'json']));
  console.log(`demo 무대 준비 ${state.stageSeconds}초${ready ? '(이미지 미리 빌드됨, --skip-build)' : '(이미지 빌드 포함)'}`);
}, { timeout: BUILD_TIMEOUT });

after(async () => {
  // 실패해도 데모 네임스페이스만 정리한다(클러스터는 남긴다). DS-10이 이미 내렸으면 아무것도 하지 않는다
  try {
    const left = (await namespaces()).filter((n) => DEMO_NAMESPACES.includes(n));
    if (left.length === 0) return;
    const r = cli(['demo-down'], { timeout: 900_000 });
    console.log(`정리: 데모 네임스페이스 ${left.join(', ')} 삭제(exit ${r.status})`);
  } catch (e) {
    console.error(`정리 실패: ${e.message}`);
  }
}, { timeout: 30 * 60_000 });

test('DS-02 이미지 열 개가 실제로 빌드되고 실행 이미지에 원본·시험·.git이 없다', { timeout: 20 * 60_000 }, () => {
  const check = (file, args) => {
    const r = spawnSync('docker', [file, ...args], { encoding: 'utf8', timeout: 600_000 });
    assert.equal(r.status, 0, `docker ${file} ${args.join(' ')} → ${r.status}\n${tail(r.stderr)}`);
    return r.stdout;
  };
  for (const i of DEMO_IMAGES) {
    check('image', ['inspect', i.image]);
    if (i.kind === 'service') {
      // 서비스 이미지(node): 계획 §6 DS-02는 node --version·dist/main.js를 본다
      check('run', ['--rm', '--entrypoint', 'node', i.image, '--version']);
      check('run', ['--rm', '--entrypoint', 'test', i.image, '-f', 'dist/main.js']);
      check('run', ['--rm', '--entrypoint', 'sh', i.image, '-c', 'test ! -d /app/src && test ! -d /app/test && test ! -d /app/.git']);
    } else if (i.workload === 'web' || i.workload === 'partner') {
      // Next.js standalone(node) 이미지. 앱 이름으로 경로를 만든다(partner에 web 경로를 쓰지 않는다, RV-08)
      const app = i.workload === 'web' ? 'apps/web' : 'apps/partner';
      check('run', ['--rm', '--entrypoint', 'node', i.image, '--version']);
      check('run', ['--rm', '--entrypoint', 'sh', i.image, '-c', `test ! -d /app/${app}/src && test ! -d /app/.git && test ! -d /app/${app}/.git`]);
      if (i.workload === 'partner') check('run', ['--rm', '--entrypoint', 'sh', i.image, '-c', 'test -f /app/apps/partner/server.js']);
    } else {
      // nginx 정적 이미지에는 node가 없다(console-host·scanner·queue-room). 계획 §6/§9대로 nginx -t만 본다
      check('run', ['--rm', '--entrypoint', 'nginx', i.image, '-t']);
      check('run', ['--rm', '--entrypoint', 'sh', i.image, '-c', 'test ! -d /usr/share/nginx/html/.git && test ! -d /usr/share/nginx/html/src']);
    }
  }
});

test('DS-09① 첫 시드가 공연·회차·좌석맵·스태프·기기를 만들고 공개 조회가 판매 승인 뒤 값이다', { timeout: 30 * 60_000 }, async () => {
  const seed = run(SEED_CLI, ['--apply', '--json'], { timeout: SEED_TIMEOUT });
  if (seed.status !== 0) {
    // 시드가 API에서 실패하면 DB에 공연·회차가 0이어야 한다(직접 INSERT로 새지 않았다). 수를 실패 까닭에 남긴다
    let productions = '?';
    let events = '?';
    try {
      productions = (await kc(['-n', 'purchase', 'exec', 'deploy/demo-postgres', '--', 'psql', '-U', 'postgres', '-d', 'peaket_demo_core', '-tAc', 'select count(*) from production'])).trim();
      events = (await kc(['-n', 'purchase', 'exec', 'deploy/demo-postgres', '--', 'psql', '-U', 'postgres', '-d', 'peaket_demo_core', '-tAc', 'select count(*) from event'])).trim();
    } catch {}
    assert.fail(`첫 demo-seed가 실패했다(exit ${seed.status}): ${tail(seed.stderr, 1200)} (DB production=${productions}, event=${events})`);
  }
  state.seedFirst = jsonOf(seed.stdout);
  assert.equal(state.seedFirst.ok, true, `첫 시드 ok ${JSON.stringify(state.seedFirst)}`);
  // 파트너 공연 목록·상세 API는 core-svc에 없다(HOT-260). 계획 §6 DS-09대로 시드 --json의 total과 DB로 센다
  const total = state.seedFirst.total;
  assert.equal(total.productions, 4, `시드 total 공연 수 ${total.productions}`);
  assert.equal(total.events, 7, `시드 total 회차 수 ${total.events}`);
  const seedCounts = await coreSeedCounts();
  assert.deepEqual(
    seedCounts,
    { productions: total.productions, events: total.events },
    `DB 공연·회차 수 ${JSON.stringify(seedCounts)}가 시드 total ${JSON.stringify(total)}과 다르다`,
  );
  state.firstTotals = seedCounts;
  state.firstSeedCounts = { ...seedCounts };
  console.log(`첫 시드: ${JSON.stringify(state.seedFirst.counts)} / total ${JSON.stringify(total)}`);

  // 공개 회차 ID도 DB에서 얻는다(시드 출력은 회차 개수만 낸다)
  const eventId = await coreEventId();
  assert.match(eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, `DB 회차 ID ${JSON.stringify(eventId)}`);
  state.eventId = eventId;

  // 공개 조회(GET /v1/events/{id})가 200이고 판매 승인 뒤 값(회차 상태 SCHEDULED·판매 구간 있음)이다
  const pub = await httpsJson({ host: state.contract.hosts.api, port: state.contract.ports.api, method: 'GET', path: `/v1/events/${eventId}` });
  assert.equal(pub.status, 200, `공개 회차 조회 → ${pub.status} ${tail(pub.text, 800)}`);
  assert.equal(pub.json?.status, 'SCHEDULED', `공개 회차 상태 ${JSON.stringify(pub.json?.status)}`);
  assert.ok(Array.isArray(pub.json?.salePhases) && pub.json.salePhases.length > 0, '판매 구간(salePhases)이 비었다(판매 승인 전 값일 수 있다)');
  assert.doesNotMatch(pub.text, /bodyBytes|gateway-echo/, '공개 응답이 대역 백엔드 응답이다');

  // 시드가 만든 기기 셋(관제 API)
  const ops = adminSession('sujin');
  const devices = await httpsJson({
    host: state.contract.hosts['ops-api'],
    port: state.contract.ports['ops-api'],
    method: 'GET',
    path: '/v1/ops/scanner-devices',
    headers: { cookie: cookieHeader(ops.cookies), origin: demoOrigins().console, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(devices.status, 200, `기기 목록 → ${devices.status}`);
  state.firstTotals.devices = (devices.json.items ?? devices.json.devices ?? []).length;
  assert.equal(state.firstTotals.devices, 7, `시드 뒤 기기 수 ${state.firstTotals.devices}`);

  // 시나리오 상태(주문·홀드)는 0이다
  const orders = Number(await psql('select count(*) from purchase_order'));
  const holds = Number(await psql('select count(*) from seat_hold'));
  assert.equal(orders, 0, `시드만으로 주문이 생겼다(${orders})`);
  assert.equal(holds, 0, `시드만으로 좌석 홀드가 생겼다(${holds})`);
});

test('DS-07 무대가 준비되고 마이그레이션 잡이 끝났으며, 하나를 0으로 줄이면 demo-status가 exit 1이다', { timeout: 20 * 60_000 }, async () => {
  const status = cli(['demo-status', '--json'], { timeout: 300_000 });
  assert.equal(status.status, 0, `demo-status 실패: ${tail(status.stderr)}`);
  const out = jsonOf(status.stdout);
  assert.equal(out.ok, true, `demo-status ok ${JSON.stringify(out.problems)}`);
  assert.equal(out.workloads.length, EXPECTED_WORKLOADS, `기대 워크로드 수 ${out.workloads.length}`);
  assert.deepEqual(out.problems, []);
  for (const w of out.workloads) assert.equal(w.ready, w.expected, `${w.namespace}/${w.name} ready ${w.ready}/${w.expected}`);

  // 마이그레이션 잡은 여섯이고 모두 Complete다(계획 §5의 '다섯'은 실제 구현과 다르다)
  const jobs = state.migrationJobs ?? JSON.parse(await kc(['get', 'jobs', '-A', '-l', 'app.kubernetes.io/part-of=peaket-demo', '-o', 'json']));
  const byName = new Map((jobs.items ?? []).map((j) => [j.metadata.name, j]));
  for (const name of MIGRATION_JOBS) {
    const job = byName.get(name);
    assert.ok(job, `마이그레이션 잡 ${name}이 없다`);
    assert.ok((job.status?.succeeded ?? 0) >= 1, `마이그레이션 잡 ${name}이 끝나지 않았다(${JSON.stringify(job.status)})`);
  }
  assert.equal([...byName.keys()].filter((n) => n.startsWith('demo-migrate-')).length, MIGRATION_JOBS.length, `마이그레이션 잡 수`);

  // 하나를 0으로 줄이면 demo-status가 exit 1이고 그 이름을 찍는다(닫힌 실패)
  try {
    await kc(['-n', 'web', 'scale', 'deploy/scanner', '--replicas=0']);
    const deadline = Date.now() + 120_000;
    let failed;
    while (Date.now() < deadline) {
      const r = cli(['demo-status', '--json'], { timeout: 300_000 });
      if (r.status === 1) {
        failed = r;
        break;
      }
      await sleep(2000);
    }
    assert.ok(failed, 'scanner를 0으로 줄였는데 demo-status가 계속 exit 0이다(0건을 통과로 셌다)');
    assert.match(failed.stderr + failed.stdout, /pods-not-ready web\/scanner/, `미준비 이름이 없다: ${tail(failed.stderr)}`);
    const j = jsonOf(failed.stdout);
    assert.equal(j.ok, false);
    assert.ok(j.problems.some((p) => p.includes('web/scanner')), `problems ${JSON.stringify(j.problems)}`);
  } finally {
    await kc(['-n', 'web', 'scale', 'deploy/scanner', '--replicas=1']);
    await kc(['-n', 'web', 'rollout', 'status', 'deploy/scanner', '--timeout=300s']);
  }
  const restored = cli(['demo-status', '--json'], { timeout: 300_000 });
  assert.equal(restored.status, 0, `scanner를 되돌린 뒤 demo-status가 실패했다: ${tail(restored.stderr)}`);
});

test('DS-08 게이트웨이 여섯이 실제 서비스로 답한다(www·api 200, 인증 없는 API 4xx, 502·503 아님)', { timeout: 10 * 60_000 }, async () => {
  assert.ok(state.contract, '접속 정보가 없다(demo가 실패했다)');
  const results = {};
  const problems = [];

  const www = await getFollow('www', '/');
  results.www = www.status;
  if (www.status !== 200) problems.push(`www / → ${www.status}`);
  else if (!/<html|<!DOCTYPE/i.test(www.text)) problems.push('www 응답이 앱 HTML이 아니다(대역 백엔드일 수 있다)');

  const origin = demoOrigins().www;
  const unauthenticated = [
    ['queue', { method: 'POST', path: '/v1/queues/00000000-0000-4000-8000-000000000000/entries', headers: { origin, 'content-type': 'application/json' }, body: {} }],
    ['partner-api', { method: 'GET', path: '/v1/partner/productions?limit=1', headers: { origin: demoOrigins().partner } }],
    ['ops-api', { method: 'GET', path: '/v1/ops/pending-actions', headers: { origin: demoOrigins().console } }],
    ['scanner-api', { method: 'GET', path: '/v1/scanner/scans', headers: { origin: demoOrigins().scanner } }],
  ];
  for (const [key, req] of unauthenticated) {
    const res = await httpsJson({ host: state.contract.hosts[key], port: state.contract.ports[key], ...req });
    results[key] = res.status;
    if (!(res.status >= 400 && res.status < 500)) problems.push(`${key} 인증 없는 요청 ${res.status}(4xx가 아니다)`);
    if (res.status === 502 || res.status === 503) problems.push(`${key}가 ${res.status}다(백엔드 없음)`);
    if (/bodyBytes|gateway-echo/.test(res.text)) problems.push(`${key} 응답이 대역 백엔드다`);
  }

  if (state.eventId) {
    const api = await httpsJson({ host: state.contract.hosts.api, port: state.contract.ports.api, method: 'GET', path: `/v1/events/${state.eventId}` });
    results.api = api.status;
    if (api.status !== 200) problems.push(`api 공개 회차 → ${api.status}`);
    if (/bodyBytes|gateway-echo/.test(api.text)) problems.push('api 응답이 대역이다');
  } else {
    problems.push('api 공개 회차를 부를 회차 ID가 없다(첫 시드가 공연·회차를 만들지 못했다)');
  }
  console.log(`게이트웨이 응답: ${JSON.stringify(results)}`);
  assert.deepEqual(problems, [], problems.join('; '));
});

test('DS-09② 두 번째 시드가 개수를 늘리지 않고 공개 조회 값도 그대로다', { timeout: 30 * 60_000 }, async () => {
  assert.ok(state.firstTotals, '첫 시드 결과가 없다');
  const second = must(run(SEED_CLI, ['--apply', '--json'], { timeout: SEED_TIMEOUT }), '두 번째 demo-seed --apply');
  state.seedSecond = jsonOf(second.stdout);
  assert.equal(state.seedSecond.ok, true);
  // 두 번째 total이 같아야 한다(계획 §5 연기 시험 계약)
  assert.deepEqual(state.seedSecond.total, state.seedFirst.total, `두 번째 시드의 total ${JSON.stringify(state.seedSecond.total)}이 첫 번째와 다르다`);
  // 계정·공연·회차·스태프·기기는 새로 만들지 않는다. 좌석맵 PUT은 같은 내용을 다시 써도 되므로 7까지 허용한다
  const c = state.seedSecond.counts;
  assert.equal(c.productions, 0, `두 번째 시드가 공연을 만들었다(${c.productions})`);
  assert.equal(c.events, 0, `두 번째 시드가 회차를 만들었다(${c.events})`);
  assert.equal(c.staff, 0, `두 번째 시드가 스태프 초대를 만들었다(${c.staff})`);
  assert.equal(c.devices, 0, `두 번째 시드가 기기를 만들었다(${c.devices})`);
  assert.ok(c.seatMaps <= 7, `두 번째 시드의 좌석맵 재적용 수 ${c.seatMaps}`);

  // 공연·회차 수는 DB에서 다시 센다(파트너 목록 API 없음, HOT-260)
  const seedCounts = await coreSeedCounts();
  assert.deepEqual(seedCounts, state.firstSeedCounts, `두 번째 시드 뒤 DB 공연·회차 수 ${JSON.stringify(seedCounts)}`);
  console.log(`두 번째 시드: ${JSON.stringify(c)} / DB ${JSON.stringify(seedCounts)}`);

  const ops = adminSession('sujin');
  const devices = await httpsJson({
    host: state.contract.hosts['ops-api'],
    port: state.contract.ports['ops-api'],
    method: 'GET',
    path: '/v1/ops/scanner-devices',
    headers: { cookie: cookieHeader(ops.cookies), origin: demoOrigins().console, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal((devices.json.items ?? devices.json.devices ?? []).length, state.firstTotals.devices, '두 번째 시드 뒤 기기 수가 달라졌다');

  const pub = await httpsJson({ host: state.contract.hosts.api, port: state.contract.ports.api, method: 'GET', path: `/v1/events/${state.eventId}` });
  assert.equal(pub.status, 200, `두 번째 시드 뒤 공개 조회 → ${pub.status}`);
  assert.equal(pub.json?.status, 'SCHEDULED');
  assert.equal(Number(await psql('select count(*) from purchase_order')), 0, '두 번째 시드 뒤 주문이 생겼다');
  assert.equal(Number(await psql('select count(*) from seat_hold')), 0, '두 번째 시드 뒤 좌석 홀드가 생겼다');
});

test('DS-10 demo-down 두 번이 exit 0이고 데모 네임스페이스만 지우며 클러스터·다른 갈래를 남긴다', { timeout: 30 * 60_000 }, async () => {
  const beforeNamespaces = await namespaces();
  const beforeClusters = await kindClusters();
  for (let i = 1; i <= 2; i += 1) {
    const r = cli(['demo-down'], { timeout: 900_000 });
    assert.equal(r.status, 0, `demo-down ${i}번째 실패: ${tail(r.stderr)}`);
  }
  const afterNamespaces = await namespaces();
  for (const ns of DEMO_NAMESPACES) assert.ok(!afterNamespaces.includes(ns), `데모 네임스페이스 ${ns}가 남아 있다`);
  for (const ns of beforeNamespaces.filter((n) => !DEMO_NAMESPACES.includes(n))) {
    assert.ok(afterNamespaces.includes(ns), `데모 밖 네임스페이스 ${ns}가 사라졌다`);
  }
  const afterClusters = await kindClusters();
  assert.ok(afterClusters.includes(CLUSTER), `kind 클러스터 ${CLUSTER}가 사라졌다(demo-down이 클러스터를 지웠다)`);
  for (const c of beforeClusters) assert.ok(afterClusters.includes(c), `다른 갈래 클러스터 ${c}가 사라졌다`);
  // 내린 뒤에는 demo-status가 닫힌 실패(exit 1)다
  const status = cli(['demo-status', '--json'], { timeout: 300_000 });
  assert.equal(status.status, 1, `데모를 내렸는데 demo-status가 exit ${status.status}다`);
});
