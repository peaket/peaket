// F-04-8 측정 하네스의 계약 시험(docs/review/plans/F-04-8.md §3·§7·§9, docs/verification.md V-T19, NFR-009).
// Docker·Kafka·ClickHouse는 건드리지 않는다. 순수 판정 함수·계획 산출·CLI·보고서 모양만 시험한다.
// 실제 측정은 `node loadtest/analytics/run.mjs smoke`이고, 이 시험은 그 도구가 0건·빈 결과를 통과로 세지 않는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLOCK_SKEW_LIMIT_MS,
  FRESHNESS_LIMIT_MS,
  FRESHNESS_WARMUP_MS,
  HOT_LAG_LIMIT_MS,
  LOSS_LIMIT,
  MIX,
  allocCounts,
  benchOf,
  buildPlan,
  judgeAccuracy,
  judgeClockSkew,
  judgeFreshness,
  judgeHotLag,
  judgeLoss,
  judgeRun,
  lossRatio,
  percentile,
  recordsToMs,
} from '../analytics/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const RUN = join(REPO, 'loadtest', 'analytics', 'run.mjs');

// ───────────────────────── V-T19 ① 신선도 ─────────────────────────

test('V-T19 ① 신선도 p95는 5초 경계의 아래만 통과하고 1분 창마다 본다', () => {
  assert.equal(FRESHNESS_LIMIT_MS, 5_000);
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);

  const under = Array.from({ length: 120 }, (_, i) => 4_000 + (i % 7));
  const ok = judgeFreshness(under);
  assert.equal(ok.valid, true);
  assert.equal(ok.pass, true);
  assert.ok(ok.p95 < FRESHNESS_LIMIT_MS);

  // 95번째 값이 정확히 5,000ms면 엄격 미만이 아니므로 실패다
  const boundary = [...Array.from({ length: 18 }, () => 4_000), 5_000, 5_000];
  const atLimit = judgeFreshness(boundary);
  assert.equal(atLimit.valid, true);
  assert.equal(atLimit.pass, false);

  // 전 구간 p95는 낮아도 한 1분 창이 넘으면 실패다(창별 판정)
  const oneBadWindow = [...Array.from({ length: 60 }, () => 1_000), ...Array.from({ length: 60 }, () => 6_000)];
  const windowFail = judgeFreshness(oneBadWindow);
  assert.equal(windowFail.pass, false);
  assert.ok(windowFail.windows.some((w) => w.p95 >= FRESHNESS_LIMIT_MS));

  // 빈 샘플·적은 샘플은 통과가 아니라 무효다
  assert.equal(judgeFreshness([]).valid, false);
  assert.equal(judgeFreshness([1_000, 2_000]).valid, false);
  assert.equal(judgeFreshness(Array.from({ length: 20 }, () => 1_000), { minSamples: 21 }).valid, false);
});

test('V-T19 ① 예열 첫 60초는 창 판정에서 빼고, 그 뒤 창이 넘으면 실패다', () => {
  assert.equal(FRESHNESS_WARMUP_MS, 60_000);
  // 0~120초는 6초(파이프라인이 차는 구간), 120~240초는 2초다.
  const samples = [...Array.from({ length: 120 }, (_, i) => ({ at: i * 1_000, ms: 6_000 })), ...Array.from({ length: 120 }, (_, i) => ({ at: 120_000 + i * 1_000, ms: 2_000 }))];
  assert.equal(judgeFreshness(samples, { warmupMs: 60_000 }).pass, false, '예열을 빼도 60~120초 창이 6초라 실패다');
  // 60~120초도 2초이면 예열 60초를 뺀 뒤에는 통과한다.
  const warmOnly = [...Array.from({ length: 60 }, (_, i) => ({ at: i * 1_000, ms: 6_000 })), ...Array.from({ length: 180 }, (_, i) => ({ at: 60_000 + i * 1_000, ms: 2_000 }))];
  assert.equal(judgeFreshness(warmOnly, { warmupMs: 60_000 }).pass, true);
  assert.equal(judgeFreshness(warmOnly, { warmupMs: 0 }).pass, false);
});

test('계획 §7.1 시계 차는 20ms까지만 통과하고 못 재면 무효다', () => {
  assert.equal(CLOCK_SKEW_LIMIT_MS, 20);
  assert.equal(judgeClockSkew(0).pass, true);
  assert.equal(judgeClockSkew(-19).pass, true);
  assert.equal(judgeClockSkew(20).pass, true);
  assert.equal(judgeClockSkew(21).pass, false);
  assert.equal(judgeClockSkew(Date.now()).pass, false);
  assert.equal(judgeClockSkew(undefined).valid, false);
});

