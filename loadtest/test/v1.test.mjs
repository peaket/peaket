// v1 경로(docs/verification.md §3.9 'v1 경로', BUILD_ORDER PRF-215 ④)의 계산과 시나리오 형식 검사.
// - lib/v1.mjs: 신원(UUID 꼴·실행마다 다름), 좌석 UUID와 격자 번호, 좌석맵 판(purchase-svc 판 규칙), 시각 기반 일련번호, VU별 사용자 나누기
// - lib/targets.mjs faultFor: 소수 한 자리 비율(1,000명마다 정확히 비율 × 10명, 정수 비율은 v0와 같은 사람)
// - runner/args.mjs: v1 명령(시나리오 셋, v1에 없는 인자 거부, 소수 비율, 입장 토큰 체류 규칙)
// - scenarios/v1-*.js: 고정한 k6 이미지로 k6 inspect가 읽는지(가져오는 lib·exec 함수 포함)와 구간·경로 기준(Docker가 없으면 건너뛴다)
// 시험 값은 코드 상수와 다르게 고른다.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { faultFor, PAYMENT_DRAIN_MS, paymentDrainFinished, paymentDrainNewStart, paymentDrainUnfinished, paymentOverTarget, paymentPendingBefore3s, paymentStatusPollNext, PAYMENT_STATUS_POLL_INTERVAL_MS, PAYMENT_STATUS_POLL_MAX_CALLS, PAYMENT_STATUS_POLL_MAX_MS, PAYMENT_STATUS_POLL_MIN_MS } from '../lib/targets.mjs';
import { nextPurchaseSeq, ownedUser, paymentUserOf, runTagHex, seatIndexOf, v1AccountId, v1Headers, v1Pid, v1SeatIds, v1SeatMap, v1SeatUuid, v1SessionId } from '../lib/v1.mjs';
import { seatCount, seatIdAt } from '../lib/seats.mjs';
import { parseArgs, UsageError, V1_ADMISSION_STAY_S, V1_SCENARIOS } from '../runner/args.mjs';
import { K6_IMAGE } from '../runner/manifests.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('lib/v1.mjs', () => {
  test('PRF215_신원은_UUID꼴이고_실행·사용자·종류마다_다르며_머리다섯을_단다', () => {
    const a = v1AccountId('run7x', 70_000);
    assert.match(a, UUID);
    assert.match(v1SessionId('run7x', 70_000), UUID);
    assert.notEqual(a, v1SessionId('run7x', 70_000));
    assert.notEqual(a, v1AccountId('run7y', 70_000));
    assert.notEqual(a, v1AccountId('run7x', 70_001));
    // 12비트 경계(4095 → 4096)에서도 겹치지 않는다
    assert.notEqual(v1AccountId('r', 4095), v1AccountId('r', 4096));
    assert.equal(runTagHex('r').length, 8);
    assert.deepEqual(Object.keys(v1Headers('run7x', 3, { json: true })).sort(), ['content-type', 'x-session-id', 'x-user-aud', 'x-user-id', 'x-user-pid', 'x-user-scope']);
    assert.deepEqual({ aud: v1Headers('r', 1)['x-user-aud'], scope: v1Headers('r', 1)['x-user-scope'] }, { aud: 'fan', scope: 'ticket:buy' });
    assert.equal(v1Pid('r', 9), 'pid-lt-r-9');
    assert.throws(() => v1AccountId('BAD', 1));
    assert.throws(() => v1AccountId('r', -1), RangeError);
  });

  test('PRF215_좌석UUID는_번호의16진12자리이고_격자ID와_번호가_서로돌아온다', () => {
    assert.equal(v1SeatUuid(0), '00000000-0000-4000-8000-000000000000');
    assert.equal(v1SeatUuid(4097), '00000000-0000-4000-8000-000000001001');
    const grid = { sections: ['A', 'B', 'C'], rows: 3, perRow: 7 };
    for (let k = 0; k < seatCount(grid); k++) assert.equal(seatIndexOf(grid, seatIdAt(grid, k)), k);
    assert.deepEqual(v1SeatIds(grid, ['A-1-1', 'C-3-7']), [v1SeatUuid(0), v1SeatUuid(62)]);
    for (const bad of ['D-1-1', 'A-0-1', 'A-4-1', 'A-1-8', 'A1-1']) assert.throws(() => seatIndexOf(grid, bad), RangeError, bad);
  });

  test('PRF215_좌석맵판은_구역마다_번호범위와_그범위의좌석을두고_가격·한사람상한·판매종료를싣는다', () => {
    const grid = { sections: ['A', 'B'], rows: 2, perRow: 3 };
    const sm = v1SeatMap(grid, { perAccountLimit: 3, saleEndsAtMs: Date.UTC(2026, 10, 13, 9), price: 123_000, layoutVersion: 11 });
    assert.deepEqual(Object.keys(sm).sort(), ['layout', 'orderName', 'perAccountLimit', 'saleEndsAt', 'tierPrices']);
    assert.equal(sm.saleEndsAt, '2026-11-13T09:00:00.000Z');
    assert.deepEqual(sm.tierPrices, { R: 123_000 });
    assert.equal(sm.layout.layoutVersion, 11);
    assert.deepEqual(sm.layout.sections.map((s) => [s.sectionId, s.seatIndexRange.from, s.seatIndexRange.to, s.seats.length]), [['SEC-A', 0, 5, 6], ['SEC-B', 6, 11, 6]]);
    for (const s of sm.layout.sections) for (const seat of s.seats) {
      assert.ok(seat.index >= s.seatIndexRange.from && seat.index <= s.seatIndexRange.to);
      assert.equal(seat.seatId, v1SeatUuid(seat.index));
    }
    assert.throws(() => v1SeatMap(grid, { perAccountLimit: 5, saleEndsAtMs: 1, price: 1, layoutVersion: 1 }), RangeError);
    assert.throws(() => v1SeatMap(grid, { perAccountLimit: 0, saleEndsAtMs: 1, price: 1, layoutVersion: 1 }), RangeError);
  });

  test('PRF215_일련번호는_지난번호보다크고_시각×1000보다작지않으며_VU가바뀌어도_앞번호보다크다', () => {
    assert.equal(nextPurchaseSeq(0, 1_762_000_000_123), 1_762_000_000_123_000);
    // 같은 ms 안에서 이어 부르면 1씩
    assert.equal(nextPurchaseSeq(1_762_000_000_123_000, 1_762_000_000_123), 1_762_000_000_123_001);
    // 앞 VU가 시각 t에 쓴 번호를 다음 VU(지난 번호 0)가 t + 1ms에 이어 쓰면 더 크다
    const prev = nextPurchaseSeq(nextPurchaseSeq(0, 5_000), 5_000);
    assert.ok(nextPurchaseSeq(0, 5_001) > prev);
    assert.throws(() => nextPurchaseSeq(Number.MAX_SAFE_INTEGER, 1), RangeError);
  });

  test('PRF215_VU별_사용자나누기는_무리마다_겹치지않고_모든사용자가_어느무리에든있다', () => {
    for (const [users, groups] of [[10, 3], [7, 7], [5, 9], [1, 1], [1_000, 64]]) {
      const seen = new Map();
      for (let vu = 1; vu <= groups * 3; vu++) {
        for (let k = 0; k < 50; k++) {
          const u = ownedUser(users, groups, vu, k / 50);
          if (u < 0) {
            assert.ok(vu % groups >= users, `사람 없는 무리 vu=${vu}`);
            continue;
          }
          assert.ok(u >= 0 && u < users);
          assert.equal(u % groups, vu % groups, `vu=${vu}의 사람 ${u}`);
          seen.set(u, true);
        }
      }
      assert.equal(seen.size, users, `users=${users} groups=${groups}`);
    }
    assert.throws(() => ownedUser(0, 1, 1, 0), RangeError);
  });
});

describe('faultFor 소수 한 자리(§3.9 비율 소수 한 자리)', () => {
  const tally = (from, n, drop, delay) => {
    const c = { drop: 0, delay: 0, none: 0 };
    for (let i = from; i < from + n; i++) c[faultFor(i, drop, delay) ?? 'none'] += 1;
    return c;
  };

  test('PRF215_어느자리에서시작한_1000명이든_정확히_비율×10명이다(K7 ② v1: 응답 버림 5%·늦춤 0.5%)', () => {
    for (const from of [0, 1, 99, 999, 12_345, 987_654_321]) {
      assert.deepEqual(tally(from, 1000, 5, 0.5), { drop: 50, delay: 5, none: 945 }, `from=${from}`);
      assert.deepEqual(tally(from, 1000, 0.1, 0.2), { drop: 1, delay: 2, none: 997 }, `from=${from}`);
      assert.deepEqual(tally(from, 1000, 99.9, 0.1), { drop: 999, delay: 1, none: 0 }, `from=${from}`);
    }
  });

  test('PRF215_정수비율은_v0규칙(i mod 100 < 비율)과_같은사람을_고른다(v0 행 결과 재현)', () => {
    const v0 = (i, d, l) => (i % 100 < d ? 'drop' : i % 100 < d + l ? 'delay' : null);
    for (const [d, l] of [[5, 2], [0, 0], [100, 0], [0, 100], [33, 33], [1, 99]]) for (let i = 0; i < 3000; i++) assert.equal(faultFor(i, d, l), v0(i, d, l), `i=${i} d=${d} l=${l}`);
  });

  test('PRF215_경계: 0.1은 받고 0.05·100.1·합100.1은 받지않는다', () => {
    assert.doesNotThrow(() => faultFor(0, 0.1, 0));
    assert.doesNotThrow(() => faultFor(0, 99.9, 0.1));
    for (const [d, l] of [[0.05, 0], [100.1, 0], [99.9, 0.2], [50.5, 49.6]]) assert.throws(() => faultFor(0, d, l), RangeError, `${d}+${l}`);
  });
});

