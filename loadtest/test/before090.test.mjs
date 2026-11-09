// BSL-090 Before 측정(docs/verification.md §3.10)의 순수 계산 시험. 각 export의 JSDoc을 명세로 보고 계약만 시험한다.
// 대상: loadtest/lib/targets.mjs(경로 목표·결제사 장애 배정), loadtest/runner/merge.mjs(발생기 나누기·합치기·점검 만들기),
//       loadtest/runner/probes.mjs(DB 통계 차이 K3·HPA 시간선 K9·검표 구간 K10·변경분 연결 K4), loadtest/runner/results.mjs(splitConsole의
//       검표 시도 줄, collectArgs의 BSL-090 인자), loadtest/k5/lab-summary.mjs(K5 랩 요약), loadtest/nightly/k6-args.mjs(야간 비교 실행 인자).
// 클러스터·Docker·네트워크는 건드리지 않는다(collect.py는 선언한 인자 이름을 읽고, 맨 끝의 장부 연결 시험만 OS 임시 폴더 루트로 부른다).
// JSDoc이 정하지 않은 것(결과 객체의 프로토타입, unmerged의 차례, results에 0인 결과 칸을 둘지, 요약 하나일 때 bounds에 min·max를 [값, 값]으로 둘지)은
// 어느 쪽이든 받도록 견준다.
// 실행: node --test loadtest/test/before090.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mainPhaseSummary } from '../lib/model.mjs';
import { ERROR_TARGETS, ROUTE_TARGETS, faultFor, overTargets, targetThresholds } from '../lib/targets.mjs';
import {
  ERROR_TARGETS as MERGE_ERROR_TARGETS,
  GENERATOR_RATE_CAP,
  ROUTE_TARGETS as MERGE_ROUTE_TARGETS,
  checksFromSummary,
  executionSegments,
  generatorCount,
  mergeSummaries,
} from '../runner/merge.mjs';
import { LAT_BOUNDS_MS, dbStatsDelta, deltaSummary, gateOnlineCheck, gateSummary, hpaTimeline, latencyBucket } from '../runner/probes.mjs';
import { collectArgs, splitConsole } from '../runner/results.mjs';
import { summarizeLab } from '../k5/lab-summary.mjs';
import { NIGHTLY_URL, namespaceFromUrl, parseK6Args } from '../nightly/k6-args.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');

// ---------------------------------------------------------------------------------------------
// 공통 도우미
// ---------------------------------------------------------------------------------------------

/**
 * 결과를 보통 객체·배열로 바꾼다. JSDoc은 Record 꼴만 정하므로 프로토타입 없는 객체(Object.create(null))로 돌려줘도 같은 값으로 본다.
 * 값(NaN·-0·undefined)은 그대로 둔다(JSON으로 돌리면 NaN이 null이 되어 틀린 값을 놓친다)
 */
