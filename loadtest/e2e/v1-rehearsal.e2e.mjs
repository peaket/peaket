// v1 합본 부하 리허설 e2e(docs/verification.md §3.9 'v1 경로', docs/perf-ledger.md §3 1번 '로컬 사전 리허설', BUILD_ORDER PRF-215 ⑤).
// 실행 도구 `node loadtest/run.mjs v1 …`를 셸 없이 불러 작은 규모로 끝까지 돌리고 산출물과 v1 DB를 본다. 장부에 남기지 않는다(--record 없음).
// - K1(Q-T2 v1 쪽): 진입이 모두 성공해 순번이 겹치지 않고, 입장 확정이 일어나며 Q1·Q2가 PASS, 본구간 조회 실패 0, 발생기 판정 유효
// - K2(S-T1 v1 쪽, 인기 좌석 하나·놓지 않음): 본구간 홀드가 도착률 × 본구간만큼이고, 그 좌석의 홀드는 회차 전체에서 하나이며 S1·S2·S4가 PASS
// - K2를 발생기 둘로 나눠도(k6 실행 구간) 발생기마다 제 몫의 사용자만 준비해 진입이 사람마다 한 번이고(already-waiting 409 없음) 준비가 성공한다
//   (BAT-025 측정에서 찾은 결함: setup()이 발생기마다 모든 사용자를 진입시켰다)
// - K7 ②(P-T1 v1 쪽, 응답 버림 5%·늦춤 0.5%·합본 복제 하나 강제 종료): 결제 결과가 남고 P1~P4·P6·S1·S4가 정확히 PASS이며 SKIPPED는 정본의 기대 목록(S3·P5·M1~M5)뿐,
//   (P3은 2026-11-11 OPEN[34] 결정 (가)·ADR-0266으로 시작 시각을 '결제사 승인 시각과 결과 모름 해소 시각 가운데 늦은 쪽'으로 바꿨다.
//    리허설의 P3 PASS 단언은 그대로 두며, 강제 종료 직후 승인된 결제가 원장에 반영된 뒤 60초 안에 발권 대기로 등록되는지 본다)
//   정지 판정 기록(입력 유무·못 읽은 것 없음)과 강제로 끝낸 합본 파드·그때의 리더 임대 보유자가 적힌다(코드 리뷰 H2·M1·M8)
// - 산출물과 실행 도구 출력에 Secret의 시험 키(대기표 키·입장 토큰 개인키·ECDH 개인키·묶음 난수·DB 비밀번호·TLS 키·시뮬레이터 키)·입장 토큰·공유 비밀(64자리 16진수)이 없고
//   네임스페이스 loadtest에 발생기 파드·시험 키 Secret이 남지 않는다(코드 리뷰)
// - 끝으로 합본 파드 하나를 우아하게 끝내 닫는 데 걸린 시간을 재고 종료 유예(60초)에서 preStop(5초)을 뺀 것보다 짧은지 본다(코드 리뷰)
//
// 실행(저장소 뿌리):
//   node tools/local/cluster.mjs up && node tools/local/cluster.mjs observability && node tools/local/cluster.mjs v1 --replicas 2
//   pnpm --filter @peaket/invariant-checker build
//   node --test loadtest/e2e/v1-rehearsal.e2e.mjs
// 전제(어기면 before 훅이 까닭을 적고 모든 시험이 실패한다. 건너뛰지 않는다): 네임스페이스 v1에 합본(복제 2 이상, K7 ②가 하나를 끝낸다)·릴레이·Valkey 둘·nginx 캐시·
// 시뮬레이터가 준비돼 있고, 네임스페이스 loadtest에 다른 부하 실행이 없다(kind와 부하 실행은 한 번에 한 세션, docs/PROGRESS.md 턴 규칙 '갈래').
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubectl } from '../../tools/local/cluster.mjs';
import { V1_DATABASES } from '../../tools/local/v1-objects.mjs';
import { V1_EXPECTED_SKIPPED } from '../runner/v1.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN = join(REPO, 'loadtest', 'run.mjs');
const OUT = mkdtempSync(join(tmpdir(), 'peaket-v1-e2e-'));
const RUN_KILL_MS = 30 * 60_000;
const kc = (args, o = {}) => kubectl(args, { quiet: true, timeout: 120_000, maxBuffer: 1 << 28, ...o });
const SLOW = { timeout: RUN_KILL_MS + 120_000 };
/** 실행마다 출력(산출물 밖)과 산출물 폴더 */
const runs = [];