test('ST-T17 핫 파티션 밀림은 기록 수를 도착률로 나눠 시간으로 바꾼다', () => {
  assert.equal(recordsToMs(12_000, 2_000), 6_000);
  assert.equal(recordsToMs(0, 4_500), 0);
  assert.equal(recordsToMs(4_500, 4_500), 1_000);
  assert.equal(recordsToMs(100, 0), null);
  assert.equal(recordsToMs(Number.NaN, 1_000), null);
});

// ───────────────────────── V-T19 ② 누락률 ─────────────────────────

test('V-T19 ② 누락률은 0.1% 미만만 통과하고 작은 표본은 0건만 통과한다', () => {
  assert.equal(LOSS_LIMIT, 0.001);
  const pass = lossRatio({ expected: 1_000_000, covered: 999_500, rejected: 100 });
  assert.equal(pass.denominator, 1_000_000);
  assert.equal(pass.numerator, 600);
  assert.equal(pass.ratio, 0.0006);

  const fail = judgeLoss({ expected: 1_000_000, covered: 999_000, rejected: 0 });
  assert.equal(fail.valid, true);
  assert.equal(fail.pass, false);
  assert.ok(fail.reasons.some((r) => r.includes('0.1%')));

  // 경계 바로 아래는 통과, 경계는 실패
  assert.equal(judgeLoss({ expected: 1_000_000, covered: 999_001, rejected: 0 }).pass, true);
  assert.equal(judgeLoss({ expected: 1_000_000, covered: 999_000, rejected: 0 }).pass, false);

  // 1만 건 미만: 1건이라도 잃으면 실패(작은 표본에서 0.1%가 10건이라 통과가 새지 않게)
  assert.equal(judgeLoss({ expected: 9_999, covered: 9_999, rejected: 0 }).pass, true);
  assert.equal(judgeLoss({ expected: 9_999, covered: 9_998, rejected: 0 }).pass, false);

  // 발생기 실패는 통과로 만들지 않고 무효로 둔다
  const dropped = judgeLoss({ expected: 1_000_000, covered: 1_000_000, rejected: 0, producerFailures: 1 });
  assert.equal(dropped.valid, false);
  assert.equal(dropped.pass, false);

  // 거절은 덮은 수에 들어 있어도 누락으로 더한다
  const rejected = judgeLoss({ expected: 1_000_000, covered: 1_000_000, rejected: 2_000 });
  assert.equal(rejected.ratio > LOSS_LIMIT, true);
  assert.equal(rejected.pass, false);

  // 0건 모집단은 통과가 아니라 무효다
  assert.equal(judgeLoss({ expected: 0, covered: 0, rejected: 0 }).valid, false);
});

// ───────────────────────── V-T19 ③ 정확성 ─────────────────────────

test('V-T19 ③ 강제 종료 뒤 정확성은 고유 eventKey 수와 금액 합계가 정확히 같아야 한다', () => {
  const expected = {
    bronze: { seat: 1_000, order: 900, orderAmount: 9_450_000, payment: 500, paymentAmount: 15_250_000 },
    rt: { seatSold: 1_000, orderConfirmed: 900, paymentAmount: 15_250_000, holdHelped: 720, verdictPass: 1_440 },
  };
  assert.equal(judgeAccuracy({ expected, actual: structuredClone(expected) }).pass, true);

  const missing = structuredClone(expected);
  missing.rt.seatSold = 999;
  const miss = judgeAccuracy({ expected, actual: missing });
  assert.equal(miss.pass, false);
  assert.ok(miss.reasons.some((r) => r.includes('seatSold')));

  const extra = structuredClone(expected);
  extra.rt.verdictPass = 1_441;
  assert.equal(judgeAccuracy({ expected, actual: extra }).pass, false);

  const amount = structuredClone(expected);
  amount.bronze.paymentAmount = 15_249_999;
  assert.equal(judgeAccuracy({ expected, actual: amount }).pass, false);

  // 원시 행이 중복으로 많아도 고유 수가 같으면 통과한다(verify가 고유 수를 넘긴다)
  const duplicateRaw = { ...structuredClone(expected), rawRows: { rt: 99_999, bronze: 88_888 } };
  assert.equal(judgeAccuracy({ expected, actual: duplicateRaw }).pass, true);

  // 비교할 값이 비면 통과가 아니다
  assert.equal(judgeAccuracy({ expected, actual: {} }).pass, false);
});

// ───────────────────────── ST-T17 인기 회차 ─────────────────────────

test('ST-T17 인기 회차 한 파티션은 소비 밀림 p95 5초 미만만 통과한다', () => {
  assert.equal(HOT_LAG_LIMIT_MS, 5_000);
  const ok = judgeHotLag([1_000, 1_500, 2_000, 4_999, 2_500]);
  assert.equal(ok.valid, true);
  assert.equal(ok.pass, true);
  const atLimit = judgeHotLag([1_000, 1_500, 2_000, 5_000, 2_500]);
  assert.equal(atLimit.pass, false);
  assert.equal(judgeHotLag([]).valid, false);
});