describe('BAT-035 v1 payment 사용자 번호', () => {
  test('시나리오별 반복 번호에서 예열과 본구간 사용자 범위가 겹치지 않고, 계획 밖 꼬리는 버린다', () => {
    const users = 11002;
    const rate = 100;
    const warmS = 10;
    const mainS = 100;
    const warmCount = rate * warmS;
    const mainCount = rate * mainS;
    const warm = Array.from({ length: warmCount + 8 }, (_, it) => paymentUserOf('warm', it, users, rate, warmS, mainS));
    const main = Array.from({ length: mainCount + 8 }, (_, it) => paymentUserOf('main', it, users, rate, warmS, mainS));
    const validWarm = warm.filter((i) => i >= 0 && i < users);
    const validMain = main.filter((i) => i >= 0 && i < users);
    assert.equal(validWarm.length, warmCount, '예열은 계획한 반복 수만 사용자 번호를 쓴다');
    assert.equal(validMain.length, mainCount, '본구간은 계획한 반복 수만 사용자 번호를 쓴다');
    assert.equal(new Set([...validWarm, ...validMain]).size, validWarm.length + validMain.length, '겹침 없음');
    assert.deepEqual(warm.slice(warmCount), Array(8).fill(-1), '예열 꼬리는 버린다');
    assert.deepEqual(main.slice(mainCount), Array(8).fill(-1), '본구간 꼬리는 버린다');
    assert.equal(validWarm[0], users - 1);
    assert.equal(validWarm.at(-1), users - warmCount);
    assert.equal(validMain[0], 0);
    assert.equal(validMain.at(-1), mainCount - 1);
  });
});

describe('BAT-511 K7 결제 확정 드레인', () => {
  test('드레인 중 끝난 결제는 실제 시간으로 판정하고, 20초가 지나도 안 끝난 결제는 위반이다', () => {
    const mainEndMs = 1_000_000;
    assert.equal(PAYMENT_DRAIN_MS, 20_000);
    assert.equal(paymentDrainFinished({ startedMs: mainEndMs - 5_000, finishedMs: mainEndMs + 1_000, mainEndMs }), true);
    assert.equal(paymentDrainFinished({ startedMs: mainEndMs + 1, finishedMs: mainEndMs + 1_000, mainEndMs }), false);
    assert.equal(paymentDrainFinished({ startedMs: mainEndMs - 5_000, finishedMs: mainEndMs - 1, mainEndMs }), false);
    assert.equal(paymentDrainNewStart({ startedMs: mainEndMs, mainEndMs }), true);
    assert.equal(paymentDrainNewStart({ startedMs: mainEndMs - 1, mainEndMs }), false);
    assert.equal(paymentDrainUnfinished({ started: 10, finished: 8 }), 2);
    assert.equal(paymentDrainUnfinished({ started: 8, finished: 10 }), 0);
    assert.equal(paymentOverTarget({ tookMs: 3_000, terminal: true }), false);
    assert.equal(paymentOverTarget({ tookMs: 3_001, terminal: true }), true);
    assert.equal(paymentOverTarget({ tookMs: 100, terminal: false }), true);
    assert.equal(paymentOverTarget({ tookMs: 10_000, terminal: true }), true);
  });

  test('빠른 비끝 답은 3초까지 다시 묻고, 3초가 지나면 그때 멈춘다', () => {
    assert.equal(PAYMENT_STATUS_POLL_MIN_MS, 3_000);
    assert.equal(PAYMENT_STATUS_POLL_INTERVAL_MS, 100);
    assert.equal(PAYMENT_STATUS_POLL_MAX_CALLS, 100);
    assert.equal(PAYMENT_STATUS_POLL_MAX_MS, PAYMENT_DRAIN_MS);
    assert.deepEqual(paymentStatusPollNext({ startedMs: 0, nowMs: 0, calls: 0, terminal: false }), { poll: true, sleepMs: 100, reason: 'until-min' });
    assert.deepEqual(paymentStatusPollNext({ startedMs: 0, nowMs: 2_999, calls: 1, terminal: false }), { poll: true, sleepMs: 1, reason: 'until-min' });
    assert.deepEqual(paymentStatusPollNext({ startedMs: 0, nowMs: 3_000, calls: 2, terminal: false }), { poll: false, sleepMs: 0, reason: 'min' });
    assert.deepEqual(paymentStatusPollNext({ startedMs: 0, nowMs: 20_000, calls: 2, terminal: false }), { poll: false, sleepMs: 0, reason: 'max' });
    assert.deepEqual(paymentStatusPollNext({ startedMs: 0, nowMs: 1_000, calls: 100, terminal: false }), { poll: false, sleepMs: 0, reason: 'calls' });
    assert.deepEqual(paymentStatusPollNext({ startedMs: 0, nowMs: 1_000, calls: 1, terminal: true }), { poll: false, sleepMs: 0, reason: 'terminal' });
    assert.equal(paymentPendingBefore3s({ tookMs: 2_999, terminal: false }), true);
    assert.equal(paymentPendingBefore3s({ tookMs: 3_000, terminal: false }), false);
    assert.equal(paymentPendingBefore3s({ tookMs: 1_000, terminal: true }), false);
  });
});

describe('runner/args.mjs v1', () => {
  const ok = (argv) => parseArgs(argv);
  const bad = (argv, re) => assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && re.test(e.message), argv.join(' '));

  test('PRF215_v1_시나리오는_queue·seat-hold·payment이고_파일은_v1-*.js다', () => {
    assert.deepEqual(V1_SCENARIOS, { queue: 'v1-queue.js', 'seat-hold': 'v1-seat-hold.js', payment: 'v1-payment.js' });
    bad(['v1', 'seat-deltas', '--users', '10', '--rate', '1', '--connections', '1'], /v1 시나리오는/);
    bad(['v1', 'gate', '--scanners', '1', '--rate', '1'], /v1 시나리오는/);
    const q = ok(['v1', 'queue', '--users', '1200', '--entry-rate', '300', '--admit-per-second', '28']);
    assert.deepEqual({ command: q.command, scenario: q.scenario, namespace: q.namespace }, { command: 'v1', scenario: 'queue', namespace: 'v1' });
  });

  test('PRF215_v1에는_--namespace·--settle·--hpa-timeline이_없다', () => {
    for (const f of [['--namespace', 'v0'], ['--settle'], ['--hpa-timeline']]) bad(['v1', 'seat-hold', '--users', '100', '--rate', '20', ...f], /v1:seat-hold에 없는 인자/);
  });

  test('PRF215_장애비율은_소수한자리까지받고_합은_10배정수로견준다', () => {
    const p = ok(['v1', 'payment', '--users', '3000', '--rate', '20', '--warm', '10', '--main', '100', '--fault-drop-pct', '5', '--fault-delay-pct', '0.5', '--kill-app-at', '50']);
    assert.deepEqual({ d: p.faultDropPct, l: p.faultDelayPct, k: p.killAppAtS }, { d: 5, l: 0.5, k: 50 });
    assert.deepEqual([ok(['v1', 'payment', '--users', '3000', '--rate', '20', '--fault-drop-pct', '99.9', '--fault-delay-pct', '0.1']).faultDropPct], [99.9]);
    for (const v of ['0.05', '-1', '100.1', '1e1', '.5', '5.', ' 5']) bad(['v1', 'payment', '--users', '3000', '--rate', '20', '--fault-drop-pct', v], /fault-drop-pct/);
    bad(['v1', 'payment', '--users', '3000', '--rate', '20', '--fault-drop-pct', '99.9', '--fault-delay-pct', '0.2'], /합은 100 이하/);
  });

  test('BAT028_K2_seat-hold_기본예열은60초이고_K1_K7_기본예열은30초그대로다', () => {
    assert.equal(ok(['v1', 'seat-hold', '--users', '100', '--rate', '20']).warmS, 60);
    assert.equal(ok(['v1', 'queue', '--users', '100', '--entry-rate', '10', '--admit-per-second', '5']).warmS, 30);
    assert.equal(ok(['v1', 'payment', '--users', '3000', '--rate', '20']).warmS, 30);
    assert.equal(ok(['v1', 'seat-hold', '--users', '100', '--rate', '20', '--warm', '45']).warmS, 45);
  });

  test('PRF215_v1_seat-hold는_입구IP한도규칙이없고_입장토큰체류45분안이어야한다', () => {
    // v0이면 IP 몫 규칙에 걸리는 값(10명에 초당 2,000건)도 v1은 받는다(게이트웨이 없음)
    bad(['v0', 'seat-hold', '--users', '10', '--rate', '2000'], /IP당 한도/);
    assert.equal(ok(['v1', 'seat-hold', '--users', '10', '--rate', '2000', '--keep']).rate, 2000);
    assert.equal(V1_ADMISSION_STAY_S, 2700);
    // 준비 2 × ⌈100 ÷ 100⌉ + 3 = 5초 + 예열 + 본구간 + 60초 ≤ 2,700초(경계 양쪽)
    assert.equal(ok(['v1', 'seat-hold', '--users', '100', '--rate', '20', '--warm', '600', '--main', '2035']).mainS, 2035);
    bad(['v1', 'seat-hold', '--users', '100', '--rate', '20', '--warm', '600', '--main', '2036'], /최대 체류/);
  });
});