/**
 * 실행 도구를 셸 없이 부른다. 종료 코드와 출력. 시간을 넘기면 끝내고 바로 cleanup을 부른다(Windows의 child.kill()은 실행 도구의 정리 없이 끝낸다, 코드 리뷰)
 * @param {string[]} args @param {number} [killMs]
 */
function runTool(args, killMs = RUN_KILL_MS) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [RUN, ...args], { cwd: REPO, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    let text = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const t = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, killMs);
    child.on('exit', async (code) => {
      clearTimeout(t);
      if (timedOut && args[0] !== 'cleanup') {
        const c = await runTool(['cleanup'], 10 * 60_000);
        text += `\n[시간 초과(${killMs}ms)로 끝내고 cleanup을 불렀다: 종료 코드 ${c.code}]\n${c.text}`;
      }
      ok({ code: timedOut ? 'timeout' : code, text });
    });
  });
}

/** 합본 파드 안 node 스크립트(결과 줄 @@RESULT) */
async function inBundle(script) {
  const out = await kc(['-n', 'v1', 'exec', 'deploy/bundle', '--', 'node', '--input-type=module', '-e', script], { timeout: 180_000 });
  const m = /^@@RESULT (.*)$/m.exec(out);
  if (!m) throw new Error(`결과 줄이 없다: ${out.slice(-800)}`);
  return JSON.parse(m[1]);
}
const dbQuery = (db, sql, params) =>
  inBundle(`import { createDatabase } from '@peaket/platform'; import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/etc/peaket/bundle/purchase-svc.env', 'utf8').split('\\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const url = env.PEAKET_DATABASE_URL.replace(/\\/${V1_DATABASES.purchase}$/, '/${db}');
const d = createDatabase({ url, max: 1, applicationName: 'v1-e2e' });
const r = await d.pool.query(${JSON.stringify(sql)}, ${JSON.stringify(params)});
await d.close(); console.log('@@RESULT ' + JSON.stringify(r.rows));`);

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** invariants.csv(id,name,sources,violations,unknown,result,as_of)의 id → result. 이름 칸에 쉼표가 있을 수 있어 끝에서 둘째 칸을 읽는다 */
const csv = (file) => Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')).map((c) => [c[0], c[c.length - 2]]));
const metric = (summary, key) => summary.metrics[key]?.values ?? {};
/** 불변식 csv에서 결과가 SKIPPED인 id(차례대로) */
const skippedOf = (inv) => Object.entries(inv).filter(([, r]) => r === 'SKIPPED').map(([id]) => id).sort();
/** infra.txt의 PostgreSQL 연결 한도와 잰 최대 연결 수 */
function pgConnectionsOf(out) {
  const m = /max_connections (\d+)\) 클라이언트 연결 최대 (\d+)/.exec(readFileSync(join(out, 'infra.txt'), 'utf8'));
  return m ? { limit: Number(m[1]), max: Number(m[2]) } : undefined;
}

before(async () => {
  const deploys = JSON.parse(await kc(['-n', 'v1', 'get', 'deploy', '-o', 'json'])).items;
  const ready = Object.fromEntries(deploys.map((d) => [d.metadata.name, d.status.readyReplicas ?? 0]));
  for (const d of ['bundle', 'valkey-queue', 'valkey-seat', 'queue-state-cache', 'pg-simulator', 'purchase-svc-outbox-relay', 'payment-svc-outbox-relay']) assert.ok(ready[d] >= 1, `v1 무대의 ${d}가 준비되지 않았다(node tools/local/cluster.mjs v1 --replicas 2)`);
  assert.ok(ready.bundle >= 2, `합본 복제가 둘 이상이어야 한다(K7 ②가 하나를 끝낸다): ${ready.bundle}`);
  const pods = (await kc(['-n', 'loadtest', 'get', 'pods', '-o', 'name', '--ignore-not-found'])).trim();
  assert.equal(pods, '', `네임스페이스 loadtest에 다른 부하 실행의 파드가 있다: ${pods}`);
  assert.ok(existsSync(join(REPO, 'services', 'invariant-checker', 'dist', 'cli.js')), "검사기를 먼저 빌드한다: pnpm --filter @peaket/invariant-checker build");
});

