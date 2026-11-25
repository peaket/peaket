// p75 집계·FE-T10 판정 시험(F-08-1, docs/frontend.md §5.8 '판정은 둘로 나눈다'·FE-T10, NFR-012).
// 단언 값은 정본에서 가져온다: 20회 [가정], INP 200ms, LCP 2.5초, CLS 0.1, 첫 그림 1초, 메시지 p95 2ms.
// 구현 전 기준 트리에서는 lib/vitals.mjs가 없어 이 파일이 읽히지 않는다(실패 확인 15절).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLS_LIMIT,
  FIRST_PAINT_LIMIT_MS,
  INP_LIMIT_MS,
  LCP_LIMIT_MS,
  MESSAGE_P95_LIMIT_MS,
  aggregateRuns,
  labVerdict,
  p75,
  percentile,
  renderLabReport,
} from './vitals.mjs';

/** 회차 하나. valid가 false면 reason이 있어야 한다 */
const run = (o = {}) => ({
  valid: true,
  firstPaintMs: 500,
  inpMs: 90,
  lcpMs: 800,
  cls: 0,
  longTasks: [],
  loafCount: 0,
  messageP95Ms: 0.2,
  ...o,
});

test('F081-01 p75는 최근접 순위다(20회면 15번째, 보간 없음)', () => {
  const xs = Array.from({ length: 20 }, (_, i) => i + 1);
  // 평균 10.5, 중앙값 10.5, 마지막 20, 옛 floor 방식 16과 모두 다르다
  assert.equal(p75(xs), 15);
  assert.equal(percentile(xs, 0.75), 15);
  assert.equal(percentile([5, 1, 4, 2, 3], 0.75), 4);
  assert.equal(percentile([7], 0.75), 7);
  assert.equal(percentile([10, 20, 30, 40], 0.75), 30);
});

test('F081-02 p75는 빈 배열·비율 경계에서 멈춘다', () => {
  assert.throws(() => p75([]), /값이 없다/);
  assert.throws(() => percentile([1, 2], -0.1), /비율/);
  assert.throws(() => percentile([1, 2], 1.1), /비율/);
  assert.throws(() => percentile([1, Number.NaN], 0.5), /숫자/);
  assert.equal(percentile([1, 2, 3], 0), 1);
  assert.equal(percentile([1, 2, 3], 1), 3);
  // 받은 배열을 바꾸지 않는다
  const xs = [3, 1, 2];
  assert.equal(p75(xs), 3); // n=3이면 ceil(2.25)−1=2 → 가장 큰 값(보간 없음)
  assert.deepEqual(xs, [3, 1, 2]);
});

test('F081-03 집계는 무효 회차를 빼고 부족하면 잠정이다', () => {
  const runs = Array.from({ length: 20 }, (_, i) => (i === 0 ? run({ valid: false, reason: '좌석 수 4만' }) : run({ inpMs: 100 + i })));
  const agg = aggregateRuns(runs, { reps: 20 });
  assert.equal(agg.n, 19);
  assert.equal(agg.invalid.length, 1);
  assert.equal(agg.invalid[0].reason, '좌석 수 4만');
  assert.equal(agg.provisional, true);
  // 유효 19개의 p75는 15번째(104부터 세면 115), 20번째가 아니다
  assert.equal(agg.metrics.inpMs.p75, 115);
  assert.equal(agg.metrics.inpMs.n, 19);

  const full = aggregateRuns(Array.from({ length: 20 }, (_, i) => run({ inpMs: 100 + i })), { reps: 20 });
  assert.equal(full.provisional, false);
  assert.equal(full.n, 20);
  assert.equal(full.metrics.inpMs.p75, 114); // 100..119 20개 중 15번째
});