// ───────────────────────── 계획 산출 ─────────────────────────

test('V-T19 계획은 3만 건/초를 100칸 비율로 정확히 나누고 기대 합계를 식으로 낸다', () => {
  const weights = Object.values(MIX);
  assert.equal(weights.reduce((a, b) => a + b, 0), 100);

  const plan = buildPlan({ rate: 30_000, durationMs: 60_000, partitions: 12 });
  assert.equal(plan.total, 1_800_000);
  assert.equal(Object.values(plan.byRecord).reduce((a, b) => a + b, 0), plan.total);
  assert.equal(plan.byRecord.seat, 522_000);
  assert.equal(plan.byRecord.order, 270_000);
  assert.equal(plan.byRecord.payment, 180_000);
  assert.equal(plan.byRecord.ticket, 144_000);
  assert.equal(plan.byRecord.hold, 360_000);
  assert.equal(plan.byRecord.verdict, 288_000);
  assert.equal(plan.byRecord.queue, 36_000);
  assert.equal(plan.expected.holdHelped, 288_000);
  assert.equal(plan.expected.holdConflict, 72_000);
  assert.equal(plan.expected.orderAmount, 270_000 * 10_000 + 1_000 * 809_994);
  assert.equal(plan.expected.paymentAmount, 180_000 * 30_000 + 1_000 * 360_000);

  // 100칸 비율을 정확히 나누지 못하는 수는 largest remainder로 합이 정확히 total이 되게 한다
  const counts = allocCounts(101, MIX);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 101);
  for (const [k, w] of Object.entries(MIX)) {
    const exact = (101 * w) / 100;
    assert.ok(Math.abs(counts[k] - exact) < 1, `${k}: ${counts[k]} vs ${exact}`);
  }

  // 핫 모드는 파티션 0에 회차 하나를 몰아 넣는다
  const hot = buildPlan({ rate: 30_000, durationMs: 60_000, partitions: 12, hot: true });
  assert.equal(hot.hotPartition, 0);
  assert.equal(hot.total, plan.total);
});

// ───────────────────────── CLI와 보고서 ─────────────────────────

test('F-04-8 하네스 CLI는 스모크·기준·사다리·강제 종료·인기 회차·검증·정리를 제공한다', () => {
  assert.equal(existsSync(RUN), true);
  const help = spawnSync(process.execPath, [RUN, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  for (const word of ['smoke', 'run', 'ladder', 'crash', 'hot', 'verify', 'cleanup']) {
    assert.ok(help.stdout.includes(word), `--help에 ${word}가 없다`);
  }

  const bad = spawnSync(process.execPath, [RUN, 'run', '--rate', '0', '--duration', '10'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.ok(bad.stderr.includes('rate'));
});

test('F-04-8 판정은 빈 결과와 발생기 실패를 통과로 세지 않고 bench 모양을 낸다', () => {
  const good = judgeRun({
    freshness: { samples: Array.from({ length: 60 }, () => 2_000) },
    loss: { expected: 1_000_000, covered: 1_000_000, rejected: 0, producerFailures: 0 },
    accuracy: { expected: { rt: { seatSold: 1 } }, actual: { rt: { seatSold: 1 } } },
    mode: 'run',
  });
  assert.equal(good.verdict, 'pass');
  assert.equal(good.reasons.length, 0);

  const empty = judgeRun({ freshness: { samples: [] }, loss: { expected: 0, covered: 0, rejected: 0 }, accuracy: {}, mode: 'run' });
  assert.equal(empty.verdict, 'invalid');
  assert.ok(empty.reasons.length >= 2);

  const dropped = judgeRun({
    freshness: { samples: Array.from({ length: 60 }, () => 2_000) },
    loss: { expected: 1_000, covered: 1_000, rejected: 0, producerFailures: 1 },
    accuracy: { expected: { rt: { seatSold: 1 } }, actual: { rt: { seatSold: 1 } } },
    mode: 'run',
  });
  assert.equal(dropped.verdict, 'invalid');

  const failed = judgeRun({
    freshness: { samples: Array.from({ length: 60 }, () => 6_000) },
    loss: { expected: 1_000, covered: 1_000, rejected: 0 },
    accuracy: { expected: { rt: { seatSold: 1 } }, actual: { rt: { seatSold: 1 } } },
    mode: 'run',
  });
  assert.equal(failed.verdict, 'fail');

  const bench = benchOf({ total: 1_000_000, producerFailures: 0, freshness: { p95: 2_000 }, loss: { ratio: 0 } });
  assert.equal(bench.requests, 1_000_000);
  assert.equal(bench.dropped, 0);
  assert.equal(bench.p99_ms, 2_000);
  assert.equal(bench.error_rate, 0);
});