after(async () => {
  await runTool(['cleanup']).catch(() => {});
});

test('PRF215_K1 Q-T2 v1 대기열 리허설: 진입이 모두 성공해 순번이 겹치지 않고 입장 확정이 일어나며 Q1·Q2가 PASS이고 본구간 조회 실패가 0건이며 발생기 판정이 유효하다', SLOW, async () => {
  const out = join(OUT, 'k1');
  // 진입 10초(600명 ÷ 60/s), 입장 초당 15명이라 본구간(20~40초)에도 기다리는 사람이 있어 조회가 나간다
  const r = await runTool(['v1', 'queue', '--users', '600', '--entry-rate', '60', '--admit-per-second', '15', '--warm', '10', '--main', '20', '--cpus', '1', '--memory-mi', '1024', '--invariants', '--out', out]);
  runs.push({ name: 'k1', out, text: r.text });
  assert.equal(r.code, 0, r.text.slice(-3000));
  const rec = lines(join(out, 'records.ndjson'));
  const entries = rec.filter((x) => x.kind === 'queue_entry');
  const admits = rec.filter((x) => x.kind === 'queue_admit');
  assert.equal(entries.length, 600);
  assert.ok(entries.every((e) => e.result === 'ok'));
  assert.equal(new Set(entries.map((e) => e.seq)).size, 600, '순번이 겹치지 않는다');
  assert.ok(admits.filter((a) => a.result === 'ok').length > 0, '입장 확정이 일어난다');
  const inv = csv(join(out, 'invariants.csv'));
  assert.equal(inv.Q1, 'PASS');
  assert.equal(inv.Q2, 'PASS');
  const s = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.ok((metric(s, 'http_reqs{phase:main,route:status}').count ?? 0) > 0, '본구간 조회가 있다');
  assert.equal(metric(s, 'http_req_failed{phase:main,route:status}').passes ?? 0, 0, '본구간 조회 실패 0');
  assert.equal(JSON.parse(readFileSync(join(out, 'generator.json'), 'utf8')).judge.valid, true);
  const notes = readFileSync(join(out, 'notes.txt'), 'utf8');
  assert.match(notes, /한 프로세스 합본.*Redis TLS/);
  // 코드 리뷰 H2·H3·M5: SKIPPED 목록, 진입 시행 수, Q1의 1초 칸 너그러움을 적는다
  assert.deepEqual(skippedOf(inv), [...V1_EXPECTED_SKIPPED].sort());
  assert.match(notes, /불변식 SKIPPED: M1·M2·M3·M4·M5·P5·S3/);
  assert.match(notes, /진입 시행 600건\(사전 검증 실패 포함 실패 0건\)/);
  assert.match(notes, /Q1은 서버의 1초 칸 serving 기록으로 견준다/);
  // 코드 리뷰 M2: 무대 전용 PostgreSQL의 연결 한도와 잰 최대 연결 수
  const pgc = pgConnectionsOf(out);
  assert.ok(pgc && pgc.max > 0 && pgc.max < pgc.limit, JSON.stringify(pgc));
});