test('F081-04 지표가 없는 회차는 통과로 세지 않는다', () => {
  // 무효 표시가 있으면 계산에서 뺀다
  const mixed = aggregateRuns([run(), run({ valid: false, reason: 'INP 표본 없음' }), run()], { reps: 2 });
  assert.equal(mixed.n, 2);
  assert.equal(mixed.metrics.inpMs.n, 2);

  // 유효 회차 가운데 지표가 비면 그 지표 표본이 줄고 판정은 실패다
  const missing = aggregateRuns([run(), run({ inpMs: null }), run()], { reps: 3 });
  assert.equal(missing.n, 3);
  assert.equal(missing.metrics.inpMs.n, 2);
  const verdict = labVerdict(missing);
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.reasons.join('\n'), /INP 표본 2\/3/);

  // 유효 회차가 0이면 통과가 아니라 unknown이다
  const none = aggregateRuns([run({ valid: false, reason: 'ready 없음' })], { reps: 1 });
  assert.equal(none.n, 0);
  assert.equal(labVerdict(none).status, 'unknown');
});

test('F081-05 FE-T10 경계: 첫 그림 1,000ms·INP 200ms·LCP 2,500ms·CLS 0.1·메시지 2ms·긴 작업 0', () => {
  assert.deepEqual([INP_LIMIT_MS, LCP_LIMIT_MS, CLS_LIMIT, FIRST_PAINT_LIMIT_MS, MESSAGE_P95_LIMIT_MS], [200, 2500, 0.1, 1000, 2]);
  const at = (o) => labVerdict(aggregateRuns(Array.from({ length: 20 }, () => run(o)), { reps: 20 }));
  assert.equal(at({}).status, 'pass');
  assert.equal(at({ firstPaintMs: 1000 }).status, 'pass');
  assert.equal(at({ firstPaintMs: 1001 }).status, 'fail');
  assert.equal(at({ inpMs: 200 }).status, 'pass');
  assert.equal(at({ inpMs: 201 }).status, 'fail');
  assert.equal(at({ lcpMs: 2500 }).status, 'pass');
  assert.equal(at({ lcpMs: 2501 }).status, 'fail');
  assert.equal(at({ cls: 0.1 }).status, 'pass');
  assert.equal(at({ cls: 0.101 }).status, 'fail');
  assert.equal(at({ messageP95Ms: 2 }).status, 'pass');
  assert.equal(at({ messageP95Ms: 2.001 }).status, 'fail');
  // 긴 작업은 p75가 아니라 조작 경로 전체에서 0이어야 한다. 20회 가운데 한 번만 있어도 실패다
  const oneLong = Array.from({ length: 20 }, (_, i) => run({ longTasks: i === 7 ? [52] : [] }));
  const v = labVerdict(aggregateRuns(oneLong, { reps: 20 }));
  assert.equal(v.status, 'fail');
  assert.match(v.reasons.join('\n'), /긴 작업/);
});

test('F081-05b 잠정 회차는 통과로 세지 않고, 유효 0회는 unknown이다', () => {
  const few = labVerdict(aggregateRuns(Array.from({ length: 5 }, () => run()), { reps: 20 }));
  assert.equal(few.status, 'provisional');
  assert.notEqual(few.status, 'pass');
  const none = labVerdict(aggregateRuns([], { reps: 20 }));
  assert.equal(none.status, 'unknown');
  assert.match(none.reasons.join('\n'), /유효 회차/);
});

test('F081-05c 보고서는 모드별 p75·최댓값·무효·잠정 표시를 남긴다', () => {
  const worker = aggregateRuns(Array.from({ length: 20 }, (_, i) => run({ inpMs: 40 + i })), { reps: 20 });
  const canvas = aggregateRuns(Array.from({ length: 5 }, () => run({ inpMs: 180 })), { reps: 20 });
  const md = renderLabReport({
    reps: 20,
    profile: '412×823·배율 2.625·CPU 4배·왕복 150ms·1.6Mbps',
    modes: [
      { name: 'worker', label: 'Worker(OffscreenCanvas)', summary: worker, verdict: labVerdict(worker) },
      { name: 'canvas', label: 'Canvas(메인 스레드)', summary: canvas, verdict: labVerdict(canvas) },
    ],
  });
  assert.match(md, /412×823/);
  assert.match(md, /\| Worker\(OffscreenCanvas\) \|/);
  assert.match(md, /잠정/);
  assert.match(md, /INP/);
  assert.match(md, /p75/);
});