// ─────────── 시나리오 형식(k6 inspect) ───────────

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST_REPO = process.platform === 'win32' ? REPO.replaceAll('\\', '/') : REPO;
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
// Linux 러너에서는 임시 폴더(mkdtemp, 0700)에 k6가 쓰도록 이 프로세스의 사용자로 돈다(Docker Desktop에서는 이미지 사용자. manifests090.test.mjs runArgs와 같다, CI 42826751275)
const K6_USER = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
const docker = (args, timeout) => execFileSync('docker', args, { encoding: 'utf8', env: DOCKER_ENV, timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let SKIP = false;
try {
  docker(['version', '--format', '{{.Server.Version}}'], 60_000);
} catch (e) {
  SKIP = `Docker가 없어 v1 시나리오 형식 검사를 건너뛴다(${e.code ?? e.status})`;
}
const ENV = {
  RUN_TAG: 'fmtv1',
  OUT_DIR: '/tmp/out',
  USERS_FILE: '/repo/loadtest/test/fixtures/users.json',
  EVENT_ID: '0193a4b2-7c1a-7d3e-9f40-6b2a8c1d5e70',
  USERS: 30,
  RATE: 2,
  ENTRY_RATE: 10,
  ADMIT_PER_SECOND: 2,
  WARM_S: 15,
  MAIN_S: 25,
  PRE_VUS: 5,
  MAX_VUS: 10,
  MODE: 'hot',
  HOLD_SIZE: 1,
  HOT_COUNT: 1,
  PAIRS: 1,
  RELEASE_MS: 0,
  KEEP: 1,
  SECTIONS: 'A,B',
  ROWS: 2,
  PER_ROW: 10,
  SEATS_PER_ORDER: 1,
  CLIENT_KEY: 'B'.repeat(87),
  SHARED_SECRET_HEX: '8f1c4a2be05d97316ac4e2b7d0938f5a1e6b2c7d40f9a3851be7c62d04a9f315',
  FAULT_DROP_PCT: '5',
  FAULT_DELAY_PCT: '0.5',
  PG_SIMULATOR_SECRET_KEY: 'sim_sk_test_0000000000000000',
};

function inspect(file) {
  const args = ['run', '--rm', '--network', 'none', '--mount', `type=bind,source=${HOST_REPO},target=/repo,readonly`, '-w', '/repo', K6_IMAGE, 'inspect', '--execution-requirements'];
  for (const [k, v] of Object.entries(ENV)) args.push('-e', `${k}=${v}`);
  args.push(`loadtest/scenarios/${file}`);
  try {
    return JSON.parse(docker(args, 180_000));
  } catch (e) {
    assert.fail(`k6 inspect ${file} 실패: ${String(e.stderr ?? e.message).slice(-2500)}`);
  }
}

describe('v1 시나리오 형식(k6 inspect)', { skip: SKIP }, () => {
  test('PRF215_v1-queue는_한시나리오(flow)에_진입·예열·본구간을두고_구간표시와_진입점검기준이있다', () => {
    const o = inspect('v1-queue.js');
    assert.deepEqual(Object.keys(o.scenarios).sort(), ['flow', 'mark_end', 'mark_start']);
    assert.equal(o.scenarios.flow.executor, 'ramping-arrival-rate');
    assert.equal(o.scenarios.flow.exec, 'flow');
    for (const k of ['http_req_duration{phase:main,route:status}', 'http_req_duration{phase:main,route:admission}', 'http_reqs{phase:prep,route:entry}', 'over_target{phase:prep,route:entry,le:200}', 'over_target{phase:main,route:status,le:200}']) assert.ok(o.thresholds[k], k);
  });

  test('PRF215_v1-seat-hold는_예열·본구간(도착률)과_준비시간한도가있고_홀드·해제경로기준이있다', () => {
    const o = inspect('v1-seat-hold.js');
    for (const n of ['warm', 'main', 'mark_start', 'mark_end']) assert.ok(o.scenarios[n], n);
    assert.equal(o.scenarios.main.exec, 'hold');
    assert.equal(o.scenarios.warm.rate, Math.max(1, Math.floor(ENV.RATE / 2)), '예열은 본구간 절반 도착률');
    assert.equal(o.scenarios.warm.gracefulStop, '5s', '예열 끝 진행 중인 홀드를 마무리한다');
    assert.equal(o.scenarios.main.startTime, `${ENV.WARM_S + 5}s`, '예열 유예 뒤 본구간을 시작한다');
    assert.equal(o.setupTimeout, '15m0s');
    for (const k of ['http_req_duration{phase:main,route:hold}', 'over_target{phase:main,route:hold,le:150}', 'http_reqs{phase:main,route:release}']) assert.ok(o.thresholds[k], k);
  });

  test('PRF215_v1-payment는_예열·본구간(도착률)과_결제경로기준·결과상태셈이있다', () => {
    const o = inspect('v1-payment.js');
    assert.equal(o.scenarios.main.exec, 'pay');
    assert.equal(o.scenarios.main.gracefulStop, '20s', '본구간 뒤 20초 드레인');
    for (const k of ['http_req_duration{phase:main,route:payment}', 'over_target{phase:main,route:payment,le:3000}', 'payment_outcomes{phase:main,status:CONFIRMED}', 'payment_outcomes{phase:main,status:PENDING}', 'payment_confirm_ms{phase:main}']) assert.ok(o.thresholds[k], k);
  });
});

describe('runner/results.mjs collectArgs의 Redis TLS(v1)', () => {
  test('PRF215_redisTls를_주면_--redis-tls true·false로_넘기고_짝실행이있으면_--paired-run을_더하며_참거짓이아니면_던진다', async () => {
    const { collectArgs } = await import('../runner/results.mjs');
    const base = { runId: '2026-11-11-k1-v1-local-1k-r1', kpi: 'K1', version: 'v1', profile: 'local-1k', scenario: 'loadtest/scenarios/v1-queue.js', summaryFile: 's.json', infraFile: 'i.txt', notes: 'n', durationS: 120, warmupS: 30 };
    const on = collectArgs({ ...base, redisTls: true });
    assert.deepEqual(on.slice(on.indexOf('--redis-tls'), on.indexOf('--redis-tls') + 2), ['--redis-tls', 'true']);
    assert.ok(!on.includes('--paired-run'));
    const off = collectArgs({ ...base, redisTls: false, pairedRun: '2026-11-11-k2-v1-local-1k-r1' });
    assert.deepEqual(off.slice(-4), ['--redis-tls', 'false', '--paired-run', '2026-11-11-k2-v1-local-1k-r1']);
    assert.ok(!collectArgs(base).includes('--redis-tls'));
    assert.throws(() => collectArgs({ ...base, redisTls: 'true' }), /redisTls/);
  });
});

describe('run.mjs v1StageNotes(§3.10 notes에 적는 무대 사실)', () => {
  test('PRF215_notes는_합본·OTel이름·Redis TLS·빠진서비스대역·게이트웨이없음을_싣고_K7은반복안입장·K1은입장속도시드를_더한다', async () => {
    const { v1StageNotes } = await import('../run.mjs');
    const base = v1StageNotes({ scenario: 'seat-hold' }, { redisTls: false }).join('; ');
    for (const want of ['한 프로세스 합본', 'OTel 서비스 이름 bundle', 'Redis TLS 끔', 'trust-svc', 'identity-svc', 'ticket-svc', 'core-svc', '게이트웨이 없음']) assert.ok(base.includes(want), want);
    assert.ok(!base.includes('K7') && !base.includes('K1'));
    assert.match(v1StageNotes({ scenario: 'payment' }, { redisTls: true }).join('; '), /Redis TLS 켬.*K7: 가상 사용자마다 반복 안에서 진입·입장/);
    const k1 = v1StageNotes({ scenario: 'queue', admitPerSecond: 37 }, { redisTls: true, entry: { trials: 600, failed: 2 }, skipped: ['M1', 'P5', 'S3'] }).join('; ');
    assert.match(k1, /결제사 승인 상한 37\/s로 시드\(실행마다 다른 묶음 이름, 동시 입장 목표 상한 3330명/);
    // 코드 리뷰 M5·H3·H2: Q1의 1초 칸 너그러움, 진입 시행, SKIPPED 목록을 적는다
    assert.match(k1, /Q1은 서버의 1초 칸 serving 기록으로 견준다\(같은 초 안에서 차례보다 이른 입장은 놓친다/);
    assert.match(k1, /진입 시행 600건\(사전 검증 실패 포함 실패 2건\)/);
    assert.match(k1, /불변식 SKIPPED: M1·P5·S3/);
    // 코드 리뷰 M8: 정지 판정 입력이 없으면 정지 전이를 판정하지 못한다고 적는다
    assert.match(v1StageNotes({ scenario: 'payment' }, { redisTls: true, pause: { inputs: 'absent', newPaymentPaused503: 0 } }).join('; '), /정지 판정 입력\(kube_pod_status_ready\) 없음: 로컬 무대에서는 K7 ②의 정지 전이를 판정하지 못한다/);
  });
});

describe('run.mjs 합본 파드 안 스크립트(글로 넘기는 node 스크립트)', () => {
  test('PRF215_코드리뷰M4_측정 뒤 serving 기록을 읽는 스크립트는 Redis에 붙기를 v0 관리 스크립트와 같은 30초까지 기다린다', async () => {
    const { servingLogScriptV1 } = await import('../run.mjs');
    assert.match(servingLogScriptV1('0193a4b2-7c1a-7d3e-9f40-6b2a8c1d5e70'), /createHotRedis\(\{[^}]*startupTimeoutMs: 30000 \}\)/);
  });
  test('PRF215_serving 전진 기록·시뮬레이터 원장 스크립트는_문법이맞고_환경파일을_줄마다읽으며_결과줄하나를낸다', async () => {
    const { servingLogScriptV1, V1_LEDGER_SCRIPT } = await import('../run.mjs');
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    for (const [name, text] of [['serving', servingLogScriptV1('0193a4b2-7c1a-7d3e-9f40-6b2a8c1d5e70')], ['ledger', V1_LEDGER_SCRIPT()]]) {
      // import 줄을 빼고 함수 몸으로 읽어 문법만 본다(줄바꿈 이스케이프가 실제 줄바꿈이 되면 여기서 깨진다)
      assert.doesNotThrow(() => new AsyncFunction(text.replace(/^import .*$/gm, '')), name);
      assert.ok(text.includes(".split('\\n')"), `${name}: 환경 파일을 줄마다 나눈다(스크립트 글 안의 이스케이프로)`);
      assert.match(text, /@@RESULT /, name);
    }
    assert.match(servingLogScriptV1('0193a4b2-7c1a-7d3e-9f40-6b2a8c1d5e70'), /q:\{event:0193a4b2-7c1a-7d3e-9f40-6b2a8c1d5e70\}:serving_log/);
  });
});

// ─────────── 코드 리뷰 반영(BUILD_ORDER PRF-215): 재현 시험 ───────────

describe('runner/v1.mjs 코드 리뷰 반영', async () => {
  const v1r = await import('../runner/v1.mjs');

  test('PRF215_코드리뷰H2_불변식 SKIPPED가 정본의 기대 목록(S3·P5·M1~M5)과 다르면 문제로 돌려주고 목록을 적는다', () => {
    const head = 'id,name,sources,violations,unknown,result,as_of';
    const row = (id, result) => `${id},이름,src,${result === 'SKIPPED' ? '' : 0},${result === 'SKIPPED' ? '' : 0},${result},2026-11-10T00:00:00.000+09:00`;
    const ok = [head, ...['S1', 'S2', 'S4', 'P1', 'P2', 'P3', 'P4', 'P6', 'Q1', 'Q2'].map((id) => row(id, 'PASS')), ...['S3', 'P5', 'M1', 'M2', 'M3', 'M4', 'M5'].map((id) => row(id, 'SKIPPED'))].join('\n');
    assert.deepEqual(v1r.V1_EXPECTED_SKIPPED, ['M1', 'M2', 'M3', 'M4', 'M5', 'P5', 'S3']);
    assert.deepEqual(v1r.skippedProblem(ok), { skipped: ['M1', 'M2', 'M3', 'M4', 'M5', 'P5', 'S3'], problem: null });
    // P3가 표가 없어 SKIPPED면(리뷰 전 K7 ②) 문제다
    const p3 = ok.replace(row('P3', 'PASS'), row('P3', 'SKIPPED'));
    assert.match(v1r.skippedProblem(p3).problem, /기대와 다른 SKIPPED: 더 P3/);
    // 기대한 SKIPPED가 PASS면(원본이 생김) 그것도 알린다
    const s3 = ok.replace(row('S3', 'SKIPPED'), row('S3', 'PASS'));
    assert.match(v1r.skippedProblem(s3).problem, /덜 S3/);
  });

  test('PRF215_코드리뷰H3_진입 시행 수가 사용자 수보다 적으면 무효 사유이고, 진입 점검은 실패한 기록(사전 검증 실패 포함)까지 센다', () => {
    const rec = (i, result) => JSON.stringify({ kind: 'queue_entry', account_ref: `acc-lt-r-${i}`, result, seq: result === 'ok' ? i + 1 : null });
    const lines = [rec(0, 'ok'), rec(1, 'error'), rec(2, 'ok')];
    assert.deepEqual(v1r.entryTrials(lines, 3), { trials: 3, failed: 1, reasons: [] });
    assert.deepEqual(v1r.entryTrials(lines.slice(0, 2), 3).reasons, ['진입 시행 2/3건(사용자 수보다 적다)']);
    // 같은 사람의 기록이 두 번이면 한 번으로 센다(사람마다 진입 한 번)
    assert.equal(v1r.entryTrials([...lines, rec(2, 'ok')], 3).trials, 3);
    const checks = { checks: [{ name: 'entry_errors', allowed: 0.001, trials: 2, violations: 0, target: 'x' }, { name: 'entry_p99_200ms', allowed: 0.01, trials: 2, violations: 0, target: 'y' }] };
    const fixed = v1r.withEntryRecords(checks, v1r.entryTrials(lines, 3));
    assert.deepEqual(fixed.checks.find((c) => c.name === 'entry_errors'), { name: 'entry_errors', allowed: 0.001, trials: 3, violations: 1, target: 'x' });
    assert.equal(fixed.checks.find((c) => c.name === 'entry_p99_200ms').trials, 2);
  });

  test('PRF215_코드리뷰M7_serving 전진 기록(1초 칸) 변환은 칸 시작 ms와 그 칸의 마지막 serving이고 RESP2·RESP3·빈 값을 받는다', () => {
    const want = [{ atMs: 1_794_302_809_000, serving: 6 }, { atMs: 1_794_302_810_000, serving: 36 }];
    assert.deepEqual(v1r.servingLogFromZset(['1794302809', '6', '1794302810', '36']), want);
    assert.deepEqual(v1r.servingLogFromZset([['1794302810', 36], ['1794302809', 6]]), want);
    assert.deepEqual(v1r.servingLogFromZset({ 1794302809: '6', 1794302810: '36' }), want);
    assert.deepEqual(v1r.servingLogFromZset([]), []);
    assert.throws(() => v1r.servingLogFromZset(['x', '6']), RangeError);
    assert.throws(() => v1r.servingLogFromZset(['1794302809', 'NaN']), RangeError);
    // '칸 값 + 1 순번은 위반'은 실제 Q1 판정 경로(이 변환 → servingRecords → 검사기 parseRecords·Q1 SQL)로 본다:
    // services/invariant-checker/test-int/invariants.int.test.ts 'PRF215_재확인9_…'(실제 PostgreSQL, 재확인 리뷰 9)
  });

  test('PRF215_코드리뷰M9_TLS를 끈 무대에서 K1·K7 ② 기록은 거부하고, 짝 실행은 좌석 홀드에만 받는다', () => {
    assert.match(v1r.v1RecordProblem({ scenario: 'queue', record: true }, { redisTls: false }), /K1.*TLS 켬/);
    assert.match(v1r.v1RecordProblem({ scenario: 'payment', record: true }, { redisTls: false }), /K7.*TLS 켬/);
    assert.equal(v1r.v1RecordProblem({ scenario: 'queue', record: false }, { redisTls: false }), null);
    assert.equal(v1r.v1RecordProblem({ scenario: 'seat-hold', record: true }, { redisTls: false }), null);
    assert.equal(v1r.v1RecordProblem({ scenario: 'queue', record: true }, { redisTls: true }), null);
  });

  test('PRF215_코드리뷰M1·M8_정지 기록을 못 읽었거나, 판정 입력이 없는데 새 결제 정지 503이 나면 무효 사유다', () => {
    assert.deepEqual(v1r.pauseReasons({ error: null, inputs: 'present', newPaymentPaused503: 0 }), []);
    assert.deepEqual(v1r.pauseReasons({ error: null, inputs: 'absent', newPaymentPaused503: 0 }), []);
    assert.deepEqual(v1r.pauseReasons({ error: null, inputs: 'absent', newPaymentPaused503: 3 }), ['정지 판정 입력이 없는데 새 결제 정지 503이 3건 났다(자기 파드 서킷만으로 멈춤, 측정 조건 밖)']);
    assert.deepEqual(v1r.pauseReasons({ error: 'logs: 시간 초과', inputs: 'present', newPaymentPaused503: 0 }), ['정지 기록을 모으지 못했다: logs: 시간 초과']);
  });

  test('PRF215_변이검토_코드리뷰M8_판정 입력을 확인하지 못했으면(unknown) 없는 것과 같이 보고 새 결제 정지 503이 나면 무효 사유다', () => {
    assert.deepEqual(v1r.pauseReasons({ error: null, inputs: 'unknown', newPaymentPaused503: 2 }), ['정지 판정 입력이 없는데 새 결제 정지 503이 2건 났다(자기 파드 서킷만으로 멈춤, 측정 조건 밖)']);
    assert.deepEqual(v1r.pauseReasons({ error: null, inputs: 'unknown', newPaymentPaused503: 0 }), []);
  });

  test('PRF215_변이검토_코드리뷰H3·M1_runV1은 진입 시행 부족과 정지 기록 사유를 발생기 판정에 무효로 합치고 그 판정으로 장부의 무효 사유를 준다(소스 확인, 행동은 리허설 e2e)', async () => {
    // runV1은 kind 무대가 있어야 돈다. 리허설 e2e는 유효한 실행만 보므로 사유를 버리는 결함을 여기서 막는다
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(REPO, 'loadtest', 'run.mjs'), 'utf8');
    const body = src.slice(src.indexOf('async function runV1('), src.indexOf('function putHostFile('));
    assert.match(body, /generator\.judge = \{ valid: false, reasons: \[\.\.\.generator\.judge\.reasons, \.\.\.entry\.reasons\] \}/, '진입 시행 사유');
    assert.match(body, /generator\.judge = \{ valid: false, reasons: \[\.\.\.generator\.judge\.reasons, \.\.\.why\] \}/, '정지 기록 사유');
    assert.ok(body.lastIndexOf("writeFileSync(join(outDir, 'generator.json')") > body.indexOf('...entry.reasons'), '합친 뒤 generator.json을 다시 쓴다');
    assert.match(body, /\.\.\.\(g\.judge\.valid \? \{\} : \{ invalidReason: g\.judge\.reasons\.join\('; '\) \}\)/, '장부의 무효 사유');
  });

  test('PRF215_변이검토_코드리뷰H3_한 사람의 기록에 실패와 성공이 함께 있으면(다시 진입) 차례와 상관없이 성공 한 번으로 센다', () => {
    const rec = (i, result) => JSON.stringify({ kind: 'queue_entry', account_ref: `acc-lt-r-${i}`, result, seq: result === 'ok' ? i + 1 : null });
    assert.deepEqual(v1r.entryTrials([rec(5, 'error'), rec(5, 'ok'), rec(6, 'ok'), rec(6, 'error'), rec(7, 'error')], 3), { trials: 3, failed: 1, reasons: [] });
  });

  test('PRF215_코드리뷰H1_실행의 결제사 묶음 이름은 lt-<실행 꼬리표>이고 다른 진행 중 회차가 있으면 문제다', () => {
    assert.equal(v1r.stagePgKey('mwah7w0a30bd'), 'lt-mwah7w0a30bd');
    assert.throws(() => v1r.stagePgKey('BAD!'));
    assert.equal(v1r.activeEventsProblem([], 'e1'), null);
    assert.equal(v1r.activeEventsProblem(['e1'], 'e1'), null);
    assert.match(v1r.activeEventsProblem(['e0', 'e1'], 'e1'), /진행 중인 다른 회차 1개.*e0.*cleanup/);
  });
});

describe('runner/args.mjs 코드 리뷰 반영', () => {
  test('PRF215_코드리뷰낮음_장애비율 소수는 v1에서만 받고 v0는 정수만이다', () => {
    assert.throws(() => parseArgs(['v0', 'payment', '--users', '3000', '--rate', '20', '--fault-delay-pct', '0.5']), (e) => e instanceof UsageError && /정수/.test(e.message));
    assert.equal(parseArgs(['v0', 'payment', '--users', '3000', '--rate', '20', '--fault-delay-pct', '2']).faultDelayPct, 2);
    assert.equal(parseArgs(['v1', 'payment', '--users', '3000', '--rate', '20', '--fault-delay-pct', '0.5']).faultDelayPct, 0.5);
  });

  test('PRF215_코드리뷰M9_--paired-run은 v1 seat-hold에서 --record와 함께만 받는다', () => {
    const ok = parseArgs(['v1', 'seat-hold', '--users', '100', '--rate', '20', '--record', '--invariants', '--run-id', '2026-11-11-k2-v1-local-1k-tls-r1', '--paired-run', '2026-11-11-k2-v1-local-1k-notls-r1']);
    assert.equal(ok.pairedRun, '2026-11-11-k2-v1-local-1k-notls-r1');
    for (const bad of [
      ['v1', 'seat-hold', '--users', '100', '--rate', '20', '--paired-run', '2026-11-11-x'],
      ['v1', 'queue', '--users', '100', '--entry-rate', '10', '--admit-per-second', '5', '--record', '--invariants', '--run-id', '2026-11-11-k1', '--paired-run', '2026-11-11-x'],
      ['v0', 'seat-hold', '--users', '100', '--rate', '20', '--record', '--run-id', '2026-11-11-k2', '--paired-run', '2026-11-11-x'],
      ['v1', 'seat-hold', '--users', '100', '--rate', '20', '--record', '--invariants', '--run-id', '2026-11-11-k2', '--paired-run', 'BAD ID'],
    ]) assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
  });
});

describe('v1-payment.js 결제 확정 시간(코드 리뷰 M6, k6를 가짜 서버에 돌린다)', { skip: SKIP }, () => {
  test('PRF215_코드리뷰M6_결제 결과가 끝 상태가 아닌 빠른 답으로 끝나면 route:payment 목표를 넘은 것으로 세고, 결제 확정 시간은 접수 시작부터 잰다', async () => {
    const { createServer } = await import('node:http');
    const { mkdtempSync, readFileSync: read, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const jwt = `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ jti: '01934b2e-7c1a-7d3e-9f40-6b2a8c1d5e70' })).toString('base64url')}.c2ln`;
    let seq = 0;
    let statusCalls = 0;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const u = req.url ?? '';
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(obj === undefined ? '' : JSON.stringify(obj));
        };
        if (u.includes('pre-verifications')) return send(201, { preverifyToken: 'pv' });
        if (u.includes('/entries')) return send(201, { queueTicket: `t${++seq}`, seq, generation: 1, segment: 0 });
        if (u.includes('segment-states')) return send(200, { serving: 1_000_000, pollHintMs: 200 });
        if (u.includes('/admission')) return send(200, { status: 'ADMITTED', admissionToken: jwt });
        if (u.includes('seatmap-snapshot')) return send(200, {});
        if (u.includes('/holds')) return send(201, { holdId: 'h1' });
        if (u.endsWith('/v1/orders')) return send(201, { orderId: 'o1', amount: 1000 });
        if (u.endsWith('/payments')) return send(201, { attemptId: 'a1', pg: 'SIMULATOR', checkout: { orderId: 'o1', amount: 1000, orderName: 'x' } });
        if (u.includes('/sim/authenticate')) return send(200, { paymentKey: 'pk' });
        if (u.includes('/sim/faults')) return send(204);
        if (u.includes('payment-acceptance')) return send(202);
        // 끝 상태가 아닌 빠른 답(기다림 없이 ACCEPTED)
        if (u.includes('payment-status')) return statusCalls++, send(200, { status: 'ACCEPTED' });
        return send(404, {});
      });
    });
    await new Promise((r) => server.listen(0, '0.0.0.0', r));
    const port = server.address().port;
    const out = mkdtempSync(join(tmpdir(), 'v1-m6-'));
    try {
      const base = `http://host.docker.internal:${port}`;
      const env = { ...ENV, QUEUE_BASE: base, STATE_BASE: base, PURCHASE_BASE: base, SIM_URL: base, OUT_DIR: '/out', USERS: 40, RATE: 2, WARM_S: 1, MAIN_S: 5, PRE_VUS: 4, MAX_VUS: 8, FAULT_DROP_PCT: '0', FAULT_DELAY_PCT: '0', ADMIT_WAIT_S: 10 };
      const args = ['run', '--rm', ...K6_USER, '--add-host=host.docker.internal:host-gateway', '--mount', `type=bind,source=${HOST_REPO},target=/repo,readonly`, '--mount', `type=bind,source=${out.replaceAll('\\', '/')},target=/out`, '-w', '/repo', K6_IMAGE, 'run', '--quiet', '--no-usage-report'];
      for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
      args.push('loadtest/scenarios/v1-payment.js');
      await new Promise((ok, no) => {
        const child = spawn('docker', args, { env: DOCKER_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => (err += d));
        child.on('exit', (code) => (code === 0 || code === 99 ? ok() : no(new Error(`k6 ${code}: ${err.slice(-1500)}`))));
      });
      const m = JSON.parse(read(join(out, 'summary.json'), 'utf8')).metrics;
      const trials = m['http_reqs{phase:main,route:payment}']?.values?.count ?? 0;
      assert.ok(trials >= 8, `본구간 결제 접수 ${trials}건`);
      assert.ok(statusCalls >= trials * 4, '끝 상태가 아니면 3초까지 다시 묻는다');
      // 모든 결제가 끝 상태 없이 끝났다. 드레인 규칙에서는 끝 상태가 아닌 결제가 모두 위반이고,
      // 가짜 서버가 빨라 드레인까지 간 결제는 없다(BAT-511).
      assert.equal(m['payment_pending_before_3s{phase:main}']?.values?.count ?? 0, 0, '3초 전에 포기한 결제 없음');
      assert.equal(m['payment_pending_after_3s{phase:main}']?.values?.count, trials, '3초가 지나도 비끝인 결제');
      assert.equal(m['payment_pending_last_status{phase:main,status:ACCEPTED}']?.values?.count, trials);
      assert.ok((m['payment_status_calls{phase:main}']?.values?.med ?? 0) >= 4, '결제마다 여러 번 묻는다');
      assert.equal(m['over_target{phase:main,route:payment,le:3000}']?.values?.count, trials);
      // 본구간 끝 무렵에 시작한 결제는 3초 폴링 때문에 드레인으로 넘어간다. 모두 비끝 상태라 위반으로 센다.
      const drainFinished = m['payment_drain_finished{phase:main}']?.values?.count ?? 0;
      assert.ok(drainFinished >= 0);
      assert.equal(m['payment_drain_finished_terminal{phase:main}']?.values?.count ?? 0, 0);
      assert.equal(m['payment_drain_finished_pending{phase:main}']?.values?.count ?? 0, drainFinished);
      assert.equal(m['payment_drain_unfinished{phase:main}']?.values?.count ?? 0, 0);
      assert.equal(m['payment_started{phase:main}']?.values?.count, trials);
      assert.equal(m['payment_finished{phase:main}']?.values?.count, trials);
      assert.equal(m['payment_accept_status{phase:main,status:202}']?.values?.count, trials);
      assert.equal(m['payment_outcomes{phase:main,status:PENDING}']?.values?.count, trials);
      assert.ok(Number.isFinite(m['payment_confirm_ms{phase:main}']?.values?.['p(99)']), '결제 확정 시간 지표');
    } finally {
      server.close();
      rmSync(out, { recursive: true, force: true });
    }
  });
});