test('PRF215_K2 S-T1 v1 인기 좌석 홀드 리허설: 본구간 홀드가 도착률 × 본구간만큼 남고, 그 좌석의 홀드는 회차 전체에서 하나이며 S1·S2·S4가 PASS다', SLOW, async () => {
  const out = join(OUT, 'k2');
  const rate = 100;
  const mainS = 20;
  const r = await runTool(['v1', 'seat-hold', '--users', '200', '--rate', String(rate), '--mode', 'hot', '--hot-count', '1', '--keep', '--warm', '10', '--main', String(mainS), '--cpus', '1', '--memory-mi', '1024', '--invariants', '--out', out]);
  runs.push({ name: 'k2', out, text: r.text });
  assert.equal(r.code, 0, r.text.slice(-3000));
  const s = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  const holds = metric(s, 'http_reqs{phase:main,route:hold}').count ?? 0;
  assert.ok(Math.abs(holds - rate * mainS) <= rate * mainS * 0.02 + 1, `본구간 홀드 ${holds}건(계획 ${rate * mainS})`);
  const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const rows = await dbQuery(V1_DATABASES.purchase, 'select count(*)::int as n from seat_hold where event_id = $1', [run.eventId]);
  assert.ok(rows[0].n <= 1, `인기 좌석의 홀드는 하나다(원장 ${rows[0].n}건)`);
  const inv = csv(join(out, 'invariants.csv'));
  for (const id of ['S1', 'S2', 'S4']) assert.equal(inv[id], 'PASS', id);
  assert.deepEqual(skippedOf(inv), [...V1_EXPECTED_SKIPPED].sort());
  assert.equal(JSON.parse(readFileSync(join(out, 'generator.json'), 'utf8')).judge.valid, true);
});

test('PRF215_발생기나누기_K2 인기 좌석을 발생기 둘로 나눠도 발생기마다 제 몫만 준비해 진입이 사람마다 한 번이고 본구간 홀드가 도착률 × 본구간만큼이다', SLOW, async () => {
  const out = join(OUT, 'k2-split');
  const rate = 100;
  const mainS = 15;
  const r = await runTool(['v1', 'seat-hold', '--users', '200', '--rate', String(rate), '--mode', 'hot', '--hot-count', '1', '--keep', '--generators', '2', '--warm', '5', '--main', String(mainS), '--cpus', '1', '--memory-mi', '1024', '--out', out]);
  runs.push({ name: 'k2-split', out, text: r.text });
  assert.equal(r.code, 0, r.text.slice(-3000));
  assert.match(r.text, /발생기 2대/);
  const s = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  // 준비 진입은 사람마다 한 번(두 발생기 합 200건, already-waiting 409 없음)
  assert.equal(metric(s, 'http_reqs{phase:prep,route:entry}').count ?? 0, 200);
  assert.equal(metric(s, 'http_req_failed{phase:prep,route:entry}').passes ?? 0, 0);
  const holds = metric(s, 'http_reqs{phase:main,route:hold}').count ?? 0;
  assert.ok(Math.abs(holds - rate * mainS) <= rate * mainS * 0.02 + 2, `본구간 홀드 ${holds}건(계획 ${rate * mainS})`);
  assert.equal(metric(s, 'scenario_errors').count ?? 0, 0);
  assert.equal(JSON.parse(readFileSync(join(out, 'generator.json'), 'utf8')).judge.valid, true);
});

