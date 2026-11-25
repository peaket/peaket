// 좌석맵 랩 판정 시험(F-08-1, docs/frontend.md FE-T10, docs/verification.md §3.10 K5, tools/web-checks/seatmap/RESULT.md).
// 회차 무효 처리·모드 비교·Worker 스레드 몫 보정을 숫자로만 본다. 구현 전 기준 트리에서는 seats/lab-judge.mjs가 없어 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareModes, invalidReason, judgeMode, summarizeMode, workerCorrection } from './lab-judge.mjs';
import { VITALS_COLLECTOR_SOURCE } from './vitals-collector.mjs';

/** 랩 회차 하나(seats/page/main.ts가 내는 모양) */
const run = (o = {}) => ({
  mode: 'worker',
  expectedMode: 'worker',
  seats: 50_000,
  sectionCount: 25,
  firstPaintMs: 600,
  longTasks: [],
  loafCount: 0,
  messageP95Ms: 0.3,
  heapMB: 2.1,
  clicks: { asked: 10, hits: 10 },
  vitals: { status: 'ready', inpMs: 80, lcpMs: 700, cls: 0 },
  ...o,
});

test('F081-10 무효 회차를 까닭과 함께 가른다(50,000석·모드·계측 상태·INP 표본)', () => {
  assert.equal(invalidReason(run()), null);
  assert.match(invalidReason(run({ seats: 49_999 })), /좌석 수/);
  assert.match(invalidReason(run({ sectionCount: 24 })), /구역 수/);
  assert.match(invalidReason(run({ mode: 'main-thread' })), /모드/);
  assert.match(invalidReason(run({ vitals: { status: 'loading', inpMs: 80, lcpMs: 700, cls: 0 } })), /계측 상태/);
  assert.match(invalidReason(run({ vitals: { status: 'ready', inpMs: null, lcpMs: 700, cls: 0 } })), /INP/);
  // 눌렀는데 16ms 이상 사건이 하나도 없으면 모두 16ms 미만이라 0으로 적는다(무효가 아니다)
  const fast = run({ vitals: { status: 'ready', inpMs: null, lcpMs: 700, cls: 0, interactions: 0 } });
  assert.equal(invalidReason(fast), null);
  assert.equal(summarizeMode([fast], { mode: 'worker', reps: 1 }).metrics.inpMs.p75, 0);
  // 표본이 있는데 INP가 비는 것은 무효다
  assert.match(invalidReason(run({ vitals: { status: 'ready', inpMs: null, lcpMs: 700, cls: 0, interactions: 3 } })), /INP/);
  assert.match(invalidReason(run({ vitals: { status: 'ready', inpMs: 80, lcpMs: null, cls: 0 } })), /LCP/);
  assert.match(invalidReason(run({ vitals: { status: 'ready', inpMs: 80, lcpMs: 700, cls: null } })), /CLS/);
  assert.match(invalidReason(run({ firstPaintMs: -1 })), /첫 그림/);
  assert.match(invalidReason(run({ longTasks: null })), /긴 작업/);
  assert.match(invalidReason(run({ messageP95Ms: null })), /메시지/);
  assert.match(invalidReason(run({ clicks: { asked: 10, hits: 0 } })), /조작/);
  assert.equal(invalidReason(null), '회차 기록이 없다');
});

test('F081-10b 요약은 유효 회차로만 p75를 내고, 전부 무효면 unknown이다', () => {
  const runs = Array.from({ length: 20 }, (_, i) => (i === 3 ? run({ seats: 0 }) : run({ vitals: { status: 'ready', inpMs: 100 + i, lcpMs: 700, cls: 0 } })));
  const s = summarizeMode(runs, { mode: 'worker', reps: 20 });
  assert.equal(s.n, 19);
  assert.equal(s.provisional, true);
  assert.equal(s.invalid.length, 1);
  assert.equal(s.metrics.inpMs.p75, 115); // 100..119 가운데 넣은 103을 빼면 15번째는 115
  assert.equal(judgeMode(runs, { mode: 'worker', reps: 20 }).verdict.status, 'provisional');

  const none = judgeMode([run({ seats: 0 }), run({ mode: 'main-thread' })], { mode: 'worker', reps: 20 });
  assert.equal(none.verdict.status, 'unknown');
  assert.match(none.verdict.reasons.join('\n'), /유효 회차/);
});