// ─────────── 재확인 리뷰(측정 도구의 가짜 통과 길, BUILD_ORDER PRF-215, 2026-11-10) ───────────

describe('재확인 리뷰: 판정·기록 쪽 가짜 통과', async () => {
  const v1r = await import('../runner/v1.mjs');
  const lib = await import('../lib/v1.mjs');
  const csvOf = (skipped) => ['id,name,sources,violations,unknown,result,as_of', ...['Q1', 'S1', 'S3', 'P3', 'P5', 'M1', 'M2', 'M3', 'M4', 'M5'].map((id) => `${id},x,y,0,0,${skipped.includes(id) ? 'SKIPPED' : 'PASS'},t`)].join('\n');

  test('PRF215_재확인1_SKIPPED가 기대 목록과 다르면 장부 판정이 무효이고 collect 인자에 --invalid-reason이 실린다', async () => {
    const { collectArgs } = await import('../runner/results.mjs');
    const bad = v1r.skippedProblem(csvOf(['S3', 'P3', 'P5', 'M1', 'M2', 'M3', 'M4', 'M5']));
    assert.ok(bad.problem);
    const judge = v1r.v1LedgerJudge({ valid: true, reasons: [] }, { skipped: bad });
    assert.equal(judge.valid, false);
    assert.match(judge.reasons.join('; '), /기대와 다른 SKIPPED: 더 P3/);
    const args = collectArgs({ runId: '2026-11-10-k7-v1-local-1k', kpi: 'K7', version: 'v1', profile: 'local-1k', durationS: 60, warmupS: 5, scenario: 'loadtest/scenarios/v1-payment.js', summaryFile: 's.json', infraFile: 'i.txt', notes: 'n', ...(judge.valid ? {} : { invalidReason: judge.reasons.join('; ') }) });
    assert.match(args[args.indexOf('--invalid-reason') + 1], /SKIPPED/);
    // 기대 목록 그대로면 판정을 바꾸지 않는다. 진입 시행·정지 기록 사유도 같은 길로 더한다
    const ok = v1r.skippedProblem(csvOf(['S3', 'P5', 'M1', 'M2', 'M3', 'M4', 'M5']));
    assert.deepEqual(v1r.v1LedgerJudge({ valid: true, reasons: [] }, { skipped: ok }), { valid: true, reasons: [] });
    assert.deepEqual(v1r.v1LedgerJudge({ valid: false, reasons: ['발생기'] }, { entry: { reasons: ['진입 시행 2/3건'] }, pause: ['정지 기록'] }).reasons, ['발생기', '진입 시행 2/3건', '정지 기록']);
  });

  test('PRF215_재확인1_run.mjs의 v1 장부 기록은 불변식 뒤에 v1LedgerJudge로 다시 판정한 결과로 invalidReason을 낸다', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'run.mjs'), 'utf8');
    const v1 = src.slice(src.indexOf('async function runV1('), src.indexOf('async function runCleanup') > src.indexOf('async function runV1(') ? src.indexOf('async function runCleanup') : undefined);
    const inv = v1.indexOf('skippedProblem(');
    const judged = v1.indexOf('v1LedgerJudge(', inv);
    const record = v1.indexOf('collectArgs(', judged);
    assert.ok(inv > 0 && judged > inv && record > judged, '불변식 → 다시 판정 → 기록 차례');
  });

  test('PRF215_재확인2_사전 검증이 모두 실패해 진입 요청이 0건이어도 진입 오류율 점검을 기록으로 만든다', () => {
    const entry = { trials: 3, failed: 3, reasons: [] };
    assert.deepEqual(v1r.withEntryRecords(null, entry), { checks: [{ name: 'entry_errors', allowed: 0.001, trials: 3, violations: 3, target: 'entry 오류율 < 0.1%' }] });
    const other = { checks: [{ name: 'status_errors', allowed: 0.001, trials: 9, violations: 0, target: 's' }] };
    assert.deepEqual(v1r.withEntryRecords(other, entry).checks.map((c) => [c.name, c.trials, c.violations]), [['status_errors', 9, 0], ['entry_errors', 3, 3]]);
  });

  test('PRF215_재확인3_결제 결과 끝 상태에 거쳐 가는 UNKNOWN은 없다(끝 상태까지 더 묻는다)', () => {
    assert.deepEqual([...lib.PAYMENT_TERMINAL].sort(), ['AWAITING_DEPOSIT', 'COMPENSATED', 'CONFIRMED', 'FAILED']);
    assert.ok(!lib.PAYMENT_TERMINAL.includes('UNKNOWN'));
  });

  test('PRF215_재확인4_결제 정지 503은 실행 시작 때 값을 빼 이 실행 몫만 센다(앞 실행·새로 생긴 파드 포함)', () => {
    const row = (pod, v) => ({ metric: { pod, outcome: 'new_payment_paused' }, value: [1, String(v)] });
    // 파드 a는 앞 실행에서 5건, 이번에 8까지. 파드 b는 이번에 생겨 2건. 시작 때 없던 파드는 전부 이번 몫
    assert.equal(v1r.pausedDelta([row('a', 5)], [row('a', 8), row('b', 2)]), 5);
    assert.equal(v1r.pausedDelta([row('a', 5)], [row('a', 5)]), 0);
    assert.equal(v1r.pausedDelta([], []), 0);
  });

  test('PRF215_재확인6_사전 검증 201인데 토큰이 없으면 성공이 아니다', () => {
    assert.equal(lib.preverifyResult(201, 'pv-token'), 'ok');
    assert.equal(lib.preverifyResult(201, undefined), 'unknown');
    assert.equal(lib.preverifyResult(429, undefined), 'fail');
    assert.equal(lib.preverifyResult(503, undefined), 'unknown');
  });

  test('PRF215_재확인7_결제 원본 검색 경로는 public이 먼저라 진짜 결제 취소 표가 생기면 빈 검사 뷰가 가리지 않는다', () => {
    assert.equal(v1r.v1PaymentDbUrl('postgres://u:p@127.0.0.1:5432/v1_payment'), 'postgres://u:p@127.0.0.1:5432/v1_payment?options=-c%20search_path%3Dpublic%2Cv1_check');
  });

  test('PRF215_재확인8_리더 임대 보유자를 못 읽으면 삼키지 않고 오류를 적는다', async () => {
    const r = await v1r.readLeaseHolders(['admission-ctrl', 'payment-entry-pause'], async (name) => {
      if (name === 'payment-entry-pause') throw new Error('leases.coordination.k8s.io "payment-entry-pause" not found');
      return 'bundle-x-1\n';
    });
    assert.deepEqual(r.holders, { 'admission-ctrl': 'bundle-x-1', 'payment-entry-pause': null });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /payment-entry-pause: .*not found/);
  });
});

