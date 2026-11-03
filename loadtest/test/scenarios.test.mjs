// k6 시나리오 형식 검사(docs/verification.md §3.5 1·2번, §3.9 '오픈 모델과 요약'·'시나리오', loadtest/README.md).
// 고정한 k6 이미지(K6_IMAGE)로 `k6 inspect --execution-requirements`를 돌려, 시나리오 파일이 읽히는지(가져오는 lib와 exec 함수 포함)와
// 그 options(구간 이름·실행기·phase 꼬리표·시작 시각·길이·경로별 본구간 기준·요약 통계)가 설계대로인지 본다. 클러스터는 쓰지 않는다.
// - 저장소를 컨테이너의 /repo에 읽기 전용으로 붙이고 망 없이(--network none) 돌린다. 셸 없이 부른다
// - 가상 사용자 토큰 파일은 가짜 글 묶음(loadtest/test/fixtures/users.json, JWT가 아님)이다
// - Docker 엔진이 없으면(`docker version` 실패) 모두 건너뛴다. CI(loadtest-check.yml, ubuntu)에는 Docker가 있다
// 실행: node --test loadtest/test/scenarios.test.mjs
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { K6_IMAGE } from '../runner/manifests.mjs';
import { pollStages } from '../lib/model.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Docker에 줄 저장소 경로(Windows는 D:\ticketpass → D:/ticketpass) */
const HOST_REPO = process.platform === 'win32' ? REPO.replaceAll('\\', '/') : REPO;
const FIXTURE = 'loadtest/test/fixtures/users.json';
/** Git Bash에서 띄워도 경로 인자를 바꾸지 않게 한다 */
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };

function docker(args, timeout) {
  return execFileSync('docker', args, { encoding: 'utf8', env: DOCKER_ENV, timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/** Docker 엔진에 닿는지. 닿지 않으면 그 까닭(건너뛰는 사유) */
function dockerProblem() {
  try {
    docker(['version', '--format', '{{.Server.Version}}'], 60_000);
    return '';
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'docker 명령이 없다' : `docker version 실패(종료 코드 ${e.status ?? e.code}): ${String(e.stderr ?? '').trim().slice(0, 200)}`;
    return `Docker가 없어 k6 시나리오 형식 검사를 건너뛴다: ${why}`;
  }
}
const SKIP = dockerProblem() || false;

/** Go 꼴 기간 글(k6 inspect가 쓰는 '30s'·'1m30s'·'2m0s'·'500ms')을 초로 */
function seconds(d) {
  assert.equal(typeof d, 'string', `기간이 글이 아니다: ${JSON.stringify(d)}`);
  assert.ok(d.length > 0, '빈 기간');
  const unit = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, ns: 1e-9 };
  const re = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/y;
  let total = 0;
  let at = 0;
  while (at < d.length) {
    re.lastIndex = at;
    const m = re.exec(d);
    assert.ok(m, `기간 꼴이 아니다: ${d}`);
    total += Number(m[1]) * unit[m[2]];
    at = re.lastIndex;
  }
  return Math.round(total * 1000) / 1000;
}

/** k6 inspect --execution-requirements의 JSON(options + totalDuration·maxVUs) */
function inspect(file, env) {
  const rel = `loadtest/scenarios/${file}`;
  assert.ok(existsSync(join(REPO, rel)), `시나리오 파일이 없다: ${rel}`);
  const args = ['run', '--rm', '--network', 'none', '--mount', `type=bind,source=${HOST_REPO},target=/repo,readonly`, '-w', '/repo', K6_IMAGE,
    'inspect', '--execution-requirements'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(rel);
  let out;
  try {
    out = docker(args, 180_000);
  } catch (e) {
    assert.fail(`k6 inspect ${rel} 실패(종료 코드 ${e.status ?? e.code}):\n${String(e.stderr ?? e.message).slice(-3000)}`);
  }
  return JSON.parse(out);
}

// ─────────── 기대값 ───────────

/** 모든 시나리오에 주는 환경(시나리오가 쓰지 않는 값은 무시된다) */
const BASE_ENV = Object.freeze({
  BASE: 'https://v0-gateway.v0.svc.cluster.local:8443',
  ORIGIN: 'https://127.0.0.1:8443',
  RUN_TAG: 'fmt1',
  OUT_DIR: '/tmp/out',
  USERS_FILE: `/repo/${FIXTURE}`,
  EVENT_ID: '5f0c6a2e-8a1b-4c3d-9e4f-0a1b2c3d4e5f',
  USERS: 25,
  RATE: 2,
  ENTRY_RATE: 10,
  ADMIT_PER_SECOND: 2,
  // STEP_S(10초)로 나누어떨어지지 않게 둬서 마지막 칸이 짧은 경우도 본다
  WARM_S: 15,
  MAIN_S: 25,
  PRE_VUS: 5,
  MAX_VUS: 10,
  MODE: 'spread',
  HOLD_SIZE: 2,
  HOT_COUNT: 1,
  PAIRS: 1,
  RELEASE_MS: 0,
  SECTIONS: 'A,B',
  ROWS: 2,
  PER_ROW: 10,
  SEATS_PER_ORDER: 1,
  SIM_URL: 'http://pg-simulator.v0.svc.cluster.local:8790',
  PREP_RATE: 10,
  PG_SIMULATOR_SECRET_KEY: 'sim_sk_test_0000000000000000',
});

const ARRIVAL = ['constant-arrival-rate', 'ramping-arrival-rate'];

/** 경로별 본구간 지표를 요약에 남기는 기준(lib/model.mjs phaseThresholds의 JSDoc 값을 따로 적는다) */
function expectedThresholds(routes) {
  const t = (tag) => ({ [`http_req_duration{${tag}}`]: ['max>=0'], [`http_reqs{${tag}}`]: ['count>=0'], [`http_req_failed{${tag}}`]: ['rate>=0'] });
  const out = { ...t('phase:main'), dropped_iterations: ['count>=0'] };
  for (const r of routes) Object.assign(out, t(`phase:main,route:${r}`));
  return out;
}

/** 실행기 하나가 끝나는 시각(초). 도착률 실행기만(그 밖은 끝이 정해지지 않는다) */
function endS(sc) {
  assert.ok(ARRIVAL.includes(sc.executor), `도착률 실행기가 아니다: ${sc.executor}`);
  const len = sc.executor === 'constant-arrival-rate' ? seconds(sc.duration) : sc.stages.reduce((x, st) => x + seconds(st.duration), 0);
  return seconds(sc.startTime ?? '0s') + len;
}

/**
 * 모든 시나리오에 같은 규칙: 예열·본구간(도착률 실행기, phase 꼬리표, 길이 WARM_S·MAIN_S, 본구간은 예열 바로 뒤),
 * 구간 표시 둘(shared-iterations 한 번, 본구간 시작·끝 시각), 준비 구간(phase:prep, 도착률 실행기, 예열 전에 끝남),
 * 경로별 본구간 기준과 dropped_iterations 기준, 요약 통계(장부가 읽는 med·p(95)·p(99))
 */
function checkCommon(o, env, { executor, routes, prep }) {
  const sc = o.scenarios ?? {};
  for (const name of ['warm', 'main', 'mark_start', 'mark_end', ...prep]) assert.ok(sc[name], `구간 ${name}이 없다(있는 것: ${Object.keys(sc).join(', ')})`);
  const { warm, main } = sc;
  for (const [name, s, phase] of [['warm', warm, 'warm'], ['main', main, 'main']]) {
    assert.equal(s.executor, executor, `${name} 실행기`);
    assert.equal(s.tags?.phase, phase, `${name} phase 꼬리표`);
    assert.equal(seconds(s.timeUnit), 1, `${name} timeUnit`);
    assert.equal(s.preAllocatedVUs, Number(env.PRE_VUS), `${name} preAllocatedVUs`);
    assert.equal(s.maxVUs, Number(env.MAX_VUS), `${name} maxVUs`);
    if (executor === 'constant-arrival-rate') assert.equal(s.rate, Number(env.RATE), `${name} rate`);
    assert.equal(typeof s.exec, 'string', `${name} exec`);
  }
  const warmStart = seconds(warm.startTime ?? '0s');
  const mainStart = seconds(main.startTime);
  assert.equal(endS(warm) - warmStart, Number(env.WARM_S), '예열 길이 = WARM_S');
  assert.equal(endS(main) - mainStart, Number(env.MAIN_S), '본구간 길이 = MAIN_S');
  assert.equal(mainStart, warmStart + Number(env.WARM_S), '본구간은 예열이 끝난 때 시작한다');
  // 구간 표시: 한 번만 내는 실행(같은 표시가 두 번이면 실행 도구가 거절한다)
  for (const [name, at] of [['mark_start', mainStart], ['mark_end', mainStart + Number(env.MAIN_S)]]) {
    const m = sc[name];
    assert.equal(m.executor, 'shared-iterations', `${name} 실행기`);
    assert.equal(m.iterations ?? 1, 1, `${name} 반복 수`);
    assert.equal(m.vus ?? 1, 1, `${name} VU 수`);
    assert.equal(seconds(m.startTime), at, `${name} 시작 시각`);
  }
  // 준비 구간: 진입·입장도 도착률로 보내(빠진 반복은 dropped_iterations로 센다) 가상 사용자 모두를 예열 전에 마친다
  for (const name of prep) {
    const p = sc[name];
    assert.equal(p.tags?.phase, 'prep', `${name} phase 꼬리표`);
    assert.ok(endS(p) <= warmStart, `${name}이 예열(${warmStart}초) 전에 끝나지 않는다(${endS(p)}초)`);
    if (p.executor === 'constant-arrival-rate') {
      const iterations = p.rate * ((endS(p) - seconds(p.startTime ?? '0s')) / seconds(p.timeUnit ?? '1s'));
      assert.ok(iterations >= Number(env.USERS), `${name}의 반복 ${iterations}번으로 가상 사용자 ${env.USERS}명을 모두 준비하지 못한다`);
    }
  }
  // 예열·본구간·준비 밖의 구간은 본구간 꼬리표를 달지 않는다
  for (const [name, s] of Object.entries(sc)) {
    if (name !== 'main' && !name.startsWith('mark_')) assert.notEqual(s.tags?.phase, 'main', `${name}에 phase:main이 붙었다`);
  }
  const th = o.thresholds ?? {};
  for (const [k, v] of Object.entries(expectedThresholds(routes))) assert.deepEqual(th[k], v, `thresholds ${k}`);
  const stats = o.summaryTrendStats ?? [];
  assert.ok(stats.includes('p(99)'), `summaryTrendStats에 p(99)가 없다: ${stats}`);
  assert.ok(stats.includes('p(95)'), `summaryTrendStats에 p(95)가 없다: ${stats}`);
  assert.ok(stats.includes('med') || stats.includes('p(50)'), `summaryTrendStats에 med·p(50)이 없다: ${stats}`);
  return { warm, main, warmStart, mainStart };
}

/** ramping 구간의 단계가 pollStages 결과와 같은지(기간은 k6가 Go 꼴로 다시 쓰므로 초로 견준다) */
function assertStages(label, got, want) {
  assert.equal(got.startRate, want.startRate, `${label} startRate`);
  assert.equal(got.stages.length, want.stages.length, `${label} 단계 수`);
  got.stages.forEach((st, j) => {
    assert.equal(st.target, want.stages[j].target, `${label} 단계 ${j} target`);
    assert.equal(seconds(st.duration), seconds(want.stages[j].duration), `${label} 단계 ${j} duration`);
  });
}

// ─────────── 시험 ───────────

test('NFR-013 ADR-0057 형식 검사용 토큰 묶음은 가짜 글 20개 이상(시험이 쓰는 가장 많은 USERS 40 이상)이고 JWT가 아니다', () => {
  const tokens = JSON.parse(readFileSync(join(REPO, FIXTURE), 'utf8'));
  assert.ok(Array.isArray(tokens) && tokens.length >= 40, `토큰 ${tokens.length}개`);
  for (const t of tokens) {
    assert.match(t, /^fixture-\d+$/);
    assert.doesNotMatch(t, /eyJ|\./, '서명한 토큰처럼 보이는 글을 두지 않는다');
  }
  assert.equal(new Set(tokens).size, tokens.length);
});

describe('k6 시나리오 형식(k6 inspect --execution-requirements)', { skip: SKIP, concurrency: false }, () => {
  before(() => {
    // 이미지가 없으면 먼저 받는다(CI 첫 실행). 다이제스트로 고정한 이미지만 쓴다
    try {
      docker(['image', 'inspect', '--format', '{{.Id}}', K6_IMAGE], 60_000);
    } catch {
      docker(['pull', '--quiet', K6_IMAGE], 600_000);
    }
  }, { timeout: 660_000 });

  test('NFR-013 ADR-0057 K1 Q-T2 v0-queue.js: 진입(prep) 뒤 대기자 조회를 pollStages 단계의 ramping-arrival-rate로 보내고 경로별 본구간 기준을 둔다', { timeout: 240_000 }, () => {
    const env = { ...BASE_ENV };
    const o = inspect('v0-queue.js', env);
    const { warm, main, warmStart } = checkCommon(o, env, { executor: 'ramping-arrival-rate', routes: ['entry', 'status', 'admission'], prep: ['entry'] });
    // 진입: 정한 도착률(ENTRY_RATE)로 N명. 모델 시각 0 = 진입 시작이고, 조회 예열은 모두 진입한 때(ceil(USERS ÷ ENTRY_RATE)초)에 시작한다
    const entry = o.scenarios.entry;
    assert.equal(entry.executor, 'constant-arrival-rate', 'entry 실행기');
    assert.equal(entry.rate, env.ENTRY_RATE, 'entry rate');
    const startS = Math.ceil(env.USERS / env.ENTRY_RATE);
    assert.equal(startS, 3);
    assert.equal(warmStart - seconds(entry.startTime ?? '0s'), startS, '예열은 진입 시작 뒤 ceil(USERS ÷ ENTRY_RATE)초에 시작한다');
    const model = { users: env.USERS, entryRate: env.ENTRY_RATE, admitPerSecond: env.ADMIT_PER_SECOND };
    assertStages('warm', warm, pollStages({ ...model, startS, durationS: env.WARM_S }));
    assertStages('main', main, pollStages({ ...model, startS: startS + env.WARM_S, durationS: env.MAIN_S }));
  });

  for (const mode of ['spread', 'hot', 'crossed']) {
    test(`NFR-013 ADR-0057 K2 S-T1 K3 S-T10 v0-seat-hold.js(${mode}): 준비(진입·입장) 뒤 홀드를 constant-arrival-rate로 보내고 hold·release 본구간 기준을 둔다`, { timeout: 240_000 }, () => {
      const env = { ...BASE_ENV, MODE: mode, HOT_COUNT: 3, PAIRS: 2, RELEASE_MS: mode === 'spread' ? 0 : 500 };
      const o = inspect('v0-seat-hold.js', env);
      checkCommon(o, env, { executor: 'constant-arrival-rate', routes: ['hold', 'release'], prep: ['prep_entry', 'prep_admit'] });
      assert.ok(seconds(o.scenarios.prep_entry.startTime ?? '0s') <= seconds(o.scenarios.prep_admit.startTime ?? '0s'), '진입 준비가 입장 준비보다 먼저 시작한다');
    });
  }

  test('NFR-013 ADR-0057 K7 v0-payment.js: 준비 뒤 결제를 constant-arrival-rate로 시작하고 hold·order·sim_auth·payment·order_view 본구간 기준을 둔다', { timeout: 240_000 }, () => {
    // 실행 도구가 받는 값: 결제 시작 수의 상한 RATE × (WARM_S + MAIN_S) + 2 = 1 × 38 + 2 = 40 ≤ USERS,
    // 좌석 USERS × SEATS_PER_ORDER = 40 ≤ 구역 2 × 열 2 × 열당 10
    const env = { ...BASE_ENV, USERS: 40, RATE: 1, WARM_S: 13, MAIN_S: 25, SEATS_PER_ORDER: 1, SECTIONS: 'A,B', ROWS: 2, PER_ROW: 10 };
    assert.ok(env.RATE * (env.WARM_S + env.MAIN_S) + 2 <= env.USERS && env.USERS * env.SEATS_PER_ORDER <= 2 * env.ROWS * env.PER_ROW);
    const o = inspect('v0-payment.js', env);
    checkCommon(o, env, { executor: 'constant-arrival-rate', routes: ['hold', 'order', 'sim_auth', 'payment', 'order_view'], prep: ['prep_entry', 'prep_admit'] });
    assert.ok(seconds(o.scenarios.prep_entry.startTime ?? '0s') <= seconds(o.scenarios.prep_admit.startTime ?? '0s'), '진입 준비가 입장 준비보다 먼저 시작한다');
  });

  test('NFR-013 ADR-0057 calibrate.js: 대기 상태 조회 모양의 GET을 constant-arrival-rate 예열·본구간으로 보내고 status 본구간 기준을 둔다', { timeout: 240_000 }, () => {
    const env = { ...BASE_ENV, BASE: 'https://null-target.loadtest.svc.cluster.local:8443', RATE: 50, WARM_S: 3, MAIN_S: 7 };
    const o = inspect('calibrate.js', env);
    checkCommon(o, env, { executor: 'constant-arrival-rate', routes: ['status'], prep: [] });
  });
});

// ─────────── BSL-090 Before 측정(docs/verification.md §3.10 '경로 목표 점검'·'K별 실행') ───────────

/** 검표 시나리오가 읽는 티켓 코드 묶음(가짜 글, 발권 코드와 같은 22자 base64url 꼴) */
const CODES_FIXTURE = 'loadtest/test/fixtures/codes.json';

/**
 * 검표 형식 검사의 환경. 실행 도구가 주는 꼴(loadtest/runner/args.mjs gate): 티켓 수 = RATE × (WARM_S + MAIN_S) + 2.
 * 도착률·스캐너 수·구간 길이·가상 사용자 수를 서로 다른 수(1도 아님)로 둬, 시나리오가 다른 값을 도착률·시각으로 써도 알아본다
 */
const GATE_ENV = Object.freeze({ ...BASE_ENV, SCANNERS: 2, RATE: 3, WARM_S: 4, MAIN_S: 7, TICKETS: 3 * (4 + 7) + 2, CODES_FILE: `/repo/${CODES_FIXTURE}`, SCAN_TIMEOUT: '3s' });

/** 경로 목표 시간(ms, §3.10 '경로 목표 점검'). lib/targets.mjs ROUTE_TARGETS의 값을 따로 적는다 */
const ROUTE_TARGET_MS = Object.freeze({ entry: [200], status: [200], admission: [200], hold: [50, 150], payment: [3000], scan: [150] });

/**
 * options.thresholds의 over_target 기준이 정확히 '그 시나리오 경로 가운데 목표가 있는 경로의 목표마다 하나'인지
 * ('over_target{phase:main,route:<경로>,le:<ms>}': ['count>=0'], 판정이 아니라 요약에 남기려는 기준. 목표가 없는 경로에는 없다)
 */
/** 경로 목표 기준이 본구간 경로마다 꼭 그만큼 있다. prepRoutes는 본구간 밖 진입 구간(phase:prep)에도 목표 기준이 있어야 하는 경로다(K1 진입) */
function assertOverTargets(o, routes, prepRoutes = []) {
  const want = {};
  for (const r of routes) for (const le of ROUTE_TARGET_MS[r] ?? []) want[`over_target{phase:main,route:${r},le:${le}}`] = ['count>=0'];
  for (const r of prepRoutes) for (const le of ROUTE_TARGET_MS[r] ?? []) want[`over_target{phase:prep,route:${r},le:${le}}`] = ['count>=0'];
  const got = Object.fromEntries(Object.entries(o.thresholds ?? {}).filter(([k]) => k.startsWith('over_target')));
  assert.deepEqual(got, want);
}

test('BSL090_K10_O-T1_형식검사용티켓코드묶음은_22자base64url가짜코드이고_검표시험의TICKETS이상이다', () => {
  const codes = JSON.parse(readFileSync(join(REPO, CODES_FIXTURE), 'utf8'));
  assert.ok(Array.isArray(codes) && codes.length >= GATE_ENV.TICKETS, `코드 ${codes.length}개(검표 시험의 TICKETS ${GATE_ENV.TICKETS})`);
  for (const c of codes) {
    assert.match(c, /^[A-Za-z0-9_-]{22}$/, '발권 코드와 같은 꼴(16바이트의 base64url 22자)');
    assert.match(c, /^fixture-code-\d{9}$/, '형식 검사용 가짜 코드다');
  }
  assert.equal(new Set(codes).size, codes.length);
});

describe('BSL-090 Before 측정 시나리오 형식(k6 inspect --execution-requirements)', { skip: SKIP, concurrency: false }, () => {
  before(() => {
    // 이미지가 없으면 먼저 받는다(CI 첫 실행). 다이제스트로 고정한 이미지만 쓴다
    try {
      docker(['image', 'inspect', '--format', '{{.Id}}', K6_IMAGE], 60_000);
    } catch {
      docker(['pull', '--quiet', K6_IMAGE], 600_000);
    }
  }, { timeout: 660_000 });

  test('BSL090_K10_O-T1_검표시나리오_v0-gate.js는_0초부터예열·WARM_S초부터본구간을_RATE의constant-arrival-rate로보내고_scan본구간기준과150ms목표를넘은수를둔다', { timeout: 240_000 }, () => {
    // 실행 도구가 주는 값(loadtest/runner/args.mjs gate): 티켓 수 = RATE × (WARM_S + MAIN_S) + 2, 형식 검사용 코드는 그만큼 있다
    const env = { ...GATE_ENV };
    assert.equal(env.TICKETS, env.RATE * (env.WARM_S + env.MAIN_S) + 2);
    assert.equal(new Set([1, env.SCANNERS, env.RATE, env.WARM_S, env.MAIN_S, env.PRE_VUS, env.MAX_VUS]).size, 7, '시험 값은 서로 다르다');
    assert.ok(JSON.parse(readFileSync(join(REPO, CODES_FIXTURE), 'utf8')).length >= env.TICKETS);
    const o = inspect('v0-gate.js', env);
    const { warm, main, warmStart, mainStart } = checkCommon(o, env, { executor: 'constant-arrival-rate', routes: ['scan'], prep: [] });
    assert.deepEqual(Object.keys(o.scenarios).sort(), ['main', 'mark_end', 'mark_start', 'warm'], '준비 구간이 없다(스캐너는 줄을 서지 않는다)');
    assert.equal(warmStart, 0, '예열은 0초에 시작한다');
    assert.equal(mainStart, env.WARM_S, '본구간은 WARM_S초에 시작한다');
    assert.equal(seconds(o.scenarios.mark_start.startTime), env.WARM_S);
    assert.equal(seconds(o.scenarios.mark_end.startTime), env.WARM_S + env.MAIN_S);
    assert.equal(warm.exec, 'scan');
    assert.equal(main.exec, 'scan');
    assertOverTargets(o, ['scan']);
  });

  test('BSL090_K4_S-T12_좌석홀드시나리오_LISTENERS명을함께준비하고_준비뒤CONNECT_S초를비운뒤_홀드를보낸다(구간표시도그만큼뒤)', { timeout: 300_000 }, () => {
    const plain = { ...BASE_ENV, USERS: 25, PREP_RATE: 10 };
    const env = { ...plain, LISTENERS: 10, CONNECT_S: 20 };
    const prepUsers = env.LISTENERS + env.USERS;
    const entryS = Math.ceil(prepUsers / env.PREP_RATE);
    const prepS = 2 * entryS + 3;
    assert.notEqual(entryS, Math.ceil(env.USERS / env.PREP_RATE), '시험 값: 연결 쪽을 더하면 준비 길이가 달라진다');
    const o = inspect('v0-seat-hold.js', env);
    // 준비 구간(진입·입장)은 연결 쪽 LISTENERS명과 홀드 쪽 USERS명을 모두 준비한다
    const { mainStart, warmStart } = checkCommon(o, { ...env, USERS: prepUsers }, { executor: 'constant-arrival-rate', routes: ['hold', 'release'], prep: ['prep_entry', 'prep_admit'] });
    const { prep_entry: pe, prep_admit: pa } = o.scenarios;
    assert.equal(pe.rate, env.PREP_RATE);
    assert.equal(seconds(pe.startTime ?? '0s'), 0);
    assert.equal(seconds(pe.duration), entryS, '진입 준비는 ⌈(LISTENERS + USERS) ÷ PREP_RATE⌉초');
    assert.equal(seconds(pa.startTime), entryS + 2, '입장 준비는 진입 준비가 끝나고 2초 뒤');
    assert.equal(pa.rate, env.PREP_RATE);
    assert.equal(seconds(pa.duration), entryS, '입장 준비도 ⌈(LISTENERS + USERS) ÷ PREP_RATE⌉초');
    assert.equal(warmStart, prepS + env.CONNECT_S, '홀드 예열은 준비(2 × ⌈n ÷ PREP_RATE⌉ + 3초) 뒤 CONNECT_S초를 비우고 시작한다');
    assert.equal(mainStart, prepS + env.CONNECT_S + env.WARM_S);
    assert.equal(seconds(o.scenarios.mark_start.startTime), mainStart);
    assert.equal(seconds(o.scenarios.mark_end.startTime), mainStart + env.MAIN_S);
    // 비운 CONNECT_S초 동안은 아무 구간도 돌지 않는다(받는 파드가 연결을 맺는 동안 부하가 없다)
    for (const [name, s] of Object.entries(o.scenarios)) {
      if (name.startsWith('prep_')) assert.ok(endS(s) <= prepS, `${name}이 준비 시간(${prepS}초) 안에 끝나지 않는다(${endS(s)}초)`);
      else assert.ok(seconds(s.startTime ?? '0s') >= prepS + env.CONNECT_S, `${name}이 비운 시간 안에 시작한다(${s.startTime})`);
    }
    // 연결 쪽이 없으면(기본 LISTENERS 0·CONNECT_S 0) 예전과 같다: 홀드 예열은 2 × ⌈USERS ÷ PREP_RATE⌉ + 3초에 시작한다
    const before = inspect('v0-seat-hold.js', plain);
    assert.equal(seconds(before.scenarios.prep_entry.duration), Math.ceil(plain.USERS / plain.PREP_RATE));
    assert.equal(seconds(before.scenarios.warm.startTime), 2 * Math.ceil(plain.USERS / plain.PREP_RATE) + 3);
  });

  test('BSL090_S-T1_NFR-003_좌석홀드시나리오_홀드본구간의_50ms·150ms목표를넘은수를요약에남기고_놓기에는목표가없다', { timeout: 240_000 }, () => {
    // K2 S-T1: 인기 좌석 하나에 몰리고 잡은 홀드를 놓지 않는다(KEEP=1)
    const env = { ...BASE_ENV, MODE: 'hot', HOT_COUNT: 1, KEEP: 1 };
    const o = inspect('v0-seat-hold.js', env);
    checkCommon(o, env, { executor: 'constant-arrival-rate', routes: ['hold', 'release'], prep: ['prep_entry', 'prep_admit'] });
    assertOverTargets(o, ['hold', 'release']);
    // KEEP은 잡은 홀드를 놓지 않게 할 뿐이다: 구간·기준(options)은 KEEP이 없을 때와 같다(놓기 경로 기준도 그대로 남는다)
    const released = { ...env };
    delete released.KEEP;
    assert.deepEqual(o, inspect('v0-seat-hold.js', released), 'KEEP=1은 options를 바꾸지 않는다');
  });

  test('BSL090_S-T1_NFR-003_좌석홀드시나리오_요약통계에p(99.9)가있어_K2의홀드p99.9를재고_발생기를나누면아래·위한계로적는다', { timeout: 240_000 }, () => {
    // §3.10 K별 실행 K2: 재는 것은 '홀드 p99·p99.9'. '발생기 나누기': 발생기마다 따로 나온 p99·p99.9는 합친 값의 아래·위 한계로 적는다.
    // k6는 summaryTrendStats에 든 통계만 요약에 남긴다. p(99.9)가 없으면 over_target(le:150)로 목표를 넘었는지는 세도 p99.9 값은 남지 않는다
    const env = { ...BASE_ENV, MODE: 'hot', HOT_COUNT: 1, KEEP: 1 };
    const o = inspect('v0-seat-hold.js', env);
    const stats = o.summaryTrendStats ?? [];
    assert.ok(stats.includes('p(99)'), `summaryTrendStats에 p(99)가 없다: ${stats}`);
    assert.ok(stats.includes('p(99.9)'), `summaryTrendStats에 p(99.9)가 없다(K2 홀드 p99.9를 재지 못한다): ${stats}`);
  });

  test('BSL090_P-T1_NFR-006_결제시나리오_장애걸기(route:sim_fault)본구간기준과_결제확정3초·홀드목표를넘은수를요약에남긴다', { timeout: 240_000 }, () => {
    // K7 ②: 결제사 장애 비율(100명마다 drop 5명·delay 2명, 늦춤 16초)을 받는다. 그 밖의 값은 K7 형식 검사와 같다
    const env = { ...BASE_ENV, USERS: 40, RATE: 1, WARM_S: 13, MAIN_S: 25, SEATS_PER_ORDER: 1, SECTIONS: 'A,B', ROWS: 2, PER_ROW: 10, FAULT_DROP_PCT: 5, FAULT_DELAY_PCT: 2, FAULT_DELAY_MS: 16000 };
    const routes = ['hold', 'order', 'sim_auth', 'sim_fault', 'payment', 'order_view'];
    const o = inspect('v0-payment.js', env);
    checkCommon(o, env, { executor: 'constant-arrival-rate', routes, prep: ['prep_entry', 'prep_admit'] });
    assertOverTargets(o, routes);
  });

  test('BSL090_Q-T2_NFR-001_대기열시나리오_목표가있는경로마다_그요청이나가는구간에요청수·200ms넘은수·실패기준이있어_K1점검을만든다(진입포함)', { timeout: 240_000 }, () => {
    // §3.10 K1 목표 점검: 진입·대기 상태·입장 확정 p99 200ms, 오류율 0.1% 미만. 점검 파일(runner/merge.mjs checksFromSummary)은 요약의
    // http_reqs·over_target·http_req_failed{phase,route} 수로 만들고, 시행 수가 0인 경로는 말없이 건너뛴다. k6는 기준을 건 하위 지표만 요약에 남기므로
    // 경로 요청이 나가는 구간(phase 꼬리표) 가운데 적어도 하나에 그 경로의 세 기준이 있어야 그 경로의 점검이 장부에 남는다
    const o = inspect('v0-queue.js', { ...BASE_ENV });
    const th = o.thresholds ?? {};
    const sentBy = { entry: 'enter', status: 'poll', admission: 'poll' };
    for (const [route, fn] of Object.entries(sentBy)) {
      const phases = [...new Set(Object.values(o.scenarios).filter((s) => s.exec === fn).map((s) => s.tags?.phase))];
      assert.ok(phases.length > 0, `${route} 요청을 보내는 구간(exec ${fn})이 없다`);
      const measured = phases.filter((p) => th[`http_reqs{phase:${p},route:${route}}`] && th[`over_target{phase:${p},route:${route},le:200}`] && th[`http_req_failed{phase:${p},route:${route}}`]);
      assert.ok(measured.length > 0, `${route} 요청은 구간 ${phases.join('·')}에서만 나가는데 그 구간에 ${route}의 요청 수·200ms 넘은 수·실패 기준이 없다(K1 ${route} 점검이 장부에 남지 않는다)`);
    }
  });

  test('BSL090_Q-T2_대기열시나리오_진입·대기상태·입장확정의_200ms목표를넘은수를요약에남긴다', { timeout: 240_000 }, () => {
    const env = { ...BASE_ENV };
    const o = inspect('v0-queue.js', env);
    checkCommon(o, env, { executor: 'ramping-arrival-rate', routes: ['entry', 'status', 'admission'], prep: ['entry'] });
    // 진입은 예열 앞의 진입 구간(phase:prep)에서만 나가 그 구간에도 목표 기준을 둔다(§3.10 K1 진입 점검, 2026-11-03 시험 검토)
    assertOverTargets(o, ['entry', 'status', 'admission'], ['entry']);
  });
});