test('PRF215_K7② P-T1 v1 결제 리허설: 응답 버림 5%·늦춤 0.5%·합본 복제 하나 강제 종료에도 결제 결과가 남고 P1~P4·P6·S1·S4가 정확히 PASS이며 SKIPPED는 기대 목록뿐이고, 정지 판정 기록(입력 유무)과 끝낸 파드·임대 보유자가 남는다', SLOW, async () => {
  const out = join(OUT, 'k7');
  const r = await runTool(['v1', 'payment', '--users', '700', '--rate', '10', '--warm', '5', '--main', '60', '--fault-drop-pct', '5', '--fault-delay-pct', '0.5', '--kill-app-at', '30', '--cpus', '1', '--memory-mi', '1024', '--invariants', '--out', out]);
  runs.push({ name: 'k7', out, text: r.text });
  assert.equal(r.code, 0, r.text.slice(-3000));
  const s = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  const confirmed = metric(s, 'payment_outcomes{phase:main,status:CONFIRMED}').count ?? 0;
  assert.ok(confirmed > 0, '본구간 결제 확정이 있다');
  // 결제 확정 시간(결제 접수 시작 → 끝 상태)을 잰다(코드 리뷰 M6)
  assert.ok(Number.isFinite(metric(s, 'payment_confirm_ms{phase:main}')['p(99)']), '결제 확정 시간');
  const inv = csv(join(out, 'invariants.csv'));
  // 코드 리뷰 H2: 정확히 PASS이고, SKIPPED는 정본의 기대 목록뿐이다(P3은 빈 결제 취소 뷰로 센다)
  for (const id of ['P1', 'P2', 'P3', 'P4', 'P6', 'S1', 'S4']) assert.equal(inv[id], 'PASS', id);
  assert.deepEqual(skippedOf(inv), [...V1_EXPECTED_SKIPPED].sort());
  // 코드 리뷰 M1·M8: 정지 기록을 못 읽은 것이 없고, 판정 입력 유무를 적으며, 입력이 없는데 정지 503이 나면 무효다
  const pause = JSON.parse(readFileSync(join(out, 'pause-transitions.json'), 'utf8'));
  assert.ok(Array.isArray(pause.transitions) && Number.isInteger(pause.newPaymentPaused503));
  assert.equal(pause.error, null, pause.error);
  assert.ok(['present', 'absent'].includes(pause.inputs), pause.inputs);
  const judge = JSON.parse(readFileSync(join(out, 'generator.json'), 'utf8')).judge;
  if (pause.inputs === 'absent' && pause.newPaymentPaused503 > 0) assert.equal(judge.valid, false, '입력 없이 정지 503');
  const notes = readFileSync(join(out, 'notes.txt'), 'utf8');
  assert.match(notes, /앱 파드 강제 종료 bundle-/);
  assert.match(notes, /정지 판정 입력\(kube_pod_status_ready\) (있음|없음: 로컬 무대에서는 K7 ②의 정지 전이를 판정하지 못한다\(측정 조건\))/);
  const killed = JSON.parse(readFileSync(join(out, 'killed.json'), 'utf8'));
  assert.match(killed.name, /^bundle-/);
  assert.deepEqual(Object.keys(killed.leaseHolders).sort(), ['admission-ctrl', 'payment-entry-pause']);
  assert.ok(Array.isArray(killed.heldLeases));
  const pgc = pgConnectionsOf(out);
  assert.ok(pgc && pgc.max > 0 && pgc.max < pgc.limit, JSON.stringify(pgc));
});