describe('재확인 리뷰: 인자', () => {
  test('PRF215_재확인10_v1에서 --record는 --invariants가 있어야 받는다', () => {
    assert.throws(() => parseArgs(['v1', 'seat-hold', '--users', '100', '--rate', '20', '--record', '--run-id', '2026-11-11-k2-v1-local-1k']), (e) => e instanceof UsageError && /--invariants/.test(e.message));
    assert.equal(parseArgs(['v1', 'seat-hold', '--users', '100', '--rate', '20', '--record', '--invariants', '--run-id', '2026-11-11-k2-v1-local-1k']).invariants, true);
  });
});

describe('재확인 리뷰: v1-payment.js가 UNKNOWN 뒤에도 끝 상태까지 묻는다(k6를 가짜 서버에 돌린다)', { skip: SKIP }, () => {
  test('PRF215_재확인3_결과 모름(UNKNOWN)을 두 번 받은 뒤 CONFIRMED면 결제는 CONFIRMED로 센다', async () => {
    const { createServer } = await import('node:http');
    const { mkdtempSync, readFileSync: read, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const jwt = `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ jti: '01934b2e-7c1a-7d3e-9f40-6b2a8c1d5e70' })).toString('base64url')}.c2ln`;
    let seq = 0;
    let orderNo = 0;
    const polls = new Map();
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        const u = req.url ?? '';
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(obj === undefined ? '' : JSON.stringify(obj));
        };
        if (u.includes('pre-verifications')) return send(201, { preverifyToken: 'pv' });
        if (u.includes('/entries')) return send(201, { queueTicket: `t${++seq}`, seq, generation: 1, segment: 0 });
        if (u.includes('segment-states')) return send(200, { serving: 1_000_000, pollHintMs: 200 });
        if (u.includes('/admission')) return send(200, { status: 'ADMITTED', admissionToken: jwt });
        if (u.includes('seatmap-snapshot')) return send(200, {});
        if (u.includes('/holds')) return send(201, { holdId: 'h1' });
        if (u.endsWith('/v1/orders')) return send(201, { orderId: `o${++orderNo}`, amount: 1000 });
        if (u.endsWith('/payments')) return send(201, { attemptId: 'a1', pg: 'SIMULATOR', checkout: { orderId: 'o', amount: 1000, orderName: 'x' } });
        if (u.includes('/sim/authenticate')) return send(200, { paymentKey: 'pk' });
        if (u.includes('/sim/faults')) return send(204);
        if (u.includes('payment-acceptance')) return send(202);
        if (u.includes('payment-status')) {
          const id = u.split('/')[3];
          const n = (polls.get(id) ?? 0) + 1;
          polls.set(id, n);
          return send(200, { status: n <= 2 ? 'UNKNOWN' : 'CONFIRMED' });
        }
        return send(404, {});
      });
    });
    await new Promise((r) => server.listen(0, '0.0.0.0', r));
    const port = server.address().port;
    const out = mkdtempSync(join(tmpdir(), 'v1-r2-'));
    try {
      const base = `http://host.docker.internal:${port}`;
      const env = { ...ENV, QUEUE_BASE: base, STATE_BASE: base, PURCHASE_BASE: base, SIM_URL: base, OUT_DIR: '/out', USERS: 40, RATE: 2, WARM_S: 1, MAIN_S: 5, PRE_VUS: 4, MAX_VUS: 8, FAULT_DROP_PCT: '0', FAULT_DELAY_PCT: '0', ADMIT_WAIT_S: 10 };
      const args = ['run', '--rm', ...K6_USER, '--add-host=host.docker.internal:host-gateway', '--mount', `type=bind,source=${HOST_REPO},target=/repo,readonly`, '--mount', `type=bind,source=${out.replaceAll('\\', '/')},target=/out`, '-w', '/repo', K6_IMAGE, 'run', '--quiet', '--no-usage-report'];
      for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
      args.push('loadtest/scenarios/v1-payment.js');
      await new Promise((ok, no) => {
        const child = spawn('docker', args, { env: DOCKER_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => (err += d));
        child.on('exit', (code) => (code === 0 || code === 99 ? ok() : no(new Error(`k6 ${code}: ${err.slice(-1500)}`))));
      });
      const m = JSON.parse(read(join(out, 'summary.json'), 'utf8')).metrics;
      const trials = m['http_reqs{phase:main,route:payment}']?.values?.count ?? 0;
      assert.ok(trials >= 8, `본구간 결제 접수 ${trials}건`);
      assert.equal(m['payment_outcomes{phase:main,status:CONFIRMED}']?.values?.count, trials, 'UNKNOWN 뒤 CONFIRMED까지 묻는다');
      assert.equal(m['payment_outcomes{phase:main,status:UNKNOWN}']?.values?.count ?? 0, 0);
    } finally {
      server.close();
      rmSync(out, { recursive: true, force: true });
    }
  });
});