function plain(x) {
  if (Array.isArray(x)) return x.map(plain);
  if (x !== null && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)]));
  return x;
}
const same = (actual, expected, msg) => assert.deepStrictEqual(plain(actual), expected, msg);
const rangeErr = (fn, label) => assert.throws(fn, RangeError, label);
/** 값이 undefined인 칸을 뺀다(marks.main_start?처럼 없거나 undefined면 같은 뜻) */
const norm = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
/** 0인 칸을 뺀다(검표 결과별 수에 0인 결과를 칸으로 둘지는 JSDoc이 정하지 않는다) */
const nonzero = (o) => Object.fromEntries(Object.entries(plain(o)).filter(([, v]) => v !== 0));
/** 메시지에 줄 번호 n이 독립된 수로 있는지(다른 수의 한 자리로 들어간 것은 세지 않는다) */
const mentionsNumber = (msg, n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(msg);
/** 입력을 바꾸면(엄격 모드라) TypeError가 나도록 얼린다 */
function deepFreeze(o) {
  if (o !== null && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------
// lib/targets.mjs: 경로 목표(§3.10 '경로 목표 점검')와 결제사 장애 배정(K7 ②)
// ---------------------------------------------------------------------------------------------

test('BSL090_Q-T2_대기열경로는_200ms보다_큰요청만_목표를넘은것으로센다', () => {
  // 대기열 세 경로(진입·대기 상태 조회·입장 확정)는 p99 ≤ 200ms이고 오류율 0.1% 미만이다
  for (const r of ['entry', 'status', 'admission']) {
    same(ROUTE_TARGETS[r], [{ le: 200, allowed: 0.01 }], r);
    assert.equal(ERROR_TARGETS[r], 0.001, r);
  }
  for (const r of ['entry', 'status', 'admission']) {
    same(overTargets(r, 0), [], `${r} 0ms`);
    same(overTargets(r, 199.999), [], `${r} 199.999ms`);
    same(overTargets(r, 200), [], `${r} 200ms는 목표와 같아 넘지 않는다`);
    same(overTargets(r, 200.001), [200], `${r} 200.001ms`);
    same(overTargets(r, 201), [200], `${r} 201ms`);
    same(overTargets(r, 59000), [200], `${r} 59초`);
  }
});

test('BSL090_S-T1_홀드는_p99_50ms와_p99.9_150ms두목표를센다', () => {
  // NFR-003: 홀드 p99 50ms 이하·p99.9 150ms 이하. 같은 경로의 목표는 le 오름차순이고, 홀드는 오류율 목표가 없다(409·422는 업무상 거절)
  same(ROUTE_TARGETS.hold, [{ le: 50, allowed: 0.01 }, { le: 150, allowed: 0.001 }]);
  assert.equal(Object.hasOwn(ERROR_TARGETS, 'hold'), false);
  same(overTargets('hold', 12.7), []);
  same(overTargets('hold', 50), [], '50ms는 같아 넘지 않는다');
  same(overTargets('hold', 50.01), [50]);
  same(overTargets('hold', 149.99), [50]);
  same(overTargets('hold', 150), [50], '150ms는 같아 넘지 않는다');
  // 둘 다 넘으면 둘 다 낸다(목록의 차례는 JSDoc이 정하지 않아 정렬해 견준다)
  const both = (ms) => {
    const r = overTargets('hold', ms);
    assert.ok(Array.isArray(r), '배열');
    return [...r].sort((x, y) => x - y);
  };
  same(both(150.5), [50, 150]);
  same(both(4000), [50, 150]);
});

test('BSL090_NFR-006_O-T1_결제확정은_p99_3000ms_검표는_p95_150ms목표로센다', () => {
  same(ROUTE_TARGETS.payment, [{ le: 3000, allowed: 0.01 }]);
  same(ROUTE_TARGETS.scan, [{ le: 150, allowed: 0.05 }]);
  same(Object.keys(ROUTE_TARGETS).sort(), ['admission', 'entry', 'hold', 'payment', 'scan', 'status']);
  same(Object.keys(ERROR_TARGETS).sort(), ['admission', 'entry', 'status']);
  assert.ok(Object.isFrozen(ROUTE_TARGETS) && Object.isFrozen(ERROR_TARGETS) && Object.isFrozen(ROUTE_TARGETS.hold) && Object.isFrozen(ROUTE_TARGETS.hold[1]));
  same(overTargets('payment', 812), []);
  same(overTargets('payment', 3000), []);
  same(overTargets('payment', 3000.5), [3000]);
  same(overTargets('scan', 150), []);
  same(overTargets('scan', 151), [150]);
});

test('BSL090_Q-T2_요청시간이_음수면0으로보고_유한한수가아니면_RangeError_목표없는경로는빈배열', () => {
  // VM 시계가 거꾸로 가 k6가 음수 시간을 낼 수 있다: 0으로 보므로 어떤 목표도 넘지 않는다
  same(overTargets('status', -3.2), []);
  same(overTargets('hold', -1e9), []);
  same(overTargets('hold', -0), []);
  // 목표가 없는 경로(해제·주문·시험 인증·주문 보기 등)와 객체 원형의 이름은 빈 배열이다
  for (const r of ['release', 'order', 'sim_auth', 'order_view', 'poll', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    same(overTargets(r, 99999), [], r);
  }
  for (const v of [NaN, Infinity, -Infinity, '300', null, undefined]) {
    rangeErr(() => overTargets('status', v), `status ${String(v)}`);
    rangeErr(() => overTargets('hold', v), `hold ${String(v)}`);
  }
  // 시간 검사는 경로와 상관없다: 목표가 없는 경로·객체 원형의 이름이라도 유한한 수가 아니면 RangeError
  for (const v of [NaN, Infinity, '300', undefined]) {
    rangeErr(() => overTargets('release', v), `release ${String(v)}`);
    rangeErr(() => overTargets('constructor', v), `constructor ${String(v)}`);
  }
});

test('BSL090_ADR-0077_targetThresholds_목표있는경로마다_over_target에_count>=0기준을걸고_목표없는경로는건너뛴다', () => {
  // k6는 기준(threshold)을 건 하위 지표만 요약에 남긴다(docs/perf-ledger.md §2.2 latency_crosscheck)
  same(targetThresholds(['hold', 'release']), {
    'over_target{phase:main,route:hold,le:50}': ['count>=0'],
    'over_target{phase:main,route:hold,le:150}': ['count>=0'],
  });
  same(targetThresholds(['entry', 'status', 'admission']), {
    'over_target{phase:main,route:entry,le:200}': ['count>=0'],
    'over_target{phase:main,route:status,le:200}': ['count>=0'],
    'over_target{phase:main,route:admission,le:200}': ['count>=0'],
  });
  same(targetThresholds(['order', 'sim_auth', 'payment', 'order_view']), { 'over_target{phase:main,route:payment,le:3000}': ['count>=0'] });
  same(targetThresholds(['scan']), { 'over_target{phase:main,route:scan,le:150}': ['count>=0'] });
  same(targetThresholds([]), {});
  same(targetThresholds(['release', 'order_view', 'poll_empty']), {});
  // 'constructor'는 객체 원형의 이름이지만 이름 규칙(lib/model.mjs ROUTE_PATTERN)에 맞고 목표가 없는 경로라 건너뛴다
  same(targetThresholds(['constructor']), {});
  same(targetThresholds(['constructor', 'hold', 'valueof']), {
    'over_target{phase:main,route:hold,le:50}': ['count>=0'],
    'over_target{phase:main,route:hold,le:150}': ['count>=0'],
  });
  // 규칙의 끝: 한 글자, 밑줄로 끝남, 32자(영소문자 하나 + 31자)는 이름으로 받는다(목표가 없어 건너뛴다)
  same(targetThresholds(['a', 'hold_', 'sim_auth_', 'a'.repeat(32), `h${'_'.repeat(31)}`]), {});
});

test('BSL090_ADR-0077_targetThresholds_경로이름이_ROUTE_PATTERN(영소문자로시작·영소문자·밑줄32자이하)에맞지않거나_겹치면_RangeError', () => {
  same(targetThresholds(['sim_auth', 'scan']), { 'over_target{phase:main,route:scan,le:150}': ['count>=0'] }); // 기준
  const bad = [['Hold'], ['hold-1'], ['hold2'], [''], ['ho ld'], ['hold}'], ['hold,le:1'], ['hold\n'], ['홀드'], ['ｈold'], [5], [null], [undefined],
    // 밑줄로 시작(객체 원형의 '__proto__'·'__defineGetter__' 포함), 대문자가 든 원형 이름, 33자
    ['__proto__'], ['__defineGetter__'], ['_hold'], ['_'], ['toString'], ['hasOwnProperty'], ['a'.repeat(33)], [`h${'_'.repeat(32)}`],
    // 앞의 이름이 맞아도 하나라도 어기면
    ['hold', 'scan', '__proto__']];
  for (const routes of bad) rangeErr(() => targetThresholds(routes), JSON.stringify(routes));
  rangeErr(() => targetThresholds(['hold', 'release', 'hold']), '같은 경로 두 번');
  rangeErr(() => targetThresholds(['release', 'release']), '목표가 없는 경로도 겹치면 안 된다');
});

test('BSL090_P-T1_결제사장애배정_100명마다_정확히dropPct명·delayPct명이다', () => {
  const tally = (n, drop, delay) => {
    const c = { drop: 0, delay: 0, none: 0 };
    for (let i = 0; i < n; i++) c[faultFor(i, drop, delay) ?? 'none'] += 1;
    return c;
  };
  same(tally(200, 5, 2), { drop: 10, delay: 4, none: 186 });
  // 칸 = i % 100: 칸 < 5는 drop, 5 ≤ 칸 < 7은 delay, 그 밖은 null
  same([0, 1, 4, 5, 6, 7, 99, 100, 104, 105, 106, 107, 199].map((i) => faultFor(i, 5, 2)),
    ['drop', 'drop', 'drop', 'delay', 'delay', null, null, 'drop', 'drop', 'delay', 'delay', null, null]);
  same(tally(100, 0, 0), { drop: 0, delay: 0, none: 100 });
  same(tally(100, 100, 0), { drop: 100, delay: 0, none: 0 });
  same(tally(100, 0, 100), { drop: 0, delay: 100, none: 0 });
  same(tally(300, 50, 50), { drop: 150, delay: 150, none: 0 });
  assert.equal(faultFor(49, 50, 50), 'drop');
  assert.equal(faultFor(50, 50, 50), 'delay');
  assert.equal(faultFor(1_000_000_003, 5, 2), 'drop');
  assert.equal(faultFor(1_000_000_006, 5, 2), 'delay');
  assert.equal(faultFor(Number.MAX_SAFE_INTEGER, 5, 2), null); // % 100 = 91
});

test('BSL090_P-T1_결제사장애배정_칸마다drop·delay·null이정해지고_어느자리에서시작한100명이든정확히그수다', () => {
  const pairs = [[0, 0], [1, 0], [0, 1], [1, 1], [5, 2], [33, 33], [37, 63], [99, 1], [1, 99], [99, 0], [0, 99], [100, 0], [0, 100], [50, 50]];
  for (const [drop, delay] of pairs) {
    // 칸 = i % 100: 칸 < drop → 'drop', drop ≤ 칸 < drop + delay → 'delay', 그 밖 → null(칸의 모든 값, 몇 바퀴째든 같다)
    for (let slot = 0; slot < 100; slot++) {
      const want = slot < drop ? 'drop' : slot < drop + delay ? 'delay' : null;
      for (const i of [slot, slot + 100, slot + 4_200, slot + 987_654_300]) assert.equal(faultFor(i, drop, delay), want, `i=${i} drop=${drop} delay=${delay}`);
    }
    for (const from of [0, 1, 57, 99, 12_345]) {
      const c = { drop: 0, delay: 0, none: 0 };
      for (let i = from; i < from + 100; i++) c[faultFor(i, drop, delay) ?? 'none'] += 1;
      same(c, { drop, delay, none: 100 - drop - delay }, `${from}번부터 100명, drop=${drop} delay=${delay}`);
    }
  }
});

test('BSL090_P-T1_결제사장애배정_i는0이상정수_비율은0~100정수이고합이100이하가아니면_RangeError', () => {
  assert.equal(faultFor(0, 60, 40), 'drop'); // 기준: 합이 100이면 받는다
  for (const i of [-1, 1.5, NaN, Infinity, '3', null, undefined]) rangeErr(() => faultFor(i, 5, 2), `i=${String(i)}`);
  for (const d of [-1, 101, 2.5, NaN, Infinity, -Infinity, '5', null, undefined]) rangeErr(() => faultFor(0, d, 0), `dropPct=${String(d)}`);
  for (const l of [-1, 101, 0.5, NaN, Infinity, '2', null, undefined]) rangeErr(() => faultFor(0, 0, l), `delayPct=${String(l)}`);
  rangeErr(() => faultFor(0, 60, 41), '합 101');
  rangeErr(() => faultFor(0, 100, 1), '합 101');
  rangeErr(() => faultFor(7, 1, 100), '합 101');
});

// ---------------------------------------------------------------------------------------------
// runner/merge.mjs: 발생기 나누기·합치기(§3.10 '발생기 나누기')와 점검 만들기('경로 목표 점검')
// ---------------------------------------------------------------------------------------------

test('BSL090_NFR-013_발생기나누기_발생기수는_⌈최대도착률÷1000⌉이다', () => {
  assert.equal(GENERATOR_RATE_CAP, 1000); // 2026-11-03 보정: CPU 4개 발생기 하나가 놓침 없이 보낸 도착률
  assert.equal(generatorCount(930), 1); // K1 local-10k 조회 약 930/s
  assert.equal(generatorCount(1000), 1);
  assert.equal(generatorCount(1000.5), 2);
  assert.equal(generatorCount(1001), 2);
  assert.equal(generatorCount(2000), 2); // 홀드 피크
  assert.equal(generatorCount(9300), 10); // K1 local-100k 조회 약 9,300/s
  assert.equal(generatorCount(0.5), 1);
  assert.equal(generatorCount(64000), 64);
  assert.equal(generatorCount(100000), 100);
  assert.equal(generatorCount(2000, 500), 4);
  assert.equal(generatorCount(2001, 500), 5);
  assert.equal(generatorCount(7, 1), 7);
  assert.equal(generatorCount(1, 1), 1);
  assert.equal(generatorCount(1500, undefined), 2, '상한을 빼면 1000');
  // 정확한 배수는 그 몫이고, 조금이라도 넘으면 하나 더(올림)
  assert.equal(generatorCount(999.9999), 1);
  assert.equal(generatorCount(1000.0001), 2);
  assert.equal(generatorCount(3000), 3);
  assert.equal(generatorCount(2999.9999), 3);
  assert.equal(generatorCount(3000.0001), 4);
  assert.equal(generatorCount(750, 250), 3);
  assert.equal(generatorCount(750.5, 250), 4);
  assert.equal(generatorCount(1, 1_000_000), 1);
  // 1 이상: 몫이 0으로 내려가는(÷1000이 0이 되는) 아주 작은 양수도 1대
  assert.equal(generatorCount(Number.MIN_VALUE), 1);
});

test('BSL090_NFR-013_발생기나누기_도착률이양의유한수가아니거나_상한이1이상정수가아니면_RangeError', () => {
  assert.equal(generatorCount(1), 1); // 기준
  for (const r of [0, -0, -1, -0.5, -Number.MIN_VALUE, NaN, Infinity, -Infinity, '1000', null, undefined]) rangeErr(() => generatorCount(r), `maxRate=${String(r)}`);
  for (const c of [0, -1, 0.5, 1.5, NaN, Infinity, -Infinity, '1000', '1', null]) rangeErr(() => generatorCount(1000, c), `cap=${String(c)}`);
});

test('BSL090_NFR-013_실행구간_n개의경계를_약분하지않은분수로쓴다', () => {
  same(executionSegments(1), [{ index: 0, segment: '0:1', sequence: '0,1' }]);
  same(executionSegments(2), [
    { index: 0, segment: '0:1/2', sequence: '0,1/2,1' },
    { index: 1, segment: '1/2:1', sequence: '0,1/2,1' },
  ]);
  same(executionSegments(3), [
    { index: 0, segment: '0:1/3', sequence: '0,1/3,2/3,1' },
    { index: 1, segment: '1/3:2/3', sequence: '0,1/3,2/3,1' },
    { index: 2, segment: '2/3:1', sequence: '0,1/3,2/3,1' },
  ]);
  const four = executionSegments(4);
  same(four.map((s) => s.segment), ['0:1/4', '1/4:2/4', '2/4:3/4', '3/4:1'], '2/4를 1/2로 줄이지 않는다');
  assert.ok(four.every((s) => s.sequence === '0,1/4,2/4,3/4,1'));
  same(executionSegments(6).map((s) => s.segment), ['0:1/6', '1/6:2/6', '2/6:3/6', '3/6:4/6', '4/6:5/6', '5/6:1'], '2/6·3/6·4/6도 줄이지 않는다');
  // n = 1~64 모두: 경계는 0, i/n(약분하지 않음), 1이고 구간 i는 i번째 경계 → i+1번째 경계, sequence는 모든 구간이 같다
  for (let n = 1; n <= 64; n++) {
    const b = (i) => (i === 0 ? '0' : i === n ? '1' : `${i}/${n}`);
    const sequence = Array.from({ length: n + 1 }, (_, i) => b(i)).join(',');
    same(executionSegments(n), Array.from({ length: n }, (_, i) => ({ index: i, segment: `${b(i)}:${b(i + 1)}`, sequence })), `n=${n}`);
  }
  const s64 = executionSegments(64);
  const seq64 = ['0', ...Array.from({ length: 63 }, (_, i) => `${i + 1}/64`), '1'].join(',');
  assert.equal(s64.length, 64);
  same(s64[0], { index: 0, segment: '0:1/64', sequence: seq64 });
  same(s64[32], { index: 32, segment: '32/64:33/64', sequence: seq64 });
  same(s64[63], { index: 63, segment: '63/64:1', sequence: seq64 });
  s64.forEach((s, i) => {
    assert.equal(s.index, i);
    assert.equal(s.sequence, seq64);
    // 이웃 구간은 이어진다(앞 구간의 끝 = 다음 구간의 시작)
    if (i > 0) assert.equal(s64[i - 1].segment.split(':')[1], s.segment.split(':')[0]);
  });
});

test('BSL090_NFR-013_실행구간_n이1~64정수가아니면_RangeError', () => {
  assert.equal(executionSegments(64).length, 64); // 기준
  for (const n of [0, 65, 1.5, -1, NaN, Infinity, '3', null, undefined]) rangeErr(() => executionSegments(n), String(n));
});

const META = (testRunDurationMs) => ({
  root_group: { name: '', path: '', id: 'd41d8cd98f00b204e9800998ecf8427e', groups: [], checks: [] },
  options: { summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'], summaryTimeUnit: '', noColor: false },
  state: { isStdOutTTY: false, isStdErrTTY: false, testRunDurationMs },
});
const counter = (count, rate) => ({ type: 'counter', values: { count, rate } });
const rateMetric = (passes, fails, rate) => ({ type: 'rate', values: { passes, fails, rate } });
const gauge = (value, min, max) => ({ type: 'gauge', values: { value, min, max } });
const trend = (values) => ({ type: 'trend', values });
const HOLD_REQS = 'http_reqs{phase:main,route:hold}';
const HOLD_OVER50 = 'over_target{phase:main,route:hold,le:50}';
const HOLD_OVER150 = 'over_target{phase:main,route:hold,le:150}';
const HOLD_FAILED = 'http_req_failed{phase:main,route:hold}';
const HOLD_DUR = 'http_req_duration{phase:main,route:hold}';

/** 홀드 피크를 발생기 셋(구간 0:1/3·1/3:2/3·2/3:1)으로 나눠 잰 요약(k6 handleSummary 꼴). le:150 넘음과 놓친 반복은 한 발생기에만 있다 */
const holdGenerators = () => [
  {
    ...META(92013.4),
    metrics: {
      [HOLD_REQS]: counter(40000, 434.75),
      [HOLD_OVER50]: counter(37, 0.5),
      [HOLD_FAILED]: rateMetric(3, 39997, 3 / 40000),
      [HOLD_DUR]: trend({ avg: 9.81, min: 1.204, med: 7.5, max: 310.4, 'p(90)': 18.2, 'p(95)': 24.75, 'p(99)': 48.9 }),
      vus: gauge(12, 1, 40),
      hold_histogram: { type: 'histogram', values: { buckets: 7 } },
      legacy_no_type: { values: { count: 5 } },
    },
  },
  {
    ...META(92010.7),
    metrics: {
      [HOLD_REQS]: counter(40002, 434.25),
      [HOLD_OVER50]: counter(41, 0.25),
      [HOLD_OVER150]: counter(2, 0.125),
      [HOLD_FAILED]: rateMetric(0, 40002, 0),
      [HOLD_DUR]: trend({ avg: 10.02, min: 0.951, med: 7.25, max: 286, 'p(90)': 19.5, 'p(95)': 23.5, 'p(99)': 52.3 }),
      vus: gauge(8, 2, 35),
      hold_histogram: { type: 'histogram', values: { buckets: 9 } },
      legacy_no_type: { values: { count: 6 } },
    },
  },
  {
    ...META(92020.1),
    metrics: {
      [HOLD_REQS]: counter(39998, 435),
      [HOLD_OVER50]: counter(30, 0.375),
      [HOLD_FAILED]: rateMetric(1, 39997, 1 / 39998),
      [HOLD_DUR]: trend({ avg: 9.5, min: 1, med: 7.75, max: 299.9, 'p(90)': 18, 'p(95)': 25, 'p(99)': 50.1 }),
      vus: gauge(10, 1, 38),
      dropped_iterations: counter(4, 0.0625),
      hold_histogram: { type: 'histogram', values: { buckets: 11 } },
      legacy_no_type: { values: { count: 7 } },
    },
  },
];

test('BSL090_NFR-013_발생기합치기_counter·rate·gauge·trend를합치고_모르는지표는첫요약값을두며_입력은바꾸지않는다', () => {
  const input = deepFreeze(holdGenerators());
  const snapshot = structuredClone(input);
  const r = mergeSummaries(input);
  assert.deepStrictEqual(input, snapshot, '입력을 바꾸지 않는다');
  const { merge: { unmerged, ...mergeRest }, ...top } = plain(r);
  same([...unmerged].sort(), ['hold_histogram', 'legacy_no_type'], 'type이 없거나 모르는 지표');
  same({ ...top, merge: mergeRest }, {
    ...META(92013.4), // 지표 밖 키는 첫 요약의 것
    metrics: {
      [HOLD_REQS]: counter(120000, 1304), // count·rate를 더한다
      [HOLD_OVER50]: counter(108, 1.125),
      [HOLD_OVER150]: counter(2, 0.125), // 지표 이름은 모든 요약의 합집합
      [HOLD_FAILED]: rateMetric(4, 119996, 4 / 120000), // rate = passes ÷ (passes + fails)
      // min은 가장 작은 값, max는 가장 큰 값, 나머지 통계는 가장 큰 값(위 한계)
      [HOLD_DUR]: trend({ avg: 10.02, min: 0.951, med: 7.75, max: 310.4, 'p(90)': 19.5, 'p(95)': 25, 'p(99)': 52.3 }),
      vus: gauge(30, 1, 113), // value·max는 더하고 min은 가장 작은 값
      dropped_iterations: counter(4, 0.0625),
      hold_histogram: { type: 'histogram', values: { buckets: 7 } }, // 첫 요약의 값 그대로
      legacy_no_type: { values: { count: 5 } },
    },
    merge: {
      generators: 3,
      // 나머지 통계마다 [가장 작은 값, 가장 큰 값](모든 요청을 합친 백분위는 그 사이). min·max는 정확하므로 없다
      bounds: { [HOLD_DUR]: { avg: [9.5, 10.02], med: [7.25, 7.75], 'p(90)': [18, 19.5], 'p(95)': [23.5, 25], 'p(99)': [48.9, 52.3] } },
    },
  });
});

test('BSL090_NFR-013_발생기합치기_요약이하나면_지표는그대로이고_bounds는trend통계마다[값,값]이다', () => {
  const STATUS_DUR = 'http_req_duration{phase:main,route:status}';
  const only = deepFreeze({
    ...META(91034.2),
    metrics: {
      [STATUS_DUR]: {
        type: 'trend', contains: 'time', values: { avg: 3.1, min: 0.8, med: 2.4, max: 95.2, 'p(95)': 7.9, 'p(99)': 14.6 }, thresholds: { 'max>=0': { ok: true } },
      },
      'http_reqs{phase:main,route:status}': { type: 'counter', contains: 'default', values: { count: 55800, rate: 620 } },
      'http_req_failed{phase:main,route:status}': { type: 'rate', contains: 'default', values: { rate: 0, passes: 0, fails: 55800 } },
      'over_target{phase:main,route:status,le:200}': { type: 'counter', contains: 'default', values: { count: 12, rate: 0.1328125 }, thresholds: { 'count>=0': { ok: true } } },
      vus: { type: 'gauge', contains: 'default', values: { value: 0, min: 0, max: 61 } },
    },
  });
  const r = mergeSummaries([only]);
  same(r.metrics, plain(only.metrics), '지표는 그 값 그대로');
  same(r.root_group, plain(only.root_group));
  same(r.options, plain(only.options));
  same(r.state, plain(only.state));
  assert.equal(r.merge.generators, 1);
  same(r.merge.unmerged, []);
  same(Object.keys(r.merge.bounds), [STATUS_DUR], 'bounds는 trend 지표에만');
  const values = only.metrics[STATUS_DUR].values;
  const b = r.merge.bounds[STATUS_DUR];
  for (const st of ['avg', 'med', 'p(95)', 'p(99)']) same(b[st], [values[st], values[st]], st);
  // min·max 칸은 합쳐도 정확해 bounds에 없어도 되고, 있다면 [값, 값]이다
  for (const [st, pair] of Object.entries(b)) {
    assert.ok(Object.hasOwn(values, st), `trend에 없는 통계: ${st}`);
    same(pair, [values[st], values[st]], st);
  }
});

test('BSL090_NFR-013_발생기합치기_실패율은passes÷(passes+fails)이고_둘다0이면0_빈목록은RangeError', () => {
  const a = {
    metrics: {
      'http_req_failed{phase:main,route:status}': rateMetric(0, 0, 0),
      'http_req_failed{phase:main,route:entry}': rateMetric(1, 3, 0.25),
      vus_max: gauge(400, 100, 400),
    },
  };
  const b = {
    metrics: {
      'http_req_failed{phase:main,route:status}': rateMetric(0, 0, 0),
      'http_req_failed{phase:main,route:entry}': rateMetric(0, 4, 0),
      vus_max: gauge(300, 50, 300),
    },
  };
  same(mergeSummaries([a, b]), {
    metrics: {
      'http_req_failed{phase:main,route:status}': rateMetric(0, 0, 0),
      'http_req_failed{phase:main,route:entry}': rateMetric(1, 7, 0.125),
      vus_max: gauge(700, 50, 700),
    },
    merge: { generators: 2, bounds: {}, unmerged: [] },
  });
  rangeErr(() => mergeSummaries([]), '빈 목록');
});

test('BSL090_NFR-013_발생기합치기_일부요약에만있는지표는_지표종류마다있는요약끼리합치고_bounds도그것끼리다', () => {
  const ENTRY_REQS = 'http_reqs{phase:main,route:entry}';
  const ENTRY_DUR = 'http_req_duration{phase:main,route:entry}';
  const ENTRY_FAILED = 'http_req_failed{phase:main,route:entry}';
  // 발생기마다 받은 요청·실패·가상 사용자가 달라 지표가 빠진 요약이 있다(빠진 것은 0이나 빈 값으로 셈하지 않는다)
  const input = deepFreeze([
    {
      ...META(60000.5),
      metrics: {
        [ENTRY_REQS]: counter(100, 1.5),
        [ENTRY_DUR]: trend({ avg: 4, min: 1, med: 3, max: 40, 'p(99)': 30 }),
        iteration_duration: trend({ avg: 50, min: 10, med: 45, max: 400, 'p(99)': 300 }),
        vus: gauge(5, 1, 9),
      },
    },
    {
      ...META(60001.25),
      metrics: {
        [ENTRY_REQS]: counter(200, 2.25),
        [ENTRY_FAILED]: rateMetric(1, 199, 0.005),
        iteration_duration: trend({ avg: 60, min: 8, med: 40, max: 500, 'p(99)': 350 }),
      },
    },
    {
      ...META(59999.75),
      metrics: {
        [ENTRY_DUR]: trend({ avg: 6, min: 0.5, med: 2, max: 35, 'p(99)': 33 }),
        [ENTRY_FAILED]: rateMetric(0, 50, 0),
        vus: gauge(7, 2, 12),
        scenario_errors: counter(3, 0.05),
      },
    },
  ]);
  const snapshot = structuredClone(input);
  const r = mergeSummaries(input);
  assert.deepStrictEqual(input, snapshot, '입력을 바꾸지 않는다');
  same(r, {
    ...META(60000.5),
    metrics: {
      [ENTRY_REQS]: counter(300, 3.75), // 첫째·둘째
      [ENTRY_DUR]: trend({ avg: 6, min: 0.5, med: 3, max: 40, 'p(99)': 33 }), // 첫째·셋째
      iteration_duration: trend({ avg: 60, min: 8, med: 45, max: 500, 'p(99)': 350 }), // 첫째·둘째
      [ENTRY_FAILED]: rateMetric(1, 249, 1 / 250), // 둘째·셋째
      vus: gauge(12, 1, 21), // 첫째·셋째
      scenario_errors: counter(3, 0.05), // 셋째에만
    },
    merge: {
      generators: 3,
      // trend 지표마다 따로, 그 지표가 있는 요약의 가장 작은 값·가장 큰 값
      bounds: {
        [ENTRY_DUR]: { avg: [4, 6], med: [2, 3], 'p(99)': [30, 33] },
        iteration_duration: { avg: [50, 60], med: [40, 45], 'p(99)': [300, 350] },
      },
      unmerged: [],
    },
  });
});

const Q_SUMMARY = Object.freeze({
  metrics: {
    'http_reqs{phase:main,route:entry}': counter(30000, 333.25),
    'over_target{phase:main,route:entry,le:200}': counter(12, 0.125),
    'http_req_failed{phase:main,route:entry}': rateMetric(2, 29998, 2 / 30000),
    // status: over_target·http_req_failed 지표가 없다(넘은 요청·실패가 없었다) → 어긴 수 0
    'http_reqs{phase:main,route:status}': counter(55800, 620),
    'http_req_duration{phase:main,route:status}': trend({ avg: 3.1, min: 0.8, med: 2.4, max: 95.2, 'p(95)': 7.9, 'p(99)': 14.6 }),
    'http_reqs{phase:main,route:admission}': counter(1680, 18.75),
    'over_target{phase:main,route:admission,le:200}': counter(0, 0),
    'http_req_failed{phase:main,route:admission}': rateMetric(1, 1679, 1 / 1680),
  },
});

test('BSL090_Q-T2_점검만들기_대기열경로는_p99_200ms와_오류율0.1%점검을낸다', () => {
  assert.equal(MERGE_ROUTE_TARGETS, ROUTE_TARGETS);
  assert.equal(MERGE_ERROR_TARGETS, ERROR_TARGETS);
  same(checksFromSummary(Q_SUMMARY, ['entry', 'status', 'admission']), {
    checks: [
      { name: 'entry_p99_200ms', allowed: 0.01, trials: 30000, violations: 12, target: 'entry p99 ≤ 200ms' },
      { name: 'entry_errors', allowed: 0.001, trials: 30000, violations: 2, target: 'entry 오류율 < 0.1%' },
      { name: 'status_p99_200ms', allowed: 0.01, trials: 55800, violations: 0, target: 'status p99 ≤ 200ms' },
      { name: 'status_errors', allowed: 0.001, trials: 55800, violations: 0, target: 'status 오류율 < 0.1%' },
      { name: 'admission_p99_200ms', allowed: 0.01, trials: 1680, violations: 0, target: 'admission p99 ≤ 200ms' },
      { name: 'admission_errors', allowed: 0.001, trials: 1680, violations: 1, target: 'admission 오류율 < 0.1%' },
    ],
  });
  // 경로마다 시간 목표 다음 오류율이고, 경로는 routes의 차례를 따른다
  same(checksFromSummary(Q_SUMMARY, ['admission', 'entry']).checks.map((c) => c.name),
    ['admission_p99_200ms', 'admission_errors', 'entry_p99_200ms', 'entry_errors']);
});

test('BSL090_S-T1_점검만들기_홀드는_p99_50ms·p999_150ms점검을내고_합친요약도된다', () => {
  const holdChecks = {
    checks: [
      { name: 'hold_p99_50ms', allowed: 0.01, trials: 120000, violations: 108, target: 'hold p99 ≤ 50ms' },
      { name: 'hold_p999_150ms', allowed: 0.001, trials: 120000, violations: 2, target: 'hold p999 ≤ 150ms' },
    ],
  };
  const s = {
    metrics: {
      [HOLD_REQS]: counter(120000, 1304),
      [HOLD_OVER50]: counter(108, 1.125),
      [HOLD_OVER150]: counter(2, 0.125),
      [HOLD_FAILED]: rateMetric(4, 119996, 4 / 120000), // 홀드는 오류율 목표가 없어 점검을 만들지 않는다
      'http_reqs{phase:main,route:release}': counter(119990, 1303.75), // 목표가 없는 경로
    },
  };
  same(checksFromSummary(s, ['hold', 'release']), holdChecks);
  // 발생기 셋을 합친 요약에서도 같은 점검이다(le:150 넘음은 한 발생기에만 있었다)
  same(checksFromSummary(mergeSummaries(holdGenerators()), ['hold', 'release']), holdChecks);
  // 넘은 요청이 없어 over_target 지표가 없으면 어긴 수는 0
  const fewer = { metrics: { [HOLD_REQS]: counter(500, 5.5), [HOLD_OVER50]: counter(1, 0.0125) } };
  same(checksFromSummary(fewer, ['hold']).checks.map((c) => [c.name, c.violations]), [['hold_p99_50ms', 1], ['hold_p999_150ms', 0]]);
});

test('BSL090_NFR-006_O-T1_점검만들기_결제확정p99_3000ms와_검표p95_150ms', () => {
  const s = {
    metrics: {
      'http_reqs{phase:main,route:order}': counter(6000, 66.75),
      'http_reqs{phase:main,route:sim_auth}': counter(6000, 66.75),
      'http_reqs{phase:main,route:payment}': counter(6000, 66.75),
      'over_target{phase:main,route:payment,le:3000}': counter(3, 0.03125),
      'http_req_failed{phase:main,route:payment}': rateMetric(5, 5995, 5 / 6000), // 결제 확정은 오류율 목표가 없다
      'http_reqs{phase:main,route:order_view}': counter(6000, 66.75),
      'http_reqs{phase:main,route:scan}': counter(3000, 50),
      'over_target{phase:main,route:scan,le:150}': counter(140, 2.25),
    },
  };
  same(checksFromSummary(s, ['order', 'sim_auth', 'payment', 'order_view', 'scan']), {
    checks: [
      { name: 'payment_p99_3000ms', allowed: 0.01, trials: 6000, violations: 3, target: 'payment p99 ≤ 3000ms' },
      { name: 'scan_p95_150ms', allowed: 0.05, trials: 3000, violations: 140, target: 'scan p95 ≤ 150ms' },
    ],
  });
});

test('BSL090_Q-T2_점검만들기_시행0인경로는빼고_어긴수는시행수로자르며_점검이없으면null', () => {
  const s = {
    metrics: {
      'http_reqs{phase:main,route:entry}': counter(0, 0), // 시행 0 → 점검 없음
      'over_target{phase:main,route:entry,le:200}': counter(5, 0.05),
      'http_reqs{phase:main,route:status}': counter(100, 1.25),
      'over_target{phase:main,route:status,le:200}': counter(120, 1.5), // k6 집계 경계 차이로 시행보다 많다 → 100으로 자른다
      'http_req_failed{phase:main,route:status}': rateMetric(101, 0, 1),
      'http_reqs{phase:main,route:release}': counter(50, 0.5), // 목표가 없는 경로
    },
  };
  // admission은 http_reqs 지표가 없다 → 점검 없음
  same(checksFromSummary(s, ['entry', 'status', 'admission', 'release']), {
    checks: [
      { name: 'status_p99_200ms', allowed: 0.01, trials: 100, violations: 100, target: 'status p99 ≤ 200ms' },
      { name: 'status_errors', allowed: 0.001, trials: 100, violations: 100, target: 'status 오류율 < 0.1%' },
    ],
  });
  assert.equal(checksFromSummary(s, ['entry']), null);
  assert.equal(checksFromSummary(s, ['entry', 'admission', 'release']), null);
  assert.equal(checksFromSummary(s, []), null);
  assert.equal(checksFromSummary({ metrics: {} }, ['status', 'hold']), null);
});

test('BSL090_S-T1_점검만들기_어긴수는목표마다따로자르고_목표가없는이름(객체원형의이름포함)은건너뛴다', () => {
  const s = {
    metrics: {
      [HOLD_REQS]: counter(10, 0.125),
      [HOLD_OVER50]: counter(11, 0.25), // 시행보다 많다 → 10으로 자른다
      [HOLD_OVER150]: counter(7, 0.125), // 시행보다 적다 → 그대로
      // 객체 원형의 이름으로 된 경로(목표가 없다): 지표가 있어도 점검을 만들지 않는다
      'http_reqs{phase:main,route:constructor}': counter(5, 0.5),
      'over_target{phase:main,route:constructor,le:200}': counter(5, 0.5),
      'http_req_failed{phase:main,route:constructor}': rateMetric(5, 0, 1),
      'http_reqs{phase:main,route:toString}': counter(5, 0.5),
      'http_reqs{phase:main,route:__proto__}': counter(5, 0.5),
    },
  };
  same(checksFromSummary(s, ['constructor', 'hold', 'toString', '__proto__', 'hasOwnProperty']), {
    checks: [
      { name: 'hold_p99_50ms', allowed: 0.01, trials: 10, violations: 10, target: 'hold p99 ≤ 50ms' },
      { name: 'hold_p999_150ms', allowed: 0.001, trials: 10, violations: 7, target: 'hold p999 ≤ 150ms' },
    ],
  });
  assert.equal(checksFromSummary(s, ['constructor', 'toString', '__proto__', 'valueOf']), null);
});

test('BSL090_NFR-003_발생기합치기_p(99.9)도_합친값은위한계이고_bounds에[아래,위]한계를둔다', () => {
  // §3.10 '발생기 나누기': 발생기마다 따로 나온 p99·p99.9는 합친 값의 아래·위 한계로 적는다(K2 홀드 p99.9 150ms, NFR-003)
  const g = (p99, p999) => ({ metrics: { [HOLD_DUR]: trend({ avg: 9, min: 1, med: 7, max: 400, 'p(95)': 25, 'p(99)': p99, 'p(99.9)': p999 }) } });
  const r = mergeSummaries([g(48.9, 141.2), g(52.3, 133.75), g(50.1, 162.4)]);
  assert.equal(r.metrics[HOLD_DUR].values['p(99.9)'], 162.4, '합친 p99.9는 위 한계(나쁜 쪽)');
  assert.equal(r.metrics[HOLD_DUR].values['p(99)'], 52.3, '합친 p99는 위 한계(나쁜 쪽)');
  same(r.merge.bounds[HOLD_DUR]['p(99.9)'], [133.75, 162.4]);
  same(r.merge.bounds[HOLD_DUR]['p(99)'], [48.9, 52.3]);
});

test('BSL090_NFR-013_발생기합치기_metrics가없는요약이하나라도있으면_빼고합치지않고RangeError', () => {
  // 발생기 하나의 요약이 깨졌는데 나머지만 더하면 요청 수·놓친 반복이 모자라게 장부에 남는다(§3.10 '발생기 나누기': 모두 더한다)
  const ok = { metrics: { dropped_iterations: counter(0, 0), 'http_reqs{phase:main}': counter(100, 1) } };
  assert.equal(mergeSummaries([ok, ok]).metrics['http_reqs{phase:main}'].values.count, 200); // 기준
  for (const bad of [{}, { metrics: null }, { metrics: [] }, { metrics: 'x' }, null, 'summary', []]) {
    rangeErr(() => mergeSummaries([ok, bad]), JSON.stringify(bad));
    rangeErr(() => mergeSummaries([bad, ok]), JSON.stringify(bad));
  }
});

test('BSL090_NFR-013_발생기합치기_요약차례와상관없이_놓친반복을더한다(mainPhaseSummary가채운대체칸이섞여도)', () => {
  // §3.10 '발생기 나누기': 요청 수·실패 수·놓친 반복·목표를 넘은 수는 더한다(하나라도 놓치면 무효, §3.5 2번).
  // 발생기 요약은 시나리오의 writeSummary(lib/model.mjs mainPhaseSummary)를 거친다. mainPhaseSummary는 JSDoc대로 dropped_iterations가 없는
  // 요약에 { values: { count: 0, rate: 0 } }(type 칸 없음)를 채운다. 그런 발생기가 첫째여도 다른 발생기의 놓침 4건이 합에서 빠지면 안 된다
  // (지금은 k6가 기준을 건 dropped_iterations를 늘 요약에 남겨 드러나지 않을 수 있지만, 합은 발생기 차례에 따라 달라지면 안 된다)
  const k6 = (count, dropped) => ({
    'http_reqs{phase:main}': counter(count, count / 92),
    ...(dropped === undefined ? {} : { dropped_iterations: counter(dropped, dropped / 92) }),
  });
  const clean = { metrics: mainPhaseSummary(k6(40000), 60) };
  const dropped = { metrics: mainPhaseSummary(k6(39996, 4), 60) };
  assert.equal(Object.hasOwn(clean.metrics.dropped_iterations, 'type'), false, '시험 전제: 대체 칸에는 type이 없다');
  for (const [label, order] of [['놓친 발생기가 첫째', [dropped, clean]], ['놓친 발생기가 둘째', [clean, dropped]]]) {
    const r = mergeSummaries(order);
    assert.equal(r.metrics.dropped_iterations?.values?.count, 4, `${label}: 합친 놓친 반복`);
    assert.equal(r.metrics.http_reqs.values.count, 79996, `${label}: 합친 본구간 요청 수`);
  }
});

test('BSL090_NFR-013_Q-T2_S-T1_경로목표점검은_발생기를몇으로나눠도_모든요청을한곳에서센것과같다', () => {
  // §3.10 '경로 목표 점검': 어긴 수는 목표 시간을 넘은 요청 수이고, 오류율 목표는 실패 수다. 이 수는 더할 수 있어 판정은 발생기를 나눠도 정확하다.
  // 요청마다 시나리오(scenarios/common.js call)처럼 overTargets로 over_target{route,le}를 세어 발생기마다 요약을 만들고, 합친 요약의 점검을
  // 모든 요청을 한곳에서 명세의 목표 시간(진입 200ms, 홀드 50·150ms)으로 직접 센 값과 견준다. 목표와 같은 시간은 넘지 않은 것이다
  let s = 20261103;
  const rnd = () => {
    // mulberry32(고정 씨앗이라 늘 같은 요청 묶음)
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const EDGE = [50, 150, 200, 50.001, 150.001, 200.001, 49.999, 199.999];
  const duration = () => (rnd() < 0.2 ? EDGE[Math.floor(rnd() * EDGE.length)] : -Math.log(1 - rnd()) * 40);
  for (const n of [1, 2, 3, 4, 7, 10, 64]) {
    const reqs = Array.from({ length: 3000 }, () => ({ route: rnd() < 0.5 ? 'entry' : 'hold', ms: duration(), failed: rnd() < 0.004, g: Math.floor(rnd() * n) }));
    const summaries = Array.from({ length: n }, (_, g) => {
      const mine = reqs.filter((q) => q.g === g);
      const metrics = {};
      for (const route of ['entry', 'hold']) {
        const rs = mine.filter((q) => q.route === route);
        const fails = rs.filter((q) => q.failed).length;
        metrics[`http_reqs{phase:main,route:${route}}`] = counter(rs.length, rs.length / 60);
        metrics[`http_req_failed{phase:main,route:${route}}`] = rateMetric(fails, rs.length - fails, rs.length ? fails / rs.length : 0);
        for (const le of ROUTE_TARGETS[route].map((t) => t.le)) {
          const over = rs.filter((q) => overTargets(route, q.ms).includes(le)).length;
          metrics[`over_target{phase:main,route:${route},le:${le}}`] = counter(over, over / 60);
        }
      }
      return { metrics };
    });
    const all = (route) => reqs.filter((q) => q.route === route);
    const over = (route, le) => all(route).filter((q) => q.ms > le).length;
    const entry = all('entry').length;
    const hold = all('hold').length;
    same(checksFromSummary(mergeSummaries(summaries), ['entry', 'hold', 'release']), {
      checks: [
        { name: 'entry_p99_200ms', allowed: 0.01, trials: entry, violations: over('entry', 200), target: 'entry p99 ≤ 200ms' },
        { name: 'entry_errors', allowed: 0.001, trials: entry, violations: all('entry').filter((q) => q.failed).length, target: 'entry 오류율 < 0.1%' },
        { name: 'hold_p99_50ms', allowed: 0.01, trials: hold, violations: over('hold', 50), target: 'hold p99 ≤ 50ms' },
        { name: 'hold_p999_150ms', allowed: 0.001, trials: hold, violations: over('hold', 150), target: 'hold p999 ≤ 150ms' },
      ],
    }, `발생기 ${n}대`);
  }
});

// ---------------------------------------------------------------------------------------------
// runner/probes.mjs: 지연 칸, DB 통계 차이(K3), HPA 시간선(K9), 검표 구간(K10), 변경분 연결(K4)
// ---------------------------------------------------------------------------------------------

test('BSL090_S-T12_지연칸_ms≤경계인가장작은칸이고_30초넘으면마지막칸_음수는0칸', () => {
  same([...LAT_BOUNDS_MS], [1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000, 30000]);
  assert.ok(Object.isFrozen(LAT_BOUNDS_MS));
  const cases = [
    [0, 0], [0.4, 0], [1, 0], [1.0001, 1], [2, 1], [2.5, 2], [5, 2], [7, 3], [10, 3], [20, 4], [49.9, 5], [50, 5], [100, 6], [150, 7],
    [200, 7], [200.1, 8], [300, 8], [300.0001, 9], [500, 9], [999, 10], [1000, 10], [2000, 11], [4999, 12], [5000, 12], [10000, 13],
    [30000, 14], [30000.1, 15], [86_400_000, 15],
  ];
  for (const [ms, i] of cases) assert.equal(latencyBucket(ms), i, `${ms}ms`);
  // 경계값은 그 칸에 든다(ms ≤ 경계). 칸 i는 (앞 경계, 경계 i]: 경계 바로 아래도 그 칸, 바로 위는 다음 칸이다
  LAT_BOUNDS_MS.forEach((bound, i) => {
    assert.equal(latencyBucket(bound), i, `경계 ${bound}ms`);
    assert.equal(latencyBucket(bound - 1e-6), i, `경계 ${bound}ms 바로 아래`);
    assert.equal(latencyBucket(bound + 1e-6), i + 1, `경계 ${bound}ms 바로 위`);
  });
  assert.equal(latencyBucket(Number.MIN_VALUE), 0);
  assert.equal(latencyBucket(Number.MAX_VALUE), LAT_BOUNDS_MS.length);
  for (const ms of [-0.001, -5, -30001, -0, -Number.MAX_VALUE]) assert.equal(latencyBucket(ms), 0, `음수 ${ms}ms(시계 차이)`);
  for (const v of [NaN, Infinity, -Infinity, '300', null, undefined]) rangeErr(() => latencyBucket(v), String(v));
});

const DB_AT = Date.parse('2026-11-03T10:20:00.000Z');
const DB_BEFORE = Object.freeze({
  atMs: DB_AT,
  database: { deadlocks: 2, xact_commit: 1048576, xact_rollback: 1200 },
  tables: {
    v0_hold: { n_tup_ins: 8000, n_tup_upd: 7600, n_tup_hot_upd: 7000, n_tup_del: 7500, n_live_tup: 500, n_dead_tup: 7400 },
    v0_payment: { n_tup_ins: 120, n_tup_upd: 240, n_tup_hot_upd: 200, n_tup_del: 0, n_live_tup: 120, n_dead_tup: 9 }, // 뒤에 없는 표
    v0_quota: { n_tup_ins: 1, n_tup_upd: 1000, n_tup_hot_upd: 1000, n_tup_del: 0, n_live_tup: 1, n_dead_tup: 0 },
    v0_seat: { n_tup_ins: 50000, n_tup_upd: 120000, n_tup_hot_upd: 90000, n_tup_del: 0, n_live_tup: 50000, n_dead_tup: 3100 },
    v0_seat_event: { n_tup_ins: 40000, n_tup_upd: 0, n_tup_hot_upd: 0, n_tup_del: 0, n_live_tup: 40000, n_dead_tup: 0 },
  },
});
const DB_AFTER = Object.freeze({
  atMs: DB_AT + 61234,
  database: { deadlocks: 3, xact_commit: 1108576, xact_rollback: 1450 },
  // 이름 순이 아닌 차례로 둔다
  tables: {
    v0_seat_event: { n_tup_ins: 52000, n_tup_upd: 0, n_tup_hot_upd: 0, n_tup_del: 0, n_live_tup: 52000, n_dead_tup: 0 },
    v0_seat: { n_tup_ins: 50000, n_tup_upd: 132003, n_tup_hot_upd: 98001, n_tup_del: 0, n_live_tup: 50000, n_dead_tup: 260 }, // 청소로 죽은 행이 줄었다
    v0_quota: { n_tup_ins: 1, n_tup_upd: 1400, n_tup_hot_upd: 1400, n_tup_del: 0, n_live_tup: 1, n_dead_tup: 12 },
    v0_order: { n_tup_ins: 3, n_tup_upd: 3, n_tup_hot_upd: 2, n_tup_del: 0, n_live_tup: 3, n_dead_tup: 3 }, // 앞에 없던 표 → 0에서
    v0_hold: { n_tup_ins: 14000, n_tup_upd: 13600, n_tup_hot_upd: 12999, n_tup_del: 13500, n_live_tup: 480, n_dead_tup: 9100 },
  },
});

test('BSL090_S-T10_DB통계차이_누적칸은뒤−앞이고_hotRatio는소수넷째자리_표는뒤에있는것만이름순', () => {
  const r = dbStatsDelta(structuredClone(DB_BEFORE), structuredClone(DB_AFTER));
  same(r, {
    durationS: 61.2, // 61,234ms
    deadlocks: 1,
    commits: 60000,
    rollbacks: 250,
    tables: {
      v0_hold: { inserts: 6000, updates: 6000, hotUpdates: 5999, deletes: 6000, hotRatio: 0.9998, liveRows: 480, deadRows: 9100 },
      v0_order: { inserts: 3, updates: 3, hotUpdates: 2, deletes: 0, hotRatio: 0.6667, liveRows: 3, deadRows: 3 },
      v0_quota: { inserts: 0, updates: 400, hotUpdates: 400, deletes: 0, hotRatio: 1, liveRows: 1, deadRows: 12 },
      v0_seat: { inserts: 0, updates: 12003, hotUpdates: 8001, deletes: 0, hotRatio: 0.6666, liveRows: 50000, deadRows: 260 },
      v0_seat_event: { inserts: 12000, updates: 0, hotUpdates: 0, deletes: 0, hotRatio: null, liveRows: 52000, deadRows: 0 },
    },
  });
  same(Object.keys(r.tables), ['v0_hold', 'v0_order', 'v0_quota', 'v0_seat', 'v0_seat_event'], '이름 순');
  // 실행 시간은 소수 첫째 자리
  const db = { deadlocks: 0, xact_commit: 10, xact_rollback: 0 };
  const span = (ms) => dbStatsDelta({ atMs: DB_AT, database: { ...db }, tables: {} }, { atMs: DB_AT + ms, database: { ...db }, tables: {} });
  same(span(90049), { durationS: 90, deadlocks: 0, commits: 0, rollbacks: 0, tables: {} });
  assert.equal(span(90051).durationS, 90.1);
});

test('BSL090_S-T10_DB통계차이_누적칸이줄었거나_수가0이상정수가아니면_RangeError', () => {
  assert.equal(dbStatsDelta(structuredClone(DB_BEFORE), structuredClone(DB_AFTER)).commits, 60000); // 기준
  const bad = [
    ['xact_commit이 줄었다(통계 초기화)', (b, a) => { a.database.xact_commit = b.database.xact_commit - 1; }],
    ['deadlocks가 줄었다', (b, a) => { a.database.deadlocks = 1; }],
    ['xact_rollback이 줄었다', (b, a) => { a.database.xact_rollback = 0; }],
    ['n_tup_ins가 줄었다', (b, a) => { a.tables.v0_hold.n_tup_ins = 7999; }],
    ['n_tup_upd가 줄었다', (b, a) => { a.tables.v0_seat.n_tup_upd = 119999; }],
    ['n_tup_hot_upd가 줄었다', (b, a) => { a.tables.v0_seat.n_tup_hot_upd = 89999; }],
    ['n_tup_del이 줄었다', (b, a) => { a.tables.v0_hold.n_tup_del = 7499; }],
    ['n_live_tup이 음수', (b, a) => { a.tables.v0_seat.n_live_tup = -1; }],
    ['xact_rollback이 소수', (b, a) => { a.database.xact_rollback = 1450.5; }],
    ['n_tup_ins가 글자', (b) => { b.tables.v0_hold.n_tup_ins = '8000'; }],
    ['n_dead_tup이 null', (b, a) => { a.tables.v0_hold.n_dead_tup = null; }],
    ['deadlocks가 NaN', (b, a) => { a.database.deadlocks = NaN; }],
    ['n_tup_upd가 Infinity', (b, a) => { a.tables.v0_order.n_tup_upd = Infinity; }],
    ['n_tup_hot_upd가 없다', (b, a) => { delete a.tables.v0_order.n_tup_hot_upd; }],
    // 앞(before)의 수도 0 이상 정수여야 한다(아래는 뒤 − 앞이 줄지 않아 줄어듦 검사로는 잡히지 않는다)
    ['before의 deadlocks가 음수', (b) => { b.database.deadlocks = -1; }],
    ['before의 xact_commit이 소수', (b) => { b.database.xact_commit = 1048575.5; }],
    ['before의 n_tup_upd가 소수', (b) => { b.tables.v0_seat.n_tup_upd = 119999.5; }],
    // 누적 칸이 아닌 liveRows·deadRows(뒤의 값)도 0 이상 정수
    ['n_live_tup이 소수', (b, a) => { a.tables.v0_quota.n_live_tup = 1.5; }],
    ['n_dead_tup이 Infinity', (b, a) => { a.tables.v0_seat_event.n_dead_tup = Infinity; }],
  ];
  for (const [label, mutate] of bad) {
    const b = structuredClone(DB_BEFORE);
    const a = structuredClone(DB_AFTER);
    mutate(b, a);
    rangeErr(() => dbStatsDelta(b, a), label);
  }
});

const T = (hms) => `2026-11-03T${hms}Z`;
const HPA_REF = Object.freeze({ apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', name: 'v0-monolith', namespace: 'v0', uid: '6f1c2a9e-4b7d-4e2a-9c51-3d8e0f7a1b24' });
const DEPLOY_REF = Object.freeze({ apiVersion: 'apps/v1', kind: 'Deployment', name: 'v0-monolith', namespace: 'v0', uid: '0d3b8c47-9a21-4f6e-b8d2-5c7e1a9f3b60' });
let eventSeq = 0;
/** 쿠버네티스 core/v1 Event(kubectl get events -o json의 items 하나). 옛 기록기는 eventTime이 null이고 first·lastTimestamp를 쓴다 */
function k8sEvent({ involvedObject = HPA_REF, reason = 'SuccessfulRescale', message, type = 'Normal', eventTime = null, firstTimestamp = null, lastTimestamp = null }) {
  eventSeq += 1;
  const hpa = involvedObject.kind === 'HorizontalPodAutoscaler';
  return {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: `v0-monolith.18a4c2f9e7b${String(eventSeq).padStart(5, '0')}`, namespace: 'v0', creationTimestamp: firstTimestamp ?? lastTimestamp ?? eventTime?.replace(/\.\d+Z$/, 'Z') },
    involvedObject: { ...involvedObject },
    reason,
    message,
    type,
    count: 1,
    source: { component: hpa ? 'horizontal-pod-autoscaler' : 'deployment-controller' },
    reportingComponent: hpa ? 'horizontal-pod-autoscaler' : 'deployment-controller',
    reportingInstance: '',
    eventTime,
    firstTimestamp,
    lastTimestamp,
  };
}
const upMsg = (n) => `New size: ${n}; reason: cpu resource utilization (percentage of request) above target`;
const downMsg = (n) => `New size: ${n}; reason: All metrics below target`;
/**
 * 준비된 파드의 조건. PodReadyToStartContainers(1.29+)가 Ready 앞에 있고 더 이르다(type 'Ready'를 정확히 골라야 한다).
 * 준비 게이트가 있으면 ContainersReady가 Ready보다 이르다(containersReadyAt)
 */
const readyConditions = (created, containersStarted, readyAt, containersReadyAt = readyAt) => [
  { type: 'PodReadyToStartContainers', status: 'True', lastProbeTime: null, lastTransitionTime: containersStarted },
  { type: 'Initialized', status: 'True', lastProbeTime: null, lastTransitionTime: created },
  { type: 'Ready', status: 'True', lastProbeTime: null, lastTransitionTime: readyAt },
  { type: 'ContainersReady', status: 'True', lastProbeTime: null, lastTransitionTime: containersReadyAt },
  { type: 'PodScheduled', status: 'True', lastProbeTime: null, lastTransitionTime: created },
];
const notReadyConditions = (created, containersStarted) => [
  { type: 'PodReadyToStartContainers', status: 'True', lastProbeTime: null, lastTransitionTime: containersStarted },
  { type: 'Initialized', status: 'True', lastProbeTime: null, lastTransitionTime: created },
  { type: 'Ready', status: 'False', lastProbeTime: null, lastTransitionTime: created, reason: 'ContainersNotReady', message: 'containers with unready status: [app]' },
  { type: 'ContainersReady', status: 'False', lastProbeTime: null, lastTransitionTime: created, reason: 'ContainersNotReady', message: 'containers with unready status: [app]' },
  { type: 'PodScheduled', status: 'True', lastProbeTime: null, lastTransitionTime: created },
];
const unschedulable = (created) => ({
  type: 'PodScheduled', status: 'False', lastProbeTime: null, lastTransitionTime: created, reason: 'Unschedulable',
  message: '0/1 nodes are available: 1 Insufficient cpu. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.',
});
/** 쿠버네티스 Pod(kubectl get pods -o json의 items 하나) */
const k8sPod = (name, created, status) => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name, generateName: 'v0-monolith-6c9f8d7b5-', namespace: 'v0', creationTimestamp: created,
    labels: { 'app.kubernetes.io/name': 'v0-monolith', 'app.kubernetes.io/component': 'service', 'pod-template-hash': '6c9f8d7b5' },
  },
  spec: { nodeName: 'peaket-control-plane' },
  status,
});

test('BSL090_K9_HPA시간선_부하뒤의_늘리기사건과_새파드준비시각을_부하시작기준초로낸다', () => {
  const loadStartMs = Date.parse('2026-11-03T10:00:00.400Z');
  const events = [
    // eventTime이 먼저다(lastTimestamp와 달라도) → 51.32 − 0.4 = 50.9초
    k8sEvent({ message: upMsg(6), eventTime: '2026-11-03T10:00:51.320000Z', firstTimestamp: T('10:00:52'), lastTimestamp: T('10:00:52') }),
    k8sEvent({ message: downMsg(1), firstTimestamp: T('09:52:10'), lastTimestamp: T('09:52:10') }), // 부하 앞(지난 실행의 줄이기) → 뺀다
    k8sEvent({ message: upMsg(4), firstTimestamp: T('10:00:22'), lastTimestamp: T('10:00:22') }), // 21.6초
    k8sEvent({
      reason: 'FailedGetResourceMetric', type: 'Warning', firstTimestamp: T('10:00:05'), lastTimestamp: T('10:00:05'),
      message: 'failed to get cpu utilization: unable to get metrics for resource cpu: no metrics returned from resource metrics API',
    }), // 다른 사유 → 뺀다
    k8sEvent({ message: upMsg(5), firstTimestamp: T('10:00:40') }), // eventTime·lastTimestamp가 없다 → firstTimestamp(39.6초)
    k8sEvent({
      involvedObject: DEPLOY_REF, reason: 'ScalingReplicaSet', message: 'Scaled up replica set v0-monolith-6c9f8d7b5 to 4 from 1',
      firstTimestamp: T('10:00:22'), lastTimestamp: T('10:00:22'),
    }), // HPA 사건이 아니다
    k8sEvent({ involvedObject: DEPLOY_REF, message: upMsg(9), firstTimestamp: T('10:00:30'), lastTimestamp: T('10:00:30') }), // 대상이 HPA가 아니다 → 뺀다
    k8sEvent({ message: 'Scaled to target', firstTimestamp: T('10:00:31'), lastTimestamp: T('10:00:31') }), // 'New size'가 없다 → 건너뛴다
    k8sEvent({ message: downMsg(3), firstTimestamp: T('10:06:12'), lastTimestamp: T('10:06:12') }), // 371.6초. 줄었어도 maxSize는 가장 큰 값
    // 늘리기에 실패한 사건도 메시지가 'New size: <n>'으로 시작한다(HPA 제어기의 FailedRescale) → reason이 달라 뺀다
    k8sEvent({
      reason: 'FailedRescale', type: 'Warning', firstTimestamp: T('10:00:45'), lastTimestamp: T('10:00:45'),
      message: 'New size: 8; reason: cpu resource utilization (percentage of request) above target; error: Operation cannot be fulfilled on deployments.apps "v0-monolith": the object has been modified; please apply your changes to the latest version and try again',
    }),
  ];
  const pods = [
    k8sPod('v0-monolith-6c9f8d7b5-bq4zn', T('10:00:25'), { phase: 'Running', conditions: notReadyConditions(T('10:00:25'), T('10:00:27')) }),
    k8sPod('v0-monolith-6c9f8d7b5-2xk4p', T('09:41:07'), { phase: 'Running', conditions: readyConditions(T('09:41:07'), T('09:41:09'), T('09:41:19')) }), // 부하 앞 파드
    // 준비 게이트를 기다려 ContainersReady(27.6초)보다 Ready(28.6초)가 늦다 → Ready의 시각
    k8sPod('v0-monolith-6c9f8d7b5-9txl8', T('10:00:24'), { phase: 'Running', conditions: readyConditions(T('10:00:24'), T('10:00:26'), T('10:00:29'), T('10:00:28')) }),
    k8sPod('v0-monolith-6c9f8d7b5-zz8kc', T('10:00:53'), { phase: 'Pending' }), // 조건이 아직 없다
    k8sPod('v0-monolith-6c9f8d7b5-7mq2d', T('10:00:23'), { phase: 'Running', conditions: readyConditions(T('10:00:23'), T('10:00:25'), T('10:00:31')) }),
    k8sPod('v0-monolith-6c9f8d7b5-hh5rw', T('10:00:52'), { phase: 'Pending', conditions: [unschedulable(T('10:00:52'))] }),
  ];
  same(hpaTimeline({ events, pods, loadStartMs }), {
    rescales: [{ atS: 21.6, size: 4 }, { atS: 39.6, size: 5 }, { atS: 50.9, size: 6 }, { atS: 371.6, size: 3 }],
    firstRescaleS: 21.6,
    newPods: [
      { name: 'v0-monolith-6c9f8d7b5-7mq2d', createdS: 22.6, readyS: 30.6 },
      { name: 'v0-monolith-6c9f8d7b5-9txl8', createdS: 23.6, readyS: 28.6 },
      { name: 'v0-monolith-6c9f8d7b5-bq4zn', createdS: 24.6, readyS: null },
      { name: 'v0-monolith-6c9f8d7b5-hh5rw', createdS: 51.6, readyS: null },
      { name: 'v0-monolith-6c9f8d7b5-zz8kc', createdS: 52.6, readyS: null },
    ],
    firstNewReadyS: 28.6, // 먼저 만든 파드가 아니라 가장 먼저 준비된 새 파드
    maxSize: 6,
  });
});

test('BSL090_K9_HPA시간선_부하시작뒤는_시각≥⌊부하시작÷1000⌋×1000이다(쿠버네티스시각은초로잘린다)', () => {
  const loadStartMs = Date.parse('2026-11-03T10:00:00.900Z'); // 기준은 10:00:00.000
  const events = [
    k8sEvent({ message: upMsg(7), firstTimestamp: T('09:59:59'), lastTimestamp: T('09:59:59') }), // 기준 1초 앞 → 뺀다
    k8sEvent({ message: upMsg(8), eventTime: '2026-11-03T09:59:59.950000Z' }), // 부하 시작 0.95초 앞이지만 기준보다 앞 → 뺀다
    k8sEvent({ message: upMsg(3), eventTime: '2026-11-03T10:00:00.100000Z' }), // 부하 시작보다 앞이지만 기준 이후 → -0.8초
    k8sEvent({ message: upMsg(2), firstTimestamp: T('10:00:00'), lastTimestamp: T('10:00:00') }), // 기준과 같다 → 넣는다(-0.9초)
  ];
  const pods = [
    // 기준 1초 앞에 만든 파드는 새 파드가 아니다(넣으면 준비 4.1초가 가장 이르다)
    k8sPod('v0-monolith-6c9f8d7b5-kx7bd', T('09:59:59'), { phase: 'Running', conditions: readyConditions(T('09:59:59'), T('10:00:01'), T('10:00:05')) }),
    k8sPod('v0-monolith-6c9f8d7b5-w9fzq', T('10:00:00'), { phase: 'Running', conditions: readyConditions(T('10:00:00'), T('10:00:02'), T('10:00:07')) }),
  ];
  same(hpaTimeline({ events, pods, loadStartMs }), {
    rescales: [{ atS: -0.9, size: 2 }, { atS: -0.8, size: 3 }],
    firstRescaleS: -0.9,
    newPods: [{ name: 'v0-monolith-6c9f8d7b5-w9fzq', createdS: -0.9, readyS: 6.1 }],
    firstNewReadyS: 6.1,
    maxSize: 3,
  });
});

test('BSL090_K9_HPA시간선_사건·준비된새파드가없으면null이고_부하시작시각이유한한수가아니면_RangeError', () => {
  const loadStartMs = Date.parse('2026-11-03T10:00:00.400Z');
  same(hpaTimeline({ events: [], pods: [], loadStartMs }), { rescales: [], firstRescaleS: null, newPods: [], firstNewReadyS: null, maxSize: null });
  // 늘리기는 부하 앞에만 있고, 새 파드는 아직 준비 전
  const old = k8sEvent({ message: upMsg(2), firstTimestamp: T('09:59:58'), lastTimestamp: T('09:59:58') });
  const pending = k8sPod('v0-monolith-6c9f8d7b5-q8w2e', T('10:00:03'), { phase: 'Running', conditions: notReadyConditions(T('10:00:03'), T('10:00:05')) });
  same(hpaTimeline({ events: [old], pods: [pending], loadStartMs }), {
    rescales: [],
    firstRescaleS: null,
    newPods: [{ name: 'v0-monolith-6c9f8d7b5-q8w2e', createdS: 2.6, readyS: null }],
    firstNewReadyS: null,
    maxSize: null,
  });
  for (const v of [NaN, Infinity, -Infinity, '1793700000400', null, undefined]) rangeErr(() => hpaTimeline({ events: [], pods: [], loadStartMs: v }), String(v));
});

test('BSL090_K9_HPA시간선_사건시각은eventTime→lastTimestamp→firstTimestamp차례이고_빠진칸은null과같으며_초에맞은시작은그대로기준이다', () => {
  const loadStartMs = Date.parse('2026-11-03T10:00:00.000Z'); // 초에 맞은 시작: ⌊시작 ÷ 1000⌋ × 1000 = 시작
  const without = (o, ...keys) => {
    const c = { ...o };
    for (const k of keys) delete c[k];
    return c;
  };
  const events = [
    // 여러 번 모인 사건(count 3): firstTimestamp는 처음, lastTimestamp는 마지막 → lastTimestamp(45초)
    { ...k8sEvent({ message: upMsg(4), firstTimestamp: T('10:00:10'), lastTimestamp: T('10:00:45') }), count: 3 },
    // eventTime이 last·firstTimestamp보다 먼저다(59.96초 → 소수 첫째 자리 60초)
    k8sEvent({ message: upMsg(7), eventTime: '2026-11-03T10:00:59.960000Z', firstTimestamp: T('10:00:20'), lastTimestamp: T('10:00:30') }),
    // eventTime·lastTimestamp 칸이 아예 없다 → firstTimestamp(12초)
    without(k8sEvent({ message: upMsg(2), firstTimestamp: T('10:00:12') }), 'eventTime', 'lastTimestamp'),
    // eventTime 칸이 없고 firstTimestamp는 null → lastTimestamp(33초)
    without(k8sEvent({ message: upMsg(5), lastTimestamp: T('10:00:33') }), 'eventTime'),
    // 시작 1ms 앞(기준 = 시작이라 앞이다) → 뺀다
    k8sEvent({ message: upMsg(9), eventTime: '2026-11-03T09:59:59.999000Z' }),
    // 시작과 같다 → 0초
    k8sEvent({ message: upMsg(1), eventTime: '2026-11-03T10:00:00.000000Z' }),
  ];
  const pods = [
    // 기준 1초 앞에 만든 파드는 새 파드가 아니다(넣으면 준비 2초가 가장 이르다)
    k8sPod('v0-monolith-6c9f8d7b5-c4r7t', T('09:59:59'), { phase: 'Running', conditions: readyConditions(T('09:59:59'), T('10:00:00'), T('10:00:02')) }),
    k8sPod('v0-monolith-6c9f8d7b5-m2n8v', T('10:00:00'), { phase: 'Running', conditions: readyConditions(T('10:00:00'), T('10:00:03'), T('10:00:09')) }),
  ];
  same(hpaTimeline({ events, pods, loadStartMs }), {
    rescales: [{ atS: 0, size: 1 }, { atS: 12, size: 2 }, { atS: 33, size: 5 }, { atS: 45, size: 4 }, { atS: 60, size: 7 }],
    firstRescaleS: 0,
    newPods: [{ name: 'v0-monolith-6c9f8d7b5-m2n8v', createdS: 0, readyS: 9 }],
    firstNewReadyS: 9,
    maxSize: 7,
  });
});

const GB = Date.parse('2026-11-03T10:10:00Z');
/** 검표 시도 하나(창 시작 GB에서 잰 ms) */
const gs = (s, e, ok, result) => ({ kind: 'gate_scan', startedMs: GB + s, endedMs: GB + e, ok, result });
/** 본구간 50초: 온라인 20초 → 망 끊김 10초 → 복구 20초 */
const GW = Object.freeze({ mainStartMs: GB, cutStartMs: GB + 20_000, cutEndMs: GB + 30_000, mainEndMs: GB + 50_000 });
const GATE_PROBES = Object.freeze([
  gs(-1000, -940, true, 'ADMIT'), // 창 앞 → 뺀다
  gs(0, 120, true, 'ADMIT'), // 창 시작과 같다 → online
  gs(3000, 3080, true, 'ADMIT'),
  gs(6000, 6095, true, 'ALREADY_ENTERED'),
  gs(9000, 9200, true, 'ADMIT'),
  gs(12000, 12070, true, 'INVALID'),
  gs(15000, 15110, true, 'ADMIT'),
  gs(18000, 21000, false, null), // online에서 시작해 끊긴 뒤 실패 → 시작 시각으로 online
  gs(20000, 25000, false, null), // 끊김 시작과 같다 → cut
  gs(25500, 27900, true, 'ADMIT'),
  gs(28000, 31000, false, null),
  gs(30000, 30150, true, 'ADMIT'), // 복구와 같다 → restored
  gs(33000, 33090, true, 'ALREADY_ENTERED'),
  gs(36000, 36085, true, 'ADMIT'),
  gs(39000, 39100, true, 'WRONG_EVENT'),
  gs(42000, 42060, true, 'ADMIT'),
  gs(50000, 50070, true, 'ADMIT'), // 창 끝과 같다 → 뺀다
  gs(55000, 55080, true, 'INVALID'), // 창 뒤 → 뺀다
]);

test('BSL090_O-T1_검표구간요약_시작시각으로online·cut·restored를나누고_구간마다분당판정수와p95를낸다', () => {
  const { results, ...rest } = plain(gateSummary(GATE_PROBES.map((p) => ({ ...p })), GW));
  same(rest, {
    online: { attempts: 7, judged: 6, failed: 1, perMinute: 18, p95Ms: 200 }, // 6 ÷ 20초 × 60, ⌈0.95 × 6⌉ = 6번째
    cut: { attempts: 3, judged: 1, failed: 2, perMinute: 6, p95Ms: 2400 },
    restored: { attempts: 5, judged: 5, failed: 0, perMinute: 15, p95Ms: 150 },
    maxGapS: 12.8, // 끊기기 전 마지막 판정(15.11초) → 끊긴 동안의 판정(27.9초)
    offlineRatio: 0.333, // 6 ÷ 18
  });
  // 판정 결과별 수(창 안). 판정을 못 받은 시도(result null)는 결과가 아니다
  same(nonzero(results), { ADMIT: 8, ALREADY_ENTERED: 2, INVALID: 1, WRONG_EVENT: 1 });
});

test('BSL090_O-T1_검표구간요약_p95는가장가까운순위⌈0.95n⌉번째이고_분당판정수는소수첫째자리로둥근다', () => {
  const w = { mainStartMs: GB, cutStartMs: GB + 45_000, cutEndMs: GB + 60_000, mainEndMs: GB + 90_000 };
  const probes = [];
  // 2초마다 하나, 걸린 시간은 10~200ms가 한 번씩(섞인 차례)
  for (let k = 0; k < 20; k++) probes.push(gs(2000 * k, 2000 * k + (((7 * k) % 20) + 1) * 10, true, 'ADMIT'));
  probes.push(gs(60_000, 63_000, false, null), gs(75_000, 78_000, false, null));
  const { results, ...rest } = plain(gateSummary(probes, w));
  same(rest, {
    online: { attempts: 20, judged: 20, failed: 0, perMinute: 26.7, p95Ms: 190 }, // 20 ÷ 45초 × 60 = 26.67, ⌈0.95 × 20⌉ = 19번째
    cut: { attempts: 0, judged: 0, failed: 0, perMinute: 0, p95Ms: null },
    restored: { attempts: 2, judged: 0, failed: 2, perMinute: 0, p95Ms: null },
    maxGapS: 51.9, // 마지막 판정(38.14초) → 창 끝(90초)
    offlineRatio: 0,
  });
  same(nonzero(results), { ADMIT: 20 });
  // 하나면 그 값, 일곱이면 ⌈6.65⌉ = 7번째(가장 큰 값)
  assert.equal(gateSummary([gs(1000, 1333, true, 'ADMIT')], GW).online.p95Ms, 333);
  const seven = [10, 70, 30, 50, 20, 60, 40].map((d, i) => gs(1000 * (i + 1), 1000 * (i + 1) + d, true, 'ADMIT'));
  assert.equal(gateSummary(seven, GW).online.p95Ms, 70);
  // 열둘이면 ⌈11.4⌉ = 12번째(반올림한 11번째가 아니다)
  const twelve = [50, 120, 10, 90, 30, 110, 70, 20, 100, 40, 80, 60].map((d, i) => gs(1000 * (i + 1), 1000 * (i + 1) + d, true, 'ADMIT'));
  assert.equal(gateSummary(twelve, GW).online.p95Ms, 120);
});

test('BSL090_O-T1_검표구간요약_구간은시작시각으로[시작,끝)이고_창밖에서판정받은시도는간격·결과에넣지않는다', () => {
  // 경계마다 1ms 앞과 그 시각. 걸린 시간은 구간마다 다르게(online 11·12, cut 21·22, restored 31·32, 창 밖 98·99)
  const edges = [
    gs(-1, 98, true, 'INVALID'), // 창 시작 1ms 앞 → 뺀다
    gs(0, 11, true, 'ADMIT'), // 창 시작 → online
    gs(19_999, 20_011, true, 'ADMIT'), // 끊김 1ms 앞 → online
    gs(20_000, 20_021, true, 'ALREADY_ENTERED'), // 끊김 → cut
    gs(29_999, 30_021, true, 'ADMIT'), // 복구 1ms 앞 → cut
    gs(30_000, 30_031, true, 'WRONG_EVENT'), // 복구 → restored
    gs(49_999, 50_031, true, 'ADMIT'), // 창 끝 1ms 앞 → restored
    gs(50_000, 50_099, true, 'INVALID'), // 창 끝 → 뺀다
  ];
  const { results, ...rest } = plain(gateSummary(edges, GW));
  same(rest, {
    online: { attempts: 2, judged: 2, failed: 0, perMinute: 6, p95Ms: 12 },
    cut: { attempts: 2, judged: 2, failed: 0, perMinute: 12, p95Ms: 22 },
    restored: { attempts: 2, judged: 2, failed: 0, perMinute: 6, p95Ms: 32 },
    maxGapS: 20, // 첫 판정(0.011초) → 둘째(20.011초)
    offlineRatio: 2,
  });
  same(nonzero(results), { ADMIT: 4, ALREADY_ENTERED: 1, WRONG_EVENT: 1 });
  // 창 안의 판정은 10.1초 하나뿐이다: 창 앞(−4.9초)·뒤(60.1초)의 판정을 넣으면 가장 긴 간격이 50초가 된다
  const outside = gateSummary([gs(-5_000, -4_900, true, 'ADMIT'), gs(10_000, 10_100, true, 'INVALID'), gs(60_000, 60_100, true, 'ADMIT')], GW);
  assert.equal(outside.maxGapS, 39.9); // 마지막 판정 → 창 끝
  same(nonzero(outside.results), { INVALID: 1 });
  same(plain(outside.online), { attempts: 1, judged: 1, failed: 0, perMinute: 3, p95Ms: 100 });
});

test('BSL090_O-T1_검표구간요약_offlineRatio는낸perMinute끼리나눠소수셋째자리로둥글고_결과를못읽은판정은판정에만센다', () => {
  // online 20초에 판정 6 → 18/분, cut 10초에 판정 2 → 12/분: 12 ÷ 18 = 0.6666… → 0.667(올림)
  const probes = [0, 3000, 6000, 9000, 12_000, 15_000].map((s) => gs(s, s + 50, true, 'ADMIT'));
  // cut의 둘째는 판정은 받았지만(ok) 결과를 읽지 못했다(null): 판정 수·p95·간격에는 들고 결과별 수에는 없다
  probes.push(gs(21_000, 21_040, true, 'ADMIT'), gs(24_000, 24_060, true, null));
  const r = plain(gateSummary(probes, GW));
  same(r.cut, { attempts: 2, judged: 2, failed: 0, perMinute: 12, p95Ms: 60 });
  assert.equal(r.offlineRatio, 0.667);
  assert.equal(r.maxGapS, 25.9); // 마지막 판정(24.06초) → 창 끝(50초)
  same(nonzero(r.results), { ADMIT: 7 });
  // 비율은 낸 perMinute(소수 첫째 자리)끼리 나눈다: online 45초에 판정 20 → 26.7/분, cut 15초에 7 → 28/분 → 28 ÷ 26.7 = 1.0487 → 1.049
  // (둥글기 전 26.67로 나누면 1.05)
  const w = { mainStartMs: GB, cutStartMs: GB + 45_000, cutEndMs: GB + 60_000, mainEndMs: GB + 90_000 };
  const p2 = [];
  for (let k = 0; k < 20; k++) p2.push(gs(2000 * k, 2000 * k + 30, true, 'ADMIT'));
  for (let k = 0; k < 7; k++) p2.push(gs(45_000 + 2000 * k, 45_000 + 2000 * k + 40, true, 'ADMIT'));
  const r2 = gateSummary(p2, w);
  same([r2.online.perMinute, r2.cut.perMinute, r2.offlineRatio], [26.7, 28, 1.049]);
});

test('BSL090_O-T1_검표구간요약_판정이없으면maxGapS는창전체길이이고_online이0이면offlineRatio는null', () => {
  const Z = { attempts: 0, judged: 0, failed: 0, perMinute: 0, p95Ms: null };
  const empty = plain(gateSummary([], GW));
  same(nonzero(empty.results), {});
  delete empty.results;
  same(empty, { online: Z, cut: Z, restored: Z, maxGapS: 50, offlineRatio: null });
  const allFailed = plain(gateSummary([gs(1000, 4000, false, null), gs(21000, 24000, false, null), gs(31000, 31500, false, null)], GW));
  same(nonzero(allFailed.results), {});
  delete allFailed.results;
  const F = { attempts: 1, judged: 0, failed: 1, perMinute: 0, p95Ms: null };
  same(allFailed, { online: F, cut: F, restored: F, maxGapS: 50, offlineRatio: null });
  // online에 판정이 없으면 끊긴 동안 판정이 있어도 비율은 null. 가장 긴 간격이 창 시작 → 첫 판정일 수 있다
  const late = plain(gateSummary([gs(5000, 8000, false, null), gs(25000, 25400, true, 'ADMIT'), gs(30000, 30170, true, 'ADMIT'),
    gs(33000, 33090, true, 'ALREADY_ENTERED')], GW));
  same(nonzero(late.results), { ADMIT: 2, ALREADY_ENTERED: 1 });
  delete late.results;
  same(late, {
    online: { attempts: 1, judged: 0, failed: 1, perMinute: 0, p95Ms: null },
    cut: { attempts: 1, judged: 1, failed: 0, perMinute: 6, p95Ms: 400 },
    restored: { attempts: 2, judged: 2, failed: 0, perMinute: 6, p95Ms: 170 },
    maxGapS: 25.4,
    offlineRatio: null,
  });
});

test('BSL090_O-T1_검표구간요약_창시각이mainStart<cutStart<cutEnd<mainEnd가아니면_RangeError', () => {
  assert.equal(gateSummary([], GW).maxGapS, 50); // 기준
  const bad = [
    { mainStartMs: GB, cutStartMs: GB, cutEndMs: GB + 30_000, mainEndMs: GB + 50_000 },
    { mainStartMs: GB, cutStartMs: GB + 20_000, cutEndMs: GB + 20_000, mainEndMs: GB + 50_000 },
    { mainStartMs: GB, cutStartMs: GB + 20_000, cutEndMs: GB + 30_000, mainEndMs: GB + 30_000 },
    { mainStartMs: GB, cutStartMs: GB + 30_000, cutEndMs: GB + 20_000, mainEndMs: GB + 50_000 },
    { mainStartMs: GB + 60_000, cutStartMs: GB + 20_000, cutEndMs: GB + 30_000, mainEndMs: GB + 50_000 },
    { mainStartMs: GB, cutStartMs: GB + 20_000, cutEndMs: GB + 30_000, mainEndMs: GB + 10_000 },
    // 수가 아니면 '커진다'가 성립하지 않는다(비교가 모두 거짓이라 '작거나 같으면 거절' 꼴의 검사는 놓친다)
    { mainStartMs: GB, cutStartMs: NaN, cutEndMs: GB + 30_000, mainEndMs: GB + 50_000 },
    { mainStartMs: GB, cutStartMs: GB + 20_000, cutEndMs: GB + 30_000, mainEndMs: undefined },
    { mainStartMs: NaN, cutStartMs: NaN, cutEndMs: NaN, mainEndMs: NaN },
  ];
  for (const w of bad) rangeErr(() => gateSummary(GATE_PROBES.map((p) => ({ ...p })), w), JSON.stringify(w));
});

const S0 = Date.parse('2026-11-03T10:00:00Z') / 1000; // 에포크 초
/** 지연 칸 16개(LAT_BOUNDS_MS 15개 + 30초 넘음). pairs는 { 칸 번호: 수 } */
const lat16 = (pairs = {}) => {
  const a = new Array(16).fill(0);
  for (const [i, v] of Object.entries(pairs)) a[Number(i)] = v;
  return a;
};
const bucket = (pod, sec, o = {}) => ({ kind: 'delta_bucket', pod, sec, msgs: 0, bytes: 0, lat: lat16(), opened: 0, closed: 0, errors: 0, ...o });

test('BSL090_S-T12_변경분요약_창안에온전히든초만더해_초당메시지·바이트와지연칸을낸다', () => {
  const lines = [
    // 창 시작(S0 + 0.5초) 앞에 걸친 초 → 뺀다(연결을 맺은 초)
    bucket('delta-client-0', S0, { msgs: 99999, bytes: 9999999, opened: 2500, closed: 7, errors: 3, lat: lat16({ 12: 2500, 15: 97499 }) }),
    bucket('delta-client-1', S0 + 2, { msgs: 10010, bytes: 2502500, errors: 2, lat: lat16({ 5: 9010, 6: 900, 7: 90, 8: 10 }) }),
    bucket('delta-client-0', S0 + 1, { msgs: 10000, bytes: 2500000, lat: lat16({ 5: 9000, 6: 900, 7: 90, 8: 5, 9: 5 }) }),
    { kind: 'delta_conn', pod: 'delta-client-0', connected: 2500, failed: 0 },
    bucket('delta-client-0', S0 + 3, { msgs: 10000, bytes: 2500002, opened: 1, errors: 1, lat: lat16({ 5: 8000, 6: 1900, 7: 90, 8: 5, 9: 3, 10: 1, 15: 1 }) }),
    bucket('delta-client-1', S0 + 1, { msgs: 9990, bytes: 2497500, lat: lat16({ 5: 8990, 6: 900, 7: 90, 8: 10 }) }),
    bucket('delta-client-0', S0 + 2, { msgs: 10000, bytes: 2500001, closed: 1, lat: lat16({ 5: 9000, 6: 950, 7: 40, 8: 5, 9: 4, 10: 1 }) }),
    bucket('delta-client-1', S0 + 3, { msgs: 10001, bytes: 2500250, lat: lat16({ 5: 9001, 6: 900, 7: 90, 8: 10 }) }),
    // 창 끝(S0 + 4.2초)을 넘는 초 → 뺀다(연결을 끊은 초)
    bucket('delta-client-0', S0 + 4, { msgs: 88888, bytes: 8888888, closed: 2500, errors: 9, lat: lat16({ 14: 88888 }) }),
    { kind: 'delta_conn', pod: 'delta-client-1', connected: 2498, failed: 2 },
  ];
  same(deltaSummary(lines, { fromMs: S0 * 1000 + 500, toMs: (S0 + 4) * 1000 + 200 }), {
    seconds: 3, // S0+1·S0+2·S0+3(파드 둘이 같은 초를 내도 한 초)
    msgsPerS: 20000.3, // 60,001 ÷ 3
    bytesPerS: 5000084.3, // 15,000,253 ÷ 3
    // 누적: 50ms 칸 53,001(≥ 30,000.5) → p50 50, 100ms 칸 59,451(≥ 59,400.99) → p99 100. 300ms 칸 위: 12 + 2 + 1
    latency: { count: 60001, p50Ms: 50, p99Ms: 100, over300: 15 },
    opened: 1,
    closed: 1,
    errors: 3,
    connected: 4998, // delta_conn은 창과 상관없이 더한다
    failed: 2,
  });
});

test('BSL090_S-T12_변경분요약_p50·p99는누적이처음닿는칸의경계이고_마지막칸이면null_over300은300ms칸위의수', () => {
  const lat = (pairs) => {
    const l = lat16(pairs);
    const n = l.reduce((x, y) => x + y, 0);
    return deltaSummary([bucket('delta-client-0', S0, { msgs: n, bytes: n * 250, lat: l })], { fromMs: S0 * 1000, toMs: (S0 + 1) * 1000 }).latency;
  };
  same(lat({ 5: 50, 6: 49, 15: 1 }), { count: 100, p50Ms: 50, p99Ms: 100, over300: 1 }, '누적이 비율과 같으면 닿은 것이다');
  same(lat({ 5: 49, 6: 1, 15: 50 }), { count: 100, p50Ms: 100, p99Ms: null, over300: 50 }, 'p99가 30초 넘음 칸 → null');
  same(lat({ 8: 7, 9: 3 }), { count: 10, p50Ms: 300, p99Ms: 500, over300: 3 }, '300ms 칸 자체는 over300이 아니다');
  same(lat({}), { count: 0, p50Ms: null, p99Ms: null, over300: 0 });
  same(lat({ 0: 1 }), { count: 1, p50Ms: 1, p99Ms: 1, over300: 0 });
  same(lat({ 15: 4 }), { count: 4, p50Ms: null, p99Ms: null, over300: 4 });
  same(lat({ 13: 198, 14: 2 }), { count: 200, p50Ms: 10000, p99Ms: 10000, over300: 200 });
  same(lat({ 7: 197, 14: 3 }), { count: 200, p50Ms: 200, p99Ms: 30000, over300: 3 });
});

test('BSL090_S-T12_변경분요약_지연수는lat칸의합이라메시지수와다를수있고_받는파드가더낸칸(cpuUsec)은받는다', () => {
  // atMs를 읽지 못한 메시지는 msgs에만 들고 lat에는 없다(runner/delta-client.mjs). 받는 파드는 칸마다 cpuUsec도 낸다
  const lines = [
    bucket('delta-client-0', S0, { msgs: 120, bytes: 30000, lat: lat16({ 4: 60, 6: 40 }), cpuUsec: 1_250_000 }),
    bucket('delta-client-1', S0, { msgs: 80, bytes: 20000, lat: lat16({ 4: 30, 9: 10 }), errors: 5, cpuUsec: 990_000 }),
    { kind: 'delta_conn', pod: 'delta-client-0', connected: 500, failed: 0 },
  ];
  same(deltaSummary(lines, { fromMs: S0 * 1000, toMs: (S0 + 1) * 1000 }), {
    seconds: 1,
    msgsPerS: 200,
    bytesPerS: 50000,
    // 지연 140개(메시지 200개가 아니다): 20ms 칸 누적 90 ≥ 70 → p50 20, 500ms 칸 누적 140 ≥ 138.6 → p99 500
    latency: { count: 140, p50Ms: 20, p99Ms: 500, over300: 10 },
    opened: 0,
    closed: 0,
    errors: 5,
    connected: 500,
    failed: 0,
  });
});

test('BSL090_S-T12_변경분요약_창경계는sec×1000≥fromMs이고_(sec+1)×1000≤toMs인초만이다', () => {
  // S0−1·S0·S0+1·S0+2의 메시지 1·10·100·1000
  const lines = [S0 - 1, S0, S0 + 1, S0 + 2].map((sec, i) => bucket('delta-client-0', sec, { msgs: 10 ** i, bytes: 2 * 10 ** i, lat: lat16({ 6: 10 ** i }) }));
  const pick = (w) => {
    const r = deltaSummary(lines, w);
    return [r.seconds, r.msgsPerS, r.bytesPerS, r.latency.count];
  };
  same(pick({ fromMs: S0 * 1000, toMs: (S0 + 2) * 1000 }), [2, 55, 110, 110], '경계에 맞은 창: S0·S0+1');
  same(pick({ fromMs: S0 * 1000 + 1, toMs: (S0 + 2) * 1000 }), [1, 100, 200, 100], '1ms 늦게 시작하면 S0는 빠진다');
  same(pick({ fromMs: S0 * 1000, toMs: (S0 + 2) * 1000 - 1 }), [1, 10, 20, 10], '1ms 일찍 끝나면 S0+1은 빠진다');
  // 1초보다 짧은 창에는 온전히 든 초가 없다
  const zero = { seconds: 0, msgsPerS: 0, bytesPerS: 0, latency: { count: 0, p50Ms: null, p99Ms: null, over300: 0 }, opened: 0, closed: 0, errors: 0, connected: 0, failed: 0 };
  same(deltaSummary(lines, { fromMs: S0 * 1000 + 100, toMs: S0 * 1000 + 900 }), zero);
  same(deltaSummary([], { fromMs: S0 * 1000, toMs: (S0 + 60) * 1000 }), zero);
  // 두 파드가 같은 초를 내면 한 초다
  const twoPods = [bucket('delta-client-0', S0, { msgs: 300, bytes: 900 }), bucket('delta-client-1', S0, { msgs: 200, bytes: 600 })];
  const both = deltaSummary(twoPods, { fromMs: S0 * 1000, toMs: (S0 + 1) * 1000 });
  same([both.seconds, both.msgsPerS, both.bytesPerS], [1, 500, 1500]);
});

test('BSL090_S-T12_변경분요약_모르는kind·lat길이·음수·정수아닌수·toMs≤fromMs는_RangeError', () => {
  const ok = bucket('delta-client-0', S0, { msgs: 1, bytes: 250, lat: lat16({ 3: 1 }) });
  const W = { fromMs: S0 * 1000, toMs: (S0 + 2) * 1000 };
  assert.equal(deltaSummary([ok], W).seconds, 1); // 기준
  rangeErr(() => deltaSummary([ok], { fromMs: S0 * 1000, toMs: S0 * 1000 }), 'toMs = fromMs');
  rangeErr(() => deltaSummary([ok], { fromMs: S0 * 1000, toMs: S0 * 1000 - 1 }), 'toMs < fromMs');
  const bad = [
    { ...ok, kind: 'delta_hello' },
    { kind: 'delta_summary', pod: 'delta-client-0' },
    { ...ok, kind: undefined },
    { ...ok, lat: new Array(15).fill(0) },
    { ...ok, lat: new Array(17).fill(0) },
    { ...ok, lat: [] },
    { ...ok, msgs: -1 },
    { ...ok, bytes: 1.5 },
    { ...ok, opened: NaN },
    { ...ok, closed: -2 },
    { ...ok, errors: '1' },
    { ...ok, msgs: null },
    { ...ok, sec: S0 + 0.5 },
    { ...ok, lat: lat16({ 3: -1 }) },
    { ...ok, lat: lat16({ 0: 0.5 }) },
    { kind: 'delta_conn', pod: 'delta-client-0', connected: -1, failed: 0 },
    { kind: 'delta_conn', pod: 'delta-client-0', connected: 10, failed: 2.5 },
    { kind: 'delta_conn', pod: 'delta-client-0', connected: Infinity, failed: 0 },
    { ...ok, sec: -1 },
    // 창 밖의 초라도 줄은 검사한다(더하지 않을 뿐이다)
    { ...ok, sec: S0 + 10, msgs: -1 },
    { ...ok, sec: S0 - 10, lat: new Array(15).fill(0) },
    { ...ok, sec: S0 + 10, errors: 0.5 },
  ];
  for (const line of bad) rangeErr(() => deltaSummary([ok, line], W), JSON.stringify(line));
});

// ---------------------------------------------------------------------------------------------
// runner/results.mjs: splitConsole의 검표 시도 줄(K10)과 collectArgs의 BSL-090 인자
// ---------------------------------------------------------------------------------------------

const UUID_A = '0b5a3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const ENTRY = JSON.stringify({ kind: 'queue_entry', event_id: UUID_A, account_ref: 'acc-lt-r1-1', request_id: 'req-1', result: 'ok', seq: 1,
  generation: 1, started_at: '2026-11-03T19:10:00.000+09:00', ended_at: '2026-11-03T19:10:00.004+09:00' });
const ADMIT = JSON.stringify({ kind: 'queue_admit', event_id: UUID_A, account_ref: 'acc-lt-r1-1', request_id: 'req-2', result: 'unknown', seq: null,
  generation: null, started_at: '2026-11-03T19:10:01.000+09:00', ended_at: '2026-11-03T19:10:01.123+09:00' });
const mark = (name, atMs) => JSON.stringify({ kind: 'mark', name, at_ms: atMs });
const SCAN0 = Object.freeze({ kind: 'gate_scan', startedMs: 1793700600000, endedMs: 1793700600042, ok: true, result: 'ADMIT' });
const scanLine = (o = {}) => JSON.stringify({ ...SCAN0, ...o });

test('BSL090_O-T1_콘솔나누기_검표시도줄은probes로입력순서대로옮기고_시험기록에넣지않는다', () => {
  const s2 = { kind: 'gate_scan', startedMs: 1793700603000, endedMs: 1793700606000, ok: false, result: null };
  const s3 = { kind: 'gate_scan', startedMs: 1793700609000, endedMs: 1793700609077, ok: true, result: 'ALREADY_ENTERED' };
  // 키 차례가 달라도 같은 시도다
  const s3Line = '{"result":"ALREADY_ENTERED","ok":true,"endedMs":1793700609077,"startedMs":1793700609000,"kind":"gate_scan"}';
  const text = [ENTRY, mark('main_start', 1793700599000), scanLine(), '', JSON.stringify(s2), ADMIT, s3Line, mark('main_end', 1793700659000)].join('\n') + '\n';
  const r = splitConsole(text);
  same(r.records, [ENTRY, ADMIT]);
  same(norm(r.marks), { main_start: 1793700599000, main_end: 1793700659000 });
  same(r.probes, [{ ...SCAN0 }, s2, s3]);
});

test('BSL090_O-T1_콘솔나누기_검표시도의네판정결과·null·같은시각·0과가장큰안전한정수를받는다', () => {
  const variants = [
    { ok: true, result: 'ADMIT' },
    { ok: true, result: 'ALREADY_ENTERED' },
    { ok: true, result: 'INVALID' },
    { ok: true, result: 'WRONG_EVENT' },
    { ok: false, result: null },
    { ok: true, result: null }, // 판정은 받았지만 결과를 읽지 못함(ok가 거짓일 때만 null이어야 하는 것은 아니다)
    { startedMs: 0, endedMs: 0 },
    { startedMs: 1793700600000, endedMs: 1793700600000 }, // 끝 = 시작
    { startedMs: 0, endedMs: Number.MAX_SAFE_INTEGER },
    { startedMs: Number.MAX_SAFE_INTEGER, endedMs: Number.MAX_SAFE_INTEGER },
  ];
  for (const v of variants) {
    const o = { ...SCAN0, ...v };
    const r = splitConsole(JSON.stringify(o)); // 줄바꿈 없는 마지막 줄도 읽는다
    same(r.probes, [o], JSON.stringify(v));
    same(r.records, []);
    same(norm(r.marks), {});
  }
});

test('BSL090_O-T1_콘솔나누기_검표시도줄이규칙을어기면_줄번호와함께Error', () => {
  // 줄 1 기록, 줄 2 빈 줄, 줄 3 기록, 줄 4 빈 줄, 줄 5 검표 시도
  const at5 = (line) => `${ENTRY}\n\n${ADMIT}\n\n${line}\n${ENTRY}\n`;
  same(splitConsole(at5(scanLine())).probes, [{ ...SCAN0 }]); // 기준
  const bad = [
    scanLine({ endedMs: 1793700599999 }), // 끝이 시작보다 앞
    scanLine({ startedMs: -1, endedMs: 5 }),
    scanLine({ startedMs: 1.5, endedMs: 5 }),
    scanLine({ startedMs: '1793700600000' }),
    scanLine({ startedMs: null }),
    scanLine({ endedMs: null }),
    `{"kind":"gate_scan","startedMs":${2 ** 53},"endedMs":${2 ** 53},"ok":true,"result":"ADMIT"}`,
    '{"kind":"gate_scan","startedMs":1793700600000,"endedMs":1e300,"ok":true,"result":"ADMIT"}',
    scanLine({ ok: 'true' }),
    scanLine({ ok: 1 }),
    scanLine({ ok: null }),
    scanLine({ result: 'admit' }),
    scanLine({ result: 'OK' }),
    scanLine({ result: '' }),
    scanLine({ result: 'toString' }),
    scanLine({ ok: false, result: 'ADMIT' }), // 판정을 못 받았는데 결과가 있다
    scanLine({ ok: false, result: 'INVALID' }),
    scanLine({ device: 'gate-07' }), // 다른 키
    scanLine({ at_ms: 1793700600000 }),
    '{"kind":"gate_scan","startedMs":1793700600000,"endedMs":1793700600042,"ok":true,"result":"ADMIT","__proto__":{"ok":false}}',
    JSON.stringify({ kind: 'gate_scan', endedMs: 1793700600042, ok: true, result: 'ADMIT' }), // startedMs 없음
    JSON.stringify({ kind: 'gate_scan', startedMs: 1793700600000, ok: true, result: 'ADMIT' }), // endedMs 없음
    JSON.stringify({ kind: 'gate_scan', startedMs: 1793700600000, endedMs: 1793700600042, result: 'ADMIT' }), // ok 없음
    JSON.stringify({ kind: 'gate_scan', startedMs: 1793700600000, endedMs: 1793700600042, ok: true }), // result 없음
  ];
  for (const line of bad) {
    assert.throws(
      () => splitConsole(at5(line)),
      (e) => {
        assert.ok(e instanceof Error);
        assert.ok(mentionsNumber(e.message, 5), `줄 번호 5가 없다: ${e.message}`);
        return true;
      },
      line,
    );
  }
});

test('BSL090_[ASVS v5.0.0-16.2.5]_콘솔나누기_검표시도오류메시지에_줄내용을싣지않는다', () => {
  const secret = 'tok_SECRET_9f8e7d6c5b4a3921';
  same(splitConsole(`${ENTRY}\n${scanLine()}\n`).probes, [{ ...SCAN0 }]); // 기준
  const lines = [
    scanLine({ authorization: `Bearer ${secret}` }), // 다른 키에 토큰
    scanLine({ result: `Bearer ${secret}` }), // 결과 값 자체
    scanLine({ startedMs: `Bearer ${secret}` }),
  ];
  for (const line of lines) {
    assert.throws(
      () => splitConsole(`${ENTRY}\n${line}\n`),
      (e) => {
        assert.ok(e instanceof Error);
        assert.ok(!e.message.includes(secret) && !e.message.includes('SECRET') && !e.message.includes('Bearer'), e.message);
        return true;
      },
    );
  }
});

test('BSL090_O-T1_콘솔나누기_검표시도가없으면probes는빈목록이다', () => {
  same(splitConsole('').probes, []);
  same(splitConsole('\n\n').probes, []);
  const r = splitConsole(`${ENTRY}\n${mark('main_start', 1)}\n${ADMIT}`);
  same(r.probes, []);
  same(r.records, [ENTRY, ADMIT]);
  same(norm(r.marks), { main_start: 1 });
});

const CA_MIN = Object.freeze({
  runId: '2026-11-03-k1-v0-local-10k-before',
  kpi: 'K1',
  version: 'v0',
  profile: 'local-10k',
  durationS: 60,
  warmupS: 30,
  scenario: 'loadtest/scenarios/v0-queue.js',
  summaryFile: 'C:\\run dir\\summary.json',
  infraFile: 'C:\\run dir\\infra.txt',
  notes: 'Before 측정',
});
const CA_BASE = Object.freeze([
  'tools/perf-ledger/collect.py',
  '--run-id', '2026-11-03-k1-v0-local-10k-before',
  '--kpi', 'K1',
  '--version', 'v0',
  '--profile', 'local-10k',
  '--duration', '60',
  '--warmup', '30',
  '--scenario', 'loadtest/scenarios/v0-queue.js',
  '--k6-summary', 'C:\\run dir\\summary.json',
  '--infra-file', 'C:\\run dir\\infra.txt',
  '--notes', 'Before 측정',
  '--verdict', 'baseline',
]);
const CA_SE = Object.freeze({ start: '2026-11-03T01:00:00Z', end: '2026-11-03T01:01:30Z' });
const PROM = 'http://127.0.0.1:9090';
const QUERIES = 'tools/perf-ledger/queries.example.txt';
const RAW_BUCKET = 's3://peaket-perf-raw';
const RAW_OUTBOX = 'C:\\cache\\perf raw\\outbox';
const CA_ALL = Object.freeze({
  ...CA_MIN,
  runId: '2026-11-03-k2-v0-local-10k-gen3',
  kpi: 'K2',
  users: 4000,
  rps: 2000,
  scenario: 'loadtest/scenarios/v0-seat-hold.js',
  summaryFile: '/tmp/r/summary.json',
  infraFile: '/tmp/r/infra.txt',
  notes: '발생기 3대 합침, CPU 평균 최대 41.2% "q" $(id)',
  ...CA_SE,
  invalidReason: '발생기가 반복을 시작하지 못함(dropped_iterations 4)',
  invariants: '/tmp/r/invariants.csv',
  extra: ['/tmp/r/generator.json', '/tmp/r/records.ndjson'],
  generator: 'k6 1.4.2 × 3대, 파드마다 CPU 4·메모리 4096Mi',
  checks: '/tmp/r/checks.json',
  promUrl: PROM,
  queries: QUERIES,
  rawBucket: RAW_BUCKET,
  rawOutbox: RAW_OUTBOX,
});

test('BSL090_ADR-0077_collectArgs_--checks·--prom-url·--queries·--raw-bucket·--raw-outbox를_--generator뒤에이순서로싣는다', () => {
  same(collectArgs(CA_ALL), [
    'tools/perf-ledger/collect.py',
    '--run-id', '2026-11-03-k2-v0-local-10k-gen3',
    '--kpi', 'K2',
    '--version', 'v0',
    '--profile', 'local-10k',
    '--duration', '60',
    '--warmup', '30',
    '--scenario', 'loadtest/scenarios/v0-seat-hold.js',
    '--k6-summary', '/tmp/r/summary.json',
    '--infra-file', '/tmp/r/infra.txt',
    '--notes', CA_ALL.notes,
    '--verdict', 'baseline',
    '--users', '4000',
    '--rps', '2000',
    '--start', '2026-11-03T01:00:00Z',
    '--end', '2026-11-03T01:01:30Z',
    '--invalid-reason', CA_ALL.invalidReason,
    '--invariants', '/tmp/r/invariants.csv',
    '--extra', '/tmp/r/generator.json',
    '--extra', '/tmp/r/records.ndjson',
    '--generator', CA_ALL.generator,
    '--checks', '/tmp/r/checks.json',
    '--prom-url', PROM,
    '--queries', QUERIES,
    '--raw-bucket', RAW_BUCKET,
    '--raw-outbox', RAW_OUTBOX, // 공백이 든 경로도 원소 하나
  ]);
});

test('BSL090_ADR-0077_collectArgs_새칸을하나씩주면그인자만붙고_객체의키차례와상관없이정한차례다', () => {
  same(collectArgs(CA_MIN), [...CA_BASE]); // 새 칸이 없으면 예전과 같다
  same(collectArgs({ ...CA_MIN, checks: 'C:\\run dir\\checks.json' }), [...CA_BASE, '--checks', 'C:\\run dir\\checks.json']);
  same(collectArgs({ ...CA_MIN, ...CA_SE, promUrl: PROM, queries: QUERIES }),
    [...CA_BASE, '--start', CA_SE.start, '--end', CA_SE.end, '--prom-url', PROM, '--queries', QUERIES]);
  same(collectArgs({ ...CA_MIN, rawBucket: RAW_BUCKET }), [...CA_BASE, '--raw-bucket', RAW_BUCKET]);
  same(collectArgs({ ...CA_MIN, rawBucket: RAW_BUCKET, rawOutbox: '.cache/perf-raw-outbox' }),
    [...CA_BASE, '--raw-bucket', RAW_BUCKET, '--raw-outbox', '.cache/perf-raw-outbox']);
  // 입력 객체의 키 차례가 거꾸로여도 인자 차례는 generator → checks → prom-url·queries → raw-bucket → raw-outbox
  const reversed = { rawOutbox: RAW_OUTBOX, rawBucket: RAW_BUCKET, queries: QUERIES, promUrl: PROM, checks: 'c.json', generator: 'k6 1.4.2', ...CA_MIN, ...CA_SE };
  same(collectArgs(reversed), [...CA_BASE, '--start', CA_SE.start, '--end', CA_SE.end, '--generator', 'k6 1.4.2', '--checks', 'c.json',
    '--prom-url', PROM, '--queries', QUERIES, '--raw-bucket', RAW_BUCKET, '--raw-outbox', RAW_OUTBOX]);
});

test('BSL090_ADR-0077_collectArgs_promUrl과queries는함께주고_start·end가둘다있어야한다', () => {
  same(collectArgs({ ...CA_MIN, ...CA_SE, promUrl: PROM, queries: QUERIES }).slice(-4), ['--prom-url', PROM, '--queries', QUERIES]); // 기준
  const bad = [
    { ...CA_SE, promUrl: PROM }, // queries 없음
    { ...CA_SE, queries: QUERIES }, // promUrl 없음
    { promUrl: PROM, queries: QUERIES }, // start·end 없음
    { start: CA_SE.start, promUrl: PROM, queries: QUERIES }, // end 없음
    { end: CA_SE.end, promUrl: PROM, queries: QUERIES }, // start 없음
    { promUrl: PROM }, // queries도 start·end도 없음
  ];
  for (const over of bad) assert.throws(() => collectArgs({ ...CA_MIN, ...over }), Error, JSON.stringify(over));
});

test('BSL090_낮음-056_collectArgs_rawOutbox는rawBucket과함께만받고_새칸의빈값·-로시작하는값은Error', () => {
  same(collectArgs({ ...CA_MIN, rawBucket: RAW_BUCKET, rawOutbox: RAW_OUTBOX }).slice(-4), ['--raw-bucket', RAW_BUCKET, '--raw-outbox', RAW_OUTBOX]); // 기준
  // 가운데의 -는 된다
  same(collectArgs({ ...CA_MIN, checks: 'run-1/checks.json' }).slice(-2), ['--checks', 'run-1/checks.json']);
  assert.throws(() => collectArgs({ ...CA_MIN, rawOutbox: RAW_OUTBOX }), Error, 'rawBucket 없이 rawOutbox');
  const bad = [
    { checks: '' },
    { checks: '-checks.json' },
    { checks: '--force' },
    { ...CA_SE, promUrl: '', queries: QUERIES },
    { ...CA_SE, promUrl: '-http://127.0.0.1:9090', queries: QUERIES },
    { ...CA_SE, promUrl: PROM, queries: '' },
    { ...CA_SE, promUrl: PROM, queries: '--queries' },
    { rawBucket: '' },
    { rawBucket: '-s3://peaket-perf-raw' },
    { rawBucket: RAW_BUCKET, rawOutbox: '' },
    { rawBucket: RAW_BUCKET, rawOutbox: '--raw-outbox' },
  ];
  for (const over of bad) assert.throws(() => collectArgs({ ...CA_MIN, ...over }), Error, JSON.stringify(over));
});

test('BSL090_낮음-056_collectArgs가내는새인자는_모두collect.py가선언한인자다', () => {
  const src = readFileSync(join(REPO, 'tools', 'perf-ledger', 'collect.py'), 'utf8');
  const declared = new Set([...src.matchAll(/add_argument\('(--[a-z0-9-]+)'/g)].map((m) => m[1]));
  assert.ok(declared.has('--checks') && declared.has('--raw-bucket'), '선언 읽기');
  const args = collectArgs(CA_ALL);
  for (const flag of ['--checks', '--prom-url', '--queries', '--raw-bucket', '--raw-outbox']) assert.ok(args.includes(flag), `빠짐: ${flag}`);
  for (const a of args.filter((x) => x.startsWith('--'))) assert.ok(declared.has(a), `collect.py에 없는 인자: ${a}`);
});

/** Python 3 실행 파일(PYTHON 환경 값, 없으면 이 OS의 흔한 이름). 없으면 null */
function findPython() {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`)) return c;
  }
  return null;
}
const PY = findPython();

/**
 * collectArgs가 낸 인자로 collect.py를 OS 임시 폴더 루트(--root)에 부르고 manifest를 돌려준다(저장소의 docs/perf-ledger/runs는 건드리지 않는다).
 * files는 { 파일 이름: 내용(글이 아니면 JSON) }, make(paths)는 collectArgs 입력이다
 */
function collectLedger(make, files) {
  assert.ok(PY, 'Python 3을 찾지 못했다(PYTHON 환경 값으로 실행 파일을 줄 수 있다)');
  const root = mkdtempSync(join(tmpdir(), 'bsl090-collect-'));
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'perf-ledger.md'), '# 성능 장부\n\n<!-- ledger:begin -->\n<!-- ledger:end -->\n');
    const paths = {};
    for (const [name, body] of Object.entries(files)) {
      paths[name] = join(root, name);
      writeFileSync(paths[name], typeof body === 'string' ? body : JSON.stringify(body));
    }
    const args = collectArgs(make(paths));
    const r = spawnSync(PY, ['-I', '-X', 'utf8', ...args, '--root', root, '--commit', 'bsl090-test'], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, `collect.py 실패(${r.error?.message ?? ''}):\n${r.stdout}\n${r.stderr}`);
    const runId = args[args.indexOf('--run-id') + 1];
    assert.equal(existsSync(join(REPO, 'docs', 'perf-ledger', 'runs', runId)), false, '저장소 장부에 쓰지 않는다');
    return JSON.parse(readFileSync(join(root, 'docs', 'perf-ledger', 'runs', runId, 'manifest.json'), 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * K2 홀드 피크(2,000/s, 놓기까지 4,000/s)를 발생기 둘로 나눠 잰 요약. 시나리오의 writeSummary처럼 mainPhaseSummary를 거친 handleSummary 꼴이고,
 * k6가 기준을 건 지표(dropped_iterations 포함)는 놓친 반복이 없어도 요약에 있다. 놓친 반복 4건은 둘째 발생기에만 있다
 */
const splitHoldPeak = () => [
  { p99: 48.9, max: 310.4, reqs: 80000, fails: 3, holds: 40000, over50: 450, over150: 0, dropped: 0 },
  { p99: 52.3, max: 286, reqs: 80004, fails: 0, holds: 40002, over50: 500, over150: 30, dropped: 4 },
].map((x, g) => ({
  ...META(92013.4 + g),
  metrics: mainPhaseSummary({
    'http_req_duration{phase:main}': trend({ avg: 9.8 + g, min: 1.2 - 0.25 * g, med: 7.5, max: x.max, 'p(90)': 18.2, 'p(95)': 24.75 - g, 'p(99)': x.p99 }),
    'http_reqs{phase:main}': counter(x.reqs, x.reqs / 92),
    'http_req_failed{phase:main}': rateMetric(x.fails, x.reqs - x.fails, x.fails / x.reqs),
    [HOLD_REQS]: counter(x.holds, x.holds / 92),
    [HOLD_OVER50]: counter(x.over50, x.over50 / 92),
    [HOLD_OVER150]: counter(x.over150, x.over150 / 92),
    [HOLD_FAILED]: rateMetric(x.fails, x.holds - x.fails, x.fails / x.holds),
    [HOLD_DUR]: trend({ avg: 9.8 + g, min: 1.2 - 0.25 * g, med: 7.5, max: x.max, 'p(90)': 18.2, 'p(95)': 24.75 - g, 'p(99)': x.p99 }),
    'http_reqs{phase:main,route:release}': counter(x.reqs - x.holds, (x.reqs - x.holds) / 92),
    dropped_iterations: counter(x.dropped, x.dropped / 92),
    vus_max: gauge(400, 100, 400),
  }, 60),
}));

test('BSL090_NFR-013_S-T1_나눠잰요약을collect.py에넘기면_장부k6.p99_ms는위한계·요청과놓침은합이고_놓침이있으면valid_false·점검은그대로_v0는baseline', () => {
  // §3.10 '발생기 나누기': 장부의 k6.p99_ms는 위 한계(나쁜 쪽), 요청 수·실패 수·놓친 반복은 더한다. 놓침이 하나라도 있으면 무효(§3.5 2번).
  // '경로 목표 점검': p99 목표는 허용 비율 0.01, p99.9는 0.001이고 어긴 수는 목표 시간을 넘은 요청 수. v0의 합격·불합격은 정하지 않는다(verdict baseline)
  const merged = mergeSummaries(splitHoldPeak());
  const checks = checksFromSummary(merged, ['hold', 'release']);
  const m = collectLedger(
    (p) => ({
      runId: '2026-11-03-k2-v0-local-1k-gen2',
      kpi: 'K2',
      version: 'v0',
      profile: 'local-1k',
      users: 1000,
      rps: 2000,
      durationS: 60,
      warmupS: 30,
      scenario: 'loadtest/scenarios/v0-seat-hold.js',
      summaryFile: p['summary.json'],
      infraFile: p['infra.txt'],
      notes: '발생기 2대 합침',
      generator: 'k6 1.4.2, 발생기 파드 2대(CPU 2·메모리 1024Mi씩, kind 안, k6 실행 구간으로 나눔)',
      checks: p['checks.json'],
    }),
    { 'summary.json': merged, 'checks.json': checks, 'infra.txt': 'generator: kind pod cpu 2 memory 1024Mi × 2\n' },
  );
  assert.equal(m.k6.p99_ms, 52.3, '장부 k6.p99_ms는 발생기별 p99의 위 한계');
  assert.equal(m.k6.requests, 160004, '본구간 요청 수는 발생기의 합');
  assert.ok(Math.abs(m.k6.error_rate - 3 / 160004) < 1e-12, `오류율은 합친 실패 ÷ 합친 요청: ${m.k6.error_rate}`);
  assert.equal(m.k6.dropped_iterations, 4, '놓친 반복은 발생기의 합');
  assert.equal(m.generator.dropped_iterations, 4);
  assert.equal(m.valid, false, '발생기 하나라도 놓치면 실행은 무효');
  assert.match(m.invalid_reason ?? '', /dropped_iterations=4/);
  same(m.checks.map(({ name, allowed, trials, violations, result }) => ({ name, allowed, trials, violations, result })), [
    // 950 ÷ 80,002 ≈ 1.19% > 1% → fail, 30 ÷ 80,002 ≈ 0.037%(상한 약 0.05%) ≤ 0.1% → pass
    { name: 'hold_p99_50ms', allowed: 0.01, trials: 80002, violations: 950, result: 'fail' },
    { name: 'hold_p999_150ms', allowed: 0.001, trials: 80002, violations: 30, result: 'pass' },
  ]);
  assert.equal(m.verdict, 'baseline', 'v0의 합격·불합격은 점검으로 정하지 않는다(§3.10)');
});

// ---------------------------------------------------------------------------------------------
// k5/lab-summary.mjs: K5 랩 판정 요약(S-T15의 v0 쪽)
// ---------------------------------------------------------------------------------------------

/** 20회(중급 모바일 프로필) 랩 판정 줄. drawMs는 2회, heapMb는 1회 값이 없고, LCP는 그리지 않은 창이라 모두 없다 */
const labRows = () => {
  const draw = [119.94, 101.24, null, 127.83, 110.0, 166.52, 104.06, 123.66, 133.08, 112.34, null, 115.52, 103.71, 141.77, 121.43, 108.93, 130.42, 113.85, 125.17, 117.21];
  const inp = [96, 191.96, 40, 136, 72, 152.04, 104, 56, 184, 120, 48, 168, 88, 144, 64, 176, 112, 80, 160, 128];
  const cls = [0.00266, 0, 0.04511, 0.00051, 0, 0.00317, 0.00012, 0.01237, 0, 0.00208, 0.00004, 0.00586, 0, 0.00127, 0.00419, 0.0009, 0, 0.00342, 0.00038, 0.00163];
  const loafCount = [3, 2, null, 5, 4, 1, 0, 2, 3, null, 6, 2, 1, 3, 4, 2, 2, 1, 0, 3];
  const loafMs = [212.5, 140, null, 388, 260.25, 61, 0, 133, 201, null, 455.5, 120, 58, 199, 301, 128, 131, 66, 0, 190];
  const longTasks = [1, 0, 2, 1, null, 0, 0, 1, 3, 1, 0, 0, 2, 1, 0, 1, 0, 0, 1, 0];
  const heap = [41.09, 38.12, 44.93, 40.26, 39.04, null, 42.15, 38.47, 51.48, 40.58, 39.85, 41.8, 38.9, 43.27, 40.02, 39.33, 42.64, 41.36, 40.71, 39.61];
  return draw.map((_, i) => ({
    rep: i + 1, drawMs: draw[i], inpMs: inp[i], lcpMs: null, cls: cls[i], loafCount: loafCount[i], loafMs: loafMs[i], longTasks: longTasks[i], heapMb: heap[i],
  }));
};

test('BSL090_S-T15_K5요약_20회의p75는15번째값이고_null은빼고세며_cls는소수넷째자리', () => {
  same(summarizeLab(labRows()), {
    reps: 20,
    drawMs: { p75: 127.8, max: 166.5, missing: 2 }, // 값 18개 → ⌈13.5⌉ = 14번째 127.83
    inpMs: { p75: 152, max: 192, missing: 0 }, // 값 20개 → 15번째 152.04, 가장 큰 191.96
    lcpMs: { p75: null, max: null, missing: 20 },
    cls: { p75: 0.0032, max: 0.0451, missing: 0 }, // 15번째 0.00317, 가장 큰 0.04511
    loafCount: { sum: 44, max: 6 }, // null 둘은 0
    longTasks: { sum: 14, max: 3 },
    heapMb: { median: 40.6, max: 51.5, missing: 1 }, // 값 19개 → ⌈9.5⌉ = 10번째 40.58
  });
});

test('BSL090_S-T15_K5요약_순위는⌈0.75n⌉·⌈0.5n⌉번째이고_loafCount·longTasks의null은0으로센다', () => {
  const four = [10, 40, 20, 30].map((v, i) => ({
    rep: i + 1, drawMs: v, inpMs: v * 2, lcpMs: null, cls: v / 1000, loafCount: null, loafMs: null, longTasks: null, heapMb: v,
  }));
  same(summarizeLab(four), {
    reps: 4,
    drawMs: { p75: 30, max: 40, missing: 0 }, // ⌈3⌉ = 3번째(4번째가 아니다)
    inpMs: { p75: 60, max: 80, missing: 0 },
    lcpMs: { p75: null, max: null, missing: 4 },
    cls: { p75: 0.03, max: 0.04, missing: 0 },
    loafCount: { sum: 0, max: 0 },
    longTasks: { sum: 0, max: 0 },
    heapMb: { median: 20, max: 40, missing: 0 }, // ⌈2⌉ = 2번째(3번째가 아니다)
  });
  const one = [{ rep: 1, drawMs: 88.88, inpMs: 64, lcpMs: 1234.56, cls: 0.12346, loafCount: 2, loafMs: 140, longTasks: 1, heapMb: 39.99 }];
  same(summarizeLab(one), {
    reps: 1,
    drawMs: { p75: 88.9, max: 88.9, missing: 0 },
    inpMs: { p75: 64, max: 64, missing: 0 },
    lcpMs: { p75: 1234.6, max: 1234.6, missing: 0 },
    cls: { p75: 0.1235, max: 0.1235, missing: 0 },
    loafCount: { sum: 2, max: 2 },
    longTasks: { sum: 1, max: 1 },
    heapMb: { median: 40, max: 40, missing: 0 },
  });
});

test('BSL090_S-T15_K5요약_순위는올림이다_n=3·7의p75와_n=2의median(반올림·보간이아니다)', () => {
  const rowsOf = (vals) => vals.map((v, i) => ({ rep: i + 1, drawMs: v, inpMs: v, lcpMs: v, cls: v / 1000, loafCount: 0, loafMs: 0, longTasks: 0, heapMb: v }));
  // 일곱: p75 = ⌈5.25⌉ = 6번째(반올림하면 5번째), median = ⌈3.5⌉ = 4번째
  const seven = summarizeLab(rowsOf([70, 10, 50, 30, 60, 20, 40]));
  same([seven.drawMs.p75, seven.inpMs.p75, seven.lcpMs.p75, seven.cls.p75, seven.heapMb.median], [60, 60, 60, 0.06, 40]);
  // 셋: p75 = ⌈2.25⌉ = 3번째, median = ⌈1.5⌉ = 2번째
  const three = summarizeLab(rowsOf([30, 10, 20]));
  same([three.drawMs.p75, three.heapMb.median], [30, 20]);
  // 둘: median = ⌈1⌉ = 1번째(두 값의 평균 40이 아니다), p75 = ⌈1.5⌉ = 2번째
  const two = summarizeLab(rowsOf([41, 39]));
  same([two.heapMb.median, two.drawMs.p75, two.heapMb.max], [39, 41, 41]);
});

test('BSL090_S-T15_K5요약_빈목록이나_null아닌값이음수·유한하지않은수면_RangeError', () => {
  const row = { rep: 1, drawMs: 100, inpMs: 64, lcpMs: 1200, cls: 0.01, loafCount: 1, loafMs: 80, longTasks: 0, heapMb: 40 };
  assert.equal(summarizeLab([row]).reps, 1); // 기준
  rangeErr(() => summarizeLab([]), '빈 목록');
  // 요약에 싣지 않는 loafMs도 줄의 값이다
  const bad = [['drawMs', -1], ['drawMs', NaN], ['drawMs', Infinity], ['inpMs', -0.5], ['lcpMs', -Infinity], ['cls', -0.001], ['cls', NaN],
    ['loafCount', -1], ['loafMs', -1], ['loafMs', NaN], ['longTasks', Infinity], ['heapMb', -40], ['heapMb', '40']];
  for (const [k, v] of bad) rangeErr(() => summarizeLab([row, { ...row, rep: 2, [k]: v }]), `${k}=${String(v)}`);
});

// ---------------------------------------------------------------------------------------------
// nightly/k6-args.mjs: 야간 비교의 실행 명령이 받는 k6 인자(D-T40, docs/devops.md §3.3)
// ---------------------------------------------------------------------------------------------

/** nightly.py가 설정의 k6 명령 뒤에 붙이는 인자 그대로(tools/perf-ledger/nightly.py run) */
const NIGHTLY_ARGV = Object.freeze(['run', '--quiet', '--summary-trend-stats', 'med,p(95),p(99),max', '--summary-export', '.cache/nightly/00-base.json',
  '-e', 'BASE_URL=https://v0-gateway.v0-base.svc.cluster.local:8443', 'loadtest/scenarios/v0-queue.js']);

test('BSL090_D-T40_야간인자_nightly.py가붙인k6인자에서_요약경로·환경값·시나리오를읽는다', () => {
  same(parseK6Args([...NIGHTLY_ARGV]), {
    passthrough: [],
    summaryExport: '.cache/nightly/00-base.json',
    env: { BASE_URL: 'https://v0-gateway.v0-base.svc.cluster.local:8443' },
    scenario: 'loadtest/scenarios/v0-queue.js',
  });
});

test('BSL090_D-T40_야간인자_run앞은그대로넘기고_인자차례와상관없이읽으며_-e값의=는값에남는다', () => {
  const argv = ['--users', '1000', '--entry-rate', '500', 'run', 'loadtest/scenarios/v0-queue.js', '-e', 'BASE_URL=https://v0-gateway.v0.svc.cluster.local:8443',
    '--summary-export', '.cache/nightly/03-new.json', '-e', 'K6_NOTE=a=b', '-e', 'EMPTY=', '--quiet', '--summary-trend-stats', 'med,p(95),p(99),max'];
  same(parseK6Args(argv), {
    passthrough: ['--users', '1000', '--entry-rate', '500'],
    summaryExport: '.cache/nightly/03-new.json',
    env: { BASE_URL: 'https://v0-gateway.v0.svc.cluster.local:8443', K6_NOTE: 'a=b', EMPTY: '' },
    scenario: 'loadtest/scenarios/v0-queue.js',
  });
  // --quiet·--summary-trend-stats·-e는 없어도 된다
  same(parseK6Args(['run', '--summary-export', 'C:\\nightly out\\00-base.json', 'loadtest/scenarios/v0-queue.js']), {
    passthrough: [],
    summaryExport: 'C:\\nightly out\\00-base.json',
    env: {},
    scenario: 'loadtest/scenarios/v0-queue.js',
  });
  // 'run' 앞은 k6 인자처럼 보여도 읽지 않고 그대로 넘긴다
  same(parseK6Args(['--summary-export', 'x.json', '-e', 'NOPE', '--vus', 'run', '--summary-export', '.cache/nightly/01-new.json', 'loadtest/scenarios/v0-queue.js']), {
    passthrough: ['--summary-export', 'x.json', '-e', 'NOPE', '--vus'],
    summaryExport: '.cache/nightly/01-new.json',
    env: {},
    scenario: 'loadtest/scenarios/v0-queue.js',
  });
});

test('BSL090_D-T40_야간인자_run없음·모르는인자·값빠짐·시나리오0개나2개·요약경로없음·=없는-e는Error', () => {
  same(parseK6Args([...NIGHTLY_ARGV]).scenario, 'loadtest/scenarios/v0-queue.js'); // 기준
  const S = 'loadtest/scenarios/v0-queue.js';
  const X = ['--summary-export', '.cache/nightly/00-base.json'];
  const bad = [
    ['run 없음', ['--quiet', ...X, S]],
    ['빈 인자', []],
    ['모르는 k6 인자 --vus', ['run', ...X, '--vus', '10', S]],
    ['모르는 k6 인자 --out', ['run', ...X, '--out', 'json=.cache/nightly/raw.json', S]],
    ['모르는 k6 인자 --http-debug', ['run', '--http-debug', ...X, S]],
    ['모르는 인자를 시나리오로 읽지 않는다', ['run', ...X, '--no-thresholds']],
    ['짧은 이름 -q', ['run', '-q', ...X, S]],
    ['--이름=값 꼴', ['run', '--summary-export=.cache/nightly/00-base.json', S]],
    ['--summary-export 값 빠짐', ['run', S, '--summary-export']],
    ['--summary-trend-stats 값 빠짐', ['run', ...X, S, '--summary-trend-stats']],
    ['-e 값 빠짐', ['run', ...X, S, '-e']],
    ['시나리오 없음', ['run', ...X]],
    ['시나리오 둘', ['run', ...X, S, 'loadtest/scenarios/v0-seat-hold.js']],
    ['--summary-export 없음', ['run', '--quiet', '-e', 'BASE_URL=https://v0-gateway.v0.svc.cluster.local:8443', S]],
    ['--summary-export가 run 앞에만 있음', ['--summary-export', '.cache/nightly/00-base.json', 'run', S]],
    ['run만', ['run']],
    ['= 없는 -e', ['run', ...X, '-e', 'BASE_URL', S]],
    ['= 없는 -e(시나리오 뒤)', ['run', ...X, S, '-e', 'K6_NOTE']],
  ];
  for (const [label, argv] of bad) assert.throws(() => parseK6Args(argv), Error, label);
});

test('BSL090_D-T40_야간주소_입구주소에서v0·v0-base네임스페이스를읽고_맞지않으면Error', () => {
  assert.equal(NIGHTLY_URL.flags, '', '상태 없는 정규식(g·y 없음)');
  assert.equal(namespaceFromUrl('https://v0-gateway.v0.svc.cluster.local:8443'), 'v0');
  assert.equal(namespaceFromUrl('https://v0-gateway.v0-base.svc.cluster.local:8443'), 'v0-base');
  const bad = [
    'http://v0-gateway.v0.svc.cluster.local:8443',
    'https://v0-gateway.v1.svc.cluster.local:8443',
    'https://v0-gateway.v0-new.svc.cluster.local:8443',
    'https://v0-gateway.v0.svc.cluster.local',
    'https://v0-gateway.v0.svc.cluster.local:443',
    'https://v0-gateway.v0.svc.cluster.local:8443/',
    'https://v0-gateway.v0.svc.cluster.local:8443\n',
    ' https://v0-gateway.v0.svc.cluster.local:8443',
    'HTTPS://v0-gateway.v0.svc.cluster.local:8443',
    'https://v0-gatewayXv0.svc.cluster.local:8443',
    'https://evil.example/?u=https://v0-gateway.v0.svc.cluster.local:8443',
    'https://v0-gateway.v0.svc.cluster.local:8443.evil.example',
    '',
    undefined,
    null,
  ];
  for (const url of bad) assert.throws(() => namespaceFromUrl(url), Error, JSON.stringify(url));
});

// ---------------------------------------------------------------------------------------------
// 2026-11-03 시험 검토 뒤 고친 것의 재현 시험(BSL-090)
// ---------------------------------------------------------------------------------------------

test('BSL090_Q-T2_NFR-001_경로목표점검은_phases로준구간에서_진입의요청수·목표넘은수·실패를읽고_주지않은경로는본구간을읽는다', () => {
  const metrics = {
    'http_reqs{phase:prep,route:entry}': { type: 'counter', values: { count: 1000, rate: 10 } },
    'over_target{phase:prep,route:entry,le:200}': { type: 'counter', values: { count: 7, rate: 0 } },
    'http_req_failed{phase:prep,route:entry}': { type: 'rate', values: { passes: 2, fails: 998, rate: 0.002 } },
    // 본구간의 진입 지표(실제로는 0건)는 읽지 않는다
    'http_reqs{phase:main,route:entry}': { type: 'counter', values: { count: 0, rate: 0 } },
    'http_reqs{phase:main,route:status}': { type: 'counter', values: { count: 500, rate: 5 } },
    'over_target{phase:main,route:status,le:200}': { type: 'counter', values: { count: 3, rate: 0 } },
    'http_req_failed{phase:main,route:status}': { type: 'rate', values: { passes: 1, fails: 499, rate: 0.002 } },
    // 다른 구간의 상태 조회 값이 섞이지 않는다
    'http_reqs{phase:prep,route:status}': { type: 'counter', values: { count: 99999, rate: 0 } },
  };
  const out = checksFromSummary({ metrics }, ['entry', 'status'], { entry: 'prep' });
  const by = Object.fromEntries(out.checks.map((c) => [c.name, c]));
  assert.deepStrictEqual(by.entry_p99_200ms, { name: 'entry_p99_200ms', allowed: 0.01, trials: 1000, violations: 7, target: 'entry p99 ≤ 200ms' });
  assert.deepStrictEqual(by.entry_errors, { name: 'entry_errors', allowed: 0.001, trials: 1000, violations: 2, target: 'entry 오류율 < 0.1%' });
  assert.equal(by.status_p99_200ms.trials, 500);
  assert.equal(by.status_p99_200ms.violations, 3);
  assert.equal(by.status_errors.violations, 1);
  // phases를 주지 않으면 지금처럼 본구간만 읽어 진입 점검이 없다
  const plain = checksFromSummary({ metrics }, ['entry', 'status']);
  assert.deepStrictEqual(plain.checks.map((c) => c.name).sort(), ['status_errors', 'status_p99_200ms']);
  // 구간 이름은 영소문자만
  assert.throws(() => checksFromSummary({ metrics }, ['entry'], { entry: 'pr ep' }), RangeError);
  assert.throws(() => checksFromSummary({ metrics }, ['entry'], { entry: 'main,route:x' }), RangeError);
  assert.throws(() => checksFromSummary({ metrics }, ['entry'], null), RangeError);
});

test('BSL090_NFR-013_발생기합치기_요청시간은같은꼬리표의요청이0건인발생기를빼고_합친min과아래한계가0으로끌려가지않는다(모두0이면그대로)', () => {
  const trend = (v) => ({ type: 'trend', values: v });
  const reqs = (n) => ({ type: 'counter', values: { count: n, rate: n / 10 } });
  const s = (n, v) => ({ metrics: { 'http_reqs{phase:main,route:admission}': reqs(n), 'http_req_duration{phase:main,route:admission}': trend(v) } });
  const zero = { avg: 0, min: 0, med: 0, max: 0, 'p(90)': 0, 'p(95)': 0, 'p(99)': 0 };
  const m = mergeSummaries([s(0, zero), s(5, { avg: 3, min: 1.2, med: 2.5, max: 9, 'p(90)': 6, 'p(95)': 7, 'p(99)': 8.5 }), s(4, { avg: 2, min: 1.5, med: 2, max: 4, 'p(90)': 3, 'p(95)': 3.5, 'p(99)': 3.9 })]);
  const d = m.metrics['http_req_duration{phase:main,route:admission}'].values;
  assert.equal(d.min, 1.2, '요청 0건 발생기의 0이 합친 min이 되지 않는다');
  assert.equal(d.max, 9);
  assert.equal(d['p(99)'], 8.5);
  assert.deepStrictEqual(m.merge.bounds['http_req_duration{phase:main,route:admission}']['p(99)'], [3.9, 8.5], '아래 한계도 요청이 있던 발생기에서만');
  assert.equal(m.metrics['http_reqs{phase:main,route:admission}'].values.count, 9, '요청 수는 그대로 더한다');
  // 모든 발생기가 0건이면 빼지 않고 그대로 합친다
  const all0 = mergeSummaries([s(0, zero), s(0, zero)]);
  assert.equal(all0.metrics['http_req_duration{phase:main,route:admission}'].values['p(99)'], 0);
  // 요청 수 지표가 없는 trend(사용자 지표)는 지금처럼 모두 합친다
  const custom = mergeSummaries([{ metrics: { lat: trend({ min: 0, max: 0, 'p(99)': 0 }) } }, { metrics: { lat: trend({ min: 2, max: 5, 'p(99)': 4 }) } }]);
  assert.equal(custom.metrics.lat.values.min, 0);
  assert.deepStrictEqual(custom.merge.bounds.lat['p(99)'], [0, 4]);
});

test('BSL090_O-T1_NFR-010_검표온라인점검은_망끊김앞의온라인구간에시작한시도만세고_판정못받음·150ms넘음을어긴수로센다(같으면지킴)', () => {
  const w = { mainStartMs: 1_000, cutStartMs: 61_000, cutEndMs: 121_000, mainEndMs: 181_000 };
  const p = (startedMs, durMs, ok = true) => ({ kind: 'gate_scan', startedMs, endedMs: startedMs + durMs, ok, result: ok ? 'ADMIT' : null });
  const probes = [
    p(999, 10), // 창 앞: 빼기
    p(1_000, 10), // 시작 경계: 넣기
    p(2_000, 150), // 같으면 지킴
    p(3_000, 151), // 넘음
    p(4_000, 20, false), // 판정 못 받음
    p(60_999, 3000), // 온라인 끝 바로 앞: 넣기(넘음)
    p(61_000, 5, false), // 끊긴 구간: 빼기(빠른 실패)
    p(90_000, 3000, false),
    p(125_000, 10), // 되돌린 구간: 빼기
  ];
  assert.deepStrictEqual(gateOnlineCheck(probes, w), { name: 'scan_p95_150ms', allowed: 0.05, trials: 5, violations: 3, target: 'scan p95 ≤ 150ms(온라인 구간)' });
  assert.deepStrictEqual(gateOnlineCheck(probes, w, { le: 200, allowed: 0.01 }), { name: 'scan_p95_200ms', allowed: 0.01, trials: 5, violations: 2, target: 'scan p95 ≤ 200ms(온라인 구간)' });
  assert.equal(gateOnlineCheck([p(70_000, 5)], w), null, '온라인 시도가 없으면 null');
  assert.throws(() => gateOnlineCheck(probes, { ...w, cutStartMs: 500 }), RangeError);
  assert.throws(() => gateOnlineCheck([{ kind: 'other', startedMs: 1, endedMs: 2, ok: true }], w), RangeError);
  assert.throws(() => gateOnlineCheck(probes, w, { le: 0 }), RangeError);
  assert.throws(() => gateOnlineCheck(probes, w, { allowed: 1 }), RangeError);
});