/** Secret의 시험 값(산출물에서 찾을 것): 이름 → 값 */
async function stageSecrets() {
  const data = async (secret, key) => Buffer.from((await kc(['-n', 'v1', 'get', 'secret', secret, '-o', `jsonpath={.data.${key.replaceAll('.', '\\.')}}`])).trim(), 'base64').toString('utf8');
  /** @param {string} text */
  const envOf = (text) => Object.fromEntries(text.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const queue = envOf(await data('v1-bundle-env', 'queue-svc.env'));
  const purchase = envOf(await data('v1-bundle-env', 'purchase-svc.env'));
  const tlsKey = await data('v1-redis-tls', 'tls.key');
  const out = {
    '대기표 키': queue.PEAKET_QUEUE_TOKEN_KEY.split(':')[1],
    '입장 토큰 개인키': JSON.parse(queue.PEAKET_ADMISSION_TOKEN_KEY).d,
    'ECDH 개인키': JSON.parse(purchase.PEAKET_PURCHASE_ECDH_KEY).d,
    '묶음 난수': queue.PEAKET_TEST_BATCH_RANDOMNESS,
    'DB 비밀번호': await data('v1-postgres', 'POSTGRES_PASSWORD'),
    // PEM 몸의 첫 줄(64자)
    'TLS 키': tlsKey.split('\n').find((l) => l && !l.startsWith('-----')),
    '시뮬레이터 키': await data('pg-simulator', 'PG_SIMULATOR_SECRET_KEY'),
  };
  for (const [name, v] of Object.entries(out)) assert.ok(typeof v === 'string' && v.length >= 16, `${name}을 Secret에서 읽지 못했다`);
  return out;
}

test('PRF215_산출물과 실행 도구 출력에 Secret의 시험 키·입장 토큰·공유 비밀이 없고 네임스페이스 loadtest에 발생기 파드·시험 키 Secret이 남지 않는다', async () => {
  assert.ok(runs.length > 0, '앞 리허설이 돌았다');
  const secrets = await stageSecrets();
  for (const run of runs) {
    const files = readdirSync(run.out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    const texts = [['출력', run.text], ...files.map((e) => [e.name, readFileSync(join(e.parentPath ?? e.path, e.name), 'utf8')])];
    for (const [where, t] of texts) {
      for (const [name, v] of Object.entries(secrets)) assert.ok(!t.includes(v), `${run.name} ${where}: ${name}`);
      assert.doesNotMatch(t, /eyJhbGciOiJFUzI1NiIsInR5cCI6ImFkbWlzc2lvbitqd3Qi/, `${run.name} ${where}: 입장 토큰`);
      assert.doesNotMatch(t, /SHARED_SECRET_HEX=|"sharedSecretHex"/, `${run.name} ${where}: 공유 비밀 이름`);
      // 공유 비밀(32바이트 16진수 64자). 이미지 다이제스트(sha256:…)는 뺀다
      assert.doesNotMatch(t, /(?<!sha256:)(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/, `${run.name} ${where}: 64자리 16진수`);
    }
  }
  assert.equal((await kc(['-n', 'loadtest', 'get', 'pods', '-o', 'name', '--ignore-not-found'])).trim(), '');
  assert.equal((await kc(['-n', 'loadtest', 'get', 'secret', 'loadgen-sim', '-o', 'name', '--ignore-not-found'])).trim(), '');
});

test('PRF215_코드리뷰_합본 파드 하나를 우아하게 끝내면 닫는 데 걸린 시간을 적고, 종료 유예(60초)에서 preStop(5초)을 뺀 것보다 짧다', SLOW, async () => {
  const dep = JSON.parse(await kc(['-n', 'v1', 'get', 'deploy', 'bundle', '-o', 'json']));
  const grace = dep.spec.template.spec.terminationGracePeriodSeconds;
  const preStop = dep.spec.template.spec.containers[0].lifecycle?.preStop?.sleep?.seconds ?? 0;
  const pod = (await kc(['-n', 'v1', 'get', 'pods', '-l', 'app.kubernetes.io/name=bundle', '-o', 'jsonpath={.items[0].metadata.name}'])).trim();
  assert.ok(pod, '합본 파드');
  // 끝날 때까지 로그를 따라 읽고(파드가 지워지면 끝난다) 그동안 우아하게 지운다
  const { KUBECONFIG } = await import('../../tools/local/cluster.mjs');
  const { ensureTool } = await import('../../tools/local/tools.mjs');
  const k = await ensureTool('kubectl');
  const follow = spawn(k, ['--kubeconfig', KUBECONFIG, '-n', 'v1', 'logs', '-f', pod, '--since=1s'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  follow.stdout.on('data', (d) => (text += d));
  const ended = new Promise((ok) => follow.on('exit', ok));
  await new Promise((r) => setTimeout(r, 2_000));
  const startedMs = Date.now();
  await kc(['-n', 'v1', 'delete', 'pod', pod, '--wait=true', `--timeout=${grace + 30}s`], { timeout: (grace + 60) * 1000 });
  const tookMs = Date.now() - startedMs;
  await Promise.race([ended, new Promise((r) => setTimeout(r, 10_000))]);
  follow.kill();
  const closed = text.split('\n').flatMap((l) => {
    try {
      const j = JSON.parse(l);
      return j.msg === '합본을 닫았다' ? [j] : [];
    } catch {
      return [];
    }
  })[0];
  assert.ok(closed, `닫은 로그 줄이 없다: ${text.slice(-1500)}`);
  console.log(`합본 닫기 ${closed.closeMs}ms, 지우기 전체 ${tookMs}ms(종료 유예 ${grace}초, preStop ${preStop}초)`);
  assert.ok(closed.closeMs < (grace - preStop) * 1000, `닫기 ${closed.closeMs}ms`);
  await kc(['-n', 'v1', 'rollout', 'status', 'deploy/bundle', '--timeout=300s'], { timeout: 320_000 });
});