// ─────────── 발생기 나누기(k6 실행 구간, BAT-025 측정에서 찾은 결함) ───────────

describe('발생기 나누기: 사용자 몫(lib/v1.mjs segmentUsers)', async () => {
  const lib = await import('../lib/v1.mjs');
  const { executionSegments } = await import('../runner/merge.mjs');

  test('PRF215_발생기나누기_실행 구간마다 사용자 몫이 겹치지 않고 빠짐없이 0~USERS를 덮는다(실행 도구가 주는 구간 글 그대로)', () => {
    assert.equal(typeof lib.segmentUsers, 'function', 'segmentUsers');
    for (const [users, n] of [[1000, 2], [1000, 3], [7, 3], [200, 2], [5, 1], [2, 2]]) {
      const ranges = executionSegments(n).map((s) => lib.segmentUsers(users, s.segment));
      assert.deepEqual(ranges[0][0], 0, `${users}/${n} 처음`);
      assert.deepEqual(ranges.at(-1)[1], users, `${users}/${n} 끝`);
      for (let k = 1; k < ranges.length; k++) assert.equal(ranges[k][0], ranges[k - 1][1], `${users}/${n} 이어짐`);
      const sizes = ranges.map(([a, b]) => b - a);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${users}/${n} 고르게 ${sizes}`);
    }
    // 구간이 없으면(발생기 하나) 전체
    assert.deepEqual(lib.segmentUsers(300, undefined), [0, 300]);
    assert.deepEqual(lib.segmentUsers(300, ''), [0, 300]);
    assert.deepEqual(lib.segmentUsers(300, '0.5:1'), [150, 300]);
    for (const bad of ['1/2', '1:1/2', '0:3/2', 'x:1', '-1/2:1']) assert.throws(() => lib.segmentUsers(300, bad), RangeError, bad);
  });
});

describe('발생기 나누기: v1-seat-hold.js를 실행 구간 둘로 돌린다(k6를 가짜 서버에)', { skip: SKIP }, () => {
  test('PRF215_발생기나누기_실행 구간 둘이 setup에서 저마다 제 몫의 사용자만 진입·입장시키고 홀드도 제 몫의 사용자로만 보낸다', async () => {
    const { createServer } = await import('node:http');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const USERS_N = 20;
    const jwt = `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ jti: '01934b2e-7c1a-7d3e-9f40-6b2a8c1d5e70' })).toString('base64url')}.c2ln`;
    const byAccount = new Map(Array.from({ length: USERS_N }, (_, i) => [v1AccountId(ENV.RUN_TAG, i), i]));
    /** 실행 구간 → { entries: 사용자 번호 목록, holds: 사용자 번호 집합 } */
    const seen = { g0: { entries: [], holds: new Set() }, g1: { entries: [], holds: new Set() } };
    let current = 'g0';
    let seq = 0;
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        const u = req.url ?? '';
        const who = byAccount.get(String(req.headers['x-user-id']));
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(obj === undefined ? '' : JSON.stringify(obj));
        };
        if (u.includes('pre-verifications')) return send(201, { preverifyToken: 'pv' });
        if (u.includes('/entries')) {
          seen[current].entries.push(who);
          return send(201, { queueTicket: `t${++seq}`, seq, generation: 1, segment: 0 });
        }
        if (u.includes('segment-states')) return send(200, { serving: 1_000_000, pollHintMs: 200 });
        if (u.includes('/admission')) return send(200, { status: 'ADMITTED', admissionToken: jwt });
        if (u.includes('seatmap-snapshot')) return send(200, {});
        if (u.includes('/holds')) {
          seen[current].holds.add(who);
          return send(201, { holdId: 'h1' });
        }
        return send(404, {});
      });
    });
    await new Promise((r) => server.listen(0, '0.0.0.0', r));
    const port = server.address().port;
    const out = mkdtempSync(join(tmpdir(), 'v1-seg-'));
    try {
      const base = `http://host.docker.internal:${port}`;
      for (const [g, segment] of [['g0', '0:1/2'], ['g1', '1/2:1']]) {
        current = g;
        const env = { ...ENV, QUEUE_BASE: base, STATE_BASE: base, PURCHASE_BASE: base, OUT_DIR: '/out', USERS: USERS_N, RATE: 8, WARM_S: 1, MAIN_S: 3, PRE_VUS: 4, MAX_VUS: 8, K6_EXECUTION_SEGMENT: segment, K6_EXECUTION_SEGMENT_SEQUENCE: '0,1/2,1' };
        const args = ['run', '--rm', ...K6_USER, '--add-host=host.docker.internal:host-gateway', '--mount', `type=bind,source=${HOST_REPO},target=/repo,readonly`, '--mount', `type=bind,source=${out.replaceAll('\\', '/')},target=/out`, '-w', '/repo'];
        for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
        // 실행 도구(runner/manifests.mjs RUN_SCRIPT_SPLIT)처럼 명령줄 인자로 준다(k6는 이 둘을 환경 값으로 읽지 않는다)
        args.push(K6_IMAGE, 'run', '--quiet', '--no-usage-report', '--execution-segment', segment, '--execution-segment-sequence', '0,1/2,1', 'loadtest/scenarios/v1-seat-hold.js');
        const code = await new Promise((ok) => {
          const child = spawn('docker', args, { env: DOCKER_ENV, stdio: ['ignore', 'ignore', 'pipe'] });
          child.stderr.on('data', () => {});
          child.on('exit', ok);
        });
        assert.ok(code === 0 || code === 99, `${g} k6 종료 코드 ${code}`);
      }
      const all = [...seen.g0.entries, ...seen.g1.entries].sort((a, b) => a - b);
      assert.deepEqual(all, Array.from({ length: USERS_N }, (_, i) => i), '사용자마다 진입 한 번(두 구간 합)');
      assert.deepEqual([...new Set(seen.g0.entries)].sort((a, b) => a - b), Array.from({ length: USERS_N / 2 }, (_, i) => i));
      for (const u of seen.g0.holds) assert.ok(u < USERS_N / 2, `g0 홀드 사용자 ${u}`);
      for (const u of seen.g1.holds) assert.ok(u >= USERS_N / 2, `g1 홀드 사용자 ${u}`);
      assert.ok(seen.g0.holds.size > 0 && seen.g1.holds.size > 0, '두 구간 모두 홀드를 보냈다');
    } finally {
      server.close();
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('발생기 나누기: v1-queue.js·v1-payment.js도 실행 구간 둘이 사용자를 겹치지 않게 나눈다(k6를 가짜 서버에)', { skip: SKIP }, () => {
  /** 시나리오를 실행 구간 둘로 차례로 돌리고 구간마다 진입한 사용자 번호를 돌려준다 */
  async function entriesBySegment(script, users, extra) {
    const { createServer } = await import('node:http');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const jwt = `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ jti: '01934b2e-7c1a-7d3e-9f40-6b2a8c1d5e70' })).toString('base64url')}.c2ln`;
    const byAccount = new Map(Array.from({ length: users }, (_, i) => [v1AccountId(ENV.RUN_TAG, i), i]));
    const seen = { g0: [], g1: [] };
    let current = 'g0';
    let seq = 0;
    let orderNo = 0;
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        const u = req.url ?? '';
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(obj === undefined ? '' : JSON.stringify(obj));
        };
        if (u.includes('pre-verifications')) return send(201, { preverifyToken: 'pv' });
        if (u.includes('/entries')) {
          seen[current].push(byAccount.get(String(req.headers['x-user-id'])));
          return send(201, { queueTicket: `t${++seq}`, seq, generation: 1, segment: 0 });
        }
        if (u.includes('segment-states')) return send(200, { serving: 1_000_000, pollHintMs: 200 });
        if (u.includes('/admission')) return send(200, { status: 'ADMITTED', admissionToken: jwt });
        if (u.includes('seatmap-snapshot')) return send(200, {});
        if (u.includes('/holds')) return send(201, { holdId: 'h1' });
        if (u.endsWith('/v1/orders')) return send(201, { orderId: `o${++orderNo}`, amount: 1000 });
        if (u.endsWith('/payments')) return send(201, { attemptId: 'a1', pg: 'SIMULATOR', checkout: { orderId: 'o', amount: 1000, orderName: 'x' } });
        if (u.includes('/sim/authenticate')) return send(200, { paymentKey: 'pk' });
        if (u.includes('/sim/faults')) return send(204);
        if (u.includes('payment-acceptance')) return send(202);
        if (u.includes('payment-status')) return send(200, { status: 'CONFIRMED' });
        return send(404, {});
      });
    });
    await new Promise((r) => server.listen(0, '0.0.0.0', r));
    const port = server.address().port;
    const out = mkdtempSync(join(tmpdir(), 'v1-seg2-'));
    try {
      const base = `http://host.docker.internal:${port}`;
      for (const [g, segment] of [['g0', '0:1/2'], ['g1', '1/2:1']]) {
        current = g;
        const env = { ...ENV, QUEUE_BASE: base, STATE_BASE: base, PURCHASE_BASE: base, SIM_URL: base, OUT_DIR: '/out', USERS: users, ...extra, K6_EXECUTION_SEGMENT: segment, K6_EXECUTION_SEGMENT_SEQUENCE: '0,1/2,1' };
        const args = ['run', '--rm', ...K6_USER, '--add-host=host.docker.internal:host-gateway', '--mount', `type=bind,source=${HOST_REPO},target=/repo,readonly`, '--mount', `type=bind,source=${out.replaceAll('\\', '/')},target=/out`, '-w', '/repo'];
        for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
        args.push(K6_IMAGE, 'run', '--quiet', '--no-usage-report', '--execution-segment', segment, '--execution-segment-sequence', '0,1/2,1', script);
        const code = await new Promise((ok) => {
          const child = spawn('docker', args, { env: DOCKER_ENV, stdio: ['ignore', 'ignore', 'ignore'] });
          child.on('exit', ok);
        });
        assert.ok(code === 0 || code === 99, `${script} ${g} k6 종료 코드 ${code}`);
      }
      return seen;
    } finally {
      server.close();
      rmSync(out, { recursive: true, force: true });
    }
  }

  test('PRF215_발생기나누기_v1-queue.js는 실행 구간 둘이 사용자를 한 번씩만 진입시킨다', async () => {
    const seen = await entriesBySegment('loadtest/scenarios/v1-queue.js', 20, { ENTRY_RATE: 10, ADMIT_PER_SECOND: 5, WARM_S: 1, MAIN_S: 2, PRE_VUS: 4, MAX_VUS: 8 });
    assert.deepEqual([...seen.g0, ...seen.g1].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
    assert.ok(seen.g0.length > 0 && seen.g1.length > 0, '두 구간 모두 진입시켰다');
  });

  test('PRF215_발생기나누기_v1-payment.js는 실행 구간 둘이 같은 사용자를 두 번 쓰지 않는다', async () => {
    const seen = await entriesBySegment('loadtest/scenarios/v1-payment.js', 40, { RATE: 4, WARM_S: 1, MAIN_S: 4, PRE_VUS: 4, MAX_VUS: 8, FAULT_DROP_PCT: '0', FAULT_DELAY_PCT: '0', ADMIT_WAIT_S: 10 });
    const all = [...seen.g0, ...seen.g1];
    assert.ok(all.length >= 10, `진입 ${all.length}건`);
    assert.equal(new Set(all).size, all.length, `두 구간에서 겹친 사용자가 없다: g0 ${seen.g0.join(',')} g1 ${seen.g1.join(',')}`);
    assert.ok(!all.includes(undefined), '모든 진입이 사용자 번호로 읽힌다');
  });
});
