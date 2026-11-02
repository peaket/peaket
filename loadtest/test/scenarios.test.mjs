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