test('F081-09 요약은 힙을 판정 지표에 넣지 않고, 모드 비교는 힙 감축률을 보조로 표시한다', () => {
  const worker = summarizeMode(Array.from({ length: 20 }, () => run({ heapMB: 2 })), { mode: 'worker', reps: 20 });
  const canvas = summarizeMode(Array.from({ length: 20 }, () => run({ mode: 'main-thread', expectedMode: 'main-thread', heapMB: 5 })), { mode: 'main-thread', reps: 20 });
  assert.equal(worker.metrics.heapMB, undefined, '힙은 판정 지표에 없다');
  assert.equal(worker.heapMB.p75, 2);
  const cmp = compareModes(canvas, worker);
  assert.equal(cmp.heapReduction, 0.6);
  assert.deepEqual(cmp.secondary, ['heapReduction']);
  assert.match(cmp.note, /Worker|보정/);
  // 힙을 못 재도 판정은 그대로다
  const unknownHeap = summarizeMode(Array.from({ length: 20 }, () => run({ heapMB: null })), { mode: 'worker', reps: 20 });
  assert.equal(unknownHeap.heapMB, null);
  assert.equal(judgeMode(Array.from({ length: 20 }, () => run({ heapMB: null })), { mode: 'worker', reps: 20 }).verdict.status, 'pass');
});

test('F081-09b Worker 스레드 몫 보정은 메인 몫 + 배수 × Worker 몫이다', () => {
  assert.equal(workerCorrection({ mainMs: 1, workerMs: 6, throttle: 4 }), 25);
  assert.equal(workerCorrection({ mainMs: 10, workerMs: 0, throttle: 4 }), 10);
  assert.throws(() => workerCorrection({ mainMs: 1, workerMs: 6, throttle: 0.5 }), /배수/);
  assert.throws(() => workerCorrection({ mainMs: Number.NaN, workerMs: 6, throttle: 4 }), /숫자/);
});

test('F081-09c Canvas 모드는 보정하지 않고, 모드가 섞인 회차는 무효다', () => {
  const canvasRuns = Array.from({ length: 20 }, () => run({ mode: 'main-thread', expectedMode: 'main-thread', firstPaintMs: 1100 }));
  const s = summarizeMode(canvasRuns, { mode: 'main-thread', reps: 20 });
  assert.equal(s.metrics.firstPaintMs.p75, 1100);
  assert.equal(judgeMode(canvasRuns, { mode: 'main-thread', reps: 20 }).verdict.status, 'fail');
  // Worker 실행에 Canvas 회차가 섞이면 그 회차는 무효다
  const mixed = summarizeMode([run(), run({ mode: 'main-thread' })], { mode: 'worker', reps: 2 });
  assert.equal(mixed.n, 1);
  assert.match(mixed.invalid[0].reason, /모드/);
});

test('F081-13 수집기 원문은 문법에 맞고 LCP·CLS·INP·LoAF·longtask를 관찰한다', () => {
  assert.doesNotThrow(() => new Function(VITALS_COLLECTOR_SOURCE));
  for (const s of ['largest-contentful-paint', 'layout-shift', 'long-animation-frame', 'longtask', '__peaketVitals', '__peaketVitalsReset', 'interactionId']) {
    assert.ok(VITALS_COLLECTOR_SOURCE.includes(s), `${s}가 수집기에 없다`);
  }
  // 창(window) 전역에 붙는 원문이다(페이지 스크립트보다 먼저 주입)
  assert.match(VITALS_COLLECTOR_SOURCE, /^\(\(\) => \{/);
});

test('F081-10c 경계: 첫 그림 1,000/1,001, INP 200/201, 긴 작업 0/1, 메시지 p95 2/2.001', () => {
  const at = (o) => judgeMode(Array.from({ length: 20 }, () => run(o)), { mode: 'worker', reps: 20 }).verdict;
  assert.equal(at({ firstPaintMs: 1000 }).status, 'pass');
  assert.equal(at({ firstPaintMs: 1001 }).status, 'fail');
  assert.equal(at({ vitals: { status: 'ready', inpMs: 200, lcpMs: 700, cls: 0 } }).status, 'pass');
  assert.equal(at({ vitals: { status: 'ready', inpMs: 201, lcpMs: 700, cls: 0 } }).status, 'fail');
  assert.equal(at({ longTasks: [] }).status, 'pass');
  assert.equal(at({ longTasks: [51] }).status, 'fail');
  assert.equal(at({ messageP95Ms: 2 }).status, 'pass');
  assert.equal(at({ messageP95Ms: 2.001 }).status, 'fail');
});
